import type { Pool, PoolClient } from 'pg';
import { transaction } from './db.js';

export type Delivery = {
  id: string; event_id: string | null; source: string; provider_id: string | null;
  received_at: string; signed_at: string | null; payload_hash: string;
  signature: 'verified' | 'rejected'; disposition: string;
};
export type Job = {
  id: string; replay_id: string | null; state: string; created_at: string; available_at: string;
  attempt_count: number; max_attempts: number; lease_until: string | null;
  finished_at: string | null; detail: string | null;
};
export type Attempt = {
  job_id: string; number: number; worker_id: string; started_at: string;
  finished_at: string | null; outcome: string; detail: string | null;
  http_status: number | null; deduplicated: boolean; next_at: string | null;
};
type Replay = { id: string; approved_by: string; approved_at: string };
type ReceiverFailure = { job_id: string; attempt_number: number; occurred_at: string; detail: string };
type TimelineItem = { at: string; action: string; reference: string };
export type EventReport = {
  delivery: Delivery;
  event: { id: string; source: string; provider_id: string; sequence: number } | null;
  deliveries: Delivery[];
  jobs: Job[];
  attempts: Attempt[];
  receiverFailures: ReceiverFailure[];
  replays: Replay[];
  effect: { outcome: string; committed_at: string } | null;
  timeline: TimelineItem[];
};
type Summary = {
  received: number; verified: number; rejected: number; duplicates: number;
  queued: number; running: number; retries: number; dead: number; succeeded: number;
};
type DashboardRow = Delivery & { state: string | null; attempt_count: number | null; available_at: string | null; replay_id: string | null };
export type DashboardData = {
  totals: Summary;
  workers: { id: string; seen_at: string; online: boolean; stopped_at: string | null }[];
  buckets: { at: string; verified: number; rejected: number }[];
  rows: DashboardRow[];
  deadRows: DashboardRow[];
};

const jobsForEvent = (client: PoolClient, event: string) => client.query<Job>(`
  SELECT id, replay_id, state, created_at, available_at, attempt_count, max_attempts, lease_until, finished_at, detail
  FROM jobs WHERE event_id = $1 ORDER BY created_at
`, [event]);

export function eventReport(pool: Pool, id: string): Promise<EventReport | undefined> {
  return transaction(pool, async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: [delivery] } = await client.query<Delivery>('SELECT * FROM deliveries WHERE id = $1', [id]);
    if (!delivery) return;
    const report: EventReport = {
      delivery, event: null, deliveries: [delivery], jobs: [], attempts: [],
      receiverFailures: [], replays: [], effect: null, timeline: [],
    };
    if (delivery.event_id) {
      const key = [delivery.event_id];
      report.event = (await client.query<NonNullable<EventReport['event']>>(
        'SELECT id, source, provider_id, sequence FROM events WHERE id = $1', key)).rows[0];
      report.deliveries = (await client.query<Delivery>(
        'SELECT * FROM deliveries WHERE event_id = $1 ORDER BY received_at, id', key)).rows;
      report.jobs = (await jobsForEvent(client, delivery.event_id)).rows;
      report.attempts = (await client.query<Attempt>(`
        SELECT a.* FROM attempts a JOIN jobs j ON a.job_id = j.id
        WHERE j.event_id = $1 ORDER BY j.created_at, a.number
      `, key)).rows;
      report.receiverFailures = (await client.query<ReceiverFailure>(`
        SELECT job_id, attempt_number, occurred_at, detail
        FROM receiver_failures WHERE event_id = $1 ORDER BY occurred_at
      `, key)).rows;
      report.replays = (await client.query<Replay>(
        'SELECT id, approved_by, approved_at FROM replays WHERE event_id = $1', key)).rows;
      report.effect = (await client.query<NonNullable<EventReport['effect']>>(
        'SELECT outcome, committed_at FROM receipts WHERE event_id = $1', key)).rows[0] ?? null;
    }
    const timeline = report.timeline;
    for (const d of report.deliveries) timeline.push({ at: d.received_at, action: d.disposition, reference: d.id });
    for (const approval of report.replays) {
      timeline.push({ at: approval.approved_at, action: 'replay_approved', reference: approval.id });
    }
    for (const attempt of report.attempts) {
      const reference = `${attempt.job_id}/${attempt.number}`;
      timeline.push({ at: attempt.started_at, action: 'attempt_started', reference });
      if (attempt.finished_at) timeline.push({ at: attempt.finished_at, action: attempt.outcome, reference });
      if (attempt.next_at && new Date(attempt.next_at).getTime() <= Date.now()) {
        timeline.push({ at: attempt.next_at, action: 'retry_due', reference });
      }
    }
    for (const failure of report.receiverFailures) {
      timeline.push({ at: failure.occurred_at, action: 'receiver_failure', reference: `${failure.job_id}/${failure.attempt_number}` });
    }
    if (report.effect && delivery.event_id) {
      timeline.push({ at: report.effect.committed_at, action: `receipt_${report.effect.outcome}`, reference: delivery.event_id });
    }
    for (const job of report.jobs) {
      if (job.finished_at) timeline.push({ at: job.finished_at, action: job.state, reference: job.id });
    }
    timeline.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    return report;
  });
}

export function dashboardData(pool: Pool): Promise<DashboardData> {
  return transaction(pool, async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: [totals] } = await client.query<Summary>(`
      WITH inbound AS (
        SELECT count(*)::int AS received,
          count(*) FILTER (WHERE signature = 'verified')::int AS verified,
          count(*) FILTER (WHERE signature = 'rejected')::int AS rejected,
          count(*) FILTER (WHERE disposition = 'duplicate')::int AS duplicates FROM deliveries
      ), queue AS (
        SELECT count(*) FILTER (WHERE state = 'queued')::int AS queued,
          count(*) FILTER (WHERE state = 'running')::int AS running,
          count(*) FILTER (WHERE state = 'retry')::int AS retries,
          count(*) FILTER (WHERE state = 'dead_letter')::int AS dead,
          count(*) FILTER (WHERE state = 'succeeded')::int AS succeeded
        FROM (SELECT DISTINCT ON (event_id) state FROM jobs ORDER BY event_id, created_at DESC) current
      )
      SELECT * FROM inbound CROSS JOIN queue
    `);
    const workers = (await client.query<DashboardData['workers'][number]>(`
      SELECT id, seen_at, stopped_at, stopped_at IS NULL AND seen_at > now() - interval '5 seconds' AS online
      FROM workers ORDER BY online DESC, seen_at DESC LIMIT 25
    `)).rows;
    const buckets = (await client.query<DashboardData['buckets'][number]>(`
      WITH timing AS (SELECT date_bin('1 minute', now(), TIMESTAMPTZ '2000-01-01 00:00:00+00') AS latest),
      counts AS (
        SELECT date_bin('1 minute', received_at, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS at,
          count(*) FILTER (WHERE signature = 'verified')::int AS verified,
          count(*) FILTER (WHERE signature = 'rejected')::int AS rejected
        FROM deliveries, timing WHERE received_at >= latest - interval '11 minutes' GROUP BY 1
      )
      SELECT series.at, coalesce(verified, 0) AS verified, coalesce(rejected, 0) AS rejected
      FROM timing, generate_series(latest - interval '11 minutes', latest, interval '1 minute') series(at)
      LEFT JOIN counts USING (at) ORDER BY series.at
    `)).rows;
    const deliveryRows = `
      SELECT d.*, j.state, j.attempt_count, j.available_at, j.replay_id
      FROM deliveries d LEFT JOIN LATERAL (
        SELECT state, attempt_count, available_at, replay_id FROM jobs
        WHERE event_id = d.event_id ORDER BY created_at DESC LIMIT 1
      ) j ON true
    `;
    const order = 'ORDER BY d.received_at DESC, d.id DESC LIMIT 150';
    const { rows } = await client.query<DashboardRow>(`${deliveryRows} ${order}`);
    const { rows: deadRows } = await client.query<DashboardRow>(`
      ${deliveryRows} WHERE d.disposition = 'accepted' AND j.state = 'dead_letter' ${order}
    `);
    return { totals, workers, buckets, rows, deadRows };
  });
}
