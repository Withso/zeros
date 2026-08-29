/**
 * Pure-dark ASCII cloud field for the marketing hero.
 *
 * Density is a domain-warped ridged fBm framed into the upper sky
 * (nav + headline band, especially top-right). The product preview
 * covers the lower hero, so that region stays empty black. A well
 * keeps left-aligned type readable. Glyphs are the terminal ramp;
 * sparse `+` / `x` / `.` glints fill the open sky.
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
export const HERO_ASCII_GLYPH_RGB = [208, 208, 208] as const;

const DENSITY_FLOOR = 0.055;
const STAR_CHANCE = 0.02;

export type AsciiGlyph = {
  ch: string;
  alpha: number;
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

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * 1 inside the left-aligned type block, 0 outside. The very top of the
 * nav strip is left open so billows can sit above the headline.
 */
export function headlineWell(nx: number, ny: number, aspect: number): number {
  const landscape = aspect >= 1.05;
  const left = 0.1;
  const right = landscape ? 0.58 : 0.78;
  const top = landscape ? 0.06 : 0.05;
  const bottom = landscape ? 0.32 : 0.24;
  const feather = landscape ? 0.09 : 0.07;
  const dx = nx < left ? left - nx : nx > right ? nx - right : 0;
  const dy = ny < top ? top - ny : ny > bottom ? ny - bottom : 0;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return 1;
  return 1 - smoothstep(0, feather, dist);
}

/**
 * 1 in the upper sky (visible above the product preview), 0 in the
 * lower hero where the UI screen covers the field.
 */
export function skyGate(ny: number, aspect: number): number {
  const fadeStart = aspect >= 1.05 ? 0.3 : 0.24;
  const fadeEnd = aspect >= 1.05 ? 0.46 : 0.38;
  if (ny <= fadeStart) return 1;
  if (ny >= fadeEnd) return 0;
  return 1 - smoothstep(fadeStart, fadeEnd, ny);
}

/** 1 in the upper sky, 0 behind the product preview. */
export function productSkyline(ny: number, aspect = 1.6): number {
  return skyGate(ny, aspect);
}

function moundField(nx: number, ny: number, aspect: number): number {
  if (aspect >= 1.05) {
    return (
      1.35 * gauss(nx, ny, 0.98, 0.04, 0.3, 0.2) +
      1.12 * gauss(nx, ny, 1.04, 0.2, 0.26, 0.22) +
      0.82 * gauss(nx, ny, 0.78, -0.02, 0.28, 0.14) +
      0.58 * gauss(nx, ny, 0.62, 0.06, 0.22, 0.12) +
      0.55 * gauss(nx, ny, 0.0, 0.02, 0.18, 0.14) +
      0.42 * gauss(nx, ny, -0.02, 0.18, 0.16, 0.16)
    );
  }
  return (
    1.22 * gauss(nx, ny, 0.96, 0.05, 0.22, 0.16) +
    1.05 * gauss(nx, ny, 1.04, 0.2, 0.2, 0.18) +
    0.7 * gauss(nx, ny, 0.04, 0.04, 0.16, 0.12) +
    0.48 * gauss(nx, ny, -0.04, 0.18, 0.14, 0.14)
  );
}

function edgeBias(nx: number, ny: number, aspect: number): number {
  const top = clamp01((0.4 - ny) / 0.4);
  if (aspect >= 1.05) {
    return Math.max(
      top * 0.32,
      clamp01((nx - 0.68) / 0.32) * top,
      clamp01((0.14 - nx) / 0.14) * top * 0.55,
    );
  }
  return Math.max(
    top * 0.45,
    clamp01((nx - 0.72) / 0.28) * top,
    clamp01((0.16 - nx) / 0.16) * top * 0.7,
  );
}

/** 0..1 cloud coverage at normalized coordinates. */
export function cloudDensity(nx: number, ny: number, aspect: number): number {
  const sky = skyGate(ny, aspect);
  if (sky <= 0) return 0;
  const w1 = fbm(nx * 1.8 + 2.1, ny * 1.6, 4, 3);
  const w2 = fbm(nx * 1.7 + 8.4, ny * 1.9 + 1.2, 4, 9);
  const wx = nx * (2.6 + 0.4 * Math.min(aspect, 2.2)) + w1 * 1.05;
  const wy = ny * 2.2 + w2 * 0.95;
  const ridges = ridged(wx, wy, 5, 11);
  const fluff = fbm(nx * 5.5 + w1, ny * 5.0 + w2, 4, 21);
  const body = (ridges * 0.72 + fluff * 0.28) ** 1.15;
  const mounds = moundField(nx, ny, aspect);
  const edge = edgeBias(nx, ny, aspect);
  let dens =
    body * (0.22 + 0.95 * Math.min(1.55, mounds)) * (0.2 + 1.1 * edge);
  const well = headlineWell(nx, ny, aspect);
  dens *= 1 - 0.97 * well;
  dens *= sky;
  return clamp01(dens * 1.7 - 0.04);
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
  if (sky <= 0) return null;
  const density = cloudDensity(nx, ny, aspect);
  if (density < DENSITY_FLOOR) {
    if (sky < 0.45) return null;
    if (well > 0.28) return null;
    const star = hash2(col, row, 77);
    if (star >= STAR_CHANCE) return null;
    const pick = hash2(col, row, 91);
    const ch =
      ASCII_STAR_GLYPHS[Math.floor(pick * ASCII_STAR_GLYPHS.length)] ?? "+";
    return { ch, alpha: ch === "+" ? 0.72 : 0.42 };
  }
  const t = clamp01((density - DENSITY_FLOOR) / 0.72);
  let idx = Math.min(
    ASCII_CLOUD_RAMP.length - 1,
    Math.floor(t * ASCII_CLOUD_RAMP.length),
  );
  const jitter = hash2(col, row, 4);
  if (jitter > 0.74 && idx < ASCII_CLOUD_RAMP.length - 1) idx += 1;
  else if (jitter < 0.16 && idx > 0) idx -= 1;
  const ch = ASCII_CLOUD_RAMP[idx] ?? ".";
  return { ch, alpha: 0.36 + t * 0.56 };
}

export function cellSizeForWidth(cssWidth: number): number {
  return cssWidth < 360 ? 7 : 8;
}

type PaintContext = Pick<
  CanvasRenderingContext2D,
  "fillRect" | "fillText" | "font" | "textAlign" | "textBaseline" | "fillStyle"
>;

/** Paint a black void + ASCII clouds. Safe to call with a 2d canvas ctx. */
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
  const [r, g, b] = HERO_ASCII_GLYPH_RGB;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const glyph = glyphAt(col, row, cols, rows);
      if (!glyph) continue;
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${glyph.alpha.toFixed(3)})`;
      ctx.fillText(glyph.ch, (col + 0.5) * cell, (row + 0.5) * cell);
    }
  }
}
