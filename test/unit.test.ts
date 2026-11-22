import { describe, expect, it } from 'vitest';
import { sign, verify, payloadHash, equalsSecret } from '../server/signing.js';
import { retryDelay } from '../server/worker.js';
import { replay, webhook } from '../server/contracts.js';
import { taskSchema, investigationJsonSchema } from '../server/investigation.js';

const key = '11'.repeat(32);
const timestamp = 1_800_000_000;
const raw = Buffer.from('{"a": 1}');
const signature = sign(key, timestamp, raw);

describe('HMAC verification', () => {
  it('accepts the exact bytes and reports the signing time', () => {
    expect(verify(key, String(timestamp), signature, raw, timestamp)).toEqual({
      outcome: 'verified', signedAt: new Date(timestamp * 1000),
    });
  });
  it('rejects semantically equivalent JSON with differing bytes', () => {
    const changed = Buffer.from('{"a":1}');
    expect(verify(key, String(timestamp), signature, changed, timestamp).outcome).toBe('invalid_signature');
    expect(payloadHash(changed)).not.toBe(payloadHash(raw));
  });
  it('rejects the wrong key, malformed tags and repeated header values', () => {
    expect(verify('22'.repeat(32), String(timestamp), signature, raw, timestamp).outcome).toBe('invalid_signature');
    expect(verify(key, String(timestamp), 'v1=0', raw, timestamp).outcome).toBe('invalid_signature');
    expect(verify(key, [String(timestamp)], signature, raw, timestamp).outcome).toBe('invalid_signature');
  });
  it('enforces past and future bounds including the exact boundary', () => {
    for (const direction of [-1, 1]) {
      expect(verify(key, String(timestamp), signature, raw, timestamp + direction * 300).outcome).toBe('verified');
      expect(verify(key, String(timestamp), signature, raw, timestamp + direction * 301).outcome).toBe('stale_timestamp');
    }
  });
  it('rejects absent and wrong-length bearer credentials', () => {
    expect(equalsSecret(key, undefined)).toBe(false);
    expect(equalsSecret(key, key + '1')).toBe(false);
    expect(equalsSecret(key, key)).toBe(true);
  });
});
it('caps the deterministic exponential backoff', () => {
  expect([1, 2, 3, 4].map((attempt) => retryDelay(attempt, 100, 350))).toEqual([100, 200, 350, 350]);
});
it('projects through a typed allowlist and rejects invalid sequence and integer bounds', () => {
  const body = { id: 'n1', stream: 'p1', sequence: 1, value: 17 };
  expect(webhook.parse({ ...body, accessToken: 'synthetic-value' })).toEqual({ ...body, fault: 'none' });
  expect(webhook.safeParse({ ...body, sequence: 0 }).success).toBe(false);
  expect(webhook.safeParse({ ...body, value: 3_000_000_000 }).success).toBe(false);
});
it('requires explicit, narrowly validated replay approval', () => {
  expect(replay.safeParse({ approved: false, reason: 'Receiver restored' }).success).toBe(false);
  expect(replay.safeParse({ approved: true, reason: 'Receiver restored', actor: 'manager' }).success).toBe(false);
  expect(replay.safeParse({ approved: true, reason: 'Receiver restored' }).success).toBe(true);
});
it('publishes schemas for three agent stages and requires separate repair approval', () => {
  expect(investigationJsonSchema().oneOf ?? investigationJsonSchema().anyOf).toHaveLength(3);
  expect(taskSchema.safeParse({
    version: 1,
    phase: 'repair',
    scope: { commit: '1'.repeat(40), scenario: 'E', workspace: 'isolated-local-postgres', outbound: 'loopback-only' },
    investigationRef: '0e68480a-e3c1-41ad-8001-4221a13562c6',
    allowedPaths: ['server/worker.ts'],
  }).success).toBe(false);
});
