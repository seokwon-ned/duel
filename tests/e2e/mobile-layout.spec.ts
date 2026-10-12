import { test, expect, Page } from '@playwright/test';
import path from 'node:path';

const VIEWPORT = { width: 390, height: 844 };
const SCREENSHOT_DIR = path.join(process.cwd(), 'docs/qa/mobile-390x844');

test.use({
  viewport: VIEWPORT,
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 1,
});

async function waitForCanvas(page: Page) {
  await page.waitForSelector('#game-container canvas', { timeout: 15000 });
}

function assertInsideViewport(box: { x: number; y: number; width: number; height: number }) {
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(VIEWPORT.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(VIEWPORT.height + 1);
}

async function swipeWithTouch(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const client = await page.context().newCDPSession(page);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y, id: 0 }],
  });

  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
          id: 0,
        },
      ],
    });
  }

  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
}

test.describe('P0 mobile 390x844', () => {
  test('lobby, bot match, and results fit the viewport with touch swipe', async ({ page }) => {
    test.setTimeout(60000);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await waitForCanvas(page);

    const lobbyCanvas = await page.locator('#game-container canvas').boundingBox();
    expect(lobbyCanvas).toBeTruthy();
    assertInsideViewport(lobbyCanvas!);
    expect(lobbyCanvas!.width).toBeGreaterThan(200);
    expect(lobbyCanvas!.height).toBeGreaterThan(200);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'lobby.png'),
      animations: 'disabled',
    });

    await page.click('#botBtn');
    await page.waitForFunction(
      () => Boolean(window.__turfDebug && window.__turfDebug.tick > 5),
      { timeout: 15000 }
    );

    const matchCanvas = await page.locator('#game-container canvas').boundingBox();
    expect(matchCanvas).toBeTruthy();
    assertInsideViewport(matchCanvas!);

    const matchHud = page.locator('#matchHud');
    await expect(matchHud).toBeVisible();
    await expect(matchHud).toContainText('You:');
    const hudBox = await matchHud.boundingBox();
    expect(hudBox).toBeTruthy();
    assertInsideViewport(hudBox!);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'bot-match.png'),
      animations: 'disabled',
    });

    const before = await page.evaluate(() => window.__turfDebug?.direction);
    expect(before).toBe('RIGHT');

    await swipeWithTouch(page, { x: 195, y: 700 }, { x: 195, y: 640 });

    await page.waitForFunction(
      () => window.__turfDebug?.direction === 'UP' || Boolean(window.__turfDebug?.result),
      { timeout: 5000 }
    );

    await page.waitForFunction(
      () => Boolean(window.__turfDebug?.result),
      { timeout: 10000 }
    );

    await expect(matchHud).toBeVisible();
    await expect(matchHud).toContainText(/wins|Draw/i);
    const resultBox = await matchHud.boundingBox();
    expect(resultBox).toBeTruthy();
    assertInsideViewport(resultBox!);

    const resultCanvas = await page.locator('#game-container canvas').boundingBox();
    expect(resultCanvas).toBeTruthy();
    assertInsideViewport(resultCanvas!);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'results.png'),
      animations: 'disabled',
    });
  });
});
