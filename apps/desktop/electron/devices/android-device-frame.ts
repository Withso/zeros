// Device frames from Android Studio's device art: a picture of the whole
// device, where its screen sits, and a mask drawn over the screen that
// rounds its corners and covers the camera. Read from the user's own
// Android Studio and never bundled with Zeros. Devices without art, such as
// Android Studio's "Medium Phone", get the frame Zeros draws.

import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  SimulatorDeviceFrame,
  SimulatorFrameImage,
  SimulatorScreen,
} from "@zeros/protocol/simulators";

/** A device art `layout` file, in screen pixels. */
export interface AndroidArtLayout {
  display: { width: number; height: number; cornerRadius: number };
  /** The whole frame, and where the display sits in it. */
  frame: { width: number; height: number; screenX: number; screenY: number };
  background: { file: string; x: number; y: number };
  mask: string | null;
}

interface Block {
  values: Map<string, string>;
  blocks: Map<string, Block>;
}

function block(): Block {
  return { values: new Map(), blocks: new Map() };
}

/** The art's nested `name { key value }` format. */
function parseBlocks(text: string): Block {
  const root = block();
  const stack = [root];
  const tokens = text.replace(/[{}]/g, " $& ").split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const top = stack[stack.length - 1]!;
    if (token === "}") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const next = tokens[index + 1];
    if (next === "{") {
      const child = block();
      top.blocks.set(token, child);
      stack.push(child);
      index += 1;
    } else if (next !== undefined && next !== "}") {
      top.values.set(token, next);
      index += 1;
    }
  }
  return root;
}

function at(root: Block | undefined, ...names: string[]): Block | undefined {
  let current = root;
  for (const name of names) current = current?.blocks.get(name);
  return current;
}

function size(value: string | undefined): number | null {
  if (!value || !/^\d{1,5}$/.test(value)) return null;
  const number = Number(value);
  return number > 0 && number <= 10_000 ? number : null;
}

function offset(value: string | undefined): number {
  return value && /^-?\d{1,5}$/.test(value) ? Number(value) : 0;
}

const ART_FILE = /^[A-Za-z0-9._-]{1,64}\.(webp|png)$/;

export function parseArtLayout(text: string): AndroidArtLayout | null {
  const root = parseBlocks(text);
  const display = at(root, "parts", "device", "display");
  const width = size(display?.values.get("width"));
  const height = size(display?.values.get("height"));
  const portrait = at(root, "parts", "portrait");
  const background = portrait?.blocks.get("background")?.values.get("image");
  const mask = portrait?.blocks.get("foreground")?.values.get("mask") ?? null;
  const layout = at(root, "layouts", "portrait") ?? at(root, "layouts", "landscape");
  if (!width || !height || !layout || !background || !ART_FILE.test(background)) return null;
  if (mask !== null && !ART_FILE.test(mask)) return null;
  let screen: { x: number; y: number } | null = null;
  let picture = { x: 0, y: 0 };
  for (const part of layout.blocks.values()) {
    const name = part.values.get("name");
    const placed = { x: offset(part.values.get("x")), y: offset(part.values.get("y")) };
    if (name === "device") screen = placed;
    else if (name === "portrait") picture = placed;
  }
  const frameWidth = size(layout.values.get("width"));
  const frameHeight = size(layout.values.get("height"));
  if (!screen || !frameWidth || !frameHeight) return null;
  return {
    display: { width, height, cornerRadius: offset(display?.values.get("corner_radius")) },
    frame: { width: frameWidth, height: frameHeight, screenX: screen.x, screenY: screen.y },
    background: { file: background, ...picture },
    mask,
  };
}

/** Width and height from a WebP's header: lossy, lossless or extended. */
export function webpSize(bytes: Buffer): { width: number; height: number } | null {
  if (
    bytes.length < 30 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  switch (bytes.toString("ascii", 12, 16)) {
    case "VP8X":
      return {
        width: bytes.readUIntLE(24, 3) + 1,
        height: bytes.readUIntLE(27, 3) + 1,
      };
    case "VP8L": {
      if (bytes[20] !== 0x2f) return null;
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case "VP8 ":
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    default:
      return null;
  }
}

function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const MAX_ART_BYTES = 4 * 1024 * 1024;

export interface AndroidDeviceFramesOptions {
  /** Android Studio's `device-art-resources`, or null without it. */
  artRoot(): Promise<string | null>;
  log?(message: string): void;
}

const PROFILE = /^[A-Za-z0-9_-]{1,64}$/;

export class AndroidDeviceFrames {
  private readonly layouts = new Map<string, Promise<AndroidArtLayout | null>>();
  private readonly frames = new Map<string, Promise<SimulatorDeviceFrame | null>>();

  constructor(private readonly options: AndroidDeviceFramesOptions) {}

  /** A hardware profile's art layout, or null when it has none. */
  layout(profile: string): Promise<AndroidArtLayout | null> {
    if (!PROFILE.test(profile)) return Promise.resolve(null);
    let layout = this.layouts.get(profile);
    if (!layout) {
      layout = this.readLayout(profile);
      this.layouts.set(profile, layout);
    }
    return layout;
  }

  /** The screen's corner radius in points, from the art. */
  async cornerRadius(profile: string, screen: Omit<SimulatorScreen, "cornerRadius">): Promise<number | null> {
    const layout = await this.layout(profile);
    if (!layout || !fits(layout, screen)) return null;
    return layout.display.cornerRadius / screen.scale;
  }

  /** The frame for a device's screen, or null to draw Zeros' own. Art made
   * for another screen size never stretches to fit. */
  frame(profile: string, screen: SimulatorScreen): Promise<SimulatorDeviceFrame | null> {
    const key = `${profile}:${screen.widthPx}x${screen.heightPx}@${screen.scale}`;
    let frame = this.frames.get(key);
    if (!frame) {
      frame = this.readFrame(key, profile, screen).catch((error: unknown) => {
        this.options.log?.(`Android frame ${profile} unreadable: ${String(error)}`);
        return null;
      });
      this.frames.set(key, frame);
    }
    return frame;
  }

  private async readLayout(profile: string): Promise<AndroidArtLayout | null> {
    const root = await this.options.artRoot();
    if (!root) {
      this.layouts.delete(profile);
      return null;
    }
    const text = await readFile(path.join(root, profile, "layout"), "utf8").catch(() => null);
    return text ? parseArtLayout(text) : null;
  }

  private async readFrame(
    key: string,
    profile: string,
    screen: SimulatorScreen,
  ): Promise<SimulatorDeviceFrame | null> {
    const root = await this.options.artRoot();
    if (!root) {
      this.frames.delete(key);
      return null;
    }
    const layout = await this.layout(profile);
    // Only watch art places its picture away from the frame's corner.
    if (!layout || !fits(layout, screen) || layout.background.x || layout.background.y) {
      return null;
    }
    const scale = screen.scale;
    const image = await this.image(path.join(root, profile, layout.background.file), scale);
    const mask = layout.mask ? await this.image(path.join(root, profile, layout.mask), scale) : null;
    if (!image || (layout.mask && !mask)) return null;
    return {
      // Some pictures run a few pixels past their layout, for a shadow.
      width: Math.max(layout.frame.width / scale, image.width),
      height: Math.max(layout.frame.height / scale, image.height),
      screen: {
        x: layout.frame.screenX / scale,
        y: layout.frame.screenY / scale,
        width: layout.display.width / scale,
        height: layout.display.height / scale,
      },
      image,
      ...(mask ? { mask } : {}),
      buttons: [],
      outset: { top: 0, left: 0, bottom: 0, right: 0 },
    };
  }

  private async image(file: string, scale: number): Promise<SimulatorFrameImage | null> {
    const bytes = await readFile(file).catch(() => null);
    if (!bytes || bytes.length > MAX_ART_BYTES) return null;
    const webp = webpSize(bytes);
    const measured = webp ?? pngSize(bytes);
    if (!measured) return null;
    return {
      url: `data:image/${webp ? "webp" : "png"};base64,${bytes.toString("base64")}`,
      width: measured.width / scale,
      height: measured.height / scale,
    };
  }
}

function fits(layout: AndroidArtLayout, screen: Omit<SimulatorScreen, "cornerRadius">): boolean {
  return layout.display.width === screen.widthPx && layout.display.height === screen.heightPx;
}
