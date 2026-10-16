import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SimulatorScreen } from "@zeros/protocol/simulators";

import {
  DeviceFrames,
  SIPS,
  layoutDeviceFrame,
  parseDeviceChrome,
  parseSipsSize,
  type DeviceChrome,
  type ImageSizes,
} from "../devices/ios-device-frame";
import { PLUTIL, type ToolRunner } from "../devices/tool-runner";

const SLICES = {
  topLeft: "Phone TL",
  top: "Phone Top",
  topRight: "Phone TR",
  right: "Phone Right",
  bottomRight: "Phone BR",
  bottom: "Phone Base",
  bottomLeft: "Phone BL",
  left: "Phone Left",
};

function button(
  name: string,
  image: string,
  anchor: string,
  align: string,
  x: number,
  y: number,
  extra: Record<string, unknown> = {},
) {
  return {
    name,
    type: "button",
    image,
    imageDown: `${image} Dn`,
    onTop: false,
    anchor,
    align,
    offsets: { normal: { x, y }, rollover: { x: x / 2, y } },
    ...extra,
  };
}

// DeviceKit's phone11 chrome, as Xcode 27 ships it.
function phone11(): Record<string, unknown> {
  return {
    identifier: "com.apple.dt.devicekit.chrome.phone11",
    images: {
      ...SLICES,
      composite: "PhoneComposite",
      screen: "Screen",
      sizing: { leftWidth: 18, rightWidth: 18, topHeight: 18, bottomHeight: 18 },
    },
    inputs: [
      button("action", "Mute BTN", "left", "leading", 8, 160),
      button("volume-up", "Vol BTN", "left", "leading", 8, 221),
      button("volume-down", "Vol BTN", "left", "leading", 8, 300),
      button("power", "X_Power BTN", "right", "leading", -8, 262),
    ],
  };
}

const PHONE11_SIZES: ImageSizes = {
  "Phone TL": { width: 110, height: 110 },
  "Phone Top": { width: 1, height: 110 },
  "Phone TR": { width: 110, height: 110 },
  "Phone Right": { width: 110, height: 1 },
  "Phone BR": { width: 110, height: 110 },
  "Phone Base": { width: 1, height: 110 },
  "Phone BL": { width: 110, height: 110 },
  "Phone Left": { width: 110, height: 1 },
  "Mute BTN": { width: 16, height: 34 },
  "Vol BTN": { width: 16, height: 64 },
  "X_Power BTN": { width: 16, height: 101 },
  "Home BTN": { width: 67, height: 67 },
  "Pad Power": { width: 63, height: 16 },
};

function urlsFor(sizes: ImageSizes): Record<string, string> {
  return Object.fromEntries(Object.keys(sizes).map((name) => [name, `data:image/png;base64,${name}`]));
}

function chromeOf(document: unknown): DeviceChrome {
  const chrome = parseDeviceChrome(document);
  if (!chrome) throw new Error("chrome did not parse");
  return chrome;
}

describe("parseDeviceChrome", () => {
  it("reads the nine slices, insets and side buttons", () => {
    const chrome = chromeOf(phone11());
    expect(chrome.slices).toEqual(SLICES);
    expect(chrome.insets).toEqual({ top: 18, left: 18, bottom: 18, right: 18 });
    expect(chrome.buttons).toEqual([
      { name: "action", image: "Mute BTN", anchor: "left", align: "leading", onTop: false, x: 8, y: 160 },
      { name: "volume-up", image: "Vol BTN", anchor: "left", align: "leading", onTop: false, x: 8, y: 221 },
      { name: "volume-down", image: "Vol BTN", anchor: "left", align: "leading", onTop: false, x: 8, y: 300 },
      { name: "power", image: "X_Power BTN", anchor: "right", align: "leading", onTop: false, x: -8, y: 262 },
    ]);
  });

  it("rejects a chrome without every slice or its sizing", () => {
    const missingSlice = phone11();
    delete (missingSlice.images as Record<string, unknown>).left;
    expect(parseDeviceChrome(missingSlice)).toBeNull();

    const missingSizing = phone11();
    delete (missingSizing.images as Record<string, unknown>).sizing;
    expect(parseDeviceChrome(missingSizing)).toBeNull();

    expect(parseDeviceChrome(null)).toBeNull();
    expect(parseDeviceChrome([])).toBeNull();
  });

  it("never accepts an image name that could leave the chrome bundle", () => {
    for (const name of ["../Phone TL", "/etc/hosts", ".hidden", "a/b", "x".repeat(81)]) {
      const document = phone11();
      (document.images as Record<string, unknown>).topLeft = name;
      expect(parseDeviceChrome(document)).toBeNull();
    }
    const document = phone11();
    (document.inputs as unknown[]).push(button("evil", "../../secret", "left", "leading", 8, 10));
    expect(chromeOf(document).buttons.map((entry) => entry.name)).not.toContain("evil");
  });

  it("skips inputs it can't place", () => {
    const document = phone11();
    document.inputs = [
      { ...button("digital-crown", "DigitalCrown", "right", "leading", -6, 47), type: "crown" },
      button("sideways", "Vol BTN", "middle", "leading", 0, 0),
      button("tilted", "Vol BTN", "left", "diagonal", 0, 0),
      { ...button("far", "Vol BTN", "left", "leading", 0, 0), offsets: { normal: { x: 9_000, y: 0 } } },
      button("home", "Home BTN", "bottom", "center", 0, -90, { onTop: true }),
    ];
    expect(chromeOf(document).buttons).toEqual([
      { name: "home", image: "Home BTN", anchor: "bottom", align: "center", onTop: true, x: 0, y: -90 },
    ]);
  });
});

describe("layoutDeviceFrame", () => {
  it("frames an iPhone screen and places its side buttons behind the frame", () => {
    // iPhone 17 Pro: 1206 × 2622 pixels at 3x.
    const frame = layoutDeviceFrame(chromeOf(phone11()), 402, 874, PHONE11_SIZES, urlsFor(PHONE11_SIZES));
    expect(frame).not.toBeNull();
    expect(frame?.width).toBe(438);
    expect(frame?.height).toBe(910);
    expect(frame?.screen).toEqual({ x: 18, y: 18, width: 402, height: 874 });
    expect(frame?.slices?.topLeft).toEqual({
      url: "data:image/png;base64,Phone TL",
      width: 110,
      height: 110,
    });
    expect(frame?.buttons.map(({ name, x, y, onTop }) => ({ name, x, y, onTop }))).toEqual([
      { name: "action", x: -8, y: 160, onTop: false },
      { name: "volume-up", x: -8, y: 221, onTop: false },
      { name: "volume-down", x: -8, y: 300, onTop: false },
      { name: "power", x: 430, y: 262, onTop: false },
    ]);
    expect(frame?.outset).toEqual({ top: 0, left: 8, bottom: 0, right: 8 });
  });

  it("measures trailing offsets from the far end of the edge", () => {
    const chrome = chromeOf({
      images: {
        ...SLICES,
        sizing: { leftWidth: 46, rightWidth: 46, topHeight: 46, bottomHeight: 46 },
      },
      inputs: [
        button("power", "Pad Power", "top", "trailing", -74, 8),
        button("volume-up", "Vol BTN", "right", "leading", -8, 100),
        button("side", "Vol BTN", "right", "trailing", -4, -50),
      ],
    });
    // iPad Pro 11-inch: 834 × 1210 points.
    const frame = layoutDeviceFrame(chrome, 834, 1210, PHONE11_SIZES, urlsFor(PHONE11_SIZES));
    expect(frame?.width).toBe(926);
    expect(frame?.height).toBe(1302);
    expect(frame?.buttons.map(({ name, x, y }) => ({ name, x, y }))).toEqual([
      { name: "power", x: 926 - 74 - 63, y: -8 },
      { name: "volume-up", x: 918, y: 100 },
      { name: "side", x: 922, y: 1302 - 50 - 64 },
    ]);
    expect(frame?.outset).toEqual({ top: 8, left: 0, bottom: 0, right: 12 });
  });

  it("centres a home button on the chin and draws it over the frame", () => {
    const chrome = chromeOf({
      images: {
        ...SLICES,
        sizing: { leftWidth: 28, rightWidth: 28, topHeight: 111, bottomHeight: 111 },
      },
      inputs: [button("home", "Home BTN", "bottom", "center", 0, -90, { onTop: true })],
    });
    // iPhone SE: 375 × 667 points.
    const frame = layoutDeviceFrame(chrome, 375, 667, PHONE11_SIZES, urlsFor(PHONE11_SIZES));
    expect(frame?.buttons).toEqual([
      {
        name: "home",
        image: { url: "data:image/png;base64,Home BTN", width: 67, height: 67 },
        x: (431 - 67) / 2,
        y: 889 - 90,
        onTop: true,
      },
    ]);
    expect(frame?.outset).toEqual({ top: 0, left: 0, bottom: 0, right: 0 });
  });

  it("falls back when a slice has no art or the corners don't fit", () => {
    const chrome = chromeOf(phone11());
    const sizes = { ...PHONE11_SIZES };
    delete sizes["Phone BR"];
    expect(layoutDeviceFrame(chrome, 402, 874, sizes, urlsFor(sizes))).toBeNull();

    const urls = urlsFor(PHONE11_SIZES);
    delete urls["Phone Top"];
    expect(layoutDeviceFrame(chrome, 402, 874, PHONE11_SIZES, urls)).toBeNull();

    expect(layoutDeviceFrame(chrome, 150, 874, PHONE11_SIZES, urlsFor(PHONE11_SIZES))).toBeNull();
  });

  it("leaves out a button whose art is missing", () => {
    const sizes = { ...PHONE11_SIZES };
    delete sizes["X_Power BTN"];
    const frame = layoutDeviceFrame(chromeOf(phone11()), 402, 874, sizes, urlsFor(sizes));
    expect(frame?.buttons.map((entry) => entry.name)).toEqual(["action", "volume-up", "volume-down"]);
    expect(frame?.outset.right).toBe(0);
  });
});

describe("parseSipsSize", () => {
  it("reads a PDF's size in points", () => {
    expect(
      parseSipsSize("/x/Phone TL.pdf\n  pixelWidth: 110.000\n  pixelHeight: 96.500\n"),
    ).toEqual({ width: 110, height: 96.5 });
  });

  it("rejects missing, zero and implausible sizes", () => {
    expect(parseSipsSize("Warning: /x.pdf not a valid file - skipping\n")).toBeNull();
    expect(parseSipsSize("  pixelWidth: 0\n  pixelHeight: 10\n")).toBeNull();
    expect(parseSipsSize("  pixelWidth: 10\n  pixelHeight: 9000\n")).toBeNull();
  });
});

describe("DeviceFrames", () => {
  // iPhone 17 Pro and iPhone 17 Pro Max share phone11's art.
  const PRO: SimulatorScreen = { widthPx: 1206, heightPx: 2622, scale: 3, cornerRadius: 62 };
  const PRO_MAX: SimulatorScreen = { widthPx: 1320, heightPx: 2868, scale: 3, cornerRadius: 62 };
  const PHONE11 = "com.apple.dt.devicekit.chrome.phone11";

  let root: string;
  let chromeRoot: string;
  let cacheRoot: string;
  let calls: string[][];
  let missingArt: Set<string>;

  const run: ToolRunner = async (file, args) => {
    calls.push([file, ...args]);
    if (file === PLUTIL) return { stdout: "398\n", stderr: "" };
    if (file !== SIPS) throw new Error(`unexpected ${file}`);
    const pdf = args.find((arg) => arg.endsWith(".pdf")) ?? "";
    const name = path.basename(pdf, ".pdf");
    if (args[0] === "-g") {
      const size = PHONE11_SIZES[name];
      return {
        stdout:
          size && !missingArt.has(name)
            ? `${pdf}\n  pixelWidth: ${size.width}.000\n  pixelHeight: ${size.height}.000\n`
            : `Warning: ${pdf} not a valid file - skipping\n`,
        stderr: "",
      };
    }
    const out = args[args.indexOf("--out") + 1];
    await writeFile(out, `png:${name}:${args[args.indexOf("-Z") + 1]}`);
    return { stdout: "", stderr: "" };
  };

  const sipsCalls = () => calls.filter(([file]) => file === SIPS).length;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "zeros-device-frame-"));
    chromeRoot = path.join(root, "Chrome");
    cacheRoot = path.join(root, "cache");
    calls = [];
    missingArt = new Set();
    const contents = path.join(chromeRoot, "phone11.devicechrome", "Contents");
    await mkdir(path.join(contents, "Resources"), { recursive: true });
    await writeFile(path.join(contents, "Resources", "chrome.json"), JSON.stringify(phone11()));
    await writeFile(path.join(contents, "version.plist"), "<plist/>");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("converts the art once at 3x and lays it out for each screen", async () => {
    const frames = new DeviceFrames({ run, cacheRoot, chromeRoot });
    const [pro, proMax] = await Promise.all([frames.frame(PHONE11, PRO), frames.frame(PHONE11, PRO_MAX)]);

    expect(pro?.screen).toEqual({ x: 18, y: 18, width: 402, height: 874 });
    expect(proMax?.screen).toEqual({ x: 18, y: 18, width: 440, height: 956 });
    // Eleven distinct images, each measured then converted, once.
    expect(sipsCalls()).toBe(22);
    expect(calls).toContainEqual([
      SIPS,
      "-s",
      "format",
      "png",
      "-Z",
      "330",
      path.join(chromeRoot, "phone11.devicechrome", "Contents", "Resources", "Phone TL.pdf"),
      "--out",
      expect.stringContaining("Phone TL.png"),
    ]);
    expect(pro?.slices?.topLeft.url).toBe(
      `data:image/png;base64,${Buffer.from("png:Phone TL:330").toString("base64")}`,
    );
    expect(await readdir(cacheRoot)).toEqual(["phone11-398"]);
  });

  it("reuses the converted art on the next launch", async () => {
    await new DeviceFrames({ run, cacheRoot, chromeRoot }).frame(PHONE11, PRO);
    calls = [];
    const frame = await new DeviceFrames({ run, cacheRoot, chromeRoot }).frame(PHONE11, PRO);
    expect(frame?.buttons).toHaveLength(4);
    expect(sipsCalls()).toBe(0);
  });

  it("remembers art that won't convert and falls back without retrying", async () => {
    missingArt.add("Phone Base");
    expect(await new DeviceFrames({ run, cacheRoot, chromeRoot }).frame(PHONE11, PRO)).toBeNull();
    const manifest = JSON.parse(await readFile(path.join(cacheRoot, "phone11-398", "frame.json"), "utf8"));
    expect(manifest.missing).toEqual(["Phone Base"]);

    calls = [];
    expect(await new DeviceFrames({ run, cacheRoot, chromeRoot }).frame(PHONE11, PRO)).toBeNull();
    expect(sipsCalls()).toBe(0);
  });

  it("drops art cached for other DeviceKit versions only", async () => {
    await mkdir(path.join(cacheRoot, "phone11-397"), { recursive: true });
    await mkdir(path.join(cacheRoot, ".staging-phone11-397-1-2"), { recursive: true });
    await mkdir(path.join(cacheRoot, "phone1-398"), { recursive: true });
    await mkdir(path.join(cacheRoot, "tablet5-398"), { recursive: true });
    await new DeviceFrames({ run, cacheRoot, chromeRoot }).frame(PHONE11, PRO);
    expect((await readdir(cacheRoot)).sort()).toEqual(["phone1-398", "phone11-398", "tablet5-398"]);
  });

  it("ignores chrome identifiers it doesn't recognise", async () => {
    const frames = new DeviceFrames({ run, cacheRoot, chromeRoot });
    for (const identifier of [
      "phone11",
      "com.apple.dt.devicekit.chrome.../phone11",
      "com.apple.dt.devicekit.chrome.Phone11",
      "com.example.chrome.phone11",
    ]) {
      expect(await frames.frame(identifier, PRO)).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it("logs a missing chrome and tries again next time", async () => {
    const logs: string[] = [];
    const frames = new DeviceFrames({ run, cacheRoot, chromeRoot, log: (line) => logs.push(line) });
    const tablet = "com.apple.dt.devicekit.chrome.tablet5";
    expect(await frames.frame(tablet, PRO)).toBeNull();
    expect(logs).toHaveLength(1);

    const contents = path.join(chromeRoot, "tablet5.devicechrome", "Contents");
    await mkdir(path.join(contents, "Resources"), { recursive: true });
    await writeFile(path.join(contents, "Resources", "chrome.json"), JSON.stringify(phone11()));
    await writeFile(path.join(contents, "version.plist"), "<plist/>");
    expect(await frames.frame(tablet, PRO)).not.toBeNull();
  });
});
