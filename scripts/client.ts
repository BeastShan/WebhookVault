import { setTimeout as pause } from 'node:timers/promises';
import { secret } from '../server/config.js';
import type { Webhook } from '../server/contracts.js';
import type { DashboardData, EventReport } from '../server/reports.js';
import { sign } from '../server/signing.js';

export async function until<T>(read: () => Promise<T | undefined>, description: string, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await pause(35);
  }
}

type Submission = { deliveryId: string; eventId: string | null; disposition: string };
export function client(base: string) {
  const request = (path: string, init?: RequestInit) => fetch(base + path, {
    signal: AbortSignal.timeout(2500), ...init,
  });
  return {
    request,
    async send(data: Webhook, options: { tamper?: boolean; timestamp?: number; raw?: string } = {}) {
      const body = Buffer.from(options.raw ?? JSON.stringify(data));
      const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
      const response = await request('/webhooks/synthetic', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-vault-timestamp': String(timestamp),
          'x-vault-signature': sign(secret('VAULT_WEBHOOK_SECRET'), timestamp, body),
        },
        body: options.tamper ? Buffer.concat([body, Buffer.from(' ')]) : body,
      });
      return { status: response.status, ...await response.json() as Submission };
    },
    async dashboard(): Promise<DashboardData> {
      const response = await request('/api/dashboard');
      if (!response.ok) throw new Error(`Dashboard returned HTTP ${response.status}`);
      return response.json();
    },
    async report(id: string): Promise<EventReport> {
      const response = await request(`/api/deliveries/${id}/report`);
      if (!response.ok) throw new Error(`Report returned HTTP ${response.status}`);
      return response.json();
    },
    async waitReport(id: string, check: (report: EventReport) => boolean) {
      return until(async () => {
        const report = await this.report(id);
        if (check(report)) return report;
      }, `delivery ${id}`);
    },
    async replay(id: string, approval: unknown, token?: string) {
      return request(`/api/events/${id}/replay`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(approval),
      });
    },
  };
}
