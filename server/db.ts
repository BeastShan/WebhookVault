import pg, { type Pool, type PoolClient } from 'pg';
import { env } from './config.js';

export function database(role: 'api' | 'worker' | 'receiver'): Pool {
  return new pg.Pool({
    connectionString: env(`DATABASE_${role.toUpperCase()}_URL`),
    max: role === 'worker' ? 3 : 8,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 4_000,
    idle_in_transaction_session_timeout: 5_000,
  });
}

export async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
