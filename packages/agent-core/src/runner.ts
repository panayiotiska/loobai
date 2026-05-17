import type { RunKind, RunOutput } from '@loob/shared';
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

  let finalJson: RunOutput;
  try {
    // Deterministic exits BEFORE the LLM looks at open positions, so trades that
    // already hit TP/SL/time_limit are closed without depending on the agent's memory.
    // A transient Supabase/network blip here must not kill the whole tick — the
    // sweeps are best-effort, and the LLM still has its own paper_trade_close tool.
    try {
      const autoClose = await autoCloseTriggeredTrades(db);
      if (autoClose.closed.length || autoClose.errors.length) {
        log.info({ msg: 'auto-close swept', runId: run.id, closed: autoClose.closed.length, errors: autoClose.errors.length });
      }
    } catch (e) {
      log.warn({ msg: 'auto-close sweep skipped', runId: run.id, err: String(e) });
    }

    try {
      const mtm = await markOpenTradesToMarket(db);
      if (mtm.updated || mtm.errors.length) {
        log.info({ msg: 'mark-to-market swept', runId: run.id, updated: mtm.updated, skipped: mtm.skipped, errors: mtm.errors.length });
      }
    } catch (e) {
      log.warn({ msg: 'mark-to-market sweep skipped', runId: run.id, err: String(e) });
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

    const { tokenUsage, costUsd } = result;
    finalJson = result.finalJson;

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
      llm_cost_usd: costUsd,
    });

    log.info({ msg: 'run success', runId: run.id, kind });
  } catch (err) {
    log.error({ msg: 'run failed', runId: run.id, kind, err: String(err) });

    await updateRun(db, run.id, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err),
    });

    // Count consecutive prior failures of the same kind so Telegram can shout louder.
    // Exclude the run we just marked failed; we want the streak BEFORE this run.
    let consecutiveFailures = 0;
    try {
      const recent = await getRecentRuns(db, 10);
      for (const r of recent) {
        if (r.id === run.id) continue;
        if (r.kind !== kind) continue;
        if (r.status === 'failed') consecutiveFailures += 1;
        else break;
      }
    } catch (e) {
      log.warn({ msg: 'consecutive-failure count failed', err: String(e) });
    }

    await sendTelegramError(run.id, err, { consecutiveFailures });
    throw err;
  }

  // Telegram + post-success reads live OUTSIDE the try/catch above: a flaky
  // Telegram POST or Supabase blip here must not flip an already-persisted
  // success row to failed (and would also re-send as an error to Telegram).
  try {
    const freshOpenTrades = await getOpenTrades(db);
    const freshPendingRequests = await getPendingRequests(db);

    await sendTelegramSummary({
      runId: run.id,
      runKind: kind,
      output: finalJson,
      openTrades: freshOpenTrades,
      pendingRequestCount: freshPendingRequests.length,
    });
  } catch (e) {
    log.warn({ msg: 'post-success telegram summary failed', runId: run.id, err: String(e) });
  }
}
