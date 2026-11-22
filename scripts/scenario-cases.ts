import assert from 'node:assert/strict';
import type { Lab } from './lab.js';
import { sample } from './lab.js';
import { until } from './client.js';

const terminal = (state: string) => (report: Awaited<ReturnType<Lab['http']['report']>>) => report.jobs[0]?.state === state;

async function projection(lab: Lab, stream: string) {
  const { rows } = await lab.pool.query(
    "SELECT sequence, value FROM projections WHERE source = 'synthetic' AND stream = $1", [stream]);
  return rows;
}

export const cases = {
  async A(lab: Lab) {
    const event = sample('successful-delivery');
    const submission = await lab.http.send(event);
    assert.equal(submission.status, 202);
    const report = await lab.http.waitReport(submission.deliveryId, terminal('succeeded'));
    assert.equal(report.attempts.length, 1);
    assert.equal(report.attempts[0].outcome, 'applied');
    assert.equal(report.attempts[0].http_status, 200);
    assert.equal(report.effect?.outcome, 'applied');
    const state = await projection(lab, event.stream);
    assert.deepEqual(state, [{ sequence: 1, value: 100 }]);
    return { submission, report, projection: state };
  },
  async B(lab: Lab) {
    const event = sample('duplicate-delivery');
    const submissions = await Promise.all(Array.from({ length: 8 }, () => lab.http.send(event)));
    assert.equal(submissions.filter((entry) => entry.status === 202).length, 1);
    assert.equal(submissions.filter((entry) => entry.status === 200).length, 7);
    assert.equal(new Set(submissions.map((entry) => entry.eventId)).size, 1);
    const report = await lab.http.waitReport(submissions[0].deliveryId, terminal('succeeded'));
    assert.equal(report.attempts.length, 1);
    assert.equal(report.deliveries.length, 8);
    assert.equal(report.effect?.outcome, 'applied');
    const state = await projection(lab, event.stream);
    assert.deepEqual(state, [{ sequence: 1, value: 100 }]);
    return { submissions, report, projection: state };
  },
  async C(lab: Lab) {
    const event = sample('invalid-signature');
    const submission = await lab.http.send(event, { tamper: true });
    assert.equal(submission.status, 401);
    const report = await lab.http.report(submission.deliveryId);
    assert.equal(report.delivery.signature, 'rejected');
    assert.equal(report.event, null);
    assert.equal(report.jobs.length, 0);
    assert.equal(report.attempts.length, 0);
    assert.equal((await lab.pool.query('SELECT 1 FROM events WHERE provider_id = $1', [event.id])).rowCount, 0);
    return { submission, report };
  },
  async D(lab: Lab) {
    const event = sample('transient-receiver');
    const submission = await lab.http.send({ ...event, fault: 'transient' });
    const report = await lab.http.waitReport(submission.deliveryId, terminal('succeeded'));
    assert.deepEqual(report.attempts.map((attempt) => attempt.http_status), [503, 503, 200]);
    assert.equal(report.receiverFailures.length, 2);
    const retryWaits = report.attempts.slice(0, 2).map((attempt, i) => {
      assert.ok(attempt.next_at && attempt.finished_at);
      const next = Date.parse(attempt.next_at);
      assert.ok(Date.parse(report.attempts[i + 1].started_at) >= next);
      return next - Date.parse(attempt.finished_at);
    });
    assert.ok(retryWaits[0] >= 100 && retryWaits[0] <= 140 && retryWaits[1] >= 200 && retryWaits[1] <= 250);
    return { submission, report, retryWaits };
  },
  async E(lab: Lab) {
    const event = sample('permanent-receiver');
    const submission = await lab.http.send({ ...event, fault: 'permanent' });
    const report = await lab.http.waitReport(submission.deliveryId, terminal('dead_letter'));
    assert.deepEqual(report.attempts.map((attempt) => attempt.http_status), [503, 503, 503]);
    assert.equal(report.receiverFailures.length, 3);
    assert.equal(report.jobs[0].attempt_count, report.jobs[0].max_attempts);
    assert.equal(report.attempts[2].next_at, null);
    assert.equal(report.effect, null);
    const state = await projection(lab, event.stream);
    assert.deepEqual(state, []);
    return { submission, report, projection: state };
  },
  async F(lab: Lab) {
    const event = sample('out-of-order', 2);
    const high = await lab.http.send(event);
    const newer = await lab.http.waitReport(high.deliveryId, terminal('succeeded'));
    const low = await lab.http.send({ ...event, id: event.id + '-older', sequence: 1, value: 100 });
    const older = await lab.http.waitReport(low.deliveryId, terminal('ignored'));
    const equal = await lab.http.send({ ...event, id: event.id + '-equal', value: 999 });
    const equalSequence = await lab.http.waitReport(equal.deliveryId, terminal('ignored'));
    assert.equal(older.effect?.outcome, 'stale');
    assert.equal(equalSequence.effect?.outcome, 'stale');
    const state = await projection(lab, event.stream);
    assert.deepEqual(state, [{ sequence: 2, value: 200 }]);
    return { newer, older, equalSequence, projection: state };
  },
  async G(lab: Lab) {
    await lab.restartWorker(5000);
    const event = sample('worker-interruption');
    const submission = await lab.http.send(event);
    try {
      const before = await lab.http.waitReport(submission.deliveryId,
        (report) => report.jobs[0]?.state === 'running' && report.effect?.outcome === 'applied');
      const stopped = await lab.killWorker();
      const stuck = await lab.http.report(submission.deliveryId);
      assert.equal(stuck.jobs[0].state, 'running');
      assert.equal(stuck.attempts[0].outcome, 'running');
      const workerId = before.attempts[0].worker_id;
      const expiredWorker = await until(async () => {
        const worker = (await lab.http.dashboard()).workers.find((entry) => entry.id === workerId);
        if (worker && !worker.online && !worker.stopped_at) return worker;
      }, 'killed worker heartbeat to expire');
      await lab.restartWorker();
      const after = await lab.http.waitReport(submission.deliveryId, terminal('succeeded'));
      assert.deepEqual(after.attempts.map((attempt) => attempt.outcome), ['lease_expired', 'applied']);
      assert.equal(after.attempts[1].deduplicated, true);
      assert.notEqual(after.attempts[1].worker_id, workerId);
      assert.equal(after.effect?.committed_at, before.effect?.committed_at);
      const state = await projection(lab, event.stream);
      assert.deepEqual(state, [{ sequence: 1, value: 100 }]);
      return { submission, before, stopped, stuck, expiredWorker, after, projection: state };
    } finally {
      // A failure must leave subsequent checks with an ordinary worker.
      await lab.restartWorker();
    }
  },
};
