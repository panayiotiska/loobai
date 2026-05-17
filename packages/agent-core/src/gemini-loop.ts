import { GoogleGenAI, type Content, type FunctionDeclaration } from '@google/genai';
import { RunOutputSchema, type RunOutput } from '@loob/shared';
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
};
const DEFAULT_TOOL_CAP = 12;

// Keep history bounded — observed prod spike was 216k input tokens in one run.
const MAX_HISTORY_ENTRIES = 24;

export interface GeminiLoopInput {
  systemPrompt: string;
  toolDeclarations: FunctionDeclaration[];
  toolHandlers: Record<string, ToolHandler>;
  maxIterations: number;
  runId: string;
  /** Optional — when provided, every tool call is persisted to the tool_calls table. */
  db?: DB;
}

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

function pruneHistory(history: Content[]): void {
  if (history.length <= MAX_HISTORY_ENTRIES) return;
  // Keep the first (initial user turn) and the last MAX-1 entries.
  const keepFromEnd = MAX_HISTORY_ENTRIES - 1;
  const tail = history.splice(history.length - keepFromEnd, keepFromEnd);
  history.splice(1, history.length - 1, ...tail);
}

export async function runGeminiLoop(input: GeminiLoopInput): Promise<GeminiLoopResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');

  const genai = new GoogleGenAI({ apiKey });

  const history: Content[] = [
    {
      role: 'user',
      parts: [{ text: 'Begin your analysis. Use tools as needed, then emit the RunOutput JSON block.' }],
    },
  ];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalText = '';

  // Per-run tool dedupe + cap state. Reset every run, never cross-run.
  const toolCache = new Map<string, unknown>();
  const toolCallCount = new Map<string, number>();

  for (let iteration = 0; iteration < input.maxIterations; iteration++) {
    pruneHistory(history);
    log.info({ msg: 'gemini iteration', runId: input.runId, iteration });

    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await genai.models.generateContent({
          model: GEMINI_MODEL,
          contents: history,
          config: {
            systemInstruction: input.systemPrompt,
            tools: [{ functionDeclarations: input.toolDeclarations }],
            temperature: 0.7,
          },
        });
        break;
      } catch (e) {
        const status = (e as { status?: number }).status;
        if ((status === 503 || status === 500 || status === 429) && attempt < 2) {
          const delay = (attempt + 1) * 15000;
          log.warn({ msg: 'gemini transient error, retrying', runId: input.runId, attempt, status, delay });
          await new Promise((r) => setTimeout(r, delay));
        } else {
          throw e;
        }
      }
    }
    if (!response) throw new Error('Gemini request failed after retries');

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
        result = { ok: false, error: `Unknown tool: ${name}` };
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

      toolResultParts.push({
        functionResponse: {
          name,
          response: { result: JSON.stringify(result) },
        },
      });
    }

    history.push({ role: 'user', parts: toolResultParts });
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

function parseRunOutput(text: string): RunOutput {
  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```\s*$/);
  if (jsonBlockMatch) {
    const raw = sanitizeJsonBlock(jsonBlockMatch[1]);
    try {
      const parsed = JSON.parse(raw);
      // If the agent wrote a changelog but no formula, downgrade to a no-op rather than fail.
      if (parsed && typeof parsed === 'object' && parsed.formulaChangelog && !parsed.newFormula) {
        log.warn({ msg: 'changelog without newFormula — dropping changelog', changelog: String(parsed.formulaChangelog).slice(0, 120) });
        delete parsed.formulaChangelog;
      }
      return RunOutputSchema.parse(parsed);
    } catch (e) {
      throw new Error(
        `Failed to parse RunOutput JSON block: ${e instanceof Error ? e.message : String(e)} | raw_preview=${raw.slice(0, 400)}`,
      );
    }
  }

  // Fallback: try to find any JSON object containing the required fields
  const jsonMatch = text.match(/\{[\s\S]*"summary"[\s\S]*"confidenceInThesis"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(sanitizeJsonBlock(jsonMatch[0]));
      return RunOutputSchema.parse(parsed);
    } catch {}
  }

  return RunOutputSchema.parse({
    summary: `Agent completed but did not emit a valid JSON output block. Raw text length: ${text.length}`,
    confidenceInThesis: 0,
    nextRunFocus: 'Debug: agent must emit RunOutput JSON block at the end of response',
  });
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
