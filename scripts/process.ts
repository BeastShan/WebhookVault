import { spawn } from 'node:child_process';

export function launch(args: string[], overrides: Record<string, string> = {}) {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...overrides }, stdio: 'inherit' });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exited,
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      child.kill(signal);
      const timer = setTimeout(() => child.kill('SIGKILL'), 6500);
      try {
        return await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export const service = (name: 'api' | 'receiver' | 'worker', env?: Record<string, string>) =>
  launch(['--import', 'tsx', 'server/main.ts', name], env);
