import Fastify from 'fastify';
import type { Pool } from 'pg';
import { deliveryRequest } from './contracts.js';
import { transaction } from './db.js';
import { equalsSecret } from './signing.js';

type Outcome = 'applied' | 'stale';

export function receiver(pool: Pool, token: string) {
  const app = Fastify({ bodyLimit: 1024, requestTimeout: 3_000 });
  app.post('/deliver', async (request, reply) => {
    if (!equalsSecret(`Bearer ${token}`, request.headers.authorization)) {
      return reply.code(401).send({ error: 'receiver_auth_required' });
    }
    const parsed = deliveryRequest.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_delivery' });
    const { jobId, leaseToken } = parsed.data;

    const result = await transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [jobId]);
      const { rows: [execution] } = await client.query<{
        id: string; source: string; stream: string; sequence: number; value: number;
        fault: string; attempt_count: number;
      }>(`
        SELECT e.id, e.source, e.stream, e.sequence, e.value, e.fault, j.attempt_count
        FROM jobs j JOIN events e ON e.id = j.event_id
        WHERE j.id = $1 AND j.state = 'running' AND j.lease_token = $2 AND j.lease_until > clock_timestamp()
      `, [jobId, leaseToken]);
      if (!execution) return { status: 409, body: { error: 'lease_not_active' } };
      const prior = await client.query<{ outcome: Outcome }>(
        'SELECT outcome FROM receipts WHERE event_id = $1', [execution.id]);
      if (prior.rows[0]) {
        return { status: 200, body: { outcome: prior.rows[0].outcome, deduplicated: true } };
      }

      const failures = await client.query<{ count: number; this_attempt_failed: boolean }>(`
        SELECT count(*)::integer AS count,
          coalesce(bool_or(job_id = $2 AND attempt_number = $3), false) AS this_attempt_failed
        FROM receiver_failures WHERE event_id = $1
      `, [execution.id, jobId, execution.attempt_count]);
      const history = failures.rows[0];
      if (execution.fault === 'permanent' ||
          (execution.fault === 'transient' && (history.count < 2 || history.this_attempt_failed))) {
        await client.query(`
          INSERT INTO receiver_failures(event_id, job_id, attempt_number, detail)
          VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING
        `, [execution.id, jobId, execution.attempt_count, execution.fault]);
        return { status: 503, body: { error: 'synthetic_handler_unavailable' } };
      }

      const change = await client.query(`
        INSERT INTO projections (source, stream, sequence, value) VALUES ($1, $2, $3, $4)
        ON CONFLICT (source, stream) DO UPDATE SET sequence = EXCLUDED.sequence, value = EXCLUDED.value
        WHERE projections.sequence < EXCLUDED.sequence
      `, [execution.source, execution.stream, execution.sequence, execution.value]);
      const outcome: Outcome = change.rowCount ? 'applied' : 'stale';
      await client.query('INSERT INTO receipts (event_id, outcome) VALUES ($1, $2)', [execution.id, outcome]);
      return { status: 200, body: { outcome, deduplicated: false } };
    });

    return reply.code(result.status).send(result.body);
  });
  return app;
}
