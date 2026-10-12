/** Mockup A palette and painters. Spec: docs/ux/qix/visual-A.md */

export const A = {
  bg: '#0F172A',
  bgTop: '#111C3A',
  bgBot: '#0A0F20',
  coverTop: '#6D28D9',
  coverBot: '#4C1D95',
  me: '#FF7A1A',
  foe: '#2F6BFF',
  accent: '#FACC15',
  spark: '#F0ABFC',
  text: '#F8FAFC',
  heart: '#FF4D6D',
  heartEmpty: '#334155',
  panel: '#1E293B',
  core: '#FFE0C2',
  muted: '#94A3B8',
  body: '#DB2777',
  tentacle: '#BE185D',
  sucker: '#FBCFE8',
  angryBody: '#9F1239',
  angryTent: '#881337',
} as const;

export const AH = {
  bg: 0x0f172a,
  me: 0xff7a1a,
  foe: 0x2f6bff,
  accent: 0xfacc15,
  spark: 0xf0abfc,
  core: 0xffe0c2,
  purple: 0x6d28d9,
  heart: 0xff4d6d,
} as const;

export function mixRgb(
  src: [number, number, number],
  tint: [number, number, number],
  amount: number,
): [number, number, number] {
  return [
    Math.min(255, src[0] + Math.round((tint[0] - src[0]) * amount)),
    Math.min(255, src[1] + Math.round((tint[1] - src[1]) * amount)),
    Math.min(255, src[2] + Math.round((tint[2] - src[2]) * amount)),
  ];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Closed-cover canvas: purple gradient + 36px checker + faint '?' marks. */
export function paintCoverSheet(g: CanvasRenderingContext2D, w: number, h: number): void {
  const top = hexRgb(A.coverTop);
  const bot = hexRgb(A.coverBot);
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const t = y / Math.max(1, h - 1);
    const cr = lerp(top[0], bot[0], t);
    const cg = lerp(top[1], bot[1], t);
    const cb = lerp(top[2], bot[2], t);
    for (let x = 0; x < w; x++) {
      const checker = ((Math.floor(x / 36) + Math.floor(y / 36)) & 1) === 0 ? 10 : -8;
      const i = (y * w + x) * 4;
      img.data[i] = Math.max(0, Math.min(255, cr + checker));
      img.data[i + 1] = Math.max(0, Math.min(255, cg + checker * 0.4));
      img.data[i + 2] = Math.max(0, Math.min(255, cb + checker));
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  g.font = '11px Jua, sans-serif';
  g.fillStyle = 'rgba(248,250,252,0.14)';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const marks = 28;
  for (let i = 0; i < marks; i++) {
    const x = ((i * 73 + 19) % (w - 16)) + 8;
    const y = ((i * 149 + 41) % (h - 16)) + 8;
    g.fillText('?', x, y);
  }
}

/** Dusk landscape placeholder under the cover. */
export function paintHiddenIllustration(g: CanvasRenderingContext2D, w: number, h: number): void {
  const sky = g.createLinearGradient(0, 0, 0, h * 0.62);
  sky.addColorStop(0, '#1E3A8A');
  sky.addColorStop(0.55, '#7C3AED');
  sky.addColorStop(1, '#FDBA74');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);

  g.fillStyle = 'rgba(248,250,252,0.9)';
  const starSeed = [13, 44, 28, 71, 90, 120, 155, 178, 22, 61, 88, 140, 168, 50, 102];
  for (let i = 0; i < starSeed.length; i++) {
    const x = starSeed[i];
    const y = 8 + ((i * 37) % Math.floor(h * 0.32));
    const r = i % 4 === 0 ? 1.4 : 0.7;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }

  const sunX = w * 0.78;
  const sunY = h * 0.22;
  const sun = g.createRadialGradient(sunX, sunY, 2, sunX, sunY, 48);
  sun.addColorStop(0, 'rgba(254,243,199,0.95)');
  sun.addColorStop(0.35, 'rgba(253,186,116,0.55)');
  sun.addColorStop(1, 'rgba(253,186,116,0)');
  g.fillStyle = sun;
  g.beginPath();
  g.arc(sunX, sunY, 48, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#FEF3C7';
  g.beginPath();
  g.arc(sunX, sunY, 10, 0, Math.PI * 2);
  g.fill();

  g.fillStyle = 'rgba(248,250,252,0.22)';
  drawCloud(g, 28, 36, 22);
  drawCloud(g, 118, 22, 18);
  drawCloud(g, 160, 48, 16);

  const lakeY = h * 0.72;
  drawMountain(g, w, lakeY, 0.42, '#2E1065', 18);
  drawMountain(g, w, lakeY, 0.28, '#5B21B6', 28);
  drawMountain(g, w, lakeY, 0.16, '#7C3AED', 40);

  const water = g.createLinearGradient(0, lakeY, 0, h);
  water.addColorStop(0, '#1E3A8A');
  water.addColorStop(0.45, '#312E81');
  water.addColorStop(1, '#1E1B4B');
  g.fillStyle = water;
  g.fillRect(0, lakeY, w, h - lakeY);

  g.save();
  g.beginPath();
  g.rect(0, lakeY, w, h - lakeY);
  g.clip();
  g.globalAlpha = 0.35;
  g.scale(1, -0.55);
  g.translate(0, -lakeY * 2 - (h - lakeY) * 0.4);
  drawMountain(g, w, lakeY, 0.16, '#7C3AED', 40);
  g.restore();

  g.strokeStyle = 'rgba(253,186,116,0.35)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, lakeY);
  g.lineTo(w, lakeY);
  g.stroke();

  drawTree(g, 22, lakeY - 2, 16);
  drawTree(g, 38, lakeY - 1, 12);
  drawTree(g, 168, lakeY - 2, 15);
  drawTree(g, 184, lakeY, 11);
  drawCottage(g, 86, lakeY - 22);
}

function drawCloud(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.beginPath();
  g.arc(x, y, r * 0.55, 0, Math.PI * 2);
  g.arc(x + r * 0.7, y + 1, r * 0.7, 0, Math.PI * 2);
  g.arc(x + r * 1.4, y, r * 0.5, 0, Math.PI * 2);
  g.fill();
}

function drawMountain(
  g: CanvasRenderingContext2D,
  w: number,
  baseY: number,
  peakT: number,
  color: string,
  offset: number,
): void {
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(-10, baseY);
  g.lineTo(w * 0.18 + offset, baseY - hPeak(baseY, peakT, 0.85));
  g.lineTo(w * 0.38 + offset * 0.2, baseY - hPeak(baseY, peakT, 0.45));
  g.lineTo(w * 0.58 - offset * 0.1, baseY - hPeak(baseY, peakT, 1));
  g.lineTo(w * 0.78, baseY - hPeak(baseY, peakT, 0.5));
  g.lineTo(w + 10, baseY);
  g.closePath();
  g.fill();
}

function hPeak(baseY: number, peakT: number, scale: number): number {
  return baseY * peakT * scale;
}

function drawTree(g: CanvasRenderingContext2D, x: number, baseY: number, h: number): void {
  g.fillStyle = '#1E1B4B';
  g.fillRect(x - 1, baseY - h * 0.25, 2, h * 0.25);
  g.fillStyle = '#4C1D95';
  g.beginPath();
  g.moveTo(x, baseY - h);
  g.lineTo(x + h * 0.38, baseY - h * 0.2);
  g.lineTo(x - h * 0.38, baseY - h * 0.2);
  g.closePath();
  g.fill();
}

function drawCottage(g: CanvasRenderingContext2D, x: number, y: number): void {
  g.fillStyle = '#44403C';
  g.fillRect(x, y + 8, 22, 14);
  g.fillStyle = '#BE185D';
  g.beginPath();
  g.moveTo(x - 3, y + 9);
  g.lineTo(x + 11, y);
  g.lineTo(x + 25, y + 9);
  g.closePath();
  g.fill();
  g.fillStyle = '#FACC15';
  g.fillRect(x + 9, y + 12, 5, 5);
  g.fillStyle = '#A8A29E';
  g.fillRect(x + 16, y + 4, 3, 7);
}

/** Pink jelly octopus 꾸물이. Tentacles sway with sine; redder when angry. */
export function paintKkumuli(
  g: CanvasRenderingContext2D,
  s: number,
  time = 0,
  angry = false,
): void {
  g.clearRect(0, 0, s, s);
  const cx = s / 2;
  const cy = s * 0.4;
  const body = angry ? A.angryBody : A.body;
  const tent = angry ? A.angryTent : A.tentacle;

  g.save();
  g.shadowColor = angry ? 'rgba(159,18,57,0.95)' : 'rgba(219,39,119,0.9)';
  g.shadowBlur = s * 0.28;

  g.lineCap = 'round';
  g.strokeStyle = tent;
  g.lineWidth = s * 0.11;
  const dirs = [-0.55, -0.22, 0.22, 0.55];
  for (let i = 0; i < 4; i++) {
    const sway = Math.sin(time * 3.1 + i * 1.1) * s * 0.14;
    const dx = dirs[i];
    const x2 = cx + dx * s * 0.48 + sway;
    const y2 = cy + s * 0.52 + Math.cos(time * 2.4 + i) * s * 0.06;
    g.beginPath();
    g.moveTo(cx + dx * s * 0.1, cy + s * 0.14);
    g.quadraticCurveTo(cx + dx * s * 0.32 + sway * 0.5, cy + s * 0.34, x2, y2);
    g.stroke();
    g.fillStyle = A.sucker;
    g.shadowBlur = 0;
    for (const t of [0.35, 0.55, 0.78]) {
      const sx = cx + dx * s * 0.1 * (1 - t) + x2 * t;
      const sy = cy + s * 0.14 * (1 - t) + y2 * t;
      g.beginPath();
      g.arc(sx, sy, s * 0.04, 0, Math.PI * 2);
      g.fill();
    }
    g.shadowBlur = s * 0.28;
  }

  g.fillStyle = body;
  g.beginPath();
  g.ellipse(cx, cy, s * 0.34, s * 0.3, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();

  g.fillStyle = A.sucker;
  g.beginPath();
  g.ellipse(cx - s * 0.1, cy - s * 0.08, s * 0.12, s * 0.08, -0.4, 0, Math.PI * 2);
  g.fill();

  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(cx + s * 0.04, cy - s * 0.02, s * 0.16, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#0F172A';
  g.beginPath();
  g.arc(cx + s * 0.07, cy - s * 0.01, s * 0.08, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(cx + s * 0.1, cy - s * 0.04, s * 0.03, 0, Math.PI * 2);
  g.fill();

  g.strokeStyle = angry ? '#7F1D1D' : '#831843';
  g.lineWidth = Math.max(2, s * 0.045);
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(cx - s * 0.08, cy - s * 0.18);
  g.lineTo(cx + s * 0.02, cy - s * 0.14);
  g.stroke();
  g.beginPath();
  g.moveTo(cx + s * 0.22, cy - s * 0.18);
  g.lineTo(cx + s * 0.12, cy - s * 0.14);
  g.stroke();
}

export function paintOrb(
  g: CanvasRenderingContext2D,
  s: number,
  color: string,
  whiteRing = false,
): void {
  g.clearRect(0, 0, s, s);
  const cx = s / 2;
  const cy = s / 2;
  g.save();
  g.shadowColor = color;
  g.shadowBlur = s * 0.55;
  g.fillStyle = color;
  g.beginPath();
  g.arc(cx, cy, s * 0.36, 0, Math.PI * 2);
  g.fill();
  g.restore();
  if (whiteRing) {
    g.strokeStyle = '#ffffff';
    g.lineWidth = Math.max(2, s * 0.08);
    g.beginPath();
    g.arc(cx, cy, s * 0.34, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(cx, cy, s * 0.14, 0, Math.PI * 2);
  g.fill();
}

/** 8-point spiky star, spark pink, white center. */
export function paintSpark(g: CanvasRenderingContext2D, s: number): void {
  g.clearRect(0, 0, s, s);
  const cx = s / 2;
  const cy = s / 2;
  g.save();
  g.shadowColor = A.spark;
  g.shadowBlur = s * 0.4;
  g.fillStyle = A.spark;
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? s * 0.46 : s * 0.2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
  g.restore();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(cx, cy, s * 0.12, 0, Math.PI * 2);
  g.fill();
}

export function paintParticleDot(g: CanvasRenderingContext2D, s: number, color: string): void {
  g.clearRect(0, 0, s, s);
  g.fillStyle = color;
  g.beginPath();
  g.arc(s / 2, s / 2, s / 2 - 0.5, 0, Math.PI * 2);
  g.fill();
}
