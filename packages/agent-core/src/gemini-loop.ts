import { GoogleGenAI, type Content, type FunctionDeclaration } from '@google/genai';
import { type RunOutput } from '@loob/shared';
import { buildToolHandlers, type ToolHandler } from './tools/index.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { insertToolCall } from '@loob/db';
import pino from 'pino';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any>;

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const GEMINI_MODEL = 'gemma-4-26b-a4b-it';

// USD per 1M tokens. Gemma 4 26B A4B-it is on the Gemini API free tier (no per-token
// charge under the daily/RPM quotas). Kept as a table so a future paid model swap
// is just two numbers — update alongside GEMINI_MODEL above.
const MODEL_PRICES_USD_PER_M = {
  input: 0,
  output: 0,
};

export function computeLlmCostUsd(input: number, output: number): number {
  return (
    (input / 1_000_000) * MODEL_PRICES_USD_PER_M.input +
    (output / 1_000_000) * MODEL_PRICES_USD_PER_M.output
  );
}

// Per-tool, per-run call caps. Keeps a stuck agent from blowing through quotas.
const PER_RUN_TOOL_CAPS: Record<string, number> = {
  search_news: 6,
  get_crypto_price: 20,
  // v2 microstructure / regime tools — bounded so one mandatory pass survives but
  // the agent can't recurse on them forever.
  assess_market_regime: 2,
  get_funding_extremes: 3,
  get_orderbook_imbalance: 6,
  get_long_short_ratio: 6,
  get_liquidation_zones: 6,
  detect_manipulation_signals: 6,
  // v3: S3 breakout math — enough for a breadth pass over candidates.
  get_trend_signal: 8,
};
const DEFAULT_TOOL_CAP = 12;

// Keep history bounded — observed prod spike was 216k input tokens in one run.
const MAX_HISTORY_ENTRIES = 24;

// ---------------------------------------------------------------------------
// Free-tier input-token pacing.
//
// The Gemini API free tier caps gemma-4-26b at 16,000 INPUT tokens per model
// per minute (quotaId GenerateContentInputTokensPerModelPerMinute-FreeTier).
// Two consequences the loop must engineer around:
//   1. Two mid-size requests in the same minute exhaust the bucket → 429.
//   2. A single request whose prompt alone exceeds ~16k tokens can NEVER
//      succeed, no matter how long we back off.
// Observed 2026-07-20→22: FORMULA growth pushed the research base request to
// ~15.4k tokens and every research tick died on sustained 429s by iteration 2.
//
// Fix: (a) estimate each request's input tokens and wait until the trailing
// 60s window has room before firing; (b) prune history to a char budget so a
// single request always fits; (c) truncate oversized tool results.
// ---------------------------------------------------------------------------
const INPUT_TPM_LIMIT = 16_000;
/** Headroom for tokenizer-estimate error + the countTokens/actual gap. */
const INPUT_TPM_SAFETY = 800;
/** Measured on prod prompts: system prompt 3.60 chars/token, tool-decl JSON 3.98. */
const APPROX_CHARS_PER_TOKEN = 3.6;
/** Cap on the JSON of a single tool result entering model history (full result still goes to DB). */
const MAX_TOOL_RESULT_CHARS = 4_000;
/** Never squeeze the conversation below this many chars, even with a huge base prompt. */
const HISTORY_CHAR_FLOOR = 8_000;

export function approxTokens(chars: number): number {
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
}

// Sliding 60s window of input tokens sent to the model. Module-level on
// purpose: one tick process makes several runGeminiLoop calls (main loop,
// trade nudge, formula wrap-up, corrective follow-up) and they all share the
// same per-minute bucket.
const sentTokenWindow: Array<{ at: number; tokens: number }> = [];

function tokensInWindow(now: number): number {
  while (sentTokenWindow.length > 0 && now - sentTokenWindow[0].at > 60_000) {
    sentTokenWindow.shift();
  }
  return sentTokenWindow.reduce((sum, e) => sum + e.tokens, 0);
}

function recordSentTokens(tokens: number): void {
  sentTokenWindow.push({ at: Date.now(), tokens });
}

async function waitForTokenBudget(
  estimate: number,
  ctx: { runId: string; phase: string },
): Promise<void> {
  // An estimate at/over the whole budget can never "fit" — the best we can do
  // is fire it into an empty window (the estimate is conservative; the real
  // request is usually smaller). Without this clamp the wait would never end.
  const needed = Math.min(estimate, INPUT_TPM_LIMIT - INPUT_TPM_SAFETY);
  for (;;) {
    const now = Date.now();
    const used = tokensInWindow(now);
    if (used + needed <= INPUT_TPM_LIMIT - INPUT_TPM_SAFETY) return;
    const waitMs = Math.max(
      sentTokenWindow.length > 0 ? sentTokenWindow[0].at + 61_000 - now : 61_000,
      1_000,
    );
    log.info({
      msg: 'input-TPM pacing: waiting for token budget',
      runId: ctx.runId,
      phase: ctx.phase,
      windowTokens: used,
      nextRequestEstimate: needed,
      waitMs,
    });
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

function estimateHistoryChars(history: Content[]): number {
  return JSON.stringify(history).length;
}

function estimateRequestTokens(systemPromptChars: number, declsChars: number, history: Content[]): number {
  return approxTokens(systemPromptChars + declsChars + estimateHistoryChars(history)) + 100;
}

// Transient upstream failures worth retrying (and, for monitor ticks, degrading
// on): retryable HTTP statuses plus node-level network errors. @google/genai's
// ApiError carries .status; when absent (network layer) fall back to message
// sniffing, including the JSON body some ApiErrors embed the code in.
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_MESSAGE_RE =
  /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|UND_ERR|terminated|aborted/i;

export function isTransientGeminiError(e: unknown): boolean {
  const status = (e as { status?: number }).status;
  if (typeof status === 'number') return TRANSIENT_STATUSES.has(status);
  const msg = e instanceof Error ? `${e.message} ${String(e.cause ?? '')}` : String(e);
  if (TRANSIENT_MESSAGE_RE.test(msg)) return true;
  const embedded = msg.match(/"code"\s*:\s*(\d{3})/);
  return embedded ? TRANSIENT_STATUSES.has(Number(embedded[1])) : false;
}

// 5 attempts spanning ~3.6min + jitter. The old 3-attempt/45s window was
// shorter than a routine Gemini blip — observed 2026-06-10T23:39Z: 500s
// outlasted all retries and failed a monitor tick.
const RETRY_DELAYS_MS = [10_000, 25_000, 60_000, 120_000];

// 429 quota errors carry an explicit RetryInfo delay ("Please retry in 7.7s" /
// retryDelay:"56s"). Waiting exactly that (plus margin) beats the blind ladder.
export function parseRetryDelayMs(e: unknown): number | null {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/retry in (\d+(?:\.\d+)?)\s*s/i) ?? msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.ceil(Number(m[1]) * 1000) : null;
}

function isQuotaError(e: unknown): boolean {
  if ((e as { status?: number }).status === 429) return true;
  return /RESOURCE_EXHAUSTED|"code"\s*:\s*429/.test(e instanceof Error ? e.message : String(e));
}

interface RetryContext {
  runId: string;
  phase: string;
  /** Estimated input tokens of the request — reserved in the TPM window before every attempt. */
  estimateTokens?: number;
}

async function generateWithRetry<T extends { usageMetadata?: { promptTokenCount?: number } } | void>(
  call: () => Promise<T>,
  ctx: RetryContext,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (ctx.estimateTokens) await waitForTokenBudget(ctx.estimateTokens, ctx);
    try {
      const result = await call();
      const actual = (result as { usageMetadata?: { promptTokenCount?: number } } | undefined)
        ?.usageMetadata?.promptTokenCount;
      recordSentTokens(actual ?? ctx.estimateTokens ?? 0);
      return result;
    } catch (e) {
      if (attempt >= RETRY_DELAYS_MS.length || !isTransientGeminiError(e)) throw e;
      // Quota 429s: assume the failed attempt still burned the window and honor
      // the server's own retry delay if it is longer than our ladder.
      const quota = isQuotaError(e);
      if (quota && ctx.estimateTokens) recordSentTokens(ctx.estimateTokens);
      const serverDelay = quota ? parseRetryDelayMs(e) : null;
      const delay =
        Math.max(RETRY_DELAYS_MS[attempt], serverDelay !== null ? serverDelay + 3_000 : 0) +
        Math.floor(Math.random() * 5000);
      log.warn({
        msg: 'gemini transient error, retrying',
        runId: ctx.runId,
        phase: ctx.phase,
        attempt,
        delay,
        quota,
        err: String(e).slice(0, 300),
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export interface GeminiLoopInput {
  systemPrompt: string;
  toolDeclarations: FunctionDeclaration[];
  toolHandlers: Record<string, ToolHandler>;
  maxIterations: number;
  runId: string;
  /** Optional — when provided, every tool call is persisted to the tool_calls table. */
  db?: DB;
  /**
   * Research-only. When true and the loop is about to end without a single
   * successful `paper_trade_open` this run, inject ONE explicit decision turn
   * (tools still enabled) demanding the agent either open its best scout-tier
   * candidate or skip-with-trigger. Without this, weak models reliably trail
   * off into prose after the breadth scans and never even attempt a trade —
   * observed in 12/12 consecutive prod research runs (zero open positions ever).
   */
  enforceTradeDecision?: boolean;
}

// Injected once, when a research run is about to end with zero trades opened.
// Keeps history + tools intact so the model can actually call paper_trade_open.
const TRADE_DECISION_NUDGE =
  'You are about to end this run without opening a position. Make an EXPLICIT decision now — and note that ' +
  'BOTH outcomes are equally valid runs:\n' +
  '- If your best candidate genuinely fits a setup (S1_funding_squeeze / S2_carry_harvest / S3_trend_breakout, code-verified) ' +
  'and clears the scout bar (confidence ≥ 0.55, ≥1 confirming signal, three-perspective views, concrete invalidation_signal), ' +
  'call `paper_trade_open` NOW.\n' +
  '- If NO candidate fits a setup, SKIP: emit the RunOutput JSON whose nextRunFocus names the exact observable that would create one ' +
  '(e.g. "any perp funding ≤ −30% annualized" or "BTC daily close above prior 20d high on ≥1.25× volume").\n' +
  'Do NOT open a D_discretionary trade merely to satisfy this prompt — a forced trade in a setup-less market is how mid-June bled fees ' +
  '(anti-pattern AP-6). When the market offers no setup, the correct position size is zero, and saying so with a concrete trigger IS a successful run.\n' +
  'Do not narrate or analyze further. Your next action must be either a paper_trade_open call or the final fenced json RunOutput block.';

export interface GeminiLoopResult {
  finalJson: RunOutput;
  tokenUsage: { input: number; output: number };
  costUsd: number;
  rawText: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

// Prune oldest turns (keeping the seed user turn) until the history fits both
// the entry cap and the char budget derived from the TPM limit. Removal is
// pair-aware: a user turn holding only functionResponse parts must never
// become the oldest survivor without its preceding model functionCall turn.
export function pruneHistory(history: Content[], charBudget: number): void {
  const dropOldest = () => {
    history.splice(1, 1);
    while (
      history.length > 2 &&
      history[1].role === 'user' &&
      (history[1].parts ?? []).length > 0 &&
      (history[1].parts ?? []).every((p) => p.functionResponse)
    ) {
      history.splice(1, 1);
    }
  };
  while (history.length > MAX_HISTORY_ENTRIES) dropOldest();
  while (history.length > 3 && estimateHistoryChars(history) > charBudget) dropOldest();
}

export async function runGeminiLoop(input: GeminiLoopInput): Promise<GeminiLoopResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');

  const genai = new GoogleGenAI({ apiKey });

  const SEED_TEXT = 'Begin your analysis. Use tools as needed, then emit the RunOutput JSON block.';
  const history: Content[] = [{ role: 'user', parts: [{ text: SEED_TEXT }] }];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalText = '';

  // Per-run tool dedupe + cap state. Reset every run, never cross-run.
  const toolCache = new Map<string, unknown>();
  const toolCallCount = new Map<string, number>();

  // Trade-decision enforcement state (research only).
  let paperTradeOpenedThisRun = false;
  let tradeDecisionNudged = false;

  // Char budget for conversation history: whatever the TPM soft cap leaves
  // after the fixed base (system prompt + tool declarations), floored so the
  // loop still functions if the base prompt is bloated (with a loud warning).
  const declsChars = JSON.stringify(input.toolDeclarations).length;
  const baseTokens = approxTokens(input.systemPrompt.length + declsChars) + 100;
  const budgetChars = (INPUT_TPM_LIMIT - INPUT_TPM_SAFETY - baseTokens) * APPROX_CHARS_PER_TOKEN;
  const historyCharBudget = Math.max(budgetChars, HISTORY_CHAR_FLOOR);
  if (budgetChars < HISTORY_CHAR_FLOOR) {
    log.warn({
      msg: 'base prompt leaves too little history budget under the input-TPM limit — requests may 429',
      runId: input.runId,
      baseTokens,
      systemPromptChars: input.systemPrompt.length,
      declsChars,
    });
  }

  for (let iteration = 0; iteration < input.maxIterations; iteration++) {
    pruneHistory(history, historyCharBudget);

    // Anti-amnesia ledger: pruning can drop early tool results (the startup
    // ritual), and the model then re-runs the ritual from scratch — observed
    // burning 9 of 18 iterations on cached read_lessons_learned /
    // get_portfolio_stats loops. Keep a compact record of what already ran in
    // the always-surviving seed turn.
    if (toolCallCount.size > 0) {
      const ledger = [...toolCallCount.entries()].map(([n, c]) => `${n}(×${c})`).join(', ');
      history[0] = {
        role: 'user',
        parts: [
          {
            text:
              `${SEED_TEXT}\n\n[Auto-maintained context ledger — older turns are compacted to fit the per-minute token quota] ` +
              `Tools ALREADY CALLED this run: ${ledger}. You have already seen their results — calling them again with the same args ` +
              `returns an identical cached copy and wastes an iteration. Move on to the NEXT phase of your workflow.`,
          },
        ],
      };
    }

    log.info({ msg: 'gemini iteration', runId: input.runId, iteration });

    const response = await generateWithRetry(
      () =>
        genai.models.generateContent({
          model: GEMINI_MODEL,
          contents: history,
          config: {
            systemInstruction: input.systemPrompt,
            tools: [{ functionDeclarations: input.toolDeclarations }],
            temperature: 0.7,
          },
        }),
      {
        runId: input.runId,
        phase: 'tool-loop',
        estimateTokens: estimateRequestTokens(input.systemPrompt.length, declsChars, history),
      },
    );

    totalInputTokens += response.usageMetadata?.promptTokenCount ?? 0;
    totalOutputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;

    const candidate = response.candidates?.[0];
    if (!candidate) throw new Error('No candidate in Gemini response');

    const parts = candidate.content?.parts ?? [];
    const textParts = parts.filter((p) => p.text).map((p) => p.text ?? '');
    const functionCalls = parts.filter((p) => p.functionCall);

    if (textParts.length > 0) {
      finalText = textParts.join('');
    }

    // Add assistant turn to history
    history.push({ role: 'model', parts: candidate.content?.parts ?? [] });

    if (functionCalls.length === 0) {
      // The model thinks it's done. If this is a research run and it never
      // actually opened a position, give it ONE explicit decision turn (tools
      // still enabled) before letting it finish. This is the fix for the
      // "researches then trails off, opens nothing" prod failure mode.
      if (input.enforceTradeDecision && !tradeDecisionNudged && !paperTradeOpenedThisRun) {
        log.info({ msg: 'no trade opened — injecting trade-decision nudge', runId: input.runId, iteration });
        tradeDecisionNudged = true;
        history.push({ role: 'user', parts: [{ text: TRADE_DECISION_NUDGE }] });
        continue;
      }
      log.info({ msg: 'gemini loop complete — no more tool calls', runId: input.runId, iteration });
      break;
    }

    // Execute all function calls and collect results
    const toolResultParts: Content['parts'] = [];

    for (const part of functionCalls) {
      if (!part.functionCall) continue;
      const { name, args } = part.functionCall;
      if (!name) continue;

      log.info({ msg: 'tool call', runId: input.runId, tool: name });

      const handler = input.toolHandlers[name];
      const cacheKey = `${name}:${stableStringify(args ?? {})}`;
      const cap = PER_RUN_TOOL_CAPS[name] ?? DEFAULT_TOOL_CAP;
      const callsSoFar = toolCallCount.get(name) ?? 0;
      let cached = false;
      let capped = false;

      const start = performance.now();
      let result: unknown;

      if (!handler) {
        // Self-describing error: the model previously read "Unknown tool" as an
        // infrastructure outage and halted the whole strategy in FORMULA.
        result = {
          ok: false,
          error: `Tool '${name}' is not available in this turn. This is NOT an infrastructure failure — do not halt the strategy or record a tooling-failure lesson. Continue with the information you already have.`,
        };
      } else if (toolCache.has(cacheKey)) {
        result = toolCache.get(cacheKey);
        cached = true;
      } else if (callsSoFar >= cap) {
        result = {
          ok: false,
          error: `rate-capped-this-run: ${name} already called ${callsSoFar}/${cap} times in this run. Use the prior results or pick a different approach.`,
        };
        capped = true;
      } else {
        try {
          result = await handler((args ?? {}) as Record<string, unknown>);
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        toolCallCount.set(name, callsSoFar + 1);
        toolCache.set(cacheKey, result);
      }

      const durationMs = Math.round(performance.now() - start);
      const resultObj = result as { ok?: boolean; data?: unknown; error?: string };
      const okFlag = resultObj.ok === true;

      if (name === 'paper_trade_open' && okFlag) paperTradeOpenedThisRun = true;

      log.info({ msg: 'tool result', runId: input.runId, tool: name, ok: okFlag, durationMs, cached, capped });

      if (input.db) {
        try {
          await insertToolCall(input.db, {
            run_id: input.runId,
            tool_name: name,
            args: args ?? {},
            ok: okFlag,
            result_summary: okFlag
              ? cached
                ? { cached: true, data: resultObj.data }
                : resultObj.data
              : null,
            error: okFlag ? null : resultObj.error ?? null,
            duration_ms: durationMs,
          });
        } catch (e) {
          // Logging failures must not break the agent run.
          log.warn({ msg: 'tool-call log persist failed', runId: input.runId, tool: name, err: String(e) });
        }
      }

      // Truncate oversized results before they enter model history — the full
      // result is already persisted to tool_calls above. A single 20k-char
      // orderbook dump would eat the whole per-minute input-token budget.
      let resultJson = JSON.stringify(result);
      if (resultJson.length > MAX_TOOL_RESULT_CHARS) {
        const dropped = resultJson.length - MAX_TOOL_RESULT_CHARS;
        resultJson =
          resultJson.slice(0, MAX_TOOL_RESULT_CHARS) +
          ` …[result truncated: ${dropped} chars omitted — call again with narrower args if you need the tail]`;
      }

      toolResultParts.push({
        functionResponse: {
          name,
          response: { result: resultJson },
        },
      });
    }

    history.push({ role: 'user', parts: toolResultParts });
  }

  // If the iteration loop exhausted while the agent was still calling tools,
  // it never got a turn to write its summary JSON. Force one no-tool wrap-up
  // call so we get a real RunOutput instead of the empty-text fallback.
  //
  // The check actually attempts a parse: a loose regex check was fooled when
  // the agent's response contained quoted backticks from echoing the prompt.
  if (!hasParseableJsonBlock(finalText)) {
    log.info({ msg: 'forcing wrap-up call — no parseable JSON block in agent output', runId: input.runId });
    // The directive intentionally avoids triple-backtick characters so the
    // model can't accidentally echo them back into its response and confuse
    // the parser. We describe the fence by name only.
    history.push({
      role: 'user',
      parts: [
        {
          text:
            'Iteration budget reached. Stop calling tools. ' +
            'Now write ONLY one valid JSON object matching the RunOutput schema described in the system prompt. ' +
            'Wrap it in a fenced json code block (open fence is three backticks immediately followed by the lowercase word json on the same line; close fence is three backticks on a line by itself). ' +
            'Nothing else after the close fence. No prose, no markdown headers, no analysis — just the fenced JSON block.',
        },
      ],
    });

    pruneHistory(history, historyCharBudget);
    const wrapupResponse = await generateWithRetry(
      () =>
        genai.models.generateContent({
          model: GEMINI_MODEL,
          contents: history,
          config: {
            systemInstruction: input.systemPrompt,
            // No tools — force a text-only response.
            temperature: 0.3,
          },
        }),
      {
        runId: input.runId,
        phase: 'wrap-up',
        estimateTokens: estimateRequestTokens(input.systemPrompt.length, 0, history),
      },
    );
    if (wrapupResponse) {
      totalInputTokens += wrapupResponse.usageMetadata?.promptTokenCount ?? 0;
      totalOutputTokens += wrapupResponse.usageMetadata?.candidatesTokenCount ?? 0;
      const wrapupText = (wrapupResponse.candidates?.[0]?.content?.parts ?? [])
        .filter((p) => p.text)
        .map((p) => p.text ?? '')
        .join('');
      if (wrapupText) finalText = wrapupText;
    }
  }

  const finalJson = parseRunOutput(finalText);

  return {
    finalJson,
    tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
    costUsd: computeLlmCostUsd(totalInputTokens, totalOutputTokens),
    rawText: finalText,
  };
}

// Gemini occasionally emits `undefined` literals, trailing commas, or wraps strings in
// smart quotes — none of which are valid JSON. Repair the most common patterns in place.
export function sanitizeJsonBlock(raw: string): string {
  return (
    raw
      .trim()
      // Bare `undefined` in value position → `null`.
      .replace(/:\s*undefined\b/g, ': null')
      .replace(/\[\s*undefined\s*\]/g, '[null]')
      .replace(/,\s*undefined\b/g, ', null')
      // Trailing commas in objects/arrays.
      .replace(/,(\s*[}\]])/g, '$1')
  );
}

// Cheap "did the agent emit something parseable" check used to decide whether
// to fire the wrap-up turn. Uses coerceToRunOutput so we don't re-fire wrap-up
// on outputs parseRunOutput would already salvage.
function hasParseableJsonBlock(text: string): boolean {
  const m = text.match(/```json\s*([\s\S]*?)```\s*$/);
  if (!m) return false;
  try {
    const parsed = JSON.parse(sanitizeJsonBlock(m[1]));
    return coerceToRunOutput(parsed) !== null;
  } catch {
    return false;
  }
}

// Coerce a loosely-parsed object into the RunOutput shape, discarding any field
// the agent got wrong rather than failing the whole parse. Strict validation
// over a 5000-token analysis because one array contained objects instead of
// UUID strings is exactly the kind of failure mode we want to engineer around.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function coerceToRunOutput(parsed: any): RunOutput | null {
  if (!parsed || typeof parsed !== 'object') return null;

  const summary = typeof parsed.summary === 'string' ? parsed.summary.slice(0, 2000) : null;
  if (!summary) return null;

  const confidenceRaw = Number(parsed.confidenceInThesis);
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0.5;

  const nextRunFocus =
    typeof parsed.nextRunFocus === 'string' ? parsed.nextRunFocus.slice(0, 500) : 'No focus emitted.';

  // Array fields must be arrays of UUID strings. Anything else → drop to [].
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const coerceUuidArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && uuidRe.test(x)) : [];

  const newFormula = typeof parsed.newFormula === 'string' && parsed.newFormula.length > 0 ? parsed.newFormula : undefined;
  const formulaChangelog =
    newFormula && typeof parsed.formulaChangelog === 'string' ? parsed.formulaChangelog : undefined;

  return {
    summary,
    newFormula,
    formulaChangelog,
    paperTradesOpened: coerceUuidArray(parsed.paperTradesOpened),
    paperTradesClosed: coerceUuidArray(parsed.paperTradesClosed),
    agentRequestsCreated: coerceUuidArray(parsed.agentRequestsCreated),
    confidenceInThesis: confidence,
    nextRunFocus,
  };
}

export function parseRunOutput(text: string): RunOutput {
  // Try every plausible JSON location, in order of preference, and accept the
  // first one that parses + has a usable summary. Strict validation lives
  // in coerceToRunOutput which salvages bad sub-fields without dropping the run.
  const candidates: string[] = [];
  const fencedAtEnd = text.match(/```json\s*([\s\S]*?)```\s*$/);
  if (fencedAtEnd) candidates.push(fencedAtEnd[1]);
  // Any fenced json block anywhere (in case the agent appended prose after).
  for (const m of text.matchAll(/```json\s*([\s\S]*?)```/g)) candidates.push(m[1]);
  // Bare JSON object containing summary + confidenceInThesis.
  const bare = text.match(/\{[\s\S]*?"summary"[\s\S]*?"confidenceInThesis"[\s\S]*?\}/);
  if (bare) candidates.push(bare[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(sanitizeJsonBlock(candidate));
      const coerced = coerceToRunOutput(parsed);
      if (coerced) return coerced;
    } catch {
      /* try next candidate */
    }
  }

  // No usable JSON at all. Build a synthesized summary from the prose. Keep
  // code-block CONTENTS this time (just strip the fence markers) so a response
  // that's entirely inside fences still surfaces its text.
  const preview = text
    .replace(/```(?:json|markdown|md)?\s*/g, '')
    .replace(/```/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);
  log.warn({ msg: 'no usable RunOutput JSON found — using synthesized prose summary', preview_len: preview.length, raw_len: text.length });
  return {
    summary: preview
      ? `[synthesized from agent prose — JSON emit failed] ${preview}`
      : `Agent completed but emitted neither valid JSON nor any text. Raw length: ${text.length}.`,
    paperTradesOpened: [],
    paperTradesClosed: [],
    agentRequestsCreated: [],
    confidenceInThesis: 0.3,
    nextRunFocus: 'Investigate: agent failed to emit a parseable RunOutput JSON block.',
  };
}

export function createGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');
  return new GoogleGenAI({ apiKey });
}

export function buildToolHandlersForRun(db: DB, runId: string): ReturnType<typeof buildToolHandlers> {
  const genai = createGeminiClient();
  return buildToolHandlers(db, genai, runId);
}
