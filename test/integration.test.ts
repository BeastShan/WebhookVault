import { randomUUID } from 'node:crypto';
import { get } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { secret } from '../server/config.js';
import { database, transaction } from '../server/db.js';
import { cases } from '../scripts/scenario-cases.js';
import { sample, startLab, type Lab } from '../scripts/lab.js';
import { taskSchema } from '../server/investigation.js';

const revision = 'a'.repeat(40);
let lab: Lab;
beforeAll(async () => {
  lab = await startLab({ VAULT_REVISION: revision });
}, 20_000);
afterAll(async () => { await lab?.stop(); }, 10_000);

describe('real webhook scenarios', () => {
  for (const [name, scenario] of Object.entries(cases)) {
    it(`verifies scenario ${name} through HTTP and PostgreSQL`, async () => { await scenario(lab); }, 25_000);
  }
});

it('rejects stale signatures, invalid bodies, bad route identifiers and oversized requests', async () => {
  const event = sample('validation');
  const stale = await lab.http.send(event, { timestamp: Math.floor(Date.now() / 1000) - 600 });
  expect(stale).toMatchObject({ status: 401, disposition: 'stale_timestamp', eventId: null });
  const invalid = await lab.http.send(event, { raw: '{"secret":"canary-token","notValid":true}' });
  expect(invalid).toMatchObject({ status: 400, disposition: 'invalid_payload', eventId: null });
  expect(JSON.stringify(await lab.http.report(invalid.deliveryId))).not.toContain('canary-token');
  const oversized = await lab.http.send(event, { raw: 'a'.repeat(65537) });
  expect(oversized.status).toBe(413);
  expect((await lab.http.request('/api/deliveries/invalid/report')).status).toBe(400);
  // Node fetch normalizes the Host header. Use the HTTP client to send it on the wire.
  const badHost = await new Promise<number | undefined>((resolve, reject) => {
    get('http://127.0.0.1:14310/api/dashboard', { headers: { host: 'rebind.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  expect(badHost).toBe(403);
  expect((await lab.http.request('/api/dashboard', { headers: { origin: 'https://untrusted.example' } })).status).toBe(403);
});

it('preserves original provenance when the signed provider ID collides with a different payload', async () => {
  const event = sample('conflicting-payload');
  const input = await lab.http.send(event);
  const conflict = await lab.http.send({ ...event, value: 444 });
  expect(conflict).toMatchObject({ status: 409, eventId: input.eventId, disposition: 'conflict' });
  const report = await lab.http.waitReport(input.deliveryId, (r) => r.jobs[0]?.state === 'succeeded');
  expect(report.deliveries.map((d) => d.disposition)).toEqual(['accepted', 'conflict']);
  expect(report.attempts).toHaveLength(1);
});

it('rolls back event creation when a dependent write fails and blocks service DDL or provenance edits', async () => {
  const id = randomUUID();
  await expect(transaction(lab.pool, async (connection) => {
    await connection.query(`INSERT INTO events (id, source, provider_id, signed_at, payload_hash, stream, sequence, value, fault)
      VALUES ($1, 'synthetic', $2, now(), 'test', $2, 1, 1, 'none')`, [id, id]);
    await connection.query('INSERT INTO jobs (id, event_id, max_attempts) VALUES ($1, $2, 0)', [id, id]);
  })).rejects.toMatchObject({ code: '23514' });
  expect((await lab.pool.query('SELECT 1 FROM events WHERE id = $1', [id])).rowCount).toBe(0);
  await expect(lab.pool.query('CREATE TABLE prohibited (id int)')).rejects.toMatchObject({ code: '42501' });
  for (const role of ['worker', 'receiver'] as const) {
    const pool = database(role);
    try {
      await expect(pool.query('UPDATE events SET value = 0 WHERE id = $1', [id])).rejects.toMatchObject({ code: '42501' });
    } finally {
      await pool.end();
    }
  }
});

it('enforces operator approval, replay eligibility, and one bounded audit record under concurrent approvals', async () => {
  const incident = await cases.E(lab);
  const token = secret('VAULT_OPERATOR_TOKEN');
  const eventId = incident.report.event!.id;
  const approval = { approved: true, reason: 'Confirm bounded manual recovery' };
  expect((await lab.http.replay(eventId, approval)).status).toBe(401);
  expect((await lab.http.replay(eventId, { ...approval, approved: false }, token)).status).toBe(400);
  const successful = await cases.A(lab);
  expect((await lab.http.replay(successful.report.event!.id, approval, token)).status).toBe(409);
  const approvals = await Promise.all(Array.from({ length: 2 }, () => lab.http.replay(eventId, approval, token)));
  expect(approvals.map((response) => response.status).sort()).toEqual([202, 409]);
  const report = await lab.http.waitReport(incident.submission.deliveryId, (r) => r.jobs[1]?.state === 'dead_letter');
  expect(report.jobs.map((job) => job.attempt_count)).toEqual([3, 2]);
  expect(report.delivery).toEqual(incident.report.delivery);
  expect(report.jobs[0]).toEqual(incident.report.jobs[0]);
  expect(report.replays).toHaveLength(1);
  expect(report.replays[0].approved_by).toBe('local-operator');
  expect(report.jobs[1].replay_id).toBe(report.replays[0].id);
  expect(JSON.stringify(report)).not.toContain(approval.reason);
  expect(report.effect).toBeNull();
  const response = await lab.http.request(`/api/deliveries/${incident.submission.deliveryId}/investigation`);
  expect(response.status).toBe(200);
  const task = taskSchema.parse(await response.json());
  expect(task.scope).toMatchObject({ commit: revision, scenario: 'E' });
  expect(task).toMatchObject({ phase: 'investigation', eventId, logs: expect.arrayContaining([
    expect.objectContaining({ status: 503 }),
  ]) });
}, 15_000);

it('can redrive a transient dead-letter event successfully while retaining the failed original', async () => {
  const isolated = await startLab({ VAULT_API_PORT: '14320', VAULT_RECEIVER_PORT: '14321', VAULT_MAX_ATTEMPTS: '2' });
  try {
    const event = sample('recoverable-redrive');
    const submission = await isolated.http.send({ ...event, fault: 'transient' });
    const failed = await isolated.http.waitReport(submission.deliveryId, (r) => r.jobs[0]?.state === 'dead_letter');
    const approved = await isolated.http.replay(failed.event!.id,
      { approved: true, reason: 'Transient receiver recovered' }, secret('VAULT_OPERATOR_TOKEN'));
    expect(approved.status).toBe(202);
    const report = await isolated.http.waitReport(submission.deliveryId, (r) => r.jobs[1]?.state === 'succeeded');
    expect(report.attempts.map((attempt) => attempt.http_status)).toEqual([503, 503, 200]);
    expect(report.jobs.map((job) => job.state)).toEqual(['dead_letter', 'succeeded']);
    expect(report.effect?.outcome).toBe('applied');

    const stale = sample('stale-redrive');
    const older = await isolated.http.send({ ...stale, fault: 'transient' });
    const olderFailed = await isolated.http.waitReport(older.deliveryId, (r) => r.jobs[0]?.state === 'dead_letter');
    const advance = await isolated.http.send({ ...stale, id: stale.id + '-newer', sequence: 2, value: 200 });
    await isolated.http.waitReport(advance.deliveryId, (r) => r.jobs[0]?.state === 'succeeded');
    const olderApproved = await isolated.http.replay(olderFailed.event!.id,
      { approved: true, reason: 'Check original ordering guard' }, secret('VAULT_OPERATOR_TOKEN'));
    expect(olderApproved.status).toBe(202);
    const olderReport = await isolated.http.waitReport(older.deliveryId, (r) => r.jobs[1]?.state === 'ignored');
    expect(olderReport.effect?.outcome).toBe('stale');
    expect((await isolated.pool.query('SELECT sequence, value FROM projections WHERE stream = $1', [stale.stream])).rows)
      .toEqual([{ sequence: 2, value: 200 }]);
  } finally {
    await isolated.stop();
  }
}, 20_000);

it('rate-limits repeated ingestion requests before they can reach the queue', async () => {
  let status: number | undefined;
  for (let i = 0; i < 95 && status !== 429; i++) {
    const response = await lab.http.request('/webhooks/synthetic', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'rate-check',
    });
    status = response.status;
    await response.body?.cancel();
  }
  expect(status).toBe(429);
});
