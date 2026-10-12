import { test, expect, Page } from '@playwright/test';
import path from 'node:path';

const VIEWPORT = { width: 390, height: 844 };
const SCREENSHOT_DIR = path.join(process.cwd(), 'docs/qa/cover-390x844');

test.use({
  viewport: VIEWPORT,
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 1,
});

async function swipePad(page: Page) {
  const pad = page.locator('#dragPad');
  const box = await pad.boundingBox();
  if (!box) return;
  const client = await page.context().newCDPSession(page);
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y, id: 0 }],
  });
  for (let i = 1; i <= 6; i++) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x, y: from.y - i * 8, id: 0 }],
    });
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('Cover spike 390x844', () => {
  test('lobby, match HUD, and results', async ({ page }) => {
    test.setTimeout(180000);
    await page.goto('/?qa=1');
    await page.waitForSelector('#game-container canvas');
    await expect(page.locator('#serverUrl')).toBeVisible();
    await page.evaluate(() => document.fonts.ready).catch(() => undefined);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'lobby.png'), animations: 'disabled' });

    await page.click('#botBtn');
    await page.waitForFunction(
      () => {
        const d = window.__turfDebug;
        return Boolean(
          d &&
            d.ownedCells.p1 >= 15000 &&
            d.drawing.p1 &&
            d.trails.p1 >= 20 &&
            d.trails.p2 >= 20,
        );
      },
      { timeout: 45000 },
    );
    await expect(page.locator('#settings')).toBeHidden();
    await expect(page.locator('#hud')).toBeVisible();
    await expect(page.locator('#dragPad')).toBeVisible();
    await expect(page.locator('#timer')).toBeVisible();
    await expect(page.locator('#debugToggle')).toBeHidden();
    await swipePad(page);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'match.png') });

    await page.waitForFunction(
      () => {
        const d = window.__turfDebug;
        return Boolean(d?.cutFx && d.ownedCells.p1 >= 18000);
      },
      { timeout: 25000 },
    );
    await expect(page.locator('#cutShout')).toBeVisible();
    await expect(page.locator('#cutPopup')).toBeVisible();
    await page.waitForTimeout(280);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'bot-match.png') });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'cut.png') });

    await page.waitForFunction(() => Boolean(window.__turfDebug?.result?.includes('승리')), { timeout: 60000 });
    await expect(page.locator('#matchHud')).toBeVisible();
    await expect(page.locator('#resultOverlay')).toBeVisible();
    await expect(page.locator('#resultTitle')).toHaveText('승리!');
    await expect(page.locator('#rematchBtn')).toBeVisible();
    await page.waitForTimeout(420);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'results.png') });
  });

  test('loss result is from my perspective and keeps board width', async ({ page }) => {
    test.setTimeout(90000);
    await page.goto('/?qa=lose');
    await page.waitForSelector('#game-container canvas');
    await page.click('#botBtn');
    await page.waitForFunction(() => Boolean(window.__turfDebug?.result?.includes('패배')), { timeout: 60000 });
    await expect(page.locator('#resultTitle')).toHaveText('패배');
    await expect(page.locator('#rematchBtn')).toBeVisible();
    await expect(page.locator('#heartsYou .heart.on')).toHaveCount(0);
    const board = page.locator('#game-container');
    const box = await board.boundingBox();
    expect(box?.width).toBeGreaterThan(330);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'results-loss.png') });
  });

  test('hit flashes the screen edge and breaks a heart', async ({ page }) => {
    test.setTimeout(90000);
    await page.goto('/?qa=hit');
    await page.waitForSelector('#game-container canvas');
    await page.click('#botBtn');
    await page.waitForFunction(
      () => {
        const d = window.__turfDebug;
        return Boolean(d?.hitFx && d.ownedCells.p1 >= 15000);
      },
      { timeout: 50000 },
    );
    await expect(page.locator('#hitFlash')).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'hit.png') });
  });
});
