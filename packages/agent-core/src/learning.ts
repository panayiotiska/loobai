// Baseline "learning" layer. Model weights never change; what changes is the
// feedback the next run is forced to see and the clamps code applies to it.
//
//   1. Calibration  — does stated confidence match realized win rate?
//   2. Bandit rank  — which setup deserves attention (exploit vs. explore)?
//   3. Digest       — a compact scorecard injected into EVERY system prompt,
//                     so feedback no longer depends on the model remembering
//                     to call get_portfolio_stats.
//
// Pure functions — unit-tested, no I/O (except buildLearningDigest's loader).

import type { ClosedTradeOutcome, SetupBreakdown, SetupStats, SetupType } from '@loob/db';
import { getClosedTradeOutcomes, getSetupBreakdown } from '@loob/db';
import type { SupabaseClient } from '@supabase/supabase-js';

type DB = SupabaseClient<any>;

// ---------- 1. Calibration ----------

export interface CalibrationBucket {
  label: string;
  lo: number;
  hi: number;
  n: number;
  meanConfidence: number | null;
  winRate: number | null;
  /** winRate − meanConfidence. Negative = overconfident. */
  gap: number | null;
}

export interface Calibration {
  n: number;
  /** Mean squared error of stated confidence vs win/loss. 0.25 = coin-flip-level. */
  brier: number | null;
  buckets: CalibrationBucket[];
}

const BUCKET_EDGES: Array<[number, number]> = [
  [0, 0.65],
  [0.65, 0.75],
  [0.75, 0.85],
  [0.85, 1.0001],
];

export function computeCalibration(
  rows: Array<{ confidence: number | null; pnl_usd: number }>,
): Calibration {
  const scored = rows.filter((r) => r.confidence != null && Number.isFinite(r.confidence));
  const buckets: CalibrationBucket[] = BUCKET_EDGES.map(([lo, hi]) => {
    const inB = scored.filter((r) => r.confidence! >= lo && r.confidence! < hi);
    const n = inB.length;
    const meanConfidence = n ? inB.reduce((s, r) => s + r.confidence!, 0) / n : null;
    const winRate = n ? inB.filter((r) => r.pnl_usd > 0).length / n : null;
    return {
      label: `${lo === 0 ? '<' : lo.toFixed(2) + '–'}${hi > 1 ? '1.00' : hi.toFixed(2)}`,
      lo,
      hi,
      n,
      meanConfidence,
      winRate,
      gap: n ? winRate! - meanConfidence! : null,
    };
  });
  const brier = scored.length
    ? scored.reduce((s, r) => s + (r.confidence! - (r.pnl_usd > 0 ? 1 : 0)) ** 2, 0) / scored.length
    : null;
  return { n: scored.length, brier, buckets };
}

/** Minimum trades in a bucket before code trusts its realized win rate. */
export const CALIBRATION_MIN_BUCKET_N = 8;
/** Pseudo-count blending stated confidence with the realized win rate. */
const CALIBRATION_PRIOR_N = 8;

export interface CalibratedConfidence {
  stated: number;
  effective: number;
  adjusted: boolean;
  note: string | null;
}

/**
 * Deflates overconfident claims — NEVER inflates. If trades stated at this
 * confidence level have realized a lower win rate (n ≥ 8), the effective
 * confidence is shrunk toward that win rate. Used to clamp position size.
 */
export function calibratedConfidence(cal: Calibration, stated: number): CalibratedConfidence {
  const b = cal.buckets.find((x) => stated >= x.lo && stated < x.hi);
  if (!b || b.n < CALIBRATION_MIN_BUCKET_N || b.winRate == null) {
    return { stated, effective: stated, adjusted: false, note: null };
  }
  const blended = (b.winRate * b.n + stated * CALIBRATION_PRIOR_N) / (b.n + CALIBRATION_PRIOR_N);
  const effective = Math.min(stated, blended);
  if (effective >= stated - 0.02) return { stated, effective: stated, adjusted: false, note: null };
  return {
    stated,
    effective,
    adjusted: true,
    note:
      `calibration: trades stated in the ${b.label} band won ${(b.winRate * 100).toFixed(0)}% ` +
      `(n=${b.n}) vs ${(b.meanConfidence! * 100).toFixed(0)}% claimed → effective confidence ${effective.toFixed(2)}`,
  };
}

// ---------- 2. Bandit ranking ----------

export interface SetupRank {
  setup: SetupType;
  n: number;
  expectancyUsd: number | null;
  /** Shrunk expectancy + UCB exploration bonus (USD/trade). */
  score: number;
  /** Softmax share of attention across setups, sums to 1. */
  weight: number;
}

const UCB_C = 8;  // USD of optimism per sqrt(log-trials / n)
const SOFTMAX_TEMP = 20;
const SHRINK_N = 10;

/**
 * UCB1-style ranking over setups: exploit what has positive realized
 * expectancy, but keep an optimism bonus for setups with few trials so a
 * dormant setup isn't buried by noise. Advisory — sizing stays on the ladder.
 */
export function rankSetups(breakdown: SetupBreakdown): SetupRank[] {
  const setups = Object.keys(breakdown) as SetupType[];
  const total = setups.reduce((s, k) => s + breakdown[k].n, 0);
  const ranks = setups.map((setup) => {
    const st: SetupStats = breakdown[setup];
    const exp = st.expectancyUsd ?? 0;
    const shrunk = (exp * st.n) / (st.n + SHRINK_N);
    const bonus = UCB_C * Math.sqrt(Math.log(total + 2) / (st.n + 1));
    return { setup, n: st.n, expectancyUsd: st.expectancyUsd, score: shrunk + bonus, weight: 0 };
  });
  const exps = ranks.map((r) => Math.exp(r.score / SOFTMAX_TEMP));
  const z = exps.reduce((s, x) => s + x, 0);
  ranks.forEach((r, i) => (r.weight = exps[i] / z));
  return ranks.sort((a, b) => b.score - a.score);
}

// ---------- 3. Case-based recall ----------
//
// Retrieval, not training: before a trade, pull the closed trades that most
// resemble it and show their outcomes + lessons. Structured matching (setup,
// instrument, regime, side) is enough at this scale — no embeddings needed.

export interface CaseQuery {
  setup_type?: SetupType | null;
  instrument_id?: string | null;
  regime?: string | null;
  side?: string | null;
}

export interface RecalledCase {
  tradeId: string;
  score: number;
  setup_type: SetupType | null;
  instrument_id: string;
  side: string;
  regime: string | null;
  pnlUsd: number;
  /** pnl / size — comparable across ladder tiers. */
  rewardPct: number | null;
  thesis: string;
  luckOrSkill: string | null;
  whatWeMissed: string | null;
  lesson: string | null;
  closedAt: string;
}

export interface CaseRecall {
  matched: number;
  winRate: number | null;
  meanRewardPct: number | null;
  /** Plain-language reliability warning so the model doesn't over-read 1–2 cases. */
  caveat: string;
  cases: RecalledCase[];
}

const W_SETUP = 3;
const W_INSTRUMENT = 3;
const W_REGIME = 2;
const W_SIDE = 1;
export const RECALL_MIN_RELIABLE = 4;

const same = (a?: string | null, b?: string | null): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export function similarityScore(
  t: Pick<ClosedTradeOutcome, 'setup_type' | 'instrument_id' | 'regime_at_entry' | 'side'>,
  q: CaseQuery,
): number {
  let s = 0;
  if (q.setup_type && t.setup_type === q.setup_type) s += W_SETUP;
  if (same(t.instrument_id, q.instrument_id)) s += W_INSTRUMENT;
  if (same(t.regime_at_entry, q.regime)) s += W_REGIME;
  if (same(t.side, q.side)) s += W_SIDE;
  return s;
}

export function recallSimilarCases(outcomes: ClosedTradeOutcome[], q: CaseQuery, k = 4): CaseRecall {
  // A side-only match says nothing; require at least one substantive dimension.
  const MIN_SCORE = Math.min(W_SETUP, W_INSTRUMENT, W_REGIME);
  const scored = outcomes
    .map((t) => ({ t, score: similarityScore(t, q) }))
    .filter((x) => x.score >= MIN_SCORE)
    // Best match first; ties broken by recency (outcomes arrive newest-first).
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  const cases: RecalledCase[] = scored.map(({ t, score }) => ({
    tradeId: t.id,
    score,
    setup_type: t.setup_type,
    instrument_id: t.instrument_id,
    side: t.side,
    regime: t.regime_at_entry,
    pnlUsd: t.pnl_usd,
    rewardPct: t.size_usd ? (t.pnl_usd / t.size_usd) * 100 : null,
    thesis: t.thesis.slice(0, 160),
    luckOrSkill: t.postmortem?.luck_or_skill ?? null,
    whatWeMissed: t.postmortem?.what_we_missed?.slice(0, 160) ?? null,
    lesson: t.postmortem?.lesson?.slice(0, 160) ?? null,
    closedAt: t.closed_at,
  }));

  const n = cases.length;
  const wins = cases.filter((c) => c.pnlUsd > 0).length;
  const rewards = cases.map((c) => c.rewardPct).filter((x): x is number => x != null);
  return {
    matched: n,
    winRate: n ? wins / n : null,
    meanRewardPct: rewards.length ? rewards.reduce((s, x) => s + x, 0) / rewards.length : null,
    caveat:
      n === 0
        ? 'No comparable closed trades — this is a fresh experiment. Treat the thesis as unproven and size accordingly.'
        : n < RECALL_MIN_RELIABLE
          ? `Only ${n} comparable case${n === 1 ? '' : 's'} — anecdotes, not statistics. Use them to avoid repeating a known mistake, not as proof of edge.`
          : `${n} comparable cases. Still small-sample; weigh the lessons above the averages.`,
    cases,
  };
}

// ---------- 4. Digest ----------

export function formatLearningDigest(
  cal: Calibration,
  ranks: SetupRank[],
  outcomes: Array<Pick<ClosedTradeOutcome, 'postmortem' | 'setup_type' | 'pnl_usd'>>,
): string {
  const lines: string[] = [];
  if (cal.n === 0) {
    lines.push('Calibration: no closed trades with a stated confidence yet.');
  } else {
    lines.push(`Calibration (n=${cal.n}, Brier ${cal.brier!.toFixed(3)}; 0.25 = coin-flip):`);
    for (const b of cal.buckets.filter((x) => x.n > 0)) {
      const tag = b.n < CALIBRATION_MIN_BUCKET_N ? ' (too few to act on)' : b.gap! < -0.1 ? ' ⚠ OVERCONFIDENT — size is deflated' : '';
      lines.push(`- stated ${b.label}: won ${(b.winRate! * 100).toFixed(0)}% of ${b.n}${tag}`);
    }
  }
  lines.push('Setup attention (bandit: realized expectancy + exploration bonus):');
  for (const r of ranks) {
    const exp = r.expectancyUsd == null ? 'n/a' : `$${r.expectancyUsd.toFixed(2)}/trade`;
    lines.push(`- ${r.setup}: n=${r.n}, expectancy ${exp}, attention ${(r.weight * 100).toFixed(0)}%`);
  }
  const lessons = outcomes
    .filter((o) => o.postmortem?.lesson)
    .slice(0, 3)
    .map((o) => `- [${o.setup_type ?? 'D'} ${o.pnl_usd >= 0 ? '+' : ''}$${o.pnl_usd.toFixed(2)}] ${o.postmortem!.lesson.slice(0, 140)}`);
  if (lessons.length) {
    lines.push('Latest lessons from closed trades:');
    lines.push(...lessons);
  }
  return lines.join('\n');
}

/** Loads outcomes + breakdown and renders the scorecard. Throws on DB error — callers degrade to ''. */
export async function buildLearningDigest(db: DB): Promise<string> {
  const [outcomes, breakdown] = await Promise.all([getClosedTradeOutcomes(db), getSetupBreakdown(db)]);
  return formatLearningDigest(computeCalibration(outcomes), rankSetups(breakdown), outcomes);
}
