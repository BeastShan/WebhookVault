import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const secret = () => randomBytes(32).toString('hex');
const dbPassword = secret();
const port = process.env.VAULT_DB_PORT ?? '55432';
if (!/^\d{1,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535) {
  throw new Error('VAULT_DB_PORT must be between 1024 and 65535');
}
const url = (role, password = secret()) =>
  `postgresql://vault_${role}:${password}@127.0.0.1:${port}/webhookvault`;

try {
  writeFileSync('.env', [
    `VAULT_DB_PORT=${port}`,
    `VAULT_DB_PASSWORD=${dbPassword}`,
    `DATABASE_ADMIN_URL=${url('admin', dbPassword)}`,
    `DATABASE_API_URL=${url('api')}`,
    `DATABASE_WORKER_URL=${url('worker')}`,
    `DATABASE_RECEIVER_URL=${url('receiver')}`,
    `VAULT_WEBHOOK_SECRET=${secret()}`,
    `VAULT_RECEIVER_TOKEN=${secret()}`,
    `VAULT_OPERATOR_TOKEN=${secret()}`,
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  console.log('Created .env with generated local credentials.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Using existing .env.');
}
