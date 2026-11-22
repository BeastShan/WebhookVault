import { z } from 'zod';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
export const webhook = z.object({
  id: identifier,
  stream: identifier,
  sequence: z.number().int().min(1).max(2_147_483_647),
  value: z.number().int().min(-2_147_483_648).max(2_147_483_647),
  fault: z.enum(['none', 'transient', 'permanent']).default('none'),
});
export type Webhook = z.input<typeof webhook>;
export const replay = z.strictObject({
  approved: z.literal(true),
  reason: z.string().trim().min(8).max(160).regex(/^[a-zA-Z0-9 .,()_'-]+$/),
});
export const deliveryRequest = z.strictObject({
  jobId: z.uuid(),
  leaseToken: z.uuid(),
});
export const receipt = z.strictObject({
  outcome: z.enum(['applied', 'stale']),
  deduplicated: z.boolean(),
});
