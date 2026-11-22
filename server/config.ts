import { existsSync } from 'node:fs';
import { z } from 'zod';

if (existsSync('.env')) process.loadEnvFile('.env');

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Run npm run local:setup.`);
  return value;
}

export function secret(name: string): string {
  return z.string().regex(/^[a-f0-9]{64}$/).parse(env(name));
}

export function integer(name: string, fallback: number, min: number, max: number): number {
  return z.coerce.number().int().min(min).max(max).parse(process.env[name] ?? fallback);
}

export const apiPort = () => integer('VAULT_API_PORT', 4310, 1024, 65535);
export const receiverPort = () => integer('VAULT_RECEIVER_PORT', 4311, 1024, 65535);
export const dashboardPort = () => integer('VAULT_DASHBOARD_PORT', 3000, 1024, 65535);
