import { dashboardPort } from '../server/config.js';
import { launch, service } from './process.js';

const mode = process.argv.includes('--production') ? 'start' : 'dev';
const services = [
  service('api'), service('receiver'), service('worker'),
  launch(['node_modules/next/dist/bin/next', mode, 'dashboard', '--hostname', '127.0.0.1', '--port', String(dashboardPort())]),
];
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
const abort = new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
try {
  const first = await Promise.race([abort, ...services.map(({ exited }) => exited)]);
  if (first) {
    console.error('A WebhookVault process exited. Stopping the remaining services.');
    process.exitCode = first.code || 1;
  }
} finally {
  await Promise.all(services.map((entry) => entry.stop()));
}
