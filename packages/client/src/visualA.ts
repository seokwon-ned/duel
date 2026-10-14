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
  angryBody: '#E11D48',
  angryTent: '#BE123C',
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

function hexAlpha(hex: string, a: number): string {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
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

/** Bright hills / trees / sky under the cover. Focal sun + cottage sit in the left-center so a real left claim reveals the picture. */
export function paintHiddenIllustration(g: CanvasRenderingContext2D, w: number, h: number): void {
  const sky = g.createLinearGradient(0, 0, 0, h * 0.55);
  sky.addColorStop(0, '#38BDF8');
  sky.addColorStop(0.35, '#7DD3FC');
  sky.addColorStop(0.7, '#FDE68A');
  sky.addColorStop(1, '#FDBA74');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);

  const sunX = w * 0.36;
  const sunY = h * 0.16;
  const sun = g.createRadialGradient(sunX, sunY, 2, sunX, sunY, 70);
  sun.addColorStop(0, 'rgba(254,243,199,1)');
  sun.addColorStop(0.28, 'rgba(250,204,21,0.7)');
  sun.addColorStop(1, 'rgba(253,224,71,0)');
  g.fillStyle = sun;
  g.beginPath();
  g.arc(sunX, sunY, 70, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#FEF08A';
  g.beginPath();
  g.arc(sunX, sunY, 18, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#FFFBEB';
  g.beginPath();
  g.arc(sunX, sunY, 11, 0, Math.PI * 2);
  g.fill();

  g.fillStyle = 'rgba(255,255,255,0.92)';
  drawCloud(g, w * 0.08, h * 0.11, 28);
  drawCloud(g, w * 0.22, h * 0.07, 22);
  drawCloud(g, w * 0.55, h * 0.1, 20);
  drawCloud(g, w * 0.78, h * 0.16, 24);

  const lakeY = h * 0.68;
  drawMountain(g, w, lakeY, 0.48, '#365314', 8);
  drawMountain(g, w, lakeY, 0.34, '#4D7C0F', 22);
  drawMountain(g, w, lakeY, 0.2, '#65A30D', 36);

  const water = g.createLinearGradient(0, lakeY, 0, h);
  water.addColorStop(0, '#7DD3FC');
  water.addColorStop(0.35, '#0EA5E9');
  water.addColorStop(1, '#1D4ED8');
  g.fillStyle = water;
  g.fillRect(0, lakeY, w, h - lakeY);

  g.save();
  g.beginPath();
  g.rect(0, lakeY, w, h - lakeY);
  g.clip();
  g.globalAlpha = 0.4;
  g.scale(1, -0.55);
  g.translate(0, -lakeY * 2 - (h - lakeY) * 0.4);
  drawMountain(g, w, lakeY, 0.2, '#4D7C0F', 36);
  g.restore();

  g.strokeStyle = 'rgba(254,243,199,0.75)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, lakeY);
  g.lineTo(w, lakeY);
  g.stroke();

  drawTree(g, w * 0.1, lakeY - 2, 28);
  drawTree(g, w * 0.18, lakeY - 1, 22);
  drawTree(g, w * 0.28, lakeY - 2, 26);
  drawTree(g, w * 0.4, lakeY - 1, 20);
  drawTree(g, w * 0.78, lakeY - 2, 24);
  drawTree(g, w * 0.88, lakeY, 18);
  drawCottage(g, w * 0.22, lakeY - 34);
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
  g.fillStyle = '#78350F';
  g.fillRect(x - 1, baseY - h * 0.25, 2, h * 0.25);
  g.fillStyle = '#15803D';
  g.beginPath();
  g.moveTo(x, baseY - h);
  g.lineTo(x + h * 0.38, baseY - h * 0.2);
  g.lineTo(x - h * 0.38, baseY - h * 0.2);
  g.closePath();
  g.fill();
}

function drawCottage(g: CanvasRenderingContext2D, x: number, y: number): void {
  g.fillStyle = '#44403C';
  g.fillRect(x, y + 12, 32, 22);
  g.fillStyle = '#BE185D';
  g.beginPath();
  g.moveTo(x - 4, y + 14);
  g.lineTo(x + 16, y);
  g.lineTo(x + 36, y + 14);
  g.closePath();
  g.fill();
  g.fillStyle = '#FACC15';
  g.fillRect(x + 12, y + 18, 8, 8);
  g.fillStyle = '#A8A29E';
  g.fillRect(x + 24, y + 6, 5, 10);
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
  const cy = s * 0.32;
  const body = angry ? A.angryBody : A.body;
  const tent = angry ? A.angryTent : A.tentacle;

  const halo = g.createRadialGradient(cx, cy + s * 0.12, s * 0.08, cx, cy + s * 0.12, s * 0.52);
  halo.addColorStop(0, angry ? 'rgba(255,77,109,0.55)' : 'rgba(240,171,252,0.62)');
  halo.addColorStop(0.42, angry ? 'rgba(190,24,93,0.3)' : 'rgba(236,72,153,0.32)');
  halo.addColorStop(1, 'rgba(240,171,252,0)');
  g.fillStyle = halo;
  g.beginPath();
  g.arc(cx, cy + s * 0.12, s * 0.52, 0, Math.PI * 2);
  g.fill();

  g.lineCap = 'round';
  g.lineJoin = 'round';
  const dirs = [-0.7, -0.24, 0.24, 0.7];
  for (let i = 0; i < 4; i++) {
    const sway = Math.sin(time * 3.1 + i * 1.1) * s * 0.12;
    const dx = dirs[i];
    const x0 = cx + dx * s * 0.16;
    const y0 = cy + s * 0.22;
    const x1 = cx + dx * s * 0.4 + sway * 0.5;
    const y1 = cy + s * 0.5;
    const x2 = cx + dx * s * 0.5 + sway;
    const y2 = cy + s * 0.64 + Math.cos(time * 2.4 + i) * s * 0.05;
    g.strokeStyle = tent;
    g.lineWidth = s * 0.145;
    g.beginPath();
    g.moveTo(x0, y0);
    g.quadraticCurveTo(x1, y1, x2, y2);
    g.stroke();
    g.fillStyle = A.sucker;
    for (const t of [0.3, 0.5, 0.7, 0.88]) {
      const mt = 1 - t;
      const sx = mt * mt * x0 + 2 * mt * t * x1 + t * t * x2;
      const sy = mt * mt * y0 + 2 * mt * t * y1 + t * t * y2;
      g.beginPath();
      g.arc(sx, sy, s * 0.044, 0, Math.PI * 2);
      g.fill();
    }
  }

  g.fillStyle = body;
  g.beginPath();
  g.ellipse(cx, cy, s * 0.46, s * 0.38, 0, 0, Math.PI * 2);
  g.fill();

  g.fillStyle = A.sucker;
  g.beginPath();
  g.ellipse(cx - s * 0.14, cy - s * 0.1, s * 0.17, s * 0.11, -0.45, 0, Math.PI * 2);
  g.fill();

  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(cx + s * 0.06, cy - s * 0.02, s * 0.2, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#0F172A';
  g.beginPath();
  g.arc(cx + s * 0.1, cy - s * 0.01, s * 0.1, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(cx + s * 0.13, cy - s * 0.05, s * 0.04, 0, Math.PI * 2);
  g.fill();

  g.strokeStyle = angry ? '#7F1D1D' : '#831843';
  g.lineWidth = Math.max(2, s * 0.055);
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(cx - s * 0.12, cy - s * 0.22);
  g.lineTo(cx + s * 0.02, cy - s * 0.16);
  g.stroke();
  g.beginPath();
  g.moveTo(cx + s * 0.28, cy - s * 0.22);
  g.lineTo(cx + s * 0.15, cy - s * 0.16);
  g.stroke();
}

/** Mockup A cutter: white center, #FF7A1A (or foe) ring, tight soft glow. */
export function paintOrb(
  g: CanvasRenderingContext2D,
  s: number,
  color: string,
  whiteRing = false,
): void {
  g.clearRect(0, 0, s, s);
  const cx = s / 2;
  const cy = s / 2;
  const glow = g.createRadialGradient(cx, cy, s * 0.22, cx, cy, s * 0.5);
  glow.addColorStop(0, hexAlpha(color, 0.42));
  glow.addColorStop(0.40, hexAlpha(color, 0.16));
  glow.addColorStop(1, hexAlpha(color, 0));
  g.fillStyle = glow;
  g.beginPath();
  g.arc(cx, cy, s * 0.5, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = color;
  g.beginPath();
  g.arc(cx, cy, s * 0.36, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(cx, cy, s * 0.26, 0, Math.PI * 2);
  g.fill();
  if (whiteRing) {
    g.strokeStyle = '#ffffff';
    g.lineWidth = Math.max(2, s * 0.04);
    g.beginPath();
    g.arc(cx, cy, s * 0.38, 0, Math.PI * 2);
    g.stroke();
  }
}

/** 8-point spiky star, spark pink, white center. */
export function paintSpark(g: CanvasRenderingContext2D, s: number): void {
  g.clearRect(0, 0, s, s);
  const cx = s / 2;
  const cy = s / 2;
  const glow = g.createRadialGradient(cx, cy, s * 0.06, cx, cy, s * 0.5);
  glow.addColorStop(0, 'rgba(255,255,255,0.9)');
  glow.addColorStop(0.4, hexAlpha(A.spark, 0.7));
  glow.addColorStop(1, hexAlpha(A.spark, 0));
  g.fillStyle = glow;
  g.beginPath();
  g.arc(cx, cy, s * 0.5, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = A.spark;
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? s * 0.42 : s * 0.18;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(cx, cy, s * 0.11, 0, Math.PI * 2);
  g.fill();
}

export function paintParticleDot(g: CanvasRenderingContext2D, s: number, color: string): void {
  g.clearRect(0, 0, s, s);
  g.fillStyle = color;
  g.beginPath();
  g.arc(s / 2, s / 2, s / 2 - 0.5, 0, Math.PI * 2);
  g.fill();
}
