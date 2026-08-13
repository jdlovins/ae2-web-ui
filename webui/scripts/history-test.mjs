import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
const OUT = fileURLToPath(new URL('../.validate/', import.meta.url));
const PW = process.env.AE2_PW || 'HJKbOiTqNJ4rE4pU';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
await page.goto('http://localhost:5273/', { waitUntil: 'networkidle' });
const pw = page.locator('input[type=password]');
if (await pw.count()) { await pw.first().fill(PW); await page.getByRole('button', { name: /sign in/i }).click(); await page.waitForTimeout(2000); }
await page.locator('button[aria-label="History"]').click();
await page.waitForTimeout(1200);
const entries = page.locator('.entry');
console.log('history entries:', await entries.count());
if (await entries.count()) {
  await entries.first().click();
  await page.waitForTimeout(1500);
  // expand both charts
  for (const t of ['item crafting timeline', 'interface usage timeline']) {
    const b = page.getByRole('button', { name: new RegExp(t, 'i') });
    if (await b.count()) { await b.first().click(); await page.waitForTimeout(400); }
  }
  await page.waitForTimeout(500);
}
await page.screenshot({ path: OUT + 'history-detail.png', fullPage: false });
console.log('done');
await browser.close();
