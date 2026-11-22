import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const timestampToleranceSeconds = 300;
export const payloadHash = (body: Buffer) => createHash('sha256').update(body).digest('hex');

export function sign(secret: string, time: number, body: Buffer): string {
  return `v1=${createHmac('sha256', Buffer.from(secret, 'hex')).update(`${time}.`).update(body).digest('hex')}`;
}

export function equalsSecret(expected: string, candidate: string | undefined): boolean {
  return candidate !== undefined && Buffer.byteLength(candidate) === Buffer.byteLength(expected)
    && timingSafeEqual(Buffer.from(expected), Buffer.from(candidate));
}

export function verify(secret: string, time: unknown, signature: unknown, body: Buffer, now: number) {
  if (typeof time !== 'string' || !/^\d{10}$/.test(time) ||
      typeof signature !== 'string' || !/^v1=[a-f0-9]{64}$/.test(signature)) {
    return { outcome: 'invalid_signature' as const, signedAt: null };
  }
  const seconds = Number(time);
  if (Math.abs(now - seconds) > timestampToleranceSeconds) {
    return { outcome: 'stale_timestamp' as const, signedAt: null };
  }
  if (!equalsSecret(sign(secret, seconds, body), signature)) {
    return { outcome: 'invalid_signature' as const, signedAt: null };
  }
  return { outcome: 'verified' as const, signedAt: new Date(seconds * 1000) };
}
