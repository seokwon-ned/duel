/**
 * Lee P1 repro: first match canvas must fit #game-container.
 * Before the fix, Scale.FIT used the lobby parent height (~555px in a 484px area)
 * and clipped the orange orb at the bottom. Resize/rematch hid the bug.
 *
 * Usage: start the client preview, then `node qa/o7.mjs`.
 */
import { chromium } from '@playwright/test';

const VIEWPORT = { width: 390, height: 844 };
const url = process.env.O7_URL || 'http://127.0.0.1:4173/?qa=1';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.click('#botBtn');
await page.waitForFunction(() => document.getElementById('app')?.classList.contains('playing'));
await page.waitForFunction(() => {
  const area = document.getElementById('game-container')?.getBoundingClientRect();
  const canvas = document.querySelector('#game-container canvas')?.getBoundingClientRect();
  return Boolean(area && canvas && canvas.height > 10);
}, { timeout: 5000 });
await page.waitForTimeout(80);

const bounds = await page.evaluate(() => {
  const area = document.getElementById('game-container').getBoundingClientRect();
  const canvas = document.querySelector('#game-container canvas').getBoundingClientRect();
  return {
    areaH: Math.round(area.height),
    canvasH: Math.round(canvas.height),
    overflow: Math.round(canvas.height - area.height),
  };
});

const ok = bounds.canvasH <= bounds.areaH + 2 && bounds.overflow <= 2;
console.log(ok ? 'qa/o7 PASS' : 'qa/o7 FAIL', bounds);
await browser.close();
process.exit(ok ? 0 : 1);
