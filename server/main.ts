import { execFileSync } from 'node:child_process';
import { api } from './api.js';
import { apiPort, integer, receiverPort, secret } from './config.js';
import { database } from './db.js';
import { receiver } from './receiver.js';
import { Worker } from './worker.js';

const service = process.argv[2];
if (service !== 'api' && service !== 'receiver' && service !== 'worker') throw new Error('Select api, receiver, or worker');
const pool = database(service);
pool.on('error', () => console.error(`Idle ${service} database connection closed`));
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

function revision() {
  if (process.env.VAULT_REVISION) return process.env.VAULT_REVISION;
  try {
    if (execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trim()) return;
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

try {
  await pool.query('SELECT 1');
  if (service === 'worker') {
    const requestMs = integer('VAULT_REQUEST_MS', 2500, 50, 10_000);
    await new Worker(pool, {
      receiverPort: receiverPort(),
      token: secret('VAULT_RECEIVER_TOKEN'),
      pollMs: integer('VAULT_POLL_MS', 200, 10, 2000),
      leaseMs: integer('VAULT_LEASE_MS', 8000, requestMs + 100, 120_000),
      requestMs,
      baseMs: integer('VAULT_RETRY_BASE_MS', 1000, 10, 60_000),
      capMs: integer('VAULT_RETRY_CAP_MS', 30_000, 10, 300_000),
      ackDelayMs: integer('VAULT_TEST_ACK_DELAY_MS', 0, 0, 120_000),
    }).run(controller.signal);
  } else {
    const app = service === 'api' ? await api(pool, {
      webhookSecret: secret('VAULT_WEBHOOK_SECRET'),
      operatorToken: secret('VAULT_OPERATOR_TOKEN'),
      maxAttempts: integer('VAULT_MAX_ATTEMPTS', 3, 1, 10),
      revision: revision(),
    }) : receiver(pool, secret('VAULT_RECEIVER_TOKEN'));
    const address = await app.listen({ host: '127.0.0.1', port: service === 'api' ? apiPort() : receiverPort() });
    console.log(`${service} listening at ${address}`);
    if (!controller.signal.aborted) {
      await new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
    }
    await app.close();
  }
} finally {
  await pool.end();
}
