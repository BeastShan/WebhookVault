import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from 'pg';
import { z } from 'zod';
import { transaction } from './db.js';
import { replay, webhook } from './contracts.js';
import { equalsSecret, payloadHash, verify } from './signing.js';
import { dashboardData, eventReport } from './reports.js';
import { exportInvestigation, investigationJsonSchema } from './investigation.js';

type Options = { webhookSecret: string; operatorToken: string; maxAttempts: number; revision?: string };
const source = 'synthetic';
const utf8 = new TextDecoder('utf-8', { fatal: true });
const idParam = z.object({ id: z.uuid() });
const localhost = /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/;

export async function api(pool: Pool, options: Options) {
  const app = Fastify({ bodyLimit: 64 * 1024, requestTimeout: 5_000, trustProxy: false });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    const host = request.headers.host ?? '';
    const origin = request.headers.origin;
    if (!localhost.test(host) || (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(origin))) {
      return reply.code(403).send({ error: 'local_requests_only' });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const info = error as { statusCode?: number; code?: string };
    const status = info.statusCode ?? 500;
    if (status >= 500) console.error('API request failed', info.code ?? 'internal');
    return reply.code(status).send({
      error: ({ 400: 'invalid_request', 413: 'body_too_large', 415: 'unsupported_media_type', 429: 'rate_limited' } as Record<number, string>)[status] ?? 'request_failed',
    });
  });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ready' };
  });

  await app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    hooks.post('/webhooks/synthetic', { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } }, async (request, reply) => {
      const body = request.body;
      if (!Buffer.isBuffer(body)) return reply.code(415).send({ error: 'json_required' });
      const deliveryId = randomUUID();
      const hash = payloadHash(body);
      const proof = verify(options.webhookSecret, request.headers['x-vault-timestamp'],
        request.headers['x-vault-signature'], body, Math.floor(Date.now() / 1000));
      let data: z.output<typeof webhook> | undefined;
      if (proof.outcome === 'verified') {
        try {
          const result = webhook.safeParse(JSON.parse(utf8.decode(body)));
          if (result.success) data = result.data;
        } catch {
          // Only the payload hash and fixed disposition are persisted.
        }
      }
      const outcome = await transaction(pool, async (client) => {
        let eventId: string | null = null;
        let disposition: string = proof.outcome === 'verified' ? 'invalid_payload' : proof.outcome;
        if (data) {
          const inserted = await client.query<{ id: string }>(`
            INSERT INTO events (id, source, provider_id, signed_at, payload_hash, stream, sequence, value, fault)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (source, provider_id) DO NOTHING RETURNING id
          `, [randomUUID(), source, data.id, proof.signedAt, hash, data.stream, data.sequence, data.value, data.fault]);
          if (inserted.rows[0]) {
            eventId = inserted.rows[0].id;
            disposition = 'accepted';
            await client.query('INSERT INTO jobs (id, event_id, max_attempts) VALUES ($1, $2, $3)',
              [randomUUID(), eventId, options.maxAttempts]);
          } else {
            const { rows: [existing] } = await client.query<{ id: string; payload_hash: string }>(
              'SELECT id, payload_hash FROM events WHERE source = $1 AND provider_id = $2', [source, data.id]);
            eventId = existing.id;
            disposition = existing.payload_hash === hash ? 'duplicate' : 'conflict';
          }
        }
        await client.query(`
          INSERT INTO deliveries (id, event_id, source, provider_id, signed_at, payload_hash, signature, disposition)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [deliveryId, eventId, source, data?.id ?? null, proof.signedAt, hash,
          proof.outcome === 'verified' ? 'verified' : 'rejected', disposition]);
        return { deliveryId, eventId, disposition };
      });
      const statuses: Record<string, number> = {
        accepted: 202, duplicate: 200, conflict: 409, invalid_payload: 400, invalid_signature: 401, stale_timestamp: 401,
      };
      return reply.code(statuses[outcome.disposition]).send(outcome);
    });
  });

  app.get('/api/dashboard', () => dashboardData(pool));
  app.get('/api/task-schema', () => investigationJsonSchema());
  app.get('/api/deliveries/:id/:format', async (request, reply) => {
    const params = idParam.extend({ format: z.enum(['report', 'export', 'investigation']) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_report_request' });
    const { id, format } = params.data;
    const report = await eventReport(pool, id);
    if (!report) return reply.code(404).send({ error: 'delivery_not_found' });
    if (format === 'report') return report;
    if (format === 'investigation') {
      const task = exportInvestigation(report, options.revision);
      if (!task) return reply.code(409).send({ error: 'investigation_requires_failed_attempts_and_pinned_commit' });
      reply.header('Content-Disposition', `attachment; filename="webhookvault-task-${id}.json"`);
      return task;
    }
    reply.header('Content-Disposition', `attachment; filename="webhookvault-incident-${id}.json"`);
    return report;
  });
  app.post('/api/events/:id/replay', { bodyLimit: 2048, config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!equalsSecret(`Bearer ${options.operatorToken}`, request.headers.authorization)) {
      return reply.code(401).send({ error: 'operator_authorization_required' });
    }
    const params = idParam.safeParse(request.params);
    const approval = replay.safeParse(request.body);
    if (!params.success || !approval.success) return reply.code(400).send({ error: 'explicit_approval_and_reason_required' });
    const eventId = params.data.id;
    const result = await transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [eventId]);
      const { rows: [original] } = await client.query<{ state: string }>(`
        SELECT state FROM jobs WHERE event_id = $1 AND replay_id IS NULL
      `, [eventId]);
      if (!original) return 404;
      if (original.state !== 'dead_letter') return 409;
      const replayId = randomUUID();
      const audit = await client.query(`
        INSERT INTO replays (id, event_id, approved_by, reason) VALUES ($1, $2, 'local-operator', $3)
        ON CONFLICT (event_id) DO NOTHING RETURNING id
      `, [replayId, eventId, approval.data.reason]);
      if (!audit.rowCount) return 409;
      const jobId = randomUUID();
      await client.query('INSERT INTO jobs (id, event_id, replay_id, max_attempts) VALUES ($1, $2, $3, $4)',
        [jobId, eventId, replayId, Math.min(options.maxAttempts, 2)]);
      return { jobId, replayId, eventId };
    });
    if (typeof result === 'number') {
      return reply.code(result).send({ error: result === 404 ? 'event_not_found' : 'event_ineligible_or_replay_already_used' });
    }
    return reply.code(202).send(result);
  });
  return app;
}
