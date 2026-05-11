import pkg from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const { Client } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const migrationsDir = join(__dirname, '..', 'migrations');
const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (migrationFiles.length === 0) {
  console.error(`No .sql migrations found in ${migrationsDir}`);
  process.exit(1);
}

const client = new Client({ connectionString });

try {
  await client.connect();
  console.log('Connected to database');

  for (const file of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    await client.query(sql);
    console.log(`Migration ${file} applied successfully`);
  }
} finally {
  await client.end();
}
