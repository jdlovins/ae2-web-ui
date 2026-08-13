import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../.validate/', import.meta.url));
mkdirSync(OUT, { recursive: true });
// No default — a literal here is a live credential committed to the repo.
const PW = process.env.AE2_PW;
if (!PW) { console.error('AE2_PW is required: AE2_PW=... node scripts/craft-test.mjs'); process.exit(1); }
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') log('[console.error]', m.text()); });
page.on('pageerror', (e) => log('[pageerror]', e.message));
page.on('request', (r) => { const u = r.url(); if (u.includes('/order') || u.includes('/job')) log('[req]', r.method(), u.replace('http://localhost:5273', '')); });
page.on('response', async (r) => { const u = r.url(); if (u.includes('/order') || u.includes('/job')) log('[res]', r.status(), u.replace('http://localhost:5273', ''), '->', (await r.text().catch(() => '')).slice(0, 120)); });

await page.goto('http://localhost:5273/', { waitUntil: 'networkidle' });
const pw = page.locator('input[type=password]');
if (await pw.count()) { await pw.first().fill(PW); await page.getByRole('button', { name: /sign in/i }).click(); await page.waitForTimeout(2500); }

log('--- click Craft ---');
await page.getByRole('button', { name: 'Craft', exact: true }).first().click();
await page.waitForTimeout(500);

log('--- Calculate ---');
await page.getByRole('button', { name: /calculate/i }).click();
await page.waitForTimeout(2500);
await page.screenshot({ path: OUT + 'craft-plan.png' });

// Inspect Target CPU buttons + Start state
const startBtn = page.getByRole('button', { name: /start job/i });
log('Start job button count:', await startBtn.count());
if (await startBtn.count()) log('Start disabled?', await startBtn.first().isDisabled());
const cpuBtns = page.locator('.cpu');
log('CPU option count:', await cpuBtns.count());

log('--- click Start job ---');
if (await startBtn.count()) {
  await startBtn.first().click({ trial: false }).catch((e) => log('start click err', e.message));
  await page.waitForTimeout(2500);
}
await page.screenshot({ path: OUT + 'craft-after.png' });
log('done');
await browser.close();
