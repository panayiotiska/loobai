import { describe, it, expect } from 'vitest';
import { sanitizeJsonBlock, computeLlmCostUsd } from '../gemini-loop.js';

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
