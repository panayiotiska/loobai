import { describe, it, expect } from 'vitest';
import { validateFormulaUpdate, FORMULA_MIN_CHARS, FORMULA_MAX_CHARS } from '@loob/shared';

const SECTION_BODIES: Record<string, string> = {
  '## Setups': 'S1 funding squeeze: long crypto at annualized funding ≤ −30% with confirms.',
  '## Hypotheses': 'H70: S2 carry harvest has positive expectancy after doubled fees.',
  '## Anti-pattern log': 'AP-6: marginal-funding churn at −13% bled fees for weeks.',
  '## Recent lessons': 'L-2026-06-30: strategy memory is the most valuable asset; guard it.',
};

function validDoc(minChars = FORMULA_MIN_CHARS + 500): string {
  const base = Object.entries(SECTION_BODIES)
    .map(([h, b]) => `${h}\n${b}`)
    .join('\n\n');
  const padding = '\nFiller analysis line to reach the minimum document length.'.repeat(
    Math.ceil(Math.max(0, minChars - base.length) / 58),
  );
  return `# Strategy v3\n\n${base}\n${padding}`;
}

describe('validateFormulaUpdate', () => {
  it('rejects the literal v117 wipe payload ("...")', () => {
    const v = validateFormulaUpdate('...', { content: validDoc() });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/3 chars/);
    expect(v.reason).toMatch(/COMPLETE document/);
  });

  it('rejects empty and whitespace-only content', () => {
    expect(validateFormulaUpdate('', null).ok).toBe(false);
    expect(validateFormulaUpdate('   \n  ', null).ok).toBe(false);
  });

  it('accepts a complete document (bootstrap, no previous)', () => {
    expect(validateFormulaUpdate(validDoc(), null).ok).toBe(true);
  });

  it('rejects when any required section is missing, naming it', () => {
    for (const missing of Object.keys(SECTION_BODIES)) {
      const doc = Object.entries(SECTION_BODIES)
        .filter(([h]) => h !== missing)
        .map(([h, b]) => `${h}\n${b}`)
        .join('\n\n');
      const padded = `# Strategy\n\n${doc}\n${'filler line for length padding here\n'.repeat(60)}`;
      const v = validateFormulaUpdate(padded, null);
      expect(v.ok).toBe(false);
      expect(v.reason).toContain(missing);
    }
  });

  it('accepts section header variants (### Active Hypotheses, ## Anti-Pattern Log)', () => {
    const doc = [
      '### Setups\ncontent',
      '### Active Hypotheses\ncontent',
      '## Anti-Pattern Log\ncontent',
      '## Lessons learned\ncontent',
    ].join('\n\n');
    const padded = `${doc}\n${'filler line for the minimum length requirement\n'.repeat(50)}`;
    expect(validateFormulaUpdate(padded, null).ok).toBe(true);
  });

  it('rejects >40% shrink vs previous, accepts moderate shrink', () => {
    const prev = { content: validDoc(10_000) };
    const shrunkTooMuch = validDoc(Math.floor(prev.content.length * 0.5));
    const vBad = validateFormulaUpdate(shrunkTooMuch, prev);
    expect(vBad.ok).toBe(false);
    expect(vBad.reason).toMatch(/shrank/);

    const shrunkOk = validDoc(Math.ceil(prev.content.length * 0.75));
    expect(validateFormulaUpdate(shrunkOk, prev).ok).toBe(true);
  });

  it('does not apply the shrink rule when previous was itself degenerate', () => {
    // v118-era recovery case: previous version is mush, new version is a real doc.
    const v = validateFormulaUpdate(validDoc(), { content: '...' });
    expect(v.ok).toBe(true);
  });

  it('rejects a document over the size cap, telling the agent how to compact', () => {
    const v = validateFormulaUpdate(validDoc(FORMULA_MAX_CHARS + 2_000), null);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/max 15000/);
    expect(v.reason).toMatch(/formula_versions/);
  });

  it('allows a >40% shrink when the previous version was over the size cap (compaction path)', () => {
    // v148 case: prev 22k chars means the required move IS a big shrink.
    const prev = { content: validDoc(FORMULA_MAX_CHARS + 7_000) };
    const compacted = validDoc(Math.floor(prev.content.length * 0.55));
    expect(validateFormulaUpdate(compacted, prev).ok).toBe(true);
  });

  it('rejects leaked prompt-instruction sections (## Directive / ## Output contract)', () => {
    const leaky = `${validDoc()}\n\n## Output contract\nEnd your response with one fenced json block.`;
    const v = validateFormulaUpdate(leaky, null);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/Output contract/);
  });
});
