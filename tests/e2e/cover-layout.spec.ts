import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const VIEWPORT = { width: 390, height: 844 };
const SCREENSHOT_DIR = path.join(process.cwd(), 'docs/qa/cover-390x844');

type TrailMeasure = {
  solidWidth: number;
  glowWidth: number;
  whiteCore: number;
  ringPx: number;
  hasWhiteCenter: boolean;
  centerRgb: [number, number, number] | null;
  orangeRgb: [number, number, number] | null;
  backing: { w: number; h: number };
  css: { w: number; h: number };
  orb?: { x: number; y: number };
  sections: number;
  missing: number;
  missingPct: number;
  whiteMedian: number;
  whiteMin: number;
  orangeMedian: number;
  sampleMins: number[];
  missAt: { i: number; dTip: number; dStart: number; min: number }[];
};

async function waitTrailRedraw(page: Page) {
  const gen = await page.evaluate(() => window.__turfDebug?.trailPaintGen ?? 0);
  await page.waitForFunction((g) => (window.__turfDebug?.trailPaintGen ?? 0) > g, gen, { timeout: 4000 });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/** Next paint must be an incremental append (not a full sheet redraw). */
async function waitTrailAppend(page: Page) {
  const gen = await page.evaluate(() => window.__turfDebug?.trailPaintGen ?? 0);
  await page.waitForFunction(
    (g) => {
      const d = window.__turfDebug;
      return Boolean(d && d.trailPaintKind === 'append' && d.trailPaintGen > g);
    },
    gen,
    { timeout: 8000 },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

function expectTrailBand(measured: TrailMeasure, minSolid: number) {
  expect(measured.hasWhiteCenter, `center ${measured.centerRgb}`).toBe(true);
  expect(measured.whiteCore).toBeGreaterThanOrEqual(1);
  expect(measured.whiteCore).toBeLessThanOrEqual(3.5);
  expect(measured.solidWidth).toBeGreaterThanOrEqual(minSolid);
  expect(measured.solidWidth).toBeLessThanOrEqual(8.5);
  expect(measured.glowWidth).toBeGreaterThanOrEqual(14);
  expect(measured.glowWidth).toBeLessThanOrEqual(36);
  expect(measured.orangeRgb, 'orange band').toBeTruthy();
  expect(measured.orangeRgb![0]).toBeGreaterThanOrEqual(210);
  expect(measured.orangeRgb![1]).toBeLessThanOrEqual(170);
}

function expect390Trail(measured: TrailMeasure) {
  expectTrailBand(measured, 3);
  expect(measured.orangeRgb![2]).toBeLessThanOrEqual(70);
  expect(measured.ringPx).toBeGreaterThanOrEqual(16);
  expect(measured.ringPx).toBeLessThanOrEqual(24);
}

/**
 * Band widths = median of strictly perpendicular cross-sections along the
 * whole trail (not a single near-orb slice). White core = min(r,g,b) > 225.
 */
async function measureWholeTrailWhite(page: Page): Promise<TrailMeasure> {
  const png = await page.locator('#game-container canvas').screenshot();
  const pts = await page.evaluate(() => window.__turfDebug?.trailPtsCss ?? window.__turfDebug?.trailPts ?? []);
  return page.evaluate(
    async ({ b64, pts }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const tmp = document.createElement('canvas');
      tmp.width = img.width;
      tmp.height = img.height;
      const ctx = tmp.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, tmp.width, tmp.height);
      const pix = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return [0, 0, 0] as [number, number, number];
        const i = (y * width + x) * 4;
        return [data[i], data[i + 1], data[i + 2]] as [number, number, number];
      };
      const uniq: { x: number; y: number }[] = [];
      for (const p of pts) {
        const last = uniq[uniq.length - 1];
        if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.2) continue;
        uniq.push(p);
      }
      const mapped = uniq;
      const sampleMins: number[] = [];
      const whiteWidths: number[] = [];
      const orangeWidths: number[] = [];
      const glowWidths: number[] = [];
      const missAt: { i: number; dTip: number; dStart: number; min: number }[] = [];
      let missing = 0;
      let sections = 0;
      let centerRgb: [number, number, number] | null = null;
      let orangeRgb: [number, number, number] | null = null;
      let orangeDist = Infinity;
      const isWhite = (p: [number, number, number]) => Math.min(p[0], p[1], p[2]) > 225;
      const isOrange = (p: [number, number, number]) =>
        p[0] >= 220 &&
        p[1] >= 70 &&
        p[1] <= 160 &&
        p[2] <= 70 &&
        p[0] > p[1] + 60 &&
        p[0] > p[2] + 130 &&
        !isWhite(p);
      const isOpaque = (p: [number, number, number]) => isWhite(p) || isOrange(p);
      const isGlow = (p: [number, number, number]) =>
        isOpaque(p) || (p[0] >= 100 && p[1] >= 20 && p[2] <= 175 && p[0] > p[1] && p[0] > p[2] + 8);
      const start = mapped[0];
      const tip = mapped[mapped.length - 1];
      let prev: { x: number; y: number } | null = null;
      for (let i = 0; i < mapped.length; i++) {
        const b = mapped[i];
        if (!prev) {
          prev = b;
          continue;
        }
        const dx = b.x - prev.x;
        const dy = b.y - prev.y;
        const len = Math.hypot(dx, dy);
        if (len < 0.4) {
          prev = b;
          continue;
        }
        const nx = -dy / len;
        const ny = dx / len;
        const cx = (prev.x + b.x) / 2;
        const cy = (prev.y + b.y) / 2;
        if (cx < 0 || cy < 0 || cx >= width || cy >= height) {
          prev = b;
          continue;
        }
        // Cutter disc + lerp: far ring sits ~25px from the last trail cell, not a H/V scan.
        if (start && Math.hypot(cx - start.x, cy - start.y) < 8) {
          prev = b;
          continue;
        }
        if (tip && Math.hypot(cx - tip.x, cy - tip.y) < 28) {
          prev = b;
          continue;
        }
        let best = 0;
        let whiteRun = 0;
        let maxWhite = 0;
        let solidRun = 0;
        let solidGap = 0;
        let maxSolid = 0;
        let glowRun = 0;
        let maxGlow = 0;
        for (let t = -32; t <= 32; t++) {
          const p = pix(Math.round(cx + nx * t), Math.round(cy + ny * t));
          const m = Math.min(p[0], p[1], p[2]);
          if (m > best) best = m;
          if (isWhite(p) && !centerRgb) centerRgb = p;
          if (isOrange(p)) {
            const dist = (p[0] - 255) ** 2 + (p[1] - 122) ** 2 + (p[2] - 26) ** 2;
            if (dist < orangeDist) {
              orangeDist = dist;
              orangeRgb = p;
            }
          }
          if (isWhite(p)) {
            whiteRun++;
            if (whiteRun > maxWhite) maxWhite = whiteRun;
          } else {
            if (whiteRun > maxWhite) maxWhite = whiteRun;
            whiteRun = 0;
          }
          // 1px AA hole between white core and orange band; do not count the hole.
          if (isOpaque(p)) {
            solidRun++;
            solidGap = 0;
            if (solidRun > maxSolid) maxSolid = solidRun;
          } else if (solidRun > 0 && solidGap < 1) {
            solidGap++;
          } else {
            solidRun = 0;
            solidGap = 0;
          }
          if (isGlow(p)) {
            glowRun++;
            if (glowRun > maxGlow) maxGlow = glowRun;
          } else {
            glowRun = 0;
          }
        }
        if (whiteRun > maxWhite) maxWhite = whiteRun;
        sections++;
        sampleMins.push(best);
        whiteWidths.push(maxWhite);
        orangeWidths.push(maxSolid);
        glowWidths.push(maxGlow);
        if (maxWhite < 1) {
          missing++;
          missAt.push({
            i: sections,
            dTip: tip ? Math.round(Math.hypot(cx - tip.x, cy - tip.y) * 10) / 10 : -1,
            dStart: start ? Math.round(Math.hypot(cx - start.x, cy - start.y) * 10) / 10 : -1,
            min: best,
          });
        }
        prev = b;
      }
      const median = (arr: number[]) => {
        if (!arr.length) return 0;
        const s = arr.slice().sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
      };
      const whiteMedian = median(whiteWidths);
      const orangeMedian = median(orangeWidths);
      const glowMedian = median(glowWidths);

      let orbX = -1;
      let orbY = -1;
      const isDisc = (p: [number, number, number]) =>
        p[0] >= 180 && p[1] >= 40 && p[1] <= 190 && p[2] <= 110 && p[0] > p[1] && p[0] > p[2] + 40;
      const isDiscCore = (p: [number, number, number]) =>
        p[0] >= 185 && p[1] >= 45 && p[1] <= 180 && p[2] <= 110 && p[0] > p[1] + 20 && p[0] > p[2] + 50;
      const orbWhites: { x: number; y: number }[] = [];
      const y0 = Math.floor(height * 0.5);
      const y1 = Math.floor(height * 0.78);
      const x0 = Math.floor(width * 0.28);
      const x1 = Math.floor(width * 0.74);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (!isWhite(pix(x, y))) continue;
          let orange = 0;
          for (let a = 0; a < 8; a++) {
            const ang = (a / 8) * Math.PI * 2;
            const xx = Math.round(x + Math.cos(ang) * 10);
            const yy = Math.round(y + Math.sin(ang) * 10);
            if (xx >= 0 && yy >= 0 && xx < width && yy < height && isDisc(pix(xx, yy))) orange++;
          }
          if (orange >= 4) orbWhites.push({ x, y });
        }
      }
      if (orbWhites.length) {
        orbX = orbWhites.reduce((s, p) => s + p.x, 0) / orbWhites.length;
        orbY = orbWhites.reduce((s, p) => s + p.y, 0) / orbWhites.length;
      }
      let ring = 0;
      if (orbX >= 0) {
        const radii: number[] = [];
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2;
          const ux = Math.cos(ang);
          const uy = Math.sin(ang);
          let rad = 0;
          for (let t = 1; t < 16; t++) {
            const x = Math.round(orbX + ux * t);
            const y = Math.round(orbY + uy * t);
            if (x < 0 || y < 0 || x >= width || y >= height) break;
            const p = pix(x, y);
            if (isWhite(p) || isDiscCore(p)) rad = t;
            else if (rad > 0) break;
          }
          if (rad >= 6 && rad <= 14) radii.push(rad);
        }
        radii.sort((a, b) => a - b);
        const body = radii.filter((r) => r >= 8 && r <= 13);
        const use = body.length ? body : radii;
        if (use.length) ring = use[Math.floor(use.length * 0.5)] * 2;
      }

      return {
        solidWidth: orangeMedian,
        glowWidth: glowMedian,
        whiteCore: whiteMedian,
        ringPx: Math.round(ring * 10) / 10,
        hasWhiteCenter: whiteMedian >= 1,
        centerRgb,
        orangeRgb,
        backing: { w: width, h: height },
        css: { w: width, h: height },
        orb: orbX >= 0 ? { x: Math.round(orbX), y: Math.round(orbY) } : undefined,
        sections,
        missing,
        missingPct: sections ? Math.round((missing / sections) * 1000) / 10 : 100,
        whiteMedian,
        whiteMin: whiteWidths.length ? Math.min(...whiteWidths) : 0,
        orangeMedian,
        sampleMins,
        missAt,
      };
    },
    { b64: png.toString('base64'), pts },
  );
}

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
  await waitTrailRedraw(page);
}

/** Band widths come from whole-trail perpendicular medians. */
async function measureRenderedTrail(page: Page): Promise<TrailMeasure> {
  return measureWholeTrailWhite(page);
}

async function waitAppendDraw(page: Page) {
  await page.goto('/?qa=1');
  await page.waitForSelector('#game-container canvas');
  await page.click('#botBtn');
  await page.waitForFunction(() => document.getElementById('app')?.classList.contains('playing'));
  await page.waitForFunction(
    () => {
      const d = window.__turfDebug;
      return Boolean(d && d.drawing.p1 && !d.cutFx && d.trails.p1 >= 45 && d.trailPaintAppends >= 30);
    },
    { timeout: 45000 },
  );
  await page.evaluate(() => {
    window.__turfForceTrailDpr = 2;
  });
  await waitTrailRedraw(page);
  const base = await page.evaluate(() => window.__turfDebug?.trailPaintAppends ?? 0);
  await page.waitForFunction(
    (b) => {
      const d = window.__turfDebug;
      return Boolean(d && d.drawing.p1 && !d.cutFx && d.trails.p1 >= 45 && d.trailPaintAppends >= b + 8);
    },
    base,
    { timeout: 12000 },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

function expectAlongBand(
  along: TrailMeasure,
  label: string,
  minSolid: number,
  maxSolid: number,
  orangeB: number,
) {
  expect(along.sections, `${label} sections ${JSON.stringify(along)}`).toBeGreaterThanOrEqual(20);
  expect(along.missingPct, `${label} missing white ${JSON.stringify(along)}`).toBe(0);
  expect(along.whiteMedian, `${label} white core px ${JSON.stringify(along)}`).toBeGreaterThanOrEqual(1.5);
  expect(along.whiteCore, `${label} white core`).toBeLessThanOrEqual(3.5);
  expect(along.solidWidth, `${label} solid`).toBeGreaterThanOrEqual(minSolid);
  expect(along.solidWidth, `${label} solid`).toBeLessThanOrEqual(maxSolid);
  expect(along.glowWidth, `${label} glow`).toBeGreaterThanOrEqual(14);
  expect(along.glowWidth, `${label} glow`).toBeLessThanOrEqual(36);
  expect(along.orangeRgb, `${label} orange band`).toBeTruthy();
  expect(along.orangeRgb![0], `${label} orange r`).toBeGreaterThanOrEqual(210);
  expect(along.orangeRgb![2], `${label} orange b`).toBeLessThanOrEqual(orangeB);
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
    const perf1 = await page.evaluate(() => ({
      ms: window.__turfDebug?.trailPaintMs,
      avg: window.__turfDebug?.trailPaintAvg,
      p95: window.__turfDebug?.trailPaintP95,
      fullMs: window.__turfDebug?.trailPaintFullMs,
      uploads: window.__turfDebug?.trailPaintUploads,
      dpr: window.__turfDebug?.trailDpr,
    }));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'orb-mid-draw.png') });
    await page.evaluate(() => {
      window.__turfForceTrailDpr = 2;
    });
    await waitTrailRedraw(page);
    await waitTrailRedraw(page);
    const perf2 = await page.evaluate(() => ({
      ms: window.__turfDebug?.trailPaintMs,
      avg: window.__turfDebug?.trailPaintAvg,
      p95: window.__turfDebug?.trailPaintP95,
      fullMs: window.__turfDebug?.trailPaintFullMs,
      uploads: window.__turfDebug?.trailPaintUploads,
      dpr: window.__turfDebug?.trailDpr,
    }));
    console.log('rendered trail WIDTH (not radius) 390x844', measured, { dpr1: perf1, dpr2: perf2 });
    expect390Trail(measured);
  });

  test('incremental trail append keeps a white core', async ({ page }) => {
    test.setTimeout(180000);
    const shots: {
      label: string;
      size: { width: number; height: number };
      dir: string;
      minSolid: number;
      maxSolid: number;
      orangeB: number;
    }[] = [
      { label: '390x844', size: VIEWPORT, dir: SCREENSHOT_DIR, minSolid: 3, maxSolid: 8.5, orangeB: 70 },
      { label: '360x640', size: { width: 360, height: 640 }, dir: 'docs/qa/cover-360x640', minSolid: 2, maxSolid: 8.5, orangeB: 80 },
      { label: '412x915', size: { width: 412, height: 915 }, dir: 'docs/qa/cover-412x915', minSolid: 2, maxSolid: 8.5, orangeB: 80 },
    ];
    for (const shot of shots) {
      await page.setViewportSize(shot.size);
      await waitAppendDraw(page);
      const kind = await page.evaluate(() => ({
        kind: window.__turfDebug?.trailPaintKind,
        appends: window.__turfDebug?.trailPaintAppends,
        ms: window.__turfDebug?.trailPaintMs,
        avg: window.__turfDebug?.trailPaintAvg,
        p95: window.__turfDebug?.trailPaintP95,
        fullMs: window.__turfDebug?.trailPaintFullMs,
        uploads: window.__turfDebug?.trailPaintUploads,
        dpr: window.__turfDebug?.trailDpr,
        pts: window.__turfDebug?.trailPts?.length ?? 0,
        trail: window.__turfDebug?.trails.p1,
      }));
      expect(kind.appends ?? 0, `${shot.label} paint ${JSON.stringify(kind)}`).toBeGreaterThanOrEqual(30);
      expect(kind.uploads ?? 0, `${shot.label} glow uploads ${JSON.stringify(kind)}`).toBeGreaterThanOrEqual(1);
      const along = await measureWholeTrailWhite(page);
      console.log(`incremental append whole-trail ${shot.label}`, along, kind);
      fs.mkdirSync(path.join(process.cwd(), shot.dir), { recursive: true });
      await page.screenshot({ path: path.join(process.cwd(), shot.dir, 'orb-mid-draw-append.png') });
      expectAlongBand(along, shot.label, shot.minSolid, shot.maxSolid, shot.orangeB);
      expect(kind.p95 ?? 99, `${shot.label} p95`).toBeLessThanOrEqual(15);
    }
  });

  test('trail width stays visible at 360x640 and 412x915', async ({ page }) => {
    test.setTimeout(120000);
    const shots: { label: string; size: { width: number; height: number }; dir: string; minSolid: number; maxSolid: number }[] = [
      { label: '360x640', size: { width: 360, height: 640 }, dir: 'docs/qa/cover-360x640', minSolid: 2, maxSolid: 8.5 },
      { label: '412x915', size: { width: 412, height: 915 }, dir: 'docs/qa/cover-412x915', minSolid: 2, maxSolid: 8.5 },
    ];
    for (const shot of shots) {
      await page.setViewportSize(shot.size);
      await waitMidDraw(page);
      const measured = await measureRenderedTrail(page);
      console.log(`rendered trail WIDTH (median along trail) ${shot.label}`, measured);
      fs.mkdirSync(path.join(process.cwd(), shot.dir), { recursive: true });
      await page.screenshot({ path: path.join(process.cwd(), shot.dir, 'orb-mid-draw.png') });
      expect(measured.hasWhiteCenter, `${shot.label} white center ${measured.centerRgb}`).toBe(true);
      expect(measured.whiteCore, `${shot.label} white core`).toBeGreaterThanOrEqual(1);
      expect(measured.whiteCore, `${shot.label} white core`).toBeLessThanOrEqual(3.5);
      expect(measured.solidWidth, shot.label).toBeGreaterThanOrEqual(shot.minSolid);
      expect(measured.solidWidth, shot.label).toBeLessThanOrEqual(shot.maxSolid);
      expect(measured.glowWidth, shot.label).toBeGreaterThanOrEqual(14);
      expect(measured.glowWidth, shot.label).toBeLessThanOrEqual(36);
      expect(measured.orangeRgb, `${shot.label} orange band`).toBeTruthy();
      expect(measured.orangeRgb![0], `${shot.label} orange r`).toBeGreaterThanOrEqual(210);
      // 360 CSS is smaller so AA can add ~8 blue vs 390; still rejects washed (240,138,83).
      expect(measured.orangeRgb![2], `${shot.label} orange b`).toBeLessThanOrEqual(80);
      expect(measured.ringPx, `${shot.label} ring`).toBeGreaterThanOrEqual(16);
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
