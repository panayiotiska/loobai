import pkg from 'pg';
import { readFileSync } from 'fs';
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

const client = new Client({ connectionString });

try {
  await client.connect();
  console.log('Connected to database');

  const sqlPath = join(__dirname, '..', 'migrations', '0001_init.sql');
  const sql = readFileSync(sqlPath, 'utf-8');

  await client.query(sql);
  console.log('Migration 0001_init.sql applied successfully');
} finally {
  await client.end();
}
