import { describe, it, expect } from 'vitest';
import { sanitizeJsonBlock, computeLlmCostUsd, parseRunOutput } from '../gemini-loop.js';

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
