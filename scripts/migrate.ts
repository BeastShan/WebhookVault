import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { env } from '../server/config.js';

const admin = new pg.Client({ connectionString: env('DATABASE_ADMIN_URL') });
const grants = {
  api: [
    'SELECT ON ALL TABLES IN SCHEMA public',
    'INSERT ON events, deliveries, jobs, replays',
  ],
  worker: [
    'SELECT ON events, jobs, attempts, receipts, workers',
    'UPDATE ON jobs',
    'INSERT, UPDATE ON attempts, workers',
  ],
  receiver: [
    'SELECT ON events, jobs, attempts, receipts, receiver_failures, projections',
    'INSERT ON receipts, receiver_failures, projections',
    'UPDATE ON projections',
  ],
} as const;

await admin.connect();
try {
  await admin.query('BEGIN');
  await admin.query('SELECT pg_advisory_xact_lock(681230)');
  await admin.query(await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8'));
  await admin.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  await admin.query('REVOKE ALL ON DATABASE webhookvault FROM PUBLIC');
  for (const role of ['api', 'worker', 'receiver'] as const) {
    const name = `vault_${role}`;
    const password = decodeURIComponent(new URL(env(`DATABASE_${role.toUpperCase()}_URL`)).password);
    if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('Expected a generated database role password');
    if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).rowCount) {
      await admin.query(`CREATE ROLE ${name} LOGIN`);
    }
    await admin.query(`ALTER ROLE ${name} PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`);
    await admin.query(`GRANT CONNECT ON DATABASE webhookvault TO ${name}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${name}`);
    for (const grant of grants[role]) await admin.query(`GRANT ${grant} TO ${name}`);
  }
  await admin.query('COMMIT');
  console.log('Applied schema and restricted service grants.');
} finally {
  await admin.end();
}
