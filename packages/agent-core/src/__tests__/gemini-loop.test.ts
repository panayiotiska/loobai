import { describe, it, expect } from 'vitest';
import {
  sanitizeJsonBlock,
  computeLlmCostUsd,
  parseRunOutput,
  isTransientGeminiError,
  parseRetryDelayMs,
  pruneHistory,
} from '../gemini-loop.js';
import type { Content } from '@google/genai';

describe('sanitizeJsonBlock', () => {
  it('replaces bare undefined values with null so JSON.parse succeeds', () => {
    const raw = '{"summary": "ok", "newFormula": undefined, "confidenceInThesis": 0.5}';
    const out = sanitizeJsonBlock(raw);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out).newFormula).toBeNull();
  });

  it('strips trailing commas in objects and arrays', () => {
    const raw = '{"a": 1, "b": [1, 2, 3,],}';
    expect(JSON.parse(sanitizeJsonBlock(raw))).toEqual({ a: 1, b: [1, 2, 3] });
  });

  it('handles undefined inside arrays', () => {
    const raw = '{"x": [undefined], "y": [1, undefined]}';
    const parsed = JSON.parse(sanitizeJsonBlock(raw));
    expect(parsed.x).toEqual([null]);
    expect(parsed.y).toEqual([1, null]);
  });

  it('leaves well-formed JSON unchanged semantically', () => {
    const raw = '{"summary": "fine", "confidenceInThesis": 0.7, "nextRunFocus": "next"}';
    expect(JSON.parse(sanitizeJsonBlock(raw))).toEqual({
      summary: 'fine',
      confidenceInThesis: 0.7,
      nextRunFocus: 'next',
    });
  });
});

describe('computeLlmCostUsd', () => {
  it('returns 0 under the current free-tier model (Gemma 4 26B A4B-it)', () => {
    expect(computeLlmCostUsd(1_000_000, 1_000_000)).toBe(0);
    expect(computeLlmCostUsd(0, 0)).toBe(0);
  });
});

describe('parseRunOutput salvage', () => {
  it('keeps the summary when paperTradesOpened has wrong-shape entries', () => {
    // Regression: a real research run wrote a perfect summary but emitted
    // paperTradesOpened as array of objects instead of UUID strings. The
    // strict schema rejected everything. We now drop only the bad field.
    const text = '```json\n' + JSON.stringify({
      summary: 'A great analysis the agent worked hard on.',
      confidenceInThesis: 0.7,
      nextRunFocus: 'check funding rate',
      paperTradesOpened: [{ id: 'not-a-uuid', side: 'buy' }],
      paperTradesClosed: [],
      agentRequestsCreated: [],
    }) + '\n```';
    const out = parseRunOutput(text);
    expect(out.summary).toBe('A great analysis the agent worked hard on.');
    expect(out.confidenceInThesis).toBe(0.7);
    expect(out.paperTradesOpened).toEqual([]);
  });

  it('keeps valid UUIDs and drops invalid ones from array fields', () => {
    const valid = '11111111-1111-1111-1111-111111111111';
    const text = '```json\n' + JSON.stringify({
      summary: 'mixed array',
      confidenceInThesis: 0.4,
      nextRunFocus: 'x',
      paperTradesClosed: [valid, 'garbage', { id: 'bad' }, null],
    }) + '\n```';
    expect(parseRunOutput(text).paperTradesClosed).toEqual([valid]);
  });

  it('falls back to a prose synthesis when no usable JSON exists', () => {
    const text = 'The market is choppy today. BTC bounced off 78k support.';
    const out = parseRunOutput(text);
    expect(out.summary).toContain('synthesized from agent prose');
    expect(out.summary).toContain('market is choppy');
  });

  it('strips fences but keeps content in the prose fallback', () => {
    // Regression: a research run wrote 8765 chars entirely inside code fences;
    // the old fallback stripped fence contents wholesale and produced "no usable text".
    const text = '```markdown\nFull market report inside fences only.\n```';
    const out = parseRunOutput(text);
    expect(out.summary).toContain('Full market report inside fences only');
  });

  it('does not throw on totally malformed JSON in the fence', () => {
    const text = '```json\nthis is not even json\n```';
    expect(() => parseRunOutput(text)).not.toThrow();
  });

  it('coerces out-of-range confidence to the [0,1] interval', () => {
    const text = '```json\n' + JSON.stringify({
      summary: 'ok',
      confidenceInThesis: 5,
      nextRunFocus: 'x',
    }) + '\n```';
    expect(parseRunOutput(text).confidenceInThesis).toBe(1);
  });
});

describe('isTransientGeminiError', () => {
  it('classifies retryable HTTP statuses', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isTransientGeminiError({ status })).toBe(true);
    }
    for (const status of [400, 401, 403, 404]) {
      expect(isTransientGeminiError({ status })).toBe(false);
    }
  });

  it('classifies network-level errors by message', () => {
    expect(isTransientGeminiError(new Error('fetch failed'))).toBe(true);
    expect(isTransientGeminiError(new Error('read ECONNRESET'))).toBe(true);
    expect(isTransientGeminiError(new Error('socket hang up'))).toBe(true);
    expect(isTransientGeminiError(new Error('invalid api key'))).toBe(false);
  });

  it('falls back to the embedded JSON code when status is absent (ApiError shape)', () => {
    const apiError = new Error('{"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}');
    expect(isTransientGeminiError(apiError)).toBe(true);
    const badRequest = new Error('{"error":{"code":400,"message":"Invalid argument.","status":"INVALID_ARGUMENT"}}');
    expect(isTransientGeminiError(badRequest)).toBe(false);
  });
});

describe('parseRetryDelayMs', () => {
  it('parses the prose form ("Please retry in 7.774300322s")', () => {
    expect(parseRetryDelayMs(new Error('Quota exceeded. Please retry in 7.774300322s.'))).toBe(7775);
  });

  it('parses the RetryInfo JSON form ("retryDelay":"56s")', () => {
    expect(parseRetryDelayMs(new Error('{"details":[{"retryDelay":"56s"}]}'))).toBe(56000);
  });

  it('returns null when no delay is present', () => {
    expect(parseRetryDelayMs(new Error('Internal error'))).toBeNull();
  });
});

describe('pruneHistory', () => {
  const text = (role: 'user' | 'model', chars: number): Content => ({
    role,
    parts: [{ text: 'x'.repeat(chars) }],
  });
  const toolPair = (chars: number): Content[] => [
    { role: 'model', parts: [{ functionCall: { name: 'get_crypto_price', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'get_crypto_price', response: { result: 'y'.repeat(chars) } } }] },
  ];

  it('leaves small histories untouched', () => {
    const history = [text('user', 50), text('model', 50)];
    pruneHistory(history, 100_000);
    expect(history).toHaveLength(2);
  });

  it('drops oldest turns past the char budget, keeping the seed turn', () => {
    const seed = text('user', 20);
    const history = [seed, text('model', 5_000), text('user', 5_000), text('model', 5_000)];
    pruneHistory(history, 12_000);
    expect(history[0]).toBe(seed);
    expect(JSON.stringify(history).length).toBeLessThanOrEqual(12_000);
    expect(history.length).toBeGreaterThanOrEqual(3);
  });

  it('never leaves an orphaned functionResponse as the oldest non-seed turn', () => {
    const seed = text('user', 20);
    const history = [seed, ...toolPair(6_000), ...toolPair(6_000), text('model', 500)];
    pruneHistory(history, 10_000);
    const first = history[1];
    const parts = first.parts ?? [];
    expect(parts.length > 0 && parts.every((p) => p.functionResponse)).toBe(false);
  });

  it('enforces the entry cap', () => {
    const history: Content[] = [text('user', 10)];
    for (let i = 0; i < 40; i++) history.push(text(i % 2 ? 'user' : 'model', 10));
    pruneHistory(history, 1_000_000);
    expect(history.length).toBeLessThanOrEqual(24);
  });
});
