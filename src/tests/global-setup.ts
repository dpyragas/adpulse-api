import { execSync } from 'child_process';
import pg from 'pg';

const { Client } = pg;

const BASE_URL = 'postgresql://postgres:postgres@localhost:5432';
const TEST_DB = 'adpulse_test';
const TEST_DATABASE_URL = `${BASE_URL}/${TEST_DB}?schema=public`;

export async function setup() {
  const client = new Client({ connectionString: `${BASE_URL}/adpulse` });
  await client.connect();

  const result = await client.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [TEST_DB],
  );

  if (result.rowCount === 0) {
    await client.query(`CREATE DATABASE "${TEST_DB}"`);
  }

  await client.end();

  const apiDir = new URL('../../', import.meta.url).pathname;

  execSync('npx prisma migrate deploy', {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'inherit',
  });
}
