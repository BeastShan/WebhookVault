import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { database } from '../server/db.js';
import { client, until } from './client.js';
import { service } from './process.js';

const settings = {
  VAULT_API_PORT: '14310',
  VAULT_RECEIVER_PORT: '14311',
  VAULT_MAX_ATTEMPTS: '3',
  VAULT_REQUEST_MS: '500',
  VAULT_LEASE_MS: '1800',
  VAULT_POLL_MS: '30',
  VAULT_RETRY_BASE_MS: '140',
  VAULT_RETRY_CAP_MS: '250',
  VAULT_TEST_ACK_DELAY_MS: '0',
};

export async function startLab(overrides: Record<string, string> = {}) {
  const env = { ...settings, ...overrides };
  const http = client(`http://127.0.0.1:${env.VAULT_API_PORT}`);
  const api = service('api', env);
  const receiver = service('receiver', env);
  let worker = service('worker', env);
  const pool = database('api');
  const stop = () => Promise.all([api.stop(), receiver.stop(), worker.stop(), pool.end()]);
  try {
    await until(async () => {
      try {
        if ((await http.request('/health')).ok) return true;
      } catch {
        // The child may still be binding the port.
      }
    }, 'local API health');
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    http, pool, stop,
    async restartWorker(ackDelayMs = 0) {
      await worker.stop();
      worker = service('worker', { ...env, VAULT_TEST_ACK_DELAY_MS: String(ackDelayMs) });
    },
    async killWorker() {
      const pid = worker.child.pid;
      const result = await worker.stop('SIGKILL');
      assert.equal(result.signal, 'SIGKILL');
      return { pid, signal: result.signal };
    },
  };
}

export type Lab = Awaited<ReturnType<typeof startLab>>;
export function sample(name: string, sequence = 1) {
  const id = `${name}-${randomUUID().slice(0, 12)}`;
  return { id, stream: id, sequence, value: sequence * 100 };
}
