export interface DesignRgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface DesignHsvaColor {
  h: number;
  s: number;
  v: number;
  a: number;
}

export type DesignColorNotation = "hex" | "rgb" | "hsl";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function channel(value: string): number | null {
  const trimmed = value.trim();
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return clamp(trimmed.endsWith("%") ? (parsed / 100) * 255 : parsed, 0, 255);
}

function alpha(value: string | undefined): number | null {
  if (value === undefined) return 1;
  const trimmed = value.trim();
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return clamp(trimmed.endsWith("%") ? parsed / 100 : parsed, 0, 1);
}

function hue(value: string): number | null {
  const trimmed = value.trim().toLocaleLowerCase();
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const degrees = trimmed.endsWith("turn")
    ? parsed * 360
    : trimmed.endsWith("rad")
      ? (parsed * 180) / Math.PI
      : trimmed.endsWith("grad")
        ? parsed * 0.9
        : parsed;
  return ((degrees % 360) + 360) % 360;
}

function percentage(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed.endsWith("%")) return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? clamp(parsed / 100, 0, 1) : null;
}

function parseFunctionalParts(source: string): {
  channels: string[];
  alpha: string | undefined;
} | null {
  const slashParts = source.split("/");
  if (slashParts.length > 2) return null;
  const [rawChannels = "", slashAlpha] = slashParts;
  const channels = rawChannels
    .replace(/,/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const legacyAlpha =
    slashAlpha === undefined && channels.length === 4
      ? channels.pop()
      : undefined;
  return { channels, alpha: slashAlpha ?? legacyAlpha };
}

function parseHex(source: string): DesignRgbaColor | null {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(source);
  const value = match?.[1];
  if (!value) return null;
  const expanded =
    value.length <= 4
      ? value
          .split("")
          .map((part) => `${part}${part}`)
          .join("")
      : value;
  const hasAlpha = expanded.length === 8;
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
    a: hasAlpha ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
  };
}

function parseRgb(source: string): DesignRgbaColor | null {
  const match = /^rgba?\((.*)\)$/i.exec(source);
  if (!match?.[1]) return null;
  const parts = parseFunctionalParts(match[1]);
  if (!parts) return null;
  if (parts.channels.length !== 3) return null;
  const [rawRed = "", rawGreen = "", rawBlue = ""] = parts.channels;
  const red = channel(rawRed);
  const green = channel(rawGreen);
  const blue = channel(rawBlue);
  const opacity = alpha(parts.alpha);
  if (red === null || green === null || blue === null || opacity === null) {
    return null;
  }
  return {
    r: Math.round(red),
    g: Math.round(green),
    b: Math.round(blue),
    a: opacity,
  };
}

function hslToRgba(
  h: number,
  saturation: number,
  lightness: number,
  opacity: number,
): DesignRgbaColor {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = h / 60;
  const intermediate = chroma * (1 - Math.abs((sector % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;
  if (sector < 1) [red, green] = [chroma, intermediate];
  else if (sector < 2) [red, green] = [intermediate, chroma];
  else if (sector < 3) [green, blue] = [chroma, intermediate];
  else if (sector < 4) [green, blue] = [intermediate, chroma];
  else if (sector < 5) [red, blue] = [intermediate, chroma];
  else [red, blue] = [chroma, intermediate];
  const match = lightness - chroma / 2;
  return {
    r: Math.round((red + match) * 255),
    g: Math.round((green + match) * 255),
    b: Math.round((blue + match) * 255),
    a: opacity,
  };
}

function parseHsl(source: string): DesignRgbaColor | null {
  const match = /^hsla?\((.*)\)$/i.exec(source);
  if (!match?.[1]) return null;
  const parts = parseFunctionalParts(match[1]);
  if (!parts) return null;
  if (parts.channels.length !== 3) return null;
  const [rawHue = "", rawSaturation = "", rawLightness = ""] = parts.channels;
  const degrees = hue(rawHue);
  const saturation = percentage(rawSaturation);
  const lightness = percentage(rawLightness);
  const opacity = alpha(parts.alpha);
  if (
    degrees === null ||
    saturation === null ||
    lightness === null ||
    opacity === null
  ) {
    return null;
  }
  return hslToRgba(degrees, saturation, lightness, opacity);
}

export function parseDesignColor(value: string): DesignRgbaColor | null {
  const source = value.trim();
  if (!source) return null;
  if (source.toLocaleLowerCase() === "transparent") {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  return parseHex(source) ?? parseRgb(source) ?? parseHsl(source);
}

export function rgbaToHsva(color: DesignRgbaColor): DesignHsvaColor {
  const red = clamp(color.r, 0, 255) / 255;
  const green = clamp(color.g, 0, 255) / 255;
  const blue = clamp(color.b, 0, 255) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let h = 0;
  if (delta > 0) {
    if (maximum === red) h = 60 * (((green - blue) / delta) % 6);
    else if (maximum === green) h = 60 * ((blue - red) / delta + 2);
    else h = 60 * ((red - green) / delta + 4);
  }
  if (h < 0) h += 360;
  return {
    h,
    s: maximum === 0 ? 0 : (delta / maximum) * 100,
    v: maximum * 100,
    a: clamp(color.a, 0, 1),
  };
}

export function hsvaToRgba(color: DesignHsvaColor): DesignRgbaColor {
  const h = ((color.h % 360) + 360) % 360;
  const saturation = clamp(color.s, 0, 100) / 100;
  const value = clamp(color.v, 0, 100) / 100;
  const chroma = value * saturation;
  const sector = h / 60;
  const intermediate = chroma * (1 - Math.abs((sector % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;
  if (sector < 1) [red, green] = [chroma, intermediate];
  else if (sector < 2) [red, green] = [intermediate, chroma];
  else if (sector < 3) [green, blue] = [chroma, intermediate];
  else if (sector < 4) [green, blue] = [intermediate, chroma];
  else if (sector < 5) [red, blue] = [intermediate, chroma];
  else [red, blue] = [chroma, intermediate];
  const match = value - chroma;
  return {
    r: (red + match) * 255,
    g: (green + match) * 255,
    b: (blue + match) * 255,
    a: clamp(color.a, 0, 1),
  };
}

export function formatDesignColor(color: DesignRgbaColor): string {
  const byte = (value: number) =>
    Math.round(clamp(value, 0, 255))
      .toString(16)
      .padStart(2, "0")
      .toLocaleUpperCase();
  const base = `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;
  return color.a >= 1 ? base : `${base}${byte(color.a * 255)}`;
}

function rounded(value: number, precision = 2): string {
  return String(Number(value.toFixed(precision)));
}

/** Format one parsed color in the notation selected by the editor. Keeping
 * this pure prevents the notation control from becoming cosmetic UI. */
export function formatDesignColorNotation(
  color: DesignRgbaColor,
  notation: DesignColorNotation,
): string {
  if (notation === "hex") return formatDesignColor(color);
  const red = Math.round(clamp(color.r, 0, 255));
  const green = Math.round(clamp(color.g, 0, 255));
  const blue = Math.round(clamp(color.b, 0, 255));
  const opacity = clamp(color.a, 0, 1);
  if (notation === "rgb") {
    const channels = `${red} ${green} ${blue}`;
    if (opacity >= 1) {
      // check:ui ignore-next -- this is authored CSS output, not application chrome.
      return `rgb(${channels})`;
    }
    // check:ui ignore-next -- this is authored CSS output, not application chrome.
    return `rgb(${channels} / ${rounded(opacity)})`;
  }

  const hsva = rgbaToHsva({ r: red, g: green, b: blue, a: opacity });
  const value = hsva.v / 100;
  const saturation = hsva.s / 100;
  const lightness = value * (1 - saturation / 2);
  const hslSaturation =
    lightness <= 0 || lightness >= 1
      ? 0
      : (value - lightness) / Math.min(lightness, 1 - lightness);
  const channels = `${rounded(hsva.h, 1)} ${rounded(hslSaturation * 100, 1)}% ${rounded(lightness * 100, 1)}%`;
  if (opacity >= 1) {
    // check:ui ignore-next -- this is authored CSS output, not application chrome.
    return `hsl(${channels})`;
  }
  // check:ui ignore-next -- this is authored CSS output, not application chrome.
  return `hsl(${channels} / ${rounded(opacity)})`;
}
