// Formula write protection.
//
// On 2026-06-30 a research run emitted `newFormula: "..."` — 3 characters —
// and the runner persisted it as v117, destroying the accumulated strategy
// document (setups, hypotheses, anti-pattern log, ~47 lessons). The only
// validation at the time was `length > 0`. Subsequent versions were rebuilt
// from nothing and degraded into generic "watching, no edge" text.
//
// This guard is the fix: every formula version must be the complete document.
// It lives in @loob/shared so both the agent runner and the db seed script
// validate with the same rules.

export interface FormulaValidation {
  ok: boolean;
  reason?: string;
}

export const FORMULA_MIN_CHARS = 1500;
/** Reject a new version smaller than this fraction of the previous one. */
export const FORMULA_MIN_SIZE_RATIO = 0.6;

export const REQUIRED_FORMULA_SECTIONS: Array<{ label: string; re: RegExp }> = [
  { label: '## Setups', re: /^#{1,3}\s*setups?\b/im },
  { label: '## Hypotheses', re: /^#{1,3}\s*(active\s+)?hypothes/im },
  { label: '## Anti-pattern log', re: /^#{1,3}\s*anti[- ]?pattern/im },
  { label: '## Recent lessons', re: /^#{1,3}\s*(recent\s+|lessons\s+)?(lessons|learned)\b/im },
];

const PRESERVE_INSTRUCTION =
  'A formula version must be the COMPLETE document — never a diff, placeholder, or summary. ' +
  'Start from the current version, preserve every section (## Setups, ## Hypotheses, ' +
  '## Anti-pattern log, ## Recent lessons), and append or amend incrementally.';

export function validateFormulaUpdate(
  next: string,
  previous: { content: string } | null | undefined,
): FormulaValidation {
  const content = (next ?? '').trim();

  if (content.length < FORMULA_MIN_CHARS) {
    return {
      ok: false,
      reason:
        `FORMULA update rejected: new content is ${content.length} chars (min ${FORMULA_MIN_CHARS}). ` +
        PRESERVE_INSTRUCTION,
    };
  }

  const missing = REQUIRED_FORMULA_SECTIONS.filter((s) => !s.re.test(content));
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `FORMULA update rejected: missing required section header(s): ${missing
          .map((s) => s.label)
          .join(', ')}. These sections are load-bearing strategy memory. ` + PRESERVE_INSTRUCTION,
    };
  }

  const prev = previous?.content?.trim() ?? '';
  if (prev.length >= FORMULA_MIN_CHARS && content.length < prev.length * FORMULA_MIN_SIZE_RATIO) {
    const shrinkPct = Math.round((1 - content.length / prev.length) * 100);
    return {
      ok: false,
      reason:
        `FORMULA update rejected: content shrank ${shrinkPct}% vs the previous version ` +
        `(${prev.length} → ${content.length} chars; max allowed shrink ${Math.round(
          (1 - FORMULA_MIN_SIZE_RATIO) * 100,
        )}%). You are about to destroy accumulated strategy memory. ` +
        'Re-emit the FULL document with all prior sections preserved, adding your changes incrementally.',
    };
  }

  return { ok: true };
}
