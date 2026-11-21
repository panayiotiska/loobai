import { describe, it, expect } from 'vitest';
import { computeCalibration, calibratedConfidence, rankSetups, formatLearningDigest } from '../learning.js';
import { computeSetupStats } from '@loob/db';
import type { SetupBreakdown } from '@loob/db';

const rows = (conf: number, wins: number, losses: number) => [
  ...Array(wins).fill({ confidence: conf, pnl_usd: 5 }),
  ...Array(losses).fill({ confidence: conf, pnl_usd: -5 }),
];

describe('calibration', () => {
  it('buckets by stated confidence and computes win rate and gap', () => {
    const cal = computeCalibration(rows(0.8, 3, 7));
    const b = cal.buckets.find((x) => x.n > 0)!;
    expect(b.n).toBe(10);
    expect(b.winRate).toBeCloseTo(0.3);
    expect(b.gap).toBeCloseTo(-0.5);
  });

  it('ignores trades with no stated confidence', () => {
    expect(computeCalibration([{ confidence: null, pnl_usd: 3 }]).n).toBe(0);
  });

  it('Brier is 0.25 for 0.5 confidence at a 50% win rate', () => {
    expect(computeCalibration(rows(0.5, 5, 5)).brier).toBeCloseTo(0.25);
  });

  it('deflates overconfidence once the bucket has ≥8 trades', () => {
    const cal = computeCalibration(rows(0.8, 2, 10));
    const c = calibratedConfidence(cal, 0.8);
    expect(c.adjusted).toBe(true);
    expect(c.effective).toBeLessThan(0.8);
    expect(c.note).toMatch(/won/);
  });

  it('never acts on thin data', () => {
    const c = calibratedConfidence(computeCalibration(rows(0.8, 0, 7)), 0.8);
    expect(c.adjusted).toBe(false);
    expect(c.effective).toBe(0.8);
  });

  it('never inflates confidence, even when a band outperforms', () => {
    const c = calibratedConfidence(computeCalibration(rows(0.7, 10, 0)), 0.7);
    expect(c.effective).toBe(0.7);
  });
});

describe('bandit ranking', () => {
  const mk = (pnls: Record<string, number[]>): SetupBreakdown =>
    ({
      S1_funding_squeeze: computeSetupStats(pnls.S1 ?? []),
      S2_carry_harvest: computeSetupStats(pnls.S2 ?? []),
      S3_trend_breakout: computeSetupStats(pnls.S3 ?? []),
      D_discretionary: computeSetupStats(pnls.D ?? []),
    }) as SetupBreakdown;

  it('weights sum to 1', () => {
    const r = rankSetups(mk({ S1: [5, -2, 4] }));
    expect(r.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(1);
  });

  it('a proven setup outranks a proven loser at equal n', () => {
    const r = rankSetups(mk({ S1: Array(25).fill(8), D: Array(25).fill(-8), S2: Array(25).fill(1), S3: Array(25).fill(1) }));
    expect(r[0].setup).toBe('S1_funding_squeeze');
    expect(r[r.length - 1].setup).toBe('D_discretionary');
  });

  it('keeps exploring an untried setup over a mediocre well-sampled one', () => {
    const r = rankSetups(mk({ S1: Array(40).fill(0.5), S3: [] }));
    const s3 = r.findIndex((x) => x.setup === 'S3_trend_breakout');
    const s1 = r.findIndex((x) => x.setup === 'S1_funding_squeeze');
    expect(s3).toBeLessThan(s1);
  });
});

describe('digest', () => {
  it('renders empty state, flags overconfidence and lists lessons', () => {
    const empty = formatLearningDigest(computeCalibration([]), rankSetups({} as SetupBreakdown), []);
    expect(empty).toMatch(/no closed trades/);
    const cal = computeCalibration(rows(0.8, 2, 10));
    const d = formatLearningDigest(cal, [], [
      { setup_type: 'S1_funding_squeeze', pnl_usd: -4, postmortem: { thesis_correct: false, what_we_missed: 'x', luck_or_skill: 'luck', lesson: 'Do not chase weak funding.' } },
    ]);
    expect(d).toMatch(/OVERCONFIDENT/);
    expect(d).toMatch(/Do not chase weak funding/);
  });
});
