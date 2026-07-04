// One-off v3 seed: insert a new FORMULA version that restores the strategy
// memory destroyed by the 2026-06-30 v117 wipe (content was literally "...").
//
// Composes seeds/formula-v123.md + the last good pre-wipe version (v116,
// fetched from the DB) as a verbatim appendix, validates the result with the
// same guard the runner uses, and inserts it as max(version)+1.
//
// Usage: DATABASE_URL=... pnpm --filter @loob/db run seed:formula
// Idempotent-ish: refuses to run twice (detects the v3 reset marker in the
// latest version).
import pkg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { validateFormulaUpdate } from '@loob/shared';

const { Client } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LAST_GOOD_VERSION = 116;
const RESET_MARKER = 'v3 reset';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const seedContent = readFileSync(join(__dirname, '..', 'seeds', 'formula-v123.md'), 'utf-8');

const client = new Client({ connectionString });

try {
  await client.connect();
  console.log('Connected to database');

  const latest = await client.query(
    'select version, content, changelog from formula_versions order by version desc limit 1',
  );
  const latestVersion: number = latest.rows[0]?.version ?? 0;
  if (latest.rows[0]?.content?.includes(RESET_MARKER) || latest.rows[0]?.changelog?.includes(RESET_MARKER)) {
    console.log(`Latest version v${latestVersion} already contains the v3 reset — nothing to do.`);
    process.exit(0);
  }

  const good = await client.query('select content from formula_versions where version = $1', [
    LAST_GOOD_VERSION,
  ]);
  if (good.rows.length === 0) {
    console.error(`Expected pre-wipe version v${LAST_GOOD_VERSION} not found — aborting.`);
    process.exit(1);
  }

  const composed =
    seedContent.trimEnd() +
    `\n\n## Appendix: recovered v${LAST_GOOD_VERSION} strategy memory (pre-wipe, verbatim)\n\n` +
    good.rows[0].content;

  const verdict = validateFormulaUpdate(composed, latest.rows[0] ?? null);
  if (!verdict.ok) {
    console.error(`Seed content fails the formula guard: ${verdict.reason}`);
    process.exit(1);
  }

  const newVersion = latestVersion + 1;
  await client.query(
    `insert into formula_versions (run_id, version, content, changelog, parent_version)
     values (null, $1, $2, $3, $4)`,
    [
      newVersion,
      composed,
      `v${newVersion} — v3 reset: restores strategy memory destroyed by the v117 wipe (content='...'); codifies S1/S2/S3/D setup taxonomy with code-enforced entries, code sizing ladder, trailing stops + breakeven ratchet.`,
      LAST_GOOD_VERSION,
    ],
  );
  console.log(`Inserted formula v${newVersion} (${composed.length} chars, parent v${LAST_GOOD_VERSION})`);
} finally {
  await client.end();
}
