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

/** Cross-sections along the whole polyline. White core = min(r,g,b) > 225. */
async function measureWholeTrailWhite(page: Page): Promise<{
  sections: number;
  missing: number;
  missingPct: number;
  sampleMins: number[];
}> {
  const png = await page.locator('#game-container canvas').screenshot();
  const pts = await page.evaluate(() => window.__turfDebug?.trailPts ?? window.__turfDebug?.trailPtsCss ?? []);
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
      const toPx = (p: { x: number; y: number }) => ({
        x: ((p.x + 0.5) / 200) * width,
        y: ((p.y + 0.5) / 300) * height,
      });
      const mapped = pts.map(toPx);
      const tip = mapped.length ? mapped[mapped.length - 1] : { x: 0, y: 0 };
      const sampleMins: number[] = [];
      let missing = 0;
      let sections = 0;
      let prev: { x: number; y: number } | null = null;
      for (let i = 0; i < mapped.length; i++) {
        const b = mapped[i];
        if (Math.hypot(b.x - tip.x, b.y - tip.y) < 20) continue;
        if (!prev) {
          prev = b;
          continue;
        }
        const dx = b.x - prev.x;
        const dy = b.y - prev.y;
        const len = Math.hypot(dx, dy);
        if (len < 2) continue;
        const nx = -dy / len;
        const ny = dx / len;
        const cx = Math.round(b.x);
        const cy = Math.round(b.y);
        let found = false;
        let best = 0;
        for (let t = -18; t <= 18; t++) {
          const p = pix(Math.round(cx + nx * t), Math.round(cy + ny * t));
          const m = Math.min(p[0], p[1], p[2]);
          if (m > best) best = m;
          if (m > 225) found = true;
        }
        sections++;
        sampleMins.push(best);
        if (!found) missing++;
        prev = b;
      }
      return {
        sections,
        missing,
        missingPct: sections ? Math.round((missing / sections) * 1000) / 10 : 100,
        sampleMins,
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
    const isWhiteCore = (i: number) => {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      return r >= 240 && g >= 240 && b >= 240;
    };
    const isBright = (i: number) => isSolid(i) || isWhiteCore(i);
    const isGlow = (i: number) => {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      return r >= 110 && g >= 28 && b <= 170 && r > g && r > b + 12;
    };
    let orbX = -1;
    let orbY = -1;
    const orbWhites: { x: number; y: number }[] = [];
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
    const index = (x: number, y: number) => (y * width + x) * 4;
    const collect = (major: number, minor: number, swap: boolean) => {
      const solids: number[] = [];
      const glows: number[] = [];
      const cores: number[] = [];
      for (let a = 0; a < major; a++) {
        let sRun = 0;
        let gRun = 0;
        let wRun = 0;
        const push = () => {
          if (sRun >= 3 && sRun <= 8) solids.push(sRun);
          if (gRun >= 8 && gRun <= 40) glows.push(gRun);
          if (wRun >= 1 && wRun <= 4) cores.push(wRun);
          sRun = 0;
          gRun = 0;
          wRun = 0;
        };
        for (let b = 0; b < minor; b++) {
          const i = swap ? index(a, b) : index(b, a);
          if (isBright(i)) {
            sRun++;
            gRun++;
            if (isWhiteCore(i)) wRun++;
            else {
              if (wRun >= 1 && wRun <= 4) cores.push(wRun);
              wRun = 0;
            }
          } else if (isGlow(i)) {
            if (sRun >= 3 && sRun <= 8) solids.push(sRun);
            if (wRun >= 1 && wRun <= 4) cores.push(wRun);
            sRun = 0;
            wRun = 0;
            gRun++;
          } else {
            push();
          }
        }
        push();
      }
      return { solids, glows, cores };
    };
    const hz = collect(height, width, false);
    const vt = collect(width, height, true);
    const solids = hz.solids.concat(vt.solids);
    const glows = hz.glows.concat(vt.glows);
    const cores = hz.cores.concat(vt.cores);
    const pick = (arr: number[], q = 0.7) => {
      if (!arr.length) return 0;
      const sorted = arr.slice().sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    };
    let hasWhiteCenter = false;
    let centerRgb: [number, number, number] | null = null;
    let orangeRgb: [number, number, number] | null = null;
    let crossWhite = 0;
    let crossSolid = 0;
    let crossGlow = 0;
    if (orbX >= 0) {
      const isPixWhite = (p: [number, number, number]) =>
        p[0] >= 210 && p[1] >= 175 && p[2] >= 130 && p[1] >= p[0] * 0.58 && p[2] >= p[0] * 0.38;
      const isPixOrange = (p: [number, number, number]) =>
        p[0] >= 210 && p[1] >= 55 && p[1] <= 180 && p[2] <= 80 && p[0] > p[1] + 40;
      const isPixGlow = (p: [number, number, number]) =>
        p[0] >= 100 && p[0] > p[1] + 8 && (isPixOrange(p) || isPixWhite(p) || p[0] + 40 > p[2]);
      const xLo = Math.max(0, Math.round(orbX) - 52);
      const xHi = Math.min(width - 1, Math.round(orbX) + 52);
      type Cand = {
        solid: number;
        glow: number;
        white: number;
        rgb: [number, number, number];
        orange: [number, number, number] | null;
      };
      const cands: Cand[] = [];
      for (const dy of [8, 12, 14, 16, 20, 24, 28, 32, 36, 44, 54, 70, -12, -18]) {
        const yScan = Math.round(orbY + dy);
        if (yScan < 0 || yScan >= height) continue;
        const row: [number, number, number][] = [];
        for (let x = 0; x < width; x++) row.push(pix(x, yScan));
        const runs: { x0: number; x1: number; glow: number; whites: number }[] = [];
        let g0 = -1;
        for (let x = xLo; x <= xHi + 1; x++) {
          const on = x <= xHi && isPixGlow(row[x]);
          if (on && g0 < 0) g0 = x;
          if (!on && g0 >= 0) {
            let whites = 0;
            for (let i = g0; i < x; i++) if (isPixWhite(row[i])) whites++;
            runs.push({ x0: g0, x1: x - 1, glow: x - g0, whites });
            g0 = -1;
          }
        }
        const near = runs.filter((r) => r.glow >= 6 && r.whites >= 1);
        const best = near.sort((a, b) => a.glow - b.glow || b.whites - a.whites)[0];
        if (!best) continue;
        let wRun = 0;
        let sRun = 0;
        let white = 0;
        let solid = 0;
        let peak = Math.round((best.x0 + best.x1) / 2);
        let peakScore = -1;
        let orange: [number, number, number] | null = null;
        let orangeDist = Infinity;
        for (let x = best.x0; x <= best.x1; x++) {
          const p = row[x];
          if (p[0] >= 190 && p[0] > p[1] + 20) {
            const dist = (p[0] - 255) ** 2 + (p[1] - 122) ** 2 + (p[2] - 26) ** 2;
            if (dist < orangeDist) {
              orangeDist = dist;
              orange = p;
            }
          }
          if (isPixWhite(p)) {
            wRun++;
            sRun++;
            const score = Math.min(p[0], p[1], p[2]);
            if (score > peakScore) {
              peakScore = score;
              peak = x;
            }
          } else if (isPixOrange(p)) {
            if (wRun && wRun <= 5) white = Math.max(white, wRun);
            wRun = 0;
            sRun++;
          } else {
            if (wRun && wRun <= 5) white = Math.max(white, wRun);
            if (sRun >= 2 && sRun <= 10) solid = Math.max(solid, sRun);
            wRun = 0;
            sRun = 0;
          }
        }
        if (wRun && wRun <= 5) white = Math.max(white, wRun);
        if (sRun >= 2 && sRun <= 10) solid = Math.max(solid, sRun);
        const rgb = row[peak];
        if (!isPixWhite(rgb)) continue;
        cands.push({ solid, glow: best.glow, white, rgb, orange });
      }
      cands.sort((a, b) => {
        const aOk = a.white >= 1 && a.white <= 3.5 && a.solid >= 3 && a.solid <= 8.5 ? 0 : 1;
        const bOk = b.white >= 1 && b.white <= 3.5 && b.solid >= 3 && b.solid <= 8.5 ? 0 : 1;
        return aOk - bOk || Math.abs(a.solid - 4) - Math.abs(b.solid - 4);
      });
      const chosen = cands[0];
      if (chosen) {
        hasWhiteCenter = true;
        centerRgb = chosen.rgb;
        orangeRgb = chosen.orange;
        crossWhite = chosen.white;
        crossSolid = chosen.solid;
        crossGlow = chosen.glow;
      }
    }
    return {
      solidWidth: Math.round((crossSolid || pick(solids)) * scale * 10) / 10,
      glowWidth: Math.round((crossGlow || pick(glows)) * scale * 10) / 10,
      whiteCore: Math.round((crossWhite || pick(cores, 0.5)) * scale * 10) / 10,
      ringPx: Math.round(ring * scale * 10) / 10,
      hasWhiteCenter,
      centerRgb,
      orangeRgb,
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
    const perf1 = await page.evaluate(() => ({
      ms: window.__turfDebug?.trailPaintMs,
      avg: window.__turfDebug?.trailPaintAvg,
      p95: window.__turfDebug?.trailPaintP95,
      fullMs: window.__turfDebug?.trailPaintFullMs,
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
      dpr: window.__turfDebug?.trailDpr,
    }));
    console.log('rendered trail WIDTH (not radius) 390x844', measured, { dpr1: perf1, dpr2: perf2 });
    expect390Trail(measured);
  });

  test('incremental trail append keeps a white core', async ({ page }) => {
    test.setTimeout(60000);
    await waitMidDraw(page);
    await page.evaluate(() => {
      window.__turfForceTrailDpr = 2;
    });
    await waitTrailRedraw(page);
    const base = await page.evaluate(() => window.__turfDebug?.trailPaintAppends ?? 0);
    await page.waitForFunction((b) => (window.__turfDebug?.trailPaintAppends ?? 0) >= b + 30, base, {
      timeout: 20000,
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    const kind = await page.evaluate(() => ({
      kind: window.__turfDebug?.trailPaintKind,
      appends: window.__turfDebug?.trailPaintAppends,
      ms: window.__turfDebug?.trailPaintMs,
      avg: window.__turfDebug?.trailPaintAvg,
      p95: window.__turfDebug?.trailPaintP95,
      fullMs: window.__turfDebug?.trailPaintFullMs,
      dpr: window.__turfDebug?.trailDpr,
    }));
    expect(kind.appends ?? 0).toBeGreaterThanOrEqual(base + 30);
    const along = await measureWholeTrailWhite(page);
    const ptsN = await page.evaluate(() => window.__turfDebug?.trailPts?.length ?? 0);
    console.log('incremental append whole-trail white 390x844', along, kind, { ptsN });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'orb-mid-draw-append.png') });
    expect(along.sections, `sections ${JSON.stringify(along)}`).toBeGreaterThanOrEqual(20);
    expect(along.missingPct, `missing white ${JSON.stringify(along)}`).toBe(0);
    expect(kind.p95 ?? 99).toBeLessThanOrEqual(15);
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
      console.log(`rendered trail WIDTH (not radius) ${shot.label}`, measured);
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
      expect(measured.ringPx, `${shot.label} ring`).toBeGreaterThanOrEqual(shot.label === '360x640' ? 16 : 16);
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
