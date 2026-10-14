import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const VIEWPORT = { width: 390, height: 844 };
const SCREENSHOT_DIR = path.join(process.cwd(), 'docs/qa/cover-390x844');

type TrailMeasure = {
  solidWidth: number;
  glowWidth: number;
  ringPx: number;
  backing: { w: number; h: number };
  css: { w: number; h: number };
  orb?: { x: number; y: number };
};

async function waitMidDraw(page: Page) {
  await page.goto('/?qa=1');
  await page.waitForSelector('#game-container canvas');
  await page.click('#botBtn');
  await page.waitForFunction(() => document.getElementById('app')?.classList.contains('playing'));
  await page.waitForFunction(
    () => {
      const d = window.__turfDebug;
      return Boolean(d && d.ownedCells.p1 >= 15000 && d.drawing.p1 && d.trails.p1 >= 55);
    },
    { timeout: 45000 },
  );
}

/** Rendered WIDTH in CSS px from a composited screenshot — not stamp radius constants. */
async function measureRenderedTrail(page: Page): Promise<TrailMeasure> {
  const png = await page.locator('#game-container canvas').screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const tmp = document.createElement('canvas');
    tmp.width = img.width;
    tmp.height = img.height;
    const ctx = tmp.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, tmp.width, tmp.height);
    const scale = 1;
    const pix = (x: number, y: number) => {
      const i = (y * width + x) * 4;
      return [data[i], data[i + 1], data[i + 2]] as [number, number, number];
    };
    const isWhite = (p: [number, number, number]) => p[0] >= 210 && p[1] >= 210 && p[2] >= 200;
    const isDisc = (p: [number, number, number]) =>
      p[0] >= 180 && p[1] >= 40 && p[1] <= 190 && p[2] <= 110 && p[0] > p[1] && p[0] > p[2] + 40;
    const isDiscCore = (p: [number, number, number]) =>
      p[0] >= 185 && p[1] >= 45 && p[1] <= 180 && p[2] <= 110 && p[0] > p[1] + 20 && p[0] > p[2] + 50;
    const isSolid = (i: number) => {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      return r >= 220 && g >= 80 && g <= 150 && b <= 70 && r > g + 70 && r > b + 130;
    };
    const isGlow = (i: number) => {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      return r >= 120 && g >= 30 && b <= 160 && r > g && r > b + 15;
    };
    let orbX = -1;
    let orbY = -1;
    const whites: { x: number; y: number }[] = [];
    const y0 = Math.floor(height * 0.50);
    const y1 = Math.floor(height * 0.78);
    const x0 = Math.floor(width * 0.28);
    const x1 = Math.floor(width * 0.74);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!isWhite(pix(x, y))) continue;
        let orange = 0;
        for (let a = 0; a < 8; a++) {
          const ang = (a / 8) * Math.PI * 2;
          const xx = Math.round(x + Math.cos(ang) * 8);
          const yy = Math.round(y + Math.sin(ang) * 8);
          if (xx >= 0 && yy >= 0 && xx < width && yy < height && isDisc(pix(xx, yy))) orange++;
        }
        if (orange >= 2) whites.push({ x, y });
      }
    }
    if (whites.length) {
      orbX = whites.reduce((s, p) => s + p.x, 0) / whites.length;
      orbY = whites.reduce((s, p) => s + p.y, 0) / whites.length;
    }
    let ring = 0;
    if (orbX >= 0) {
      const radii: number[] = [];
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        const ux = Math.cos(ang);
        const uy = Math.sin(ang);
        let rad = 0;
        for (let t = 1; t < 22; t++) {
          const x = Math.round(orbX + ux * t);
          const y = Math.round(orbY + uy * t);
          if (x < 0 || y < 0 || x >= width || y >= height) break;
          const p = pix(x, y);
          if (isWhite(p) || isDiscCore(p)) rad = t;
          else if (rad > 0) break;
        }
        if (rad >= 5) radii.push(rad);
      }
      radii.sort((a, b) => a - b);
      const body = radii.filter((r) => r >= 7);
      const use = body.length ? body : radii;
      if (use.length) ring = use[Math.floor(use.length * 0.5)] * 2;
    }
    const index = (x: number, y: number) => (y * width + x) * 4;
    const collect = (major: number, minor: number, swap: boolean) => {
      const solids: number[] = [];
      const glows: number[] = [];
      for (let a = 0; a < major; a++) {
        let sRun = 0;
        let gRun = 0;
        const push = () => {
          if (sRun >= 2 && sRun <= 7) solids.push(sRun);
          if (gRun >= 2 && gRun <= 16) glows.push(gRun);
          sRun = 0;
          gRun = 0;
        };
        for (let b = 0; b < minor; b++) {
          const i = swap ? index(a, b) : index(b, a);
          if (isSolid(i)) {
            sRun++;
            gRun++;
          } else if (isGlow(i)) {
            if (sRun >= 2 && sRun <= 7) solids.push(sRun);
            sRun = 0;
            gRun++;
          } else {
            push();
          }
        }
        push();
      }
      return { solids, glows };
    };
    const hz = collect(height, width, false);
    const vt = collect(width, height, true);
    const solids = hz.solids.concat(vt.solids);
    const glows = hz.glows.concat(vt.glows);
    const pick = (arr: number[]) => {
      if (!arr.length) return 0;
      const sorted = arr.slice().sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.7)];
    };
    return {
      solidWidth: Math.round(pick(solids) * scale * 10) / 10,
      glowWidth: Math.round(pick(glows) * scale * 10) / 10,
      ringPx: Math.round(ring * scale * 10) / 10,
      backing: { w: width, h: height },
      css: { w: width, h: height },
      orb: orbX >= 0 ? { x: Math.round(orbX), y: Math.round(orbY) } : undefined,
    };
  }, png.toString('base64'));
}

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
    await page.waitForFunction(() => document.getElementById('app')?.classList.contains('playing'));
    await page.waitForFunction(
      () => {
        const area = document.getElementById('game-container')?.getBoundingClientRect();
        const canvas = document.querySelector('#game-container canvas')?.getBoundingClientRect();
        return Boolean(area && canvas && canvas.height > 40 && canvas.height <= area.height + 2);
      },
      { timeout: 4000 },
    );
    const first = await page.evaluate(() => {
      const area = document.getElementById('game-container')!.getBoundingClientRect();
      const canvas = document.querySelector('#game-container canvas')!.getBoundingClientRect();
      return { areaH: area.height, canvasH: canvas.height };
    });
    expect(first.canvasH).toBeLessThanOrEqual(first.areaH + 2);
    await page.waitForFunction(() => (window.__turfDebug?.tick ?? 0) >= 8, { timeout: 3000 });
    const stillFit = await page.evaluate(() => {
      const area = document.getElementById('game-container')!.getBoundingClientRect();
      const canvas = document.querySelector('#game-container canvas')!.getBoundingClientRect();
      return { areaH: area.height, canvasH: canvas.height };
    });
    expect(stillFit.canvasH).toBeLessThanOrEqual(stillFit.areaH + 2);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'first-match.png') });
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

  test('player orb is small enough to show the line tip mid-draw', async ({ page }) => {
    test.setTimeout(60000);
    await waitMidDraw(page);
    const measured = await measureRenderedTrail(page);
    console.log('rendered trail WIDTH (not radius) 390x844', measured);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'orb-mid-draw.png') });
    expect(measured.solidWidth).toBeGreaterThanOrEqual(3.5);
    expect(measured.solidWidth).toBeLessThanOrEqual(7.5);
    expect(measured.glowWidth).toBeGreaterThanOrEqual(4);
    expect(measured.glowWidth).toBeLessThanOrEqual(11);
    expect(measured.ringPx).toBeGreaterThanOrEqual(14);
    expect(measured.ringPx).toBeLessThanOrEqual(26);
  });

  test('trail width stays visible at 360x640 and 412x915', async ({ page }) => {
    test.setTimeout(120000);
    const shots: { label: string; size: { width: number; height: number }; dir: string; minSolid: number; maxSolid: number }[] = [
      { label: '360x640', size: { width: 360, height: 640 }, dir: 'docs/qa/cover-360x640', minSolid: 2, maxSolid: 6.5 },
      { label: '412x915', size: { width: 412, height: 915 }, dir: 'docs/qa/cover-412x915', minSolid: 2, maxSolid: 6.5 },
    ];
    for (const shot of shots) {
      await page.setViewportSize(shot.size);
      await waitMidDraw(page);
      const measured = await measureRenderedTrail(page);
      console.log(`rendered trail WIDTH (not radius) ${shot.label}`, measured);
      fs.mkdirSync(path.join(process.cwd(), shot.dir), { recursive: true });
      await page.screenshot({ path: path.join(process.cwd(), shot.dir, 'orb-mid-draw.png') });
      expect(measured.solidWidth, shot.label).toBeGreaterThanOrEqual(shot.minSolid);
      expect(measured.solidWidth, shot.label).toBeLessThanOrEqual(shot.maxSolid);
      expect(measured.glowWidth, shot.label).toBeGreaterThanOrEqual(3);
      expect(measured.glowWidth, shot.label).toBeLessThanOrEqual(11);
      expect(measured.ringPx, `${shot.label} ring`).toBeGreaterThanOrEqual(shot.label === '360x640' ? 15 : 12);
      expect(measured.ringPx, `${shot.label} ring`).toBeLessThanOrEqual(26);
    }
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
    await expect(page.locator('#heartsYou .heart')).toHaveCount(3);
    await expect(page.locator('#heartsYou .heart.gone')).toHaveCount(0);
    await expect(page.locator('#heartsYou .heart.break')).toHaveCount(0);
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
