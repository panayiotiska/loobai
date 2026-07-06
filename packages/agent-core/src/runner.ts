import type { RunKind, RunOutput } from '@loob/shared';
import { validateFormulaUpdate } from '@loob/shared';
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
  getRunsWithoutFormulaUpdate,
  failStaleRuns,
} from '@loob/db';

import { buildSystemPrompt } from './prompts/system.js';
import { runGeminiLoop, buildToolHandlersForRun, isTransientGeminiError } from './gemini-loop.js';
import { buildToolDeclarations } from './tools/index.js';
import { accrueFundingCarry, autoCloseTriggeredTrades, markOpenTradesToMarket } from './tools/paper-trade.js';
import { sendTelegramSummary, sendTelegramError } from './telegram.js';
import pino from 'pino';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(process.env.NODE_ENV !== 'production' && { transport: { target: 'pino-pretty' } }),
});

const MAX_ITERATIONS: Record<RunKind, number> = {
  // v2: research budget bumped 12→18 to absorb the mandatory startup ritual
  // (read_lessons_learned, get_portfolio_stats, read_recent_runs, assess_market_regime)
  // plus the adversarial pre-trade checks (funding extremes, orderbook imbalance,
  // long/short ratio, liquidation zones, manipulation signals) without running
  // out of room to actually write a trade or formula update.
  research: 18,
  monitor: 4,
};

export async function runTick(kind: RunKind): Promise<void> {
  const db = createServiceClient();

  log.info({ msg: 'tick starting', kind });

  // Zombie-run sweep: rows stuck in 'running' after a cancelled/timed-out
  // workflow would otherwise pollute run history forever. Best-effort.
  try {
    const swept = await failStaleRuns(db, 30);
    if (swept > 0) log.warn({ msg: 'stale running runs marked failed', swept });
  } catch (e) {
    log.warn({ msg: 'stale-run sweep skipped', err: String(e) });
  }

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
    // Accrue funding carry FIRST so auto-close and mark-to-market compute P&L
    // with up-to-date carry. The squeeze-scout thesis is funding-based — without
    // this the scoreboard never measured the mechanism the strategy trades on.
    try {
      const carry = await accrueFundingCarry(db);
      if (carry.accrued || carry.errors.length || carry.ratcheted.length || carry.closed.length) {
        log.info({
          msg: 'funding carry accrued',
          runId: run.id,
          accrued: carry.accrued,
          skipped: carry.skipped,
          ratcheted: carry.ratcheted,
          carryClosed: carry.closed,
          errors: carry.errors.length,
        });
      }
    } catch (e) {
      log.warn({ msg: 'funding carry sweep skipped', runId: run.id, err: String(e) });
    }

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

    let result;
    try {
      result = await runGeminiLoop({
        systemPrompt,
        toolDeclarations,
        toolHandlers,
        maxIterations: MAX_ITERATIONS[kind],
        runId: run.id,
        db,
        // Research runs must not silently end with zero positions opened — the loop
        // injects an explicit open-or-skip decision turn if the agent trails off.
        enforceTradeDecision: kind === 'research',
      });
    } catch (e) {
      // Monitor ticks: the safety-critical work (funding carry accrual,
      // auto-close, mark-to-market) already ran above, BEFORE the LLM call.
      // If Gemini is having a transient outage that outlasts the full retry
      // budget, degrade to a sweeps-only tick instead of failing the run and
      // paging Telegram. Research ticks still fail loudly — the LLM IS the run.
      if (kind === 'monitor' && isTransientGeminiError(e)) {
        log.warn({ msg: 'LLM unavailable — degrading monitor tick to sweeps-only', runId: run.id, err: String(e).slice(0, 300) });
        await updateRun(db, run.id, {
          status: 'success',
          finished_at: new Date().toISOString(),
          summary:
            'Degraded monitor tick: Gemini unavailable after full retry budget. ' +
            'Deterministic sweeps (funding carry, auto-close, mark-to-market) completed; discretionary review skipped this tick.',
        });
        return;
      }
      throw e;
    }

    const { tokenUsage, costUsd } = result;
    finalJson = result.finalJson;

    // v2 wrap-up enforcement (research only). If trades closed this run OR the
    // formula has been stagnant for ≥6 successful runs, force a follow-up Gemini
    // call to make the agent write a Lessons-section update. Stagnation without
    // recording why is the bug we are explicitly engineering against.
    if (kind === 'research' && !finalJson.newFormula) {
      const tradesClosedThisRun = finalJson.paperTradesClosed.length > 0;
      let staleStreak = 0;
      if (!tradesClosedThisRun) {
        try {
          const stagnant = await getRunsWithoutFormulaUpdate(db, 6);
          staleStreak = stagnant.length;
        } catch (e) {
          log.warn({ msg: 'stagnant-streak check failed', err: String(e) });
        }
      }
      if (tradesClosedThisRun || staleStreak >= 6) {
        const directive = tradesClosedThisRun
          ? `You closed ${finalJson.paperTradesClosed.length} trade(s) this run but did not write a new FORMULA.md version. ` +
            `This is mandatory: write a new version whose "## Lessons learned" section references each closed trade UUID with its structured postmortem. ` +
            `Output a single fenced json RunOutput block with newFormula + formulaChangelog. Do not call tools.`
          : `FORMULA has not been updated for ${staleStreak} consecutive successful runs. Write an "I am not seeing edge yet — here is what I am watching" version: update the regime, watchlist, and what would push confidence above the gate. Output a single fenced json RunOutput block with newFormula + formulaChangelog. Do not call tools.`;
        log.info({ msg: 'forcing wrap-up follow-up for formula update', runId: run.id, tradesClosedThisRun, staleStreak });
        try {
          // IMPORTANT: this follow-up must NOT reuse the full system prompt. The full
          // prompt mandates the startup tool ritual; combined with empty toolHandlers
          // it made the model see "Unknown tool" errors, conclude the infrastructure
          // was broken, and write HALTED/tooling-failure versions of FORMULA (v71,
          // v73, v76, v77). Use a minimal wrap-up prompt instead, and keep the real
          // handlers wired so any stray tool call still succeeds.
          const wrapUpPrompt = [
            `You are Loob, an autonomous trading research agent, wrapping up a research run. This follow-up turn has ONE job: write an updated FORMULA.md version.`,
            `Do NOT call tools in this turn. Skip the startup ritual — it already ran earlier in this run. If a tool call fails here, that is expected and is NOT an infrastructure problem: never record a "tooling failure" lesson or halt the strategy because of it.`,
            `## Current FORMULA.md (v${currentFormula?.version ?? 0})\n${currentFormula?.content ?? '(none yet)'}`,
            `## Directive\n${directive}`,
            `Preserve ALL existing sections, hypotheses, and lessons — append and amend, never truncate. The document MUST keep its "## Setups", "## Hypotheses", "## Anti-pattern log", and "## Recent lessons" sections; a validation guard rejects versions that are short, missing sections, or >40% smaller than the previous version.`,
            `## Output contract\nEnd your response with ONE fenced \`\`\`json block: {"summary": "...", "newFormula": "<full updated FORMULA.md markdown>", "formulaChangelog": "...", "paperTradesOpened": [], "paperTradesClosed": [], "agentRequestsCreated": [], "confidenceInThesis": 0.5, "nextRunFocus": "..."}. Valid JSON only — straight quotes, \\n escapes for newlines, no trailing commas, nothing after the block.`,
          ].join('\n\n');
          const followup = await runGeminiLoop({
            systemPrompt: wrapUpPrompt,
            toolDeclarations: [],
            toolHandlers,
            maxIterations: 2,
            runId: run.id,
            db,
          });
          if (followup.finalJson.newFormula) {
            finalJson = {
              ...finalJson,
              newFormula: followup.finalJson.newFormula,
              formulaChangelog: followup.finalJson.formulaChangelog ?? finalJson.formulaChangelog,
              summary: finalJson.summary, // keep original telegram summary
            };
          }
        } catch (e) {
          log.warn({ msg: 'wrap-up follow-up failed', runId: run.id, err: String(e) });
        }
      }
    }

    // Persist new formula version if agent updated it — but only through the
    // guard. On 2026-06-30 an unvalidated `newFormula: "..."` was persisted as
    // v117 and destroyed the accumulated strategy document. Never again: an
    // invalid update gets ONE corrective follow-up; if that also fails, the
    // previous version stays live (stale beats wiped) and the rejection reason
    // is surfaced in the run summary for the next run to see.
    if (finalJson.newFormula) {
      let candidate = finalJson.newFormula;
      let changelog = finalJson.formulaChangelog;
      let verdict = validateFormulaUpdate(candidate, currentFormula);

      if (!verdict.ok) {
        log.warn({ msg: 'formula update rejected — attempting corrective follow-up', runId: run.id, reason: verdict.reason });
        try {
          const correctivePrompt = [
            `You are Loob, an autonomous trading research agent. Your FORMULA.md update was REJECTED by a validation guard:`,
            `> ${verdict.reason}`,
            `## Current FORMULA.md (v${currentFormula?.version ?? 0}) — the live version you must preserve\n${currentFormula?.content ?? '(none yet)'}`,
            `## Your rejected update\n${candidate.slice(0, 8_000)}`,
            `## Directive\nRe-emit a corrected FULL FORMULA.md document: start from the current version above, preserve every section (## Setups, ## Hypotheses, ## Anti-pattern log, ## Recent lessons), and fold in your intended changes incrementally. Do NOT call tools.`,
            `## Output contract\nEnd your response with ONE fenced \`\`\`json block: {"summary": "...", "newFormula": "<full corrected FORMULA.md markdown>", "formulaChangelog": "...", "paperTradesOpened": [], "paperTradesClosed": [], "agentRequestsCreated": [], "confidenceInThesis": 0.5, "nextRunFocus": "..."}. Valid JSON only.`,
          ].join('\n\n');
          const corrective = await runGeminiLoop({
            systemPrompt: correctivePrompt,
            toolDeclarations: [],
            toolHandlers,
            maxIterations: 2,
            runId: run.id,
            db,
          });
          if (corrective.finalJson.newFormula) {
            candidate = corrective.finalJson.newFormula;
            changelog = corrective.finalJson.formulaChangelog ?? changelog;
            verdict = validateFormulaUpdate(candidate, currentFormula);
          }
        } catch (e) {
          log.warn({ msg: 'corrective formula follow-up failed', runId: run.id, err: String(e) });
        }
      }

      if (verdict.ok) {
        const newVersion = (currentFormula?.version ?? 0) + 1;
        await insertFormulaVersion(db, {
          run_id: run.id,
          version: newVersion,
          content: candidate,
          changelog: changelog ?? `v${newVersion}: updated by ${kind} run`,
          parent_version: currentFormula?.version ?? null,
        });
        log.info({ msg: 'formula version inserted', version: newVersion, runId: run.id });
      } else {
        log.warn({ msg: 'formula update dropped — keeping previous version', runId: run.id, reason: verdict.reason });
        finalJson = {
          ...finalJson,
          summary: `${finalJson.summary} [formula update rejected: ${verdict.reason}]`,
        };
      }
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
