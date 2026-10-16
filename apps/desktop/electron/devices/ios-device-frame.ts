// Device frames from the user's own Xcode (DeviceKit), for the iOS Simulator
// tab. Apple's frame art is read in place and converted to PNG with macOS's
// `sips`, cached per DeviceKit version, and never bundled or uploaded. When
// anything is missing the tab draws its own frame.

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  SIMULATOR_FRAME_SLICES,
  type SimulatorDeviceFrame,
  type SimulatorFrameImage,
  type SimulatorFrameSlice,
  type SimulatorScreen,
} from "@zeros/protocol/simulators";

import { PLUTIL, type ToolRunner } from "./tool-runner";

export const DEVICEKIT_CHROME_ROOT = "/Library/Developer/DeviceKit/Chrome";
export const SIPS = "/usr/bin/sips";

/** Pixels per point in the converted PNGs. */
const RASTER_SCALE = 3;
const MAX_CHROME_JSON_BYTES = 256 * 1024;
const CHROME_ID = /^com\.apple\.dt\.devicekit\.chrome\.([a-z0-9]{1,40})$/;
const IMAGE_NAME = /^[\w][\w .-]{0,79}$/;
const MANIFEST_VERSION = 1;

export interface DeviceChromeButton {
  name: string;
  image: string;
  anchor: "left" | "right" | "top" | "bottom";
  align: "leading" | "center" | "trailing";
  onTop: boolean;
  x: number;
  y: number;
}

export interface DeviceChrome {
  slices: Record<SimulatorFrameSlice, string>;
  insets: { top: number; left: number; bottom: number; right: number };
  buttons: DeviceChromeButton[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function imageName(value: unknown): string | null {
  return typeof value === "string" && IMAGE_NAME.test(value) && !value.includes("..")
    ? value
    : null;
}

/** Reads DeviceKit's `chrome.json`. */
export function parseDeviceChrome(document: unknown): DeviceChrome | null {
  const root = record(document);
  const images = record(root?.images);
  const sizing = record(images?.sizing);
  if (!images || !sizing) return null;
  const slices = {} as Record<SimulatorFrameSlice, string>;
  for (const slice of SIMULATOR_FRAME_SLICES) {
    const name = imageName(images[slice]);
    if (!name) return null;
    slices[slice] = name;
  }
  const left = finite(sizing.leftWidth, 0, 400);
  const right = finite(sizing.rightWidth, 0, 400);
  const top = finite(sizing.topHeight, 0, 400);
  const bottom = finite(sizing.bottomHeight, 0, 400);
  if (left === null || right === null || top === null || bottom === null) return null;
  const buttons: DeviceChromeButton[] = [];
  for (const entry of Array.isArray(root?.inputs) ? root.inputs.slice(0, 16) : []) {
    const input = record(entry);
    const offsets = record(record(input?.offsets)?.normal);
    const image = imageName(input?.image);
    const name = typeof input?.name === "string" ? input.name.slice(0, 40) : null;
    const x = finite(offsets?.x, -2_000, 2_000);
    const y = finite(offsets?.y, -2_000, 2_000);
    const anchor = input?.anchor;
    const align = input?.align;
    if (
      input?.type !== "button" ||
      !image ||
      !name ||
      x === null ||
      y === null ||
      (anchor !== "left" && anchor !== "right" && anchor !== "top" && anchor !== "bottom") ||
      (align !== "leading" && align !== "center" && align !== "trailing")
    ) {
      continue;
    }
    buttons.push({ name, image, anchor, align, onTop: input.onTop === true, x, y });
  }
  return { slices, insets: { top, left, bottom, right }, buttons };
}

export type ImageSizes = Record<string, { width: number; height: number }>;

function alongEdge(
  offset: number,
  edge: number,
  size: number,
  align: DeviceChromeButton["align"],
): number {
  if (align === "leading") return offset;
  if (align === "center") return (edge - size) / 2 + offset;
  return edge + offset - size;
}

/** Lays the frame out around a screen of `screenWidth` × `screenHeight`
 * points. Buttons follow DeviceKit's anchors: the offset across the anchored
 * edge places the button's inner side, and the offset along it is measured
 * from that edge's start (leading), middle (center) or end (trailing, where
 * it is negative). */
export function layoutDeviceFrame(
  chrome: DeviceChrome,
  screenWidth: number,
  screenHeight: number,
  sizes: ImageSizes,
  urls: Record<string, string>,
): SimulatorDeviceFrame | null {
  const width = screenWidth + chrome.insets.left + chrome.insets.right;
  const height = screenHeight + chrome.insets.top + chrome.insets.bottom;
  const image = (name: string): SimulatorFrameImage | null => {
    const size = sizes[name];
    const url = urls[name];
    return size && url ? { url, width: size.width, height: size.height } : null;
  };
  const slices = {} as Record<SimulatorFrameSlice, SimulatorFrameImage>;
  for (const slice of SIMULATOR_FRAME_SLICES) {
    const piece = image(chrome.slices[slice]);
    if (!piece) return null;
    slices[slice] = piece;
  }
  if (
    slices.topLeft.width + slices.topRight.width > width ||
    slices.topLeft.height + slices.bottomLeft.height > height
  ) {
    return null;
  }
  const outset = { top: 0, left: 0, bottom: 0, right: 0 };
  const buttons: SimulatorDeviceFrame["buttons"] = [];
  for (const button of chrome.buttons) {
    const art = image(button.image);
    if (!art) continue;
    let x: number;
    let y: number;
    if (button.anchor === "left" || button.anchor === "right") {
      x = button.anchor === "left" ? button.x - art.width : width + button.x;
      y = alongEdge(button.y, height, art.height, button.align);
    } else {
      y = button.anchor === "top" ? button.y - art.height : height + button.y;
      x = alongEdge(button.x, width, art.width, button.align);
    }
    outset.left = Math.max(outset.left, -x);
    outset.top = Math.max(outset.top, -y);
    outset.right = Math.max(outset.right, x + art.width - width);
    outset.bottom = Math.max(outset.bottom, y + art.height - height);
    buttons.push({ name: button.name, image: art, x, y, onTop: button.onTop });
  }
  return {
    width,
    height,
    screen: {
      x: chrome.insets.left,
      y: chrome.insets.top,
      width: screenWidth,
      height: screenHeight,
    },
    slices,
    buttons,
    outset,
  };
}

/** `sips -g pixelWidth -g pixelHeight` reports a PDF's size in points. */
export function parseSipsSize(output: string): { width: number; height: number } | null {
  const width = Number(/pixelWidth:\s*([\d.]+)/.exec(output)?.[1]);
  const height = Number(/pixelHeight:\s*([\d.]+)/.exec(output)?.[1]);
  return width > 0 && height > 0 && width <= 4_000 && height <= 4_000 ? { width, height } : null;
}

interface FrameManifest {
  version: typeof MANIFEST_VERSION;
  sizes: ImageSizes;
  /** Art that would not convert, so it isn't retried every launch. */
  missing: string[];
}

interface LoadedChrome {
  chrome: DeviceChrome;
  sizes: ImageSizes;
  urls: Record<string, string>;
}

export interface DeviceFramesOptions {
  run: ToolRunner;
  cacheRoot: string;
  chromeRoot?: string;
  log?(message: string): void;
}

/** Converts and caches frame art, once per DeviceKit chrome version. */
export class DeviceFrames {
  private readonly chromes = new Map<string, Promise<LoadedChrome | null>>();
  private readonly chromeRoot: string;

  constructor(private readonly options: DeviceFramesOptions) {
    this.chromeRoot = options.chromeRoot ?? DEVICEKIT_CHROME_ROOT;
  }

  async frame(
    chromeIdentifier: string,
    screen: SimulatorScreen,
  ): Promise<SimulatorDeviceFrame | null> {
    const name = CHROME_ID.exec(chromeIdentifier)?.[1];
    if (!name) return null;
    let loading = this.chromes.get(name);
    if (!loading) {
      loading = this.load(name).catch((error: unknown) => {
        this.options.log?.(`device frame unavailable: ${String(error)}`);
        return null;
      });
      this.chromes.set(name, loading);
      void loading.then((loaded) => {
        if (!loaded) this.chromes.delete(name);
      });
    }
    const loaded = await loading;
    return loaded
      ? layoutDeviceFrame(
          loaded.chrome,
          screen.widthPx / screen.scale,
          screen.heightPx / screen.scale,
          loaded.sizes,
          loaded.urls,
        )
      : null;
  }

  private async load(name: string): Promise<LoadedChrome | null> {
    const bundle = path.join(this.chromeRoot, `${name}.devicechrome`, "Contents");
    const resources = path.join(bundle, "Resources");
    const json = await readFile(path.join(resources, "chrome.json"));
    if (json.length > MAX_CHROME_JSON_BYTES) return null;
    const chrome = parseDeviceChrome(JSON.parse(json.toString("utf8")));
    if (!chrome) return null;
    const { stdout } = await this.options.run(PLUTIL, [
      "-extract",
      "CFBundleVersion",
      "raw",
      path.join(bundle, "version.plist"),
    ]);
    const version = stdout.trim();
    if (!/^[\w.]{1,20}$/.test(version)) return null;

    const names = [
      ...new Set([...Object.values(chrome.slices), ...chrome.buttons.map((button) => button.image)]),
    ];
    const cache = path.join(this.options.cacheRoot, `${name}-${version}`);
    let sizes = await this.readManifest(cache, names);
    if (!sizes) {
      sizes = await this.convert(resources, cache, names);
      await this.pruneOtherVersions(name, version);
    }
    const urls: Record<string, string> = {};
    for (const image of names) {
      if (!sizes[image]) continue;
      const png = await readFile(path.join(cache, `${image}.png`)).catch(() => null);
      if (png) urls[image] = `data:image/png;base64,${png.toString("base64")}`;
    }
    return { chrome, sizes, urls };
  }

  private async readManifest(cache: string, names: string[]): Promise<ImageSizes | null> {
    try {
      const manifest = JSON.parse(
        await readFile(path.join(cache, "frame.json"), "utf8"),
      ) as Partial<FrameManifest>;
      if (
        manifest.version !== MANIFEST_VERSION ||
        !record(manifest.sizes) ||
        !Array.isArray(manifest.missing)
      ) {
        return null;
      }
      const sizes: ImageSizes = {};
      for (const name of names) {
        if (manifest.missing.includes(name)) continue;
        const size = record(manifest.sizes?.[name]);
        const width = finite(size?.width, 0.5, 4_000);
        const height = finite(size?.height, 0.5, 4_000);
        if (width === null || height === null) return null;
        sizes[name] = { width, height };
      }
      return sizes;
    } catch {
      return null;
    }
  }

  private async convert(resources: string, cache: string, names: string[]): Promise<ImageSizes> {
    const staging = path.join(
      path.dirname(cache),
      `.staging-${path.basename(cache)}-${process.pid}-${Date.now()}`,
    );
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      const sizes: ImageSizes = {};
      const missing: string[] = [];
      const queue = [...names];
      await Promise.all(
        Array.from({ length: Math.min(4, queue.length) }, async () => {
          for (;;) {
            const name = queue.shift();
            if (!name) return;
            const size = await this.convertOne(resources, staging, name);
            if (size) sizes[name] = size;
            else missing.push(name);
          }
        }),
      );
      const manifest: FrameManifest = { version: MANIFEST_VERSION, sizes, missing };
      await writeFile(path.join(staging, "frame.json"), `${JSON.stringify(manifest)}\n`, {
        mode: 0o600,
      });
      await rm(cache, { recursive: true, force: true });
      await rename(staging, cache);
      return sizes;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async convertOne(
    resources: string,
    staging: string,
    name: string,
  ): Promise<{ width: number; height: number } | null> {
    const pdf = path.join(resources, `${name}.pdf`);
    const png = path.join(staging, `${name}.png`);
    try {
      // sips exits 0 even when it skips a file, so check its output exists.
      const size = parseSipsSize(
        (await this.options.run(SIPS, ["-g", "pixelWidth", "-g", "pixelHeight", pdf])).stdout,
      );
      if (!size) return null;
      const longest = Math.ceil(Math.max(size.width, size.height) * RASTER_SCALE);
      await this.options.run(SIPS, ["-s", "format", "png", "-Z", String(longest), pdf, "--out", png]);
      return (await stat(png)).size > 0 ? size : null;
    } catch {
      return null;
    }
  }

  private async pruneOtherVersions(name: string, version: string): Promise<void> {
    const keep = `${name}-${version}`;
    const entries = await readdir(this.options.cacheRoot).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry !== keep &&
            (entry.startsWith(`${name}-`) || entry.startsWith(`.staging-${name}-`)),
        )
        .map((entry) =>
          rm(path.join(this.options.cacheRoot, entry), { recursive: true, force: true }),
        ),
    );
  }
}
