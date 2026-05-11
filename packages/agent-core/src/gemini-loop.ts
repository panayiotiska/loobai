import { GoogleGenAI, type Content, type FunctionDeclaration } from '@google/genai';
import { RunOutputSchema, type RunOutput } from '@loob/shared';
import { buildToolHandlers, type ToolHandler } from './tools/index.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import pino from 'pino';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any>;

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const GEMINI_MODEL = 'gemma-4-31b-it';

export interface GeminiLoopInput {
  systemPrompt: string;
  toolDeclarations: FunctionDeclaration[];
  toolHandlers: Record<string, ToolHandler>;
  maxIterations: number;
  runId: string;
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
  let finalText = '';

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
        if ((status === 503 || status === 429) && attempt < 2) {
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

      log.info({ msg: 'tool result', runId: input.runId, tool: name, ok: (result as { ok?: boolean }).ok });

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
    rawText: finalText,
  };
}

function parseRunOutput(text: string): RunOutput {
  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```\s*$/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1].trim());
      return RunOutputSchema.parse(parsed);
    } catch (e) {
      throw new Error(`Failed to parse RunOutput JSON block: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Fallback: try to find any JSON object containing the required fields
  const jsonMatch = text.match(/\{[\s\S]*"summary"[\s\S]*"confidenceInThesis"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
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
