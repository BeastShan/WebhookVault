import { expect, test } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { secret } from '../server/config.js';
import { client } from '../scripts/client.js';
import { sample } from '../scripts/lab.js';

const http = client('http://127.0.0.1:4310');
const screenshots = resolve('evidence/screenshots');
test.beforeAll(async () => { await mkdir(screenshots, { recursive: true }); });

test('shows verified and rejected requests, filters live state, and downloads a real incident', async ({ page }) => {
  const event = sample('console-success');
  const accepted = await http.send(event);
  expect(accepted.status).toBe(202);
  await http.waitReport(accepted.deliveryId, (report) => report.jobs[0]?.state === 'succeeded');
  await http.send(event);
  const rejected = await http.send(sample('console-rejected'), { tamper: true });
  await page.goto('/');
  await expect(page.getByText('API connected')).toBeVisible();
  const totals = (await http.dashboard()).totals;
  await expect(page.locator('.metric').filter({ hasText: 'Total deliveries' }).locator('strong')).toHaveText(String(totals.received));
  await expect(page.getByRole('heading', { name: 'Delivery activity' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: event.id }).filter({ hasText: 'Duplicate' })).toBeVisible();
  await page.screenshot({ path: resolve(screenshots, 'overview.png') });
  await page.getByRole('button', { name: 'Rejected', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: event.id })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search deliveries' }).fill(rejected.deliveryId);
  await page.getByRole('button', { name: 'Rejected request', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('This request did not enter the processing queue.')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    drawer.getByRole('link', { name: 'Incident report' }).click(),
  ]);
  const incident = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(incident.delivery.id).toBe(rejected.deliveryId);
  expect(incident.delivery.signature).toBe('rejected');
  expect(incident.attempts).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
});

test('shows retry schedules, enforces explicit approval, and displays the audited replay', async ({ page }) => {
  const event = sample('console-dead-letter');
  const accepted = await http.send({ ...event, fault: 'permanent' });
  expect(accepted.status).toBe(202);
  await page.goto('/');
  const row = page.getByRole('row').filter({ hasText: event.id });
  await expect(row.getByText(/Next .* UTC/)).toBeVisible();
  await http.waitReport(accepted.deliveryId, (report) => report.jobs[0]?.state === 'dead_letter');
  await page.getByRole('button', { name: /Dead letter/ }).click();
  await expect(page.getByRole('heading', { name: 'Dead-letter queue' })).toBeVisible();
  await page.getByRole('button', { name: event.id }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('heading', { name: 'Delivery attempts' })).toBeVisible();
  await expect(drawer.getByText('retryable · HTTP 503', { exact: true })).toHaveCount(3);
  await expect(drawer.getByRole('button', { name: 'Queue replay' })).toBeDisabled();
  await page.screenshot({ path: resolve(screenshots, 'dead-letter.png') });
  await drawer.getByLabel('Operator token').fill('invalid-demo-token');
  await drawer.getByLabel('Audit reason').fill('Validate controlled redrive');
  await drawer.getByLabel('I approve this replay').check();
  await drawer.getByRole('button', { name: 'Queue replay' }).click();
  await expect(drawer.getByRole('status')).toHaveText('operator authorization required');
  await drawer.getByLabel('Operator token').fill(secret('VAULT_OPERATOR_TOKEN'));
  await drawer.getByRole('button', { name: 'Queue replay' }).click();
  await expect(drawer.getByRole('status')).toContainText('Replay queued');
  await expect(drawer.getByText('Replay execution')).toBeVisible();
  const report = await http.waitReport(accepted.deliveryId, (entry) => entry.jobs[1]?.state === 'dead_letter');
  expect(report.replays).toHaveLength(1);
  expect(report.jobs.map((job) => job.attempt_count)).toEqual([3, 2]);
  await expect(drawer.getByText('replay approved', { exact: true })).toBeVisible();
});

test('refreshes without navigation and shows a responsive worker health view', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByText('API connected')).toBeVisible();
  const event = sample('console-auto-refresh');
  await http.send(event);
  await expect(page.getByRole('button', { name: event.id })).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: 'Workers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Background workers' })).toBeVisible();
  await expect(page.getByText('1 active')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: resolve(screenshots, 'workers-mobile.png') });
});
