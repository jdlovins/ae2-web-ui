// Headless validation driver. Uses the system Microsoft Edge (no download).
// Logs in, walks every view, captures screenshots + console/network errors.
//
//   AE2_PW=... node scripts/validate.mjs
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const TARGET_URL = process.env.AE2_URL || 'http://localhost:5273/';
const PW = process.env.AE2_PW || 'HJKbOiTqNJ4rE4pU';
const OUT = fileURLToPath(new URL('../.validate/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const log = [];
const shot = async (page, name) => { await page.screenshot({ path: OUT + name + '.png', fullPage: false }); log.push(`shot: ${name}.png`); };

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.push(`[console.${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => log.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => { const u = r.url(); if (!u.includes('favicon')) log.push(`[requestfailed] ${u} :: ${r.failure()?.errorText}`); });
page.on('response', (r) => { if (r.status() >= 400) log.push(`[http ${r.status()}] ${r.url()}`); });

const step = async (name, fn) => {
  try { await fn(); log.push(`OK: ${name}`); }
  catch (e) { log.push(`FAIL: ${name} :: ${e.message}`); }
};

await step('load', async () => { await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 20000 }); });
await shot(page, '01-initial');

await step('login', async () => {
  const pw = page.locator('input[type=password]');
  if (await pw.count()) {
    await pw.first().fill(PW);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForTimeout(2500);
  }
});
await shot(page, '02-items');

await step('open-settings', async () => {
  await page.locator('button[aria-label="Settings"]').click();
  await page.waitForTimeout(400);
});
await shot(page, '03-settings');
await step('close-settings', async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(300); });

await step('search', async () => {
  const s = page.locator('input[placeholder="Search items…"]');
  await s.fill('iron');
  await page.waitForTimeout(600);
});
await shot(page, '04-search-iron');
await step('clear-search', async () => { await page.locator('input[placeholder="Search items…"]').fill(''); await page.waitForTimeout(400); });

await step('order-dialog', async () => {
  await page.getByRole('button', { name: 'Craft', exact: true }).first().click();
  await page.waitForTimeout(600);
});
await shot(page, '05-order-quantity');
await step('calculate', async () => {
  const c = page.getByRole('button', { name: /calculate/i });
  if (await c.count()) { await c.click(); await page.waitForTimeout(2500); }
});
await shot(page, '06-order-plan');
await step('close-order', async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(300); });

await step('crafting-view', async () => {
  await page.locator('button[aria-label="Crafting"]').click();
  await page.waitForTimeout(1500);
});
await shot(page, '07-crafting');

await step('history-view', async () => {
  await page.locator('button[aria-label="History"]').click();
  await page.waitForTimeout(1500);
});
await shot(page, '08-history');

// Mobile pass
await page.setViewportSize({ width: 390, height: 780 });
await step('mobile-items', async () => {
  await page.locator('button[aria-label="Items"]').click();
  await page.waitForTimeout(800);
});
await shot(page, '09-mobile-items');

await browser.close();
writeFileSync(OUT + 'log.txt', log.join('\n') + '\n');
console.log(log.join('\n'));
console.log('\nScreenshots + log in .validate/');
