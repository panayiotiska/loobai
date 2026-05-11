import { describe, it, expect } from 'vitest';
import { tryParseRunOutput, tryParseFromTexts } from '../gemini-loop.js';

const VALID_PAYLOAD = {
  summary: 'all good',
  paperTradesOpened: [],
  paperTradesClosed: [],
  agentRequestsCreated: [],
  confidenceInThesis: 0.5,
  nextRunFocus: 'watch BTC funding',
};

describe('tryParseRunOutput', () => {
  it('parses a fenced ```json block at the end of the response', () => {
    const text = `Some analysis prose.\n\n\`\`\`json\n${JSON.stringify(VALID_PAYLOAD)}\n\`\`\``;
    const parsed = tryParseRunOutput(text);
    expect(parsed?.summary).toBe('all good');
    expect(parsed?.confidenceInThesis).toBe(0.5);
  });

  it('parses a fenced block even when there is trailing prose after it', () => {
    const text = `Intro.\n\`\`\`json\n${JSON.stringify(VALID_PAYLOAD)}\n\`\`\`\n\nHope this helps!`;
    expect(tryParseRunOutput(text)?.summary).toBe('all good');
  });

  it('parses a bare ``` fenced block (no json tag)', () => {
    const text = `\`\`\`\n${JSON.stringify(VALID_PAYLOAD)}\n\`\`\``;
    expect(tryParseRunOutput(text)?.summary).toBe('all good');
  });

  it('picks the last fenced JSON block when multiple are present', () => {
    const earlier = { ...VALID_PAYLOAD, summary: 'earlier' };
    const final = { ...VALID_PAYLOAD, summary: 'final' };
    const text = `\`\`\`json\n${JSON.stringify(earlier)}\n\`\`\`\n\nthen\n\n\`\`\`json\n${JSON.stringify(final)}\n\`\`\``;
    expect(tryParseRunOutput(text)?.summary).toBe('final');
  });

  it('falls back to brace-matched object containing "summary" when not fenced', () => {
    const text = `Here is the result: ${JSON.stringify(VALID_PAYLOAD)} done.`;
    expect(tryParseRunOutput(text)?.summary).toBe('all good');
  });

  it('handles a brace-matched object containing nested braces (newFormula markdown)', () => {
    const payload = {
      ...VALID_PAYLOAD,
      newFormula: '# Formula\n\n```js\nconst x = { foo: 1 };\n```',
      formulaChangelog: 'v2',
    };
    const text = `prose ${JSON.stringify(payload)} more prose`;
    const parsed = tryParseRunOutput(text);
    expect(parsed?.newFormula).toContain('{ foo: 1 }');
  });

  it('returns null on bad JSON inside a fenced block (does not throw)', () => {
    const text = '```json\n{ not valid json\n```';
    expect(tryParseRunOutput(text)).toBeNull();
  });

  it('returns null when no JSON output is present', () => {
    expect(tryParseRunOutput('Let me check the open positions.')).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(tryParseRunOutput('')).toBeNull();
  });

  it('falls back to a later fenced block if the first one is malformed', () => {
    const bad = '```json\n{ broken\n```';
    const good = `\`\`\`json\n${JSON.stringify(VALID_PAYLOAD)}\n\`\`\``;
    expect(tryParseRunOutput(`${bad}\n${good}`)?.summary).toBe('all good');
  });
});

describe('tryParseFromTexts', () => {
  it('searches texts newest first', () => {
    const earlier = { ...VALID_PAYLOAD, summary: 'earlier' };
    const final = { ...VALID_PAYLOAD, summary: 'final' };
    const texts = [
      `\`\`\`json\n${JSON.stringify(earlier)}\n\`\`\``,
      'plain rationale text',
      `\`\`\`json\n${JSON.stringify(final)}\n\`\`\``,
    ];
    expect(tryParseFromTexts(texts)?.summary).toBe('final');
  });

  it('falls back to an earlier text when the latest has no JSON', () => {
    const earlier = { ...VALID_PAYLOAD, summary: 'earlier' };
    const texts = [
      `\`\`\`json\n${JSON.stringify(earlier)}\n\`\`\``,
      'just tool-call rationale, no JSON here',
    ];
    expect(tryParseFromTexts(texts)?.summary).toBe('earlier');
  });

  it('returns null when no text contains a parseable RunOutput', () => {
    expect(tryParseFromTexts(['a', 'b', 'c'])).toBeNull();
  });

  it('returns null on empty list', () => {
    expect(tryParseFromTexts([])).toBeNull();
  });
});
