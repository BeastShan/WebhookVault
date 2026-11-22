import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import { receipt } from './contracts.js';
import { transaction } from './db.js';

type Claim = { id: string; token: string; attempt: number; max: number };
type Result = {
  outcome: 'applied' | 'stale' | 'retryable' | 'lease_expired' | 'reconciled';
  state: 'succeeded' | 'ignored' | 'dead_letter' | 'retry';
  detail: string;
  status?: number;
  deduplicated?: boolean;
};
type Settings = {
  receiverPort: number;
  token: string;
  pollMs: number;
  leaseMs: number;
  requestMs: number;
  baseMs: number;
  capMs: number;
  ackDelayMs: number;
};
const concurrencyLimit = 4;
export const retryDelay = (attempt: number, baseMs: number, capMs: number) =>
  Math.min(capMs, baseMs * 2 ** (attempt - 1));

export class Worker {
  readonly id = randomUUID();

  constructor(private readonly pool: Pool, private readonly settings: Settings) {}

  private async finish(client: PoolClient, claim: Claim, result: Result) {
    const delay = retryDelay(claim.attempt, this.settings.baseMs, this.settings.capMs);
    const { rows: [job] } = await client.query<{ available_at: Date; transitioned_at: Date }>(`
      WITH transition AS (SELECT clock_timestamp() AS at)
      UPDATE jobs SET state = $3, detail = $4,
        available_at = CASE WHEN $3 = 'retry' THEN transition.at + $5 * interval '1 millisecond' ELSE available_at END,
        finished_at = CASE WHEN $3 = 'retry' THEN NULL ELSE transition.at END,
        lease_token = NULL, lease_until = NULL
      FROM transition WHERE id = $1 AND lease_token = $2 AND state = 'running'
      RETURNING available_at, transition.at AS transitioned_at
    `, [claim.id, claim.token, result.state, result.detail, delay]);
    if (!job) return;
    const attempt = await client.query(`
      UPDATE attempts SET finished_at = $8, outcome = $3, detail = $4,
        http_status = $5, deduplicated = $6, next_at = $7
      WHERE job_id = $1 AND number = $2 AND outcome = 'running'
    `, [claim.id, claim.attempt, result.outcome, result.detail, result.status ?? null,
      result.deduplicated ?? false, result.state === 'retry' ? job.available_at : null, job.transitioned_at]);
    if (attempt.rowCount !== 1) throw new Error('Missing active attempt');
  }

  private async claim(): Promise<Claim | undefined> {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(681231)');
      const expired = await client.query<Claim & { event_id: string }>(`
        SELECT id, event_id, lease_token AS token, attempt_count AS attempt, max_attempts AS max
        FROM jobs WHERE state = 'running' AND lease_until <= clock_timestamp()
        ORDER BY lease_until LIMIT 4 FOR UPDATE SKIP LOCKED
      `);
      for (const job of expired.rows) {
        const lock = await client.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired', [job.id]);
        if (!lock.rows[0].acquired) continue;
        const last = job.attempt >= job.max;
        const committed = last ? await client.query<{ outcome: 'applied' | 'stale' }>(
          'SELECT outcome FROM receipts WHERE event_id = $1', [job.event_id]) : undefined;
        const disposition = committed?.rows[0]?.outcome;
        await this.finish(client, job, disposition ? {
          outcome: 'reconciled',
          state: disposition === 'applied' ? 'succeeded' : 'ignored',
          detail: 'Receiver receipt reconciled after final lease expired',
        } : {
          outcome: 'lease_expired',
          state: last ? 'dead_letter' : 'retry',
          detail: 'Worker lease expired before acknowledgement',
        });
      }
      const active = await client.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM jobs WHERE state = 'running'");
      if (active.rows[0].count >= concurrencyLimit) return;
      const { rows: [job] } = await client.query<Claim>(`
        WITH candidate AS (
          SELECT id FROM jobs WHERE state IN ('queued', 'retry') AND available_at <= clock_timestamp()
          ORDER BY available_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        UPDATE jobs j SET state = 'running', attempt_count = j.attempt_count + 1,
          lease_token = $1, lease_until = clock_timestamp() + $2 * interval '1 millisecond'
        FROM candidate WHERE j.id = candidate.id
        RETURNING j.id, j.lease_token AS token, j.attempt_count AS attempt, j.max_attempts AS max
      `, [randomUUID(), this.settings.leaseMs]);
      if (!job) return;
      await client.query('INSERT INTO attempts (job_id, number, worker_id) VALUES ($1, $2, $3)',
        [job.id, job.attempt, this.id]);
      return job;
    });
  }

  private async deliver(job: Claim): Promise<Result> {
    let status: number | undefined;
    let detail = 'Local receiver unavailable or timed out';
    try {
      const response = await fetch(`http://127.0.0.1:${this.settings.receiverPort}/deliver`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.settings.requestMs),
        headers: {
          authorization: `Bearer ${this.settings.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jobId: job.id, leaseToken: job.token }),
      });
      status = response.status;
      if (status === 200) {
        const parsed = receipt.safeParse(await response.json());
        if (parsed.success) {
          const { outcome, deduplicated } = parsed.data;
          return {
            outcome, status, deduplicated,
            state: outcome === 'applied' ? 'succeeded' : 'ignored',
            detail: deduplicated ? 'Existing receiver receipt reused' :
              outcome === 'applied' ? 'Projection updated' : 'Sequence already reached or superseded',
          };
        }
        detail = 'Local receiver returned an invalid receipt';
      } else {
        await response.body?.cancel();
        detail = `Local receiver returned HTTP ${status}`;
      }
    } catch {
      // Persist a fixed diagnostic instead of logging network data or credentials.
    }
    return {
      state: job.attempt < job.max ? 'retry' : 'dead_letter',
      outcome: 'retryable', status, detail,
    };
  }

  private async acknowledge(job: Claim, result: Result) {
    await transaction(this.pool, async (client) => {
      const lock = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired', [job.id]);
      // If the HTTP request timed out while the receiver still owns the transaction,
      // lease recovery will observe its commit before deciding whether to retry.
      if (!lock.rows[0].acquired) return;
      const current = await client.query(`
        SELECT 1 FROM jobs WHERE id = $1 AND lease_token = $2 AND lease_until > clock_timestamp() FOR UPDATE SKIP LOCKED
      `, [job.id, job.token]);
      if (!current.rowCount) return;
      if (result.outcome === 'retryable' && job.attempt >= job.max) {
        const existing = await client.query<{ outcome: 'applied' | 'stale' }>(`
          SELECT r.outcome FROM jobs j JOIN receipts r ON r.event_id = j.event_id WHERE j.id = $1
        `, [job.id]);
        const disposition = existing.rows[0]?.outcome;
        if (disposition) {
          result = {
            ...result, outcome: 'reconciled',
            state: disposition === 'applied' ? 'succeeded' : 'ignored',
            detail: 'Receiver receipt reconciled after an ambiguous response',
          };
        }
      }
      await this.finish(client, job, result);
    });
  }

  async run(signal: AbortSignal) {
    await this.pool.query('INSERT INTO workers (id) VALUES ($1)', [this.id]);
    let heartbeat = 0;
    try {
      while (!signal.aborted) {
        try {
          if (Date.now() >= heartbeat) {
            await this.pool.query('UPDATE workers SET seen_at = clock_timestamp() WHERE id = $1', [this.id]);
            heartbeat = Date.now() + 1_000;
          }
          const job = await this.claim();
          if (job) {
            const result = await this.deliver(job);
            if (this.settings.ackDelayMs && result.status === 200) await pause(this.settings.ackDelayMs);
            await this.acknowledge(job, result);
          } else {
            await pause(this.settings.pollMs);
          }
        } catch (error) {
          const code = (error as { code?: string }).code ?? 'internal';
          console.error('Worker iteration failed', code);
          await pause(500);
        }
      }
    } finally {
      await this.pool.query('UPDATE workers SET stopped_at = clock_timestamp() WHERE id = $1', [this.id]);
    }
  }
}
