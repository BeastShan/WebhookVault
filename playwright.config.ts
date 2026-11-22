import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './browser',
  workers: 1,
  timeout: 35_000,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 1000 },
    baseURL: 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run start',
    url: 'http://127.0.0.1:3000',
    timeout: 45_000,
    env: { NEXT_TELEMETRY_DISABLED: '1', VAULT_RETRY_BASE_MS: '1800', VAULT_RETRY_CAP_MS: '4000' },
    reuseExistingServer: false,
  },
});
