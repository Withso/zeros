import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readSimulatorDeviceFrame } from "@zeros/protocol/simulators";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AndroidDeviceFrames, parseArtLayout, webpSize } from "../devices/android-device-frame";

const PIXEL_10_LAYOUT = `parts {
  device {
    display {
      width 1080
      height 2424
      x 0
      y 0
      corner_radius 87
    }
  }
  portrait {
    background {
      image back.webp
    }
    foreground {
      mask mask.webp
      cutout hole
    }
  }
}
layouts {
  portrait {
    width 1198
    height 2531
    event EV_SW:0:1
    part1 {
      name portrait
      x 0
      y 0
    }
    part2 {
      name device
      x 59
      y 55
    }
  }
}
`;

const PIXEL_TABLET_LAYOUT = `parts {
  device {
    display {
      width 2560
      height 1600
      x 0
      y 0
    }
  }
  portrait {
    background {
      image back.webp
    }
    foreground {
      mask mask.webp
    }
  }
}
layouts {
  landscape {
    width 2798
    height 1837
    part1 {
      name portrait
      x 0
      y 0
    }
    part2 {
      name device
      x 119
      y 117
    }
  }
}`;

const WATCH_LAYOUT = `parts {
    portrait {
        background {
            image   device_bezel.png
        }
    }
    device {
        display {
            width   402
            height  476
        }
    }
}
layouts {
    portrait {
        width     466
        height    540
        part1 {
            name    portrait
            x       16
            y       16
        }
        part2 {
            name    device
            x       32
            y       32
        }
    }
}`;

function riff(chunk: string, body: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + 8 + body.length, 4);
  header.write("WEBP", 8, "ascii");
  header.write(chunk, 12, "ascii");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, size, body]);
}

function extendedWebp(width: number, height: number): Buffer {
  const body = Buffer.alloc(14);
  body.writeUIntLE(width - 1, 4, 3);
  body.writeUIntLE(height - 1, 7, 3);
  return riff("VP8X", body);
}

function losslessWebp(width: number, height: number): Buffer {
  const body = Buffer.alloc(14);
  body[0] = 0x2f;
  body.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1);
  return riff("VP8L", body);
}

function lossyWebp(width: number, height: number): Buffer {
  const body = Buffer.alloc(14);
  body.set([0x9d, 0x01, 0x2a], 3);
  body.writeUInt16LE(width, 6);
  body.writeUInt16LE(height, 8);
  return riff("VP8 ", body);
}

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const PIXEL_10_SCREEN = { widthPx: 1080, heightPx: 2424, scale: 2.625, cornerRadius: 0 };

let root: string;

async function art(profile: string, files: Record<string, string | Buffer>): Promise<void> {
  await mkdir(path.join(root, profile), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(root, profile, name), content);
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zeros-android-art-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("parseArtLayout", () => {
  it("reads a Pixel's display, frame, picture and mask", () => {
    expect(parseArtLayout(PIXEL_10_LAYOUT)).toEqual({
      display: { width: 1080, height: 2424, cornerRadius: 87 },
      frame: { width: 1198, height: 2531, screenX: 59, screenY: 55 },
      background: { file: "back.webp", x: 0, y: 0 },
      mask: "mask.webp",
    });
  });

  it("uses a landscape layout when that's the only one, as on Pixel Tablet", () => {
    expect(parseArtLayout(PIXEL_TABLET_LAYOUT)).toEqual({
      display: { width: 2560, height: 1600, cornerRadius: 0 },
      frame: { width: 2798, height: 1837, screenX: 119, screenY: 117 },
      background: { file: "back.webp", x: 0, y: 0 },
      mask: "mask.webp",
    });
  });

  it("keeps where a watch's picture sits, and has no mask", () => {
    expect(parseArtLayout(WATCH_LAYOUT)).toMatchObject({
      background: { file: "device_bezel.png", x: 16, y: 16 },
      mask: null,
    });
  });

  it("rejects art without a portrait picture, and file names that leave the folder", () => {
    expect(parseArtLayout(PIXEL_10_LAYOUT.replace("portrait {\n    background", "landscape {\n    background"))).toBeNull();
    expect(parseArtLayout(PIXEL_10_LAYOUT.replace("image back.webp", "image ../back.webp"))).toBeNull();
    expect(parseArtLayout(PIXEL_10_LAYOUT.replace("mask mask.webp", "mask /tmp/mask.webp"))).toBeNull();
    expect(parseArtLayout(PIXEL_10_LAYOUT.replace("width 1080", "width -1"))).toBeNull();
    expect(parseArtLayout("")).toBeNull();
  });
});

describe("webpSize", () => {
  it("reads extended, lossless and lossy headers", () => {
    expect(webpSize(extendedWebp(1205, 2535))).toEqual({ width: 1205, height: 2535 });
    expect(webpSize(losslessWebp(1080, 2424))).toEqual({ width: 1080, height: 2424 });
    expect(webpSize(lossyWebp(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("rejects anything else", () => {
    expect(webpSize(png(10, 10))).toBeNull();
    expect(webpSize(Buffer.from("RIFF"))).toBeNull();
    const broken = losslessWebp(10, 10);
    broken[20] = 0;
    expect(webpSize(broken)).toBeNull();
  });
});

describe("AndroidDeviceFrames", () => {
  it("lays out the picture, screen and mask in points", async () => {
    const back = extendedWebp(1205, 2535);
    const mask = losslessWebp(1080, 2424);
    await art("pixel_10", { layout: PIXEL_10_LAYOUT, "back.webp": back, "mask.webp": mask });
    const frames = new AndroidDeviceFrames({ artRoot: async () => root });
    const frame = await frames.frame("pixel_10", PIXEL_10_SCREEN);
    expect(frame).not.toBeNull();
    expect(frame!.width).toBeCloseTo(1205 / 2.625);
    expect(frame!.height).toBeCloseTo(2535 / 2.625);
    expect(frame!.screen.x).toBeCloseTo(59 / 2.625);
    expect(frame!.screen.y).toBeCloseTo(55 / 2.625);
    expect(frame!.screen.width).toBeCloseTo(1080 / 2.625);
    expect(frame!.screen.height).toBeCloseTo(2424 / 2.625);
    expect(frame!.image!.url).toBe(`data:image/webp;base64,${back.toString("base64")}`);
    expect(frame!.mask!.url).toBe(`data:image/webp;base64,${mask.toString("base64")}`);
    expect(frame!.mask!.width).toBeCloseTo(frame!.screen.width);
    expect(frame!.buttons).toEqual([]);
    expect(readSimulatorDeviceFrame(frame)).toEqual(frame);
    await expect(frames.cornerRadius("pixel_10", PIXEL_10_SCREEN)).resolves.toBeCloseTo(87 / 2.625);
  });

  it("keeps the layout's size when the picture is smaller", async () => {
    await art("pixel_10", {
      layout: PIXEL_10_LAYOUT,
      "back.webp": png(1100, 2500),
      "mask.webp": png(1080, 2424),
    });
    const frame = await new AndroidDeviceFrames({ artRoot: async () => root }).frame(
      "pixel_10",
      PIXEL_10_SCREEN,
    );
    expect(frame!.width).toBeCloseTo(1198 / 2.625);
    expect(frame!.height).toBeCloseTo(2531 / 2.625);
    expect(frame!.image!.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("draws Zeros' frame when the art is for another screen, missing or unreadable", async () => {
    await art("pixel_10", { layout: PIXEL_10_LAYOUT, "back.webp": extendedWebp(1205, 2535) });
    await art("watch", { layout: WATCH_LAYOUT, "device_bezel.png": png(434, 508) });
    const log = vi.fn();
    const frames = new AndroidDeviceFrames({ artRoot: async () => root, log });
    // A device made from the Pixel 10 profile with a changed screen.
    await expect(
      frames.frame("pixel_10", { ...PIXEL_10_SCREEN, widthPx: 1440, heightPx: 3120 }),
    ).resolves.toBeNull();
    await expect(
      frames.cornerRadius("pixel_10", { widthPx: 1440, heightPx: 3120, scale: 3.5 }),
    ).resolves.toBeNull();
    // Its mask is missing.
    await expect(frames.frame("pixel_10", PIXEL_10_SCREEN)).resolves.toBeNull();
    await expect(frames.frame("medium_phone", PIXEL_10_SCREEN)).resolves.toBeNull();
    await expect(
      frames.frame("watch", { widthPx: 402, heightPx: 476, scale: 2, cornerRadius: 0 }),
    ).resolves.toBeNull();
    await expect(frames.frame("../pixel_10", PIXEL_10_SCREEN)).resolves.toBeNull();
  });

  it("skips art larger than it will ever send", async () => {
    const huge = Buffer.concat([extendedWebp(1205, 2535), Buffer.alloc(4 * 1024 * 1024)]);
    await art("pixel_10", {
      layout: PIXEL_10_LAYOUT,
      "back.webp": huge,
      "mask.webp": losslessWebp(1080, 2424),
    });
    const frames = new AndroidDeviceFrames({ artRoot: async () => root });
    await expect(frames.frame("pixel_10", PIXEL_10_SCREEN)).resolves.toBeNull();
  });

  it("reads each frame once, and looks for Android Studio again until it's there", async () => {
    await art("pixel_10", {
      layout: PIXEL_10_LAYOUT,
      "back.webp": extendedWebp(1205, 2535),
      "mask.webp": losslessWebp(1080, 2424),
    });
    let installed = false;
    const artRoot = vi.fn(async () => (installed ? root : null));
    const frames = new AndroidDeviceFrames({ artRoot });
    await expect(frames.layout("pixel_10")).resolves.toBeNull();
    await expect(frames.frame("pixel_10", PIXEL_10_SCREEN)).resolves.toBeNull();
    installed = true;
    await expect(frames.layout("pixel_10")).resolves.not.toBeNull();
    const first = await frames.frame("pixel_10", PIXEL_10_SCREEN);
    const second = await frames.frame("pixel_10", PIXEL_10_SCREEN);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });
});
