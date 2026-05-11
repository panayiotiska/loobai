import type { RunKind } from '@loob/shared';
import {
  createServiceClient,
  createRun,
  updateRun,
  getLatestFormula,
  insertFormulaVersion,
  getOpenTrades,
  getPendingRequests,
  getRecentRuns,
  getUnconsumedNotes,
  getSystemState,
  markNotesConsumed,
} from '@loob/db';

import { buildSystemPrompt } from './prompts/system.js';
import { runGeminiLoop, buildToolHandlersForRun } from './gemini-loop.js';
import { buildToolDeclarations } from './tools/index.js';
import { autoCloseTriggeredTrades, markOpenTradesToMarket } from './tools/paper-trade.js';
import { sendTelegramSummary, sendTelegramError } from './telegram.js';
import pino from 'pino';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(process.env.NODE_ENV !== 'production' && { transport: { target: 'pino-pretty' } }),
});

const MAX_ITERATIONS: Record<RunKind, number> = {
  research: 12,
  monitor: 4,
};

export async function runTick(kind: RunKind): Promise<void> {
  const db = createServiceClient();

  log.info({ msg: 'tick starting', kind });

  // Kill-switch gate — checked BEFORE creating a run row so paused ticks
  // are recorded as failed-with-reason rather than swallowed silently.
  const state = await getSystemState(db);
  if (state.paused) {
    const reason = state.paused_reason ?? 'manual';
    log.warn({ msg: 'tick aborted: agent paused', kind, reason });
    const run = await createRun(db, kind);
    await updateRun(db, run.id, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      summary: `agent paused: ${reason}`,
      error: 'paused',
    });
    return;
  }

  const run = await createRun(db, kind);
  log.info({ msg: 'run created', runId: run.id, kind });

  try {
    // Deterministic exits BEFORE the LLM looks at open positions, so trades that
    // already hit TP/SL/time_limit are closed without depending on the agent's memory.
    const autoClose = await autoCloseTriggeredTrades(db);
    if (autoClose.closed.length || autoClose.errors.length) {
      log.info({ msg: 'auto-close swept', runId: run.id, closed: autoClose.closed.length, errors: autoClose.errors.length });
    }

    // Mark remaining open trades to market so unrealized PnL on the UI and
    // in the agent's context is the actual mark-to-market number rather than null.
    const mtm = await markOpenTradesToMarket(db);
    if (mtm.updated || mtm.errors.length) {
      log.info({ msg: 'mark-to-market swept', runId: run.id, updated: mtm.updated, skipped: mtm.skipped, errors: mtm.errors.length });
    }

    const [currentFormula, openTrades, pendingRequests, recentRuns, unconsumedNotes] =
      await Promise.all([
        getLatestFormula(db),
        getOpenTrades(db),
        getPendingRequests(db),
        getRecentRuns(db, 10),
        getUnconsumedNotes(db),
      ]);

    const systemPrompt = buildSystemPrompt({
      runKind: kind,
      currentFormula,
      openTrades,
      pendingRequests,
      recentRuns,
      unconsumedNotes,
    });

    const toolDeclarations = buildToolDeclarations();
    const toolHandlers = buildToolHandlersForRun(db, run.id);

    const result = await runGeminiLoop({
      systemPrompt,
      toolDeclarations,
      toolHandlers,
      maxIterations: MAX_ITERATIONS[kind],
      runId: run.id,
      db,
    });

    const { finalJson, tokenUsage } = result;

    // Persist new formula version if agent updated it
    if (finalJson.newFormula) {
      const newVersion = (currentFormula?.version ?? 0) + 1;
      await insertFormulaVersion(db, {
        run_id: run.id,
        version: newVersion,
        content: finalJson.newFormula,
        changelog: finalJson.formulaChangelog ?? `v${newVersion}: updated by ${kind} run`,
        parent_version: currentFormula?.version ?? null,
      });
      log.info({ msg: 'formula version inserted', version: newVersion, runId: run.id });
    }

    // Mark notes as consumed
    await markNotesConsumed(
      db,
      unconsumedNotes.map((n) => n.id),
      run.id,
    );

    // Finalize the run
    await updateRun(db, run.id, {
      status: 'success',
      finished_at: new Date().toISOString(),
      summary: finalJson.summary,
      llm_input_tokens: tokenUsage.input,
      llm_output_tokens: tokenUsage.output,
    });

    log.info({ msg: 'run success', runId: run.id, kind });

    // Reload open trades with updated state for Telegram
    const freshOpenTrades = await getOpenTrades(db);
    const freshPendingRequests = await getPendingRequests(db);

    await sendTelegramSummary({
      runId: run.id,
      runKind: kind,
      output: finalJson,
      openTrades: freshOpenTrades,
      pendingRequestCount: freshPendingRequests.length,
    });
  } catch (err) {
    log.error({ msg: 'run failed', runId: run.id, kind, err: String(err) });

    await updateRun(db, run.id, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err),
    });

    await sendTelegramError(run.id, err);
    throw err;
  }
}
