import { z } from 'zod';
import type { EventReport } from './reports.js';

const commit = z.string().regex(/^[a-f0-9]{40}$/);
const taskScope = z.strictObject({
  commit,
  scenario: z.enum(['D', 'E', 'G']),
  workspace: z.literal('isolated-local-postgres'),
  outbound: z.literal('loopback-only'),
});
const approval = z.strictObject({ approved: z.literal(true), reference: z.string().min(1).max(120) });
const investigation = z.strictObject({
  version: z.literal(1),
  phase: z.literal('investigation'),
  scope: taskScope,
  eventId: z.uuid(),
  deliveryId: z.uuid(),
  logs: z.array(z.strictObject({
    jobId: z.uuid(), attempt: z.number().int().positive(), outcome: z.enum(['retryable', 'lease_expired']),
    status: z.number().int().min(100).max(599).nullable(),
  })).min(1).max(20),
});
const repair = z.strictObject({
  version: z.literal(1),
  phase: z.literal('repair'),
  scope: taskScope,
  investigationRef: z.uuid(),
  approval,
  allowedPaths: z.array(z.string().regex(/^(server|test|scripts)\/[a-zA-Z0-9/_-]+\.ts$/)).min(1),
});
const verification = z.strictObject({
  version: z.literal(1),
  phase: z.literal('verification'),
  scope: taskScope,
  repairRef: z.uuid(),
  candidateCommit: commit,
  checks: z.tuple([z.literal('original-failure'), z.literal('idempotency'), z.literal('ordering'), z.literal('git-diff')]),
});
export const taskSchema = z.discriminatedUnion('phase', [investigation, repair, verification]);
export const investigationJsonSchema = () => z.toJSONSchema(taskSchema);

export function exportInvestigation(report: EventReport, revision: string | undefined) {
  if (!revision || !report.event) return;
  const failedAttempts = report.attempts.flatMap((attempt) => {
    if (attempt.outcome !== 'retryable' && attempt.outcome !== 'lease_expired') return [];
    return [{ jobId: attempt.job_id, attempt: attempt.number, outcome: attempt.outcome, status: attempt.http_status }];
  });
  const scenario = report.attempts.some((attempt) => attempt.outcome === 'lease_expired') ? 'G' :
    report.jobs[0]?.state === 'dead_letter' ? 'E' : 'D';
  const result = investigation.safeParse({
    version: 1,
    phase: 'investigation',
    eventId: report.event.id,
    deliveryId: report.delivery.id,
    scope: { commit: revision, scenario, workspace: 'isolated-local-postgres', outbound: 'loopback-only' },
    logs: failedAttempts,
  });
  return result.success ? result.data : undefined;
}
