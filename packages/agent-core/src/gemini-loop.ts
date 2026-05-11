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
  rawText: string;
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
  // Accumulate text across every iteration: the model may emit the JSON block
  // alongside a tool call in an earlier turn, and overwriting on each iteration
  // would lose it.
  const allText: string[] = [];
  let naturalStop = false;

  for (let iteration = 0; iteration < input.maxIterations; iteration++) {
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
      allText.push(textParts.join(''));
    }

    // Add assistant turn to history
    history.push({ role: 'model', parts: candidate.content?.parts ?? [] });

    if (functionCalls.length === 0) {
      log.info({ msg: 'gemini loop complete — no more tool calls', runId: input.runId, iteration });
      naturalStop = true;
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
      const start = performance.now();
      let result: unknown;

      if (!handler) {
        result = { ok: false, error: `Unknown tool: ${name}` };
      } else {
        try {
          result = await handler((args ?? {}) as Record<string, unknown>);
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }

      const durationMs = Math.round(performance.now() - start);
      const resultObj = result as { ok?: boolean; data?: unknown; error?: string };
      const okFlag = resultObj.ok === true;

      log.info({ msg: 'tool result', runId: input.runId, tool: name, ok: okFlag, durationMs });

      if (input.db) {
        try {
          await insertToolCall(input.db, {
            run_id: input.runId,
            tool_name: name,
            args: args ?? {},
            ok: okFlag,
            result_summary: okFlag ? resultObj.data : null,
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

  // Search every iteration's text for a parseable RunOutput, newest first.
  let finalJson = tryParseFromTexts(allText);

  // If the loop exhausted its iteration budget on tool calls, or the model
  // produced text but no parseable JSON, give it one tool-free turn whose
  // sole job is to emit the RunOutput block. This is the common Gemma 4
  // failure mode where the model never reaches its "wrap up" phase.
  if (!finalJson) {
    log.warn({
      msg: 'no parseable RunOutput after loop; forcing JSON-only emission',
      runId: input.runId,
      naturalStop,
      iterations: input.maxIterations,
      accumulatedTextChars: allText.reduce((n, t) => n + t.length, 0),
    });

    const forcedText = await forceEmitJson(genai, input.systemPrompt, history, input.runId);
    if (forcedText) {
      allText.push(forcedText);
      finalJson = tryParseFromTexts([forcedText]);
    }
  }

  const rawText = allText.join('\n---\n');

  if (!finalJson) {
    log.warn({ msg: 'RunOutput parse failed after force-emit', runId: input.runId, rawText });
    finalJson = RunOutputSchema.parse({
      summary: `Agent completed but did not emit a valid JSON output block. Raw text length: ${rawText.length}`,
      confidenceInThesis: 0,
      nextRunFocus: 'Debug: agent must emit RunOutput JSON block at the end of response',
    });
  }

  return {
    finalJson,
    tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
    rawText,
  };

  async function forceEmitJson(
    client: GoogleGenAI,
    systemInstruction: string,
    chatHistory: Content[],
    runId: string,
  ): Promise<string> {
    const forcedHistory: Content[] = [
      ...chatHistory,
      {
        role: 'user',
        parts: [
          {
            text: 'Stop. You have used your tool budget. Emit ONLY the RunOutput JSON block exactly as specified in your output contract, wrapped in a ```json fenced code block. No prose before or after.',
          },
        ],
      },
    ];

    try {
      const response = await client.models.generateContent({
        model: GEMINI_MODEL,
        contents: forcedHistory,
        config: {
          systemInstruction,
          // tools intentionally omitted so the model cannot call another function.
          temperature: 0,
        },
      });
      totalInputTokens += response.usageMetadata?.promptTokenCount ?? 0;
      totalOutputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      return parts
        .filter((p) => p.text)
        .map((p) => p.text ?? '')
        .join('');
    } catch (e) {
      log.warn({ msg: 'force-emit JSON call failed', runId, err: String(e) });
      return '';
    }
  }
}

export function tryParseFromTexts(texts: readonly string[]): RunOutput | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    const parsed = tryParseRunOutput(texts[i]);
    if (parsed) return parsed;
  }
  return null;
}

export function tryParseRunOutput(text: string): RunOutput | null {
  if (!text) return null;

  // Try every fenced block (```json or bare ```), newest first. The model
  // sometimes adds prose after the JSON or uses an untagged fence.
  const fenceRegex = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  const fenced: string[] = [];
  for (const match of text.matchAll(fenceRegex)) {
    fenced.push(match[1].trim());
  }
  for (let i = fenced.length - 1; i >= 0; i--) {
    const candidate = fenced[i];
    const parsed = safeParseRunOutput(candidate);
    if (parsed) return parsed;
  }

  // Last resort: brace-match a JSON object containing "summary". The previous
  // greedy regex broke whenever any other '}' appeared inside the document.
  const obj = extractBalancedObjectContaining(text, '"summary"');
  if (obj) {
    const parsed = safeParseRunOutput(obj);
    if (parsed) return parsed;
  }

  return null;
}

function safeParseRunOutput(jsonText: string): RunOutput | null {
  try {
    const parsed = JSON.parse(jsonText);
    return RunOutputSchema.parse(parsed);
  } catch {
    return null;
  }
}

function extractBalancedObjectContaining(text: string, needle: string): string | null {
  const needleIdx = text.indexOf(needle);
  if (needleIdx < 0) return null;

  let openIdx = -1;
  for (let i = needleIdx; i >= 0; i--) {
    if (text[i] === '{') {
      openIdx = i;
      break;
    }
  }
  if (openIdx < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return null;
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
