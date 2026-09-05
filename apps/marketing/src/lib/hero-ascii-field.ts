/**
 * ASCII cloud atmosphere for the marketing hero.
 *
 * The upper void stays empty so the left-aligned tagline can breathe.
 * Luminous billows, rim-lit like terminal clouds, sit on the horizon
 * around the product peek. Cyan streaks cut through that band. The
 * clipped UI at the bottom is thinned so chrome stays readable.
 */

export const ASCII_CLOUD_RAMP = [
  ".",
  ",",
  ":",
  ";",
  "+",
  "*",
  "x",
  "#",
  "%",
  "@",
  "0",
  "1",
] as const;

export const ASCII_STAR_GLYPHS = [".", "+", "x"] as const;

export const HERO_ASCII_VOID = "#000000";
export const HERO_ASCII_GLYPH_RGB = [220, 232, 255] as const;
export const HERO_ASCII_CYAN_RGB = [110, 214, 255] as const;

const DENSITY_FLOOR = 0.05;
const STAR_CHANCE = 0.018;

export type AsciiGlyph = {
  ch: string;
  alpha: number;
  rgb: readonly [number, number, number];
};

export function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function hash2(ix: number, iy: number, seed: number): number {
  let n =
    Math.imul(ix | 0, 374761393) +
    Math.imul(iy | 0, 668265263) +
    Math.imul(seed | 0, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

export function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const u = fade(fx);
  const v = fade(fy);
  const n00 = hash2(x0, y0, seed);
  const n10 = hash2(x0 + 1, y0, seed);
  const n01 = hash2(x0, y0 + 1, seed);
  const n11 = hash2(x0 + 1, y0 + 1, seed);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return a + (b - a) * v;
}

export function fbm(
  x: number,
  y: number,
  octaves: number,
  seed: number,
): number {
  let sum = 0;
  let amp = 0.55;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    sum += amp * valueNoise(x * freq, y * freq, seed + i * 19);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

export function ridged(
  x: number,
  y: number,
  octaves: number,
  seed: number,
): number {
  let sum = 0;
  let amp = 0.55;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    const n = 1 - Math.abs(valueNoise(x * freq, y * freq, seed + i * 19) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2.02;
  }
  return sum / norm;
}

function gauss(
  nx: number,
  ny: number,
  cx: number,
  cy: number,
  sx: number,
  sy: number,
): number {
  const dx = (nx - cx) / sx;
  const dy = (ny - cy) / sy;
  return Math.exp(-0.5 * (dx * dx + dy * dy));
}

function gauss1d(x: number, sigma: number): number {
  const t = x / sigma;
  return Math.exp(-0.5 * t * t);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * 1 inside the left-aligned type block, 0 outside. Extra air sits above
 * the headline, so the well is lower than the nav strip.
 */
export function headlineWell(nx: number, ny: number, aspect: number): number {
  const landscape = aspect >= 1.05;
  const left = 0.08;
  const right = landscape ? 0.62 : 0.84;
  const top = landscape ? 0.16 : 0.12;
  const bottom = landscape ? 0.52 : 0.4;
  const feather = landscape ? 0.1 : 0.08;
  const dx = nx < left ? left - nx : nx > right ? nx - right : 0;
  const dy = ny < top ? top - ny : ny > bottom ? ny - bottom : 0;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return 1;
  return 1 - smoothstep(0, feather, dist);
}

/**
 * 1 on the horizon band around the product peek, 0 in the upper void.
 */
export function horizonGate(ny: number, aspect: number): number {
  const landscape = aspect >= 1.05;
  const rise = landscape ? 0.4 : 0.34;
  const full = landscape ? 0.54 : 0.48;
  const hold = landscape ? 0.8 : 0.74;
  const fade = landscape ? 0.98 : 0.94;
  if (ny <= rise) return smoothstep(rise - 0.14, rise, ny) * 0.22;
  if (ny < full) return 0.22 + 0.78 * smoothstep(rise, full, ny);
  if (ny <= hold) return 1;
  return 1 - 0.55 * smoothstep(hold, fade, ny);
}

/**
 * 1 in the clear upper sky (stars), 0 on the horizon.
 */
export function skyGate(ny: number, aspect: number): number {
  return clamp01(1 - horizonGate(ny, aspect) * 1.35);
}

/** 1 above the product peek, 0 inside the clipped UI band. */
export function productSkyline(ny: number, aspect = 1.6): number {
  const start = aspect >= 1.05 ? 0.62 : 0.58;
  return 1 - smoothstep(start, start + 0.14, ny);
}

/**
 * Thin the field over the product chrome so the window stays readable.
 */
export function productWell(nx: number, ny: number, aspect: number): number {
  const landscape = aspect >= 1.05;
  const left = landscape ? 0.07 : 0.04;
  const right = landscape ? 0.93 : 0.96;
  const top = landscape ? 0.64 : 0.6;
  const feather = landscape ? 0.09 : 0.07;
  if (ny < top - feather) return 0;
  const dx = nx < left ? left - nx : nx > right ? nx - right : 0;
  const dy = ny < top ? top - ny : 0;
  const dist = Math.hypot(dx, dy);
  const inside = dist === 0 ? 1 : 1 - smoothstep(0, feather, dist);
  return inside * smoothstep(top - feather, top + 0.04, ny);
}

/** Cyan data-stream streaks through the horizon clouds. */
export function streakField(nx: number, ny: number): number {
  const s1 = gauss1d(nx * 0.72 + ny * 1.05 - 1.12, 0.034);
  const s2 = gauss1d(nx * 0.9 + ny * 0.88 - 0.78, 0.026);
  const s3 = gauss1d(nx * 0.48 + ny * 1.22 - 1.28, 0.02);
  return clamp01(s1 * 0.95 + s2 * 0.55 + s3 * 0.4);
}

function moundField(nx: number, ny: number, aspect: number): number {
  if (aspect >= 1.05) {
    return (
      1.18 * gauss(nx, ny, 0.12, 0.7, 0.2, 0.16) +
      0.88 * gauss(nx, ny, 0.34, 0.76, 0.18, 0.12) +
      0.7 * gauss(nx, ny, 0.52, 0.8, 0.2, 0.1) +
      0.95 * gauss(nx, ny, 0.7, 0.7, 0.18, 0.14) +
      1.28 * gauss(nx, ny, 0.88, 0.58, 0.22, 0.2) +
      0.78 * gauss(nx, ny, 0.94, 0.42, 0.14, 0.12) +
      0.55 * gauss(nx, ny, 0.04, 0.52, 0.12, 0.12)
    );
  }
  return (
    1.05 * gauss(nx, ny, 0.14, 0.66, 0.18, 0.14) +
    0.78 * gauss(nx, ny, 0.5, 0.76, 0.22, 0.1) +
    1.15 * gauss(nx, ny, 0.88, 0.58, 0.18, 0.16) +
    0.6 * gauss(nx, ny, 0.72, 0.7, 0.16, 0.1)
  );
}

/**
 * Peak on the cloud rim, fall off in the core so billows read as
 * outlined ASCII volumes instead of a solid 0/1 slab.
 */
function shellFromRaw(raw: number): number {
  if (raw < 0.08) return 0;
  const rim = Math.exp(-Math.pow((raw - 0.4) / 0.13, 2));
  const inner = raw > 0.42 ? 0.1 + 0.22 * (1 - raw) : 0;
  const mist = raw < 0.28 ? raw * 0.7 : 0;
  return clamp01(rim * 0.95 + inner + mist);
}

/** 0..1 cloud coverage at normalized coordinates. */
export function cloudDensity(nx: number, ny: number, aspect: number): number {
  const horizon = horizonGate(ny, aspect);
  if (horizon <= 0.02) return 0;
  const w1 = fbm(nx * 1.7 + 2.1, ny * 1.8, 4, 3);
  const w2 = fbm(nx * 1.6 + 8.4, ny * 2.1 + 1.2, 4, 9);
  const wx = nx * (2.5 + 0.35 * Math.min(aspect, 2.2)) + w1 * 1.1;
  const wy = ny * 2.6 + w2 * 1.05;
  const ridges = ridged(wx, wy, 5, 11);
  const fluff = fbm(nx * 5.8 + w1, ny * 5.4 + w2, 4, 21);
  const body = Math.pow(ridges * 0.62 + fluff * 0.38, 1.05);
  const mounds = moundField(nx, ny, aspect);
  const streak = streakField(nx, ny);
  let raw =
    body * (0.28 + 1.05 * Math.min(1.45, mounds)) * (0.3 + 0.85 * horizon);
  raw += streak * 0.18 * horizon;
  raw *= 1 - 0.97 * headlineWell(nx, ny, aspect);
  raw *= 1 - 0.88 * productWell(nx, ny, aspect);
  raw *= horizon;
  return clamp01(shellFromRaw(raw));
}

function mixRgb(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  const k = clamp01(t);
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

export function glyphAt(
  col: number,
  row: number,
  cols: number,
  rows: number,
): AsciiGlyph | null {
  const nx = (col + 0.5) / cols;
  const ny = (row + 0.5) / rows;
  const aspect = cols / rows;
  const well = headlineWell(nx, ny, aspect);
  const sky = skyGate(ny, aspect);
  const density = cloudDensity(nx, ny, aspect);
  if (density < DENSITY_FLOOR) {
    if (sky < 0.55) return null;
    if (well > 0.28) return null;
    if (ny > 0.48) return null;
    const star = hash2(col, row, 77);
    if (star >= STAR_CHANCE) return null;
    const pick = hash2(col, row, 91);
    const ch =
      ASCII_STAR_GLYPHS[Math.floor(pick * ASCII_STAR_GLYPHS.length)] ?? "+";
    return {
      ch,
      alpha: ch === "+" ? 0.62 : 0.36,
      rgb: HERO_ASCII_GLYPH_RGB,
    };
  }
  const t = clamp01((density - DENSITY_FLOOR) / 0.62);
  const rim = 4 * density * (1 - density);
  const streak = streakField(nx, ny);
  const maxIdx = streak > 0.4 ? ASCII_CLOUD_RAMP.length - 1 : 8;
  let idx = Math.min(
    maxIdx,
    Math.floor((0.12 + t * 0.55 + rim * 0.22 + streak * 0.18) * ASCII_CLOUD_RAMP.length),
  );
  const jitter = hash2(col, row, 4);
  if (jitter > 0.74 && idx < ASCII_CLOUD_RAMP.length - 1) idx += 1;
  else if (jitter < 0.16 && idx > 0) idx -= 1;
  const ch = ASCII_CLOUD_RAMP[idx] ?? ".";
  const alpha = clamp01(0.22 + t * 0.42 + rim * 0.4 + streak * 0.38);
  const rgb = mixRgb(
    HERO_ASCII_GLYPH_RGB,
    HERO_ASCII_CYAN_RGB,
    streak * 1.35 + rim * 0.28,
  );
  return { ch, alpha, rgb };
}

export function cellSizeForWidth(cssWidth: number): number {
  return cssWidth < 360 ? 7 : 8;
}

type PaintContext = Pick<
  CanvasRenderingContext2D,
  "fillRect" | "fillText" | "font" | "textAlign" | "textBaseline" | "fillStyle"
>;

/** Paint a black void + lit ASCII clouds. Safe to call with a 2d canvas ctx. */
export function paintHeroAsciiField(
  ctx: PaintContext,
  cssWidth: number,
  cssHeight: number,
): void {
  ctx.fillStyle = HERO_ASCII_VOID;
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  if (cssWidth < 8 || cssHeight < 8) return;
  const cell = cellSizeForWidth(cssWidth);
  const cols = Math.ceil(cssWidth / cell);
  const rows = Math.ceil(cssHeight / cell);
  ctx.font = `${cell}px "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const glyph = glyphAt(col, row, cols, rows);
      if (!glyph) continue;
      const [r, g, b] = glyph.rgb;
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${glyph.alpha.toFixed(3)})`;
      ctx.fillText(glyph.ch, (col + 0.5) * cell, (row + 0.5) * cell);
    }
  }
}
