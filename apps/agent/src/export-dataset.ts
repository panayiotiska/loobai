// Exports closed trades as JSONL: (market context → decision → realized reward).
//
// This is the raw material for the learning Loob does NOT do yet: offline
// fine-tuning or preference training of an open-weights model (Gemma), or
// off-policy evaluation of a new prompt. Nothing here trains anything.
//
//   pnpm --filter @loob/agent run export-dataset [out.jsonl]

import { writeFileSync } from 'node:fs';
import { createServiceClient } from '@loob/db';

const out = process.argv[2] ?? 'loob-trades.jsonl';
const db = createServiceClient();

const { data, error } = await db
  .from('trades')
  .select(
    'id, instrument_kind, instrument_id, side, size_usd, setup_type, size_class, confidence, regime_at_entry, thesis, retail_view, institutional_view, adversarial_view, confirming_signals, invalidation_signal, exit_criteria, pnl_usd, funding_accrued_usd, opened_at, closed_at, postmortem',
  )
  .eq('status', 'closed')
  .not('pnl_usd', 'is', null)
  .order('closed_at', { ascending: true });
if (error) throw new Error(`export failed: ${error.message}`);

const rows = (data ?? []).map((t: any) => ({
  id: t.id,
  context: {
    instrument: `${t.instrument_kind}:${t.instrument_id}`,
    regime: t.regime_at_entry,
    setup_type: t.setup_type,
    retail_view: t.retail_view,
    institutional_view: t.institutional_view,
    adversarial_view: t.adversarial_view,
    confirming_signals: t.confirming_signals,
  },
  decision: {
    side: t.side,
    size_usd: t.size_usd,
    size_class: t.size_class,
    stated_confidence: t.confidence,
    thesis: t.thesis,
    invalidation_signal: t.invalidation_signal,
    exit_criteria: t.exit_criteria,
  },
  outcome: {
    pnl_usd: t.pnl_usd,
    /** Size-normalized reward — comparable across ladder tiers. */
    reward: t.size_usd ? t.pnl_usd / t.size_usd : null,
    win: t.pnl_usd > 0,
    funding_accrued_usd: t.funding_accrued_usd,
    opened_at: t.opened_at,
    closed_at: t.closed_at,
    postmortem: t.postmortem,
  },
}));

writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
console.log(`wrote ${rows.length} closed trades → ${out}`);
