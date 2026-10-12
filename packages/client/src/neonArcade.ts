/** Amy A Neon Arcade placeholders. visual.md / mockup_game.png were not on this box. */

export const NEON = {
  bg: '#0F172A',
  me: '#FF7A1A',
  foe: '#2F6BFF',
  cyan: '#22D3EE',
  magenta: '#E879F9',
  body: '#C026D3',
  gold: '#FDE047',
} as const;

export const NEON_HEX = {
  bg: 0x0f172a,
  me: 0xff7a1a,
  foe: 0x2f6bff,
  cyan: 0x22d3ee,
  magenta: 0xe879f9,
  gold: 0xfde047,
} as const;

/** Original-illustration placeholder: neon arcade city under the cover. */
export function paintHiddenIllustration(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.fillStyle = NEON.bg;
  g.fillRect(0, 0, w, h);

  g.strokeStyle = 'rgba(34,211,238,0.28)';
  g.lineWidth = 1;
  const horizon = Math.floor(h * 0.42);
  for (let i = 1; i <= 8; i++) {
    const y = horizon + Math.floor(((h - horizon) * i) / 8);
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  }
  for (let i = -6; i <= 6; i++) {
    g.beginPath();
    g.moveTo(w / 2, horizon);
    g.lineTo(w / 2 + i * (w / 5), h);
    g.stroke();
  }

  g.fillStyle = NEON.magenta;
  g.beginPath();
  g.arc(w * 0.78, h * 0.16, 18, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = NEON.bg;
  g.beginPath();
  g.arc(w * 0.74, h * 0.14, 14, 0, Math.PI * 2);
  g.fill();

  drawCabinet(g, 28, horizon - 48, 28, 48, NEON.me);
  drawCabinet(g, 62, horizon - 62, 32, 62, NEON.foe);
  drawCabinet(g, 102, horizon - 40, 24, 40, NEON.magenta);
  drawCabinet(g, 140, horizon - 70, 36, 70, NEON.cyan);

  g.fillStyle = 'rgba(255,122,26,0.35)';
  g.fillRect(0, h - 18, w, 18);
}

function drawCabinet(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  glow: string,
): void {
  g.fillStyle = '#1e293b';
  g.fillRect(x, y, w, h);
  g.strokeStyle = glow;
  g.lineWidth = 2;
  g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  g.fillStyle = glow;
  g.fillRect(x + 4, y + 6, w - 8, Math.max(10, h * 0.28));
  g.fillStyle = '#0f172a';
  g.fillRect(x + 6, y + 8, w - 12, Math.max(6, h * 0.2));
}

/** One-eyed octopus boss 꾸물이. */
export function paintKkumuli(g: CanvasRenderingContext2D, s: number): void {
  g.clearRect(0, 0, s, s);
  const cx = s / 2;
  const cy = s * 0.42;
  g.lineCap = 'round';
  g.strokeStyle = NEON.body;
  g.lineWidth = s * 0.09;
  const legs: Array<[number, number]> = [
    [-0.38, 0.22],
    [-0.2, 0.38],
    [0.2, 0.38],
    [0.38, 0.22],
    [-0.3, 0.08],
    [0.3, 0.08],
  ];
  for (const [dx, dy] of legs) {
    g.beginPath();
    g.moveTo(cx, cy + s * 0.1);
    g.quadraticCurveTo(cx + dx * s * 0.4, cy + s * 0.22, cx + dx * s, cy + dy * s + s * 0.18);
    g.stroke();
  }
  g.fillStyle = NEON.body;
  g.beginPath();
  g.ellipse(cx, cy, s * 0.34, s * 0.3, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = NEON.magenta;
  g.beginPath();
  g.ellipse(cx - s * 0.08, cy - s * 0.08, s * 0.14, s * 0.1, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(cx, cy - s * 0.02, s * 0.16, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = NEON.bg;
  g.beginPath();
  g.arc(cx + s * 0.03, cy - s * 0.02, s * 0.08, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = NEON.cyan;
  g.beginPath();
  g.arc(cx + s * 0.055, cy - s * 0.035, s * 0.035, 0, Math.PI * 2);
  g.fill();
}

export function paintCutter(g: CanvasRenderingContext2D, s: number, color: string): void {
  g.clearRect(0, 0, s, s);
  const cx = s / 2;
  const cy = s / 2;
  g.fillStyle = color;
  g.beginPath();
  g.arc(cx, cy, s * 0.38, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 2;
  g.stroke();
  g.fillStyle = '#0F172A';
  g.beginPath();
  g.arc(cx, cy, s * 0.14, 0, Math.PI * 2);
  g.fill();
}

export function paintSpark(g: CanvasRenderingContext2D, s: number): void {
  g.clearRect(0, 0, s, s);
  const cx = s / 2;
  const cy = s / 2;
  g.fillStyle = NEON.gold;
  g.beginPath();
  g.moveTo(cx, 1);
  g.lineTo(cx + s * 0.12, cy - s * 0.08);
  g.lineTo(s - 1, cy);
  g.lineTo(cx + s * 0.12, cy + s * 0.08);
  g.lineTo(cx, s - 1);
  g.lineTo(cx - s * 0.12, cy + s * 0.08);
  g.lineTo(1, cy);
  g.lineTo(cx - s * 0.12, cy - s * 0.08);
  g.closePath();
  g.fill();
  g.fillStyle = NEON.cyan;
  g.beginPath();
  g.arc(cx, cy, s * 0.14, 0, Math.PI * 2);
  g.fill();
}

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
