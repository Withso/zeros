import http2 from "node:http2";
import type { AddressInfo } from "node:net";

import type { SimulatorInput } from "@zeros/protocol/simulators";
import { afterEach, describe, expect, it } from "vitest";

import {
  EMULATOR_SERVICE,
  EmulatorController,
  emulatorTouches,
  imageFormatRequest,
  keyRequest,
  naturalBgra,
  performEmulatorInput,
  readEmulatorImage,
  readEmulatorStatus,
  rotationRequest,
  touchRequest,
  type EmulatorInputPort,
  type EmulatorKeyEvent,
  type EmulatorTouch,
  type ImageTurns,
} from "../devices/android-emulator";
import { ProtoWriter, protoField, readProtoFields } from "../devices/android-grpc";

function fields(message: Buffer) {
  return readProtoFields(message);
}

function imageMessage(width: number, height: number, turns: number, bytes: Buffer): Buffer {
  const rotation = new ProtoWriter().varint(1, turns);
  const format = new ProtoWriter().varint(1, 1).message(2, rotation).varint(3, width).varint(4, height);
  return new ProtoWriter().message(1, format).bytes(4, bytes).varint(5, 7).finish();
}

/** A natural framebuffer whose pixels say where they are. */
function naturalRgba(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.set([10 * y + x, 100, 200, 255], (y * width + x) * 4);
    }
  }
  return pixels;
}

/** Turns an RGBA image a quarter turn counterclockwise. */
function turnLeft(pixels: Buffer, width: number, height: number): Buffer {
  const turned = Buffer.alloc(pixels.length);
  // The turned image is `height` wide and `width` tall.
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < height; x++) {
      const from = (x * width + (width - 1 - y)) * 4;
      pixels.copy(turned, (y * height + x) * 4, from, from + 4);
    }
  }
  return turned;
}

function bgraOf(rgba: Buffer): Buffer {
  const bgra = Buffer.from(rgba);
  for (let index = 0; index < bgra.length; index += 4) {
    bgra[index] = rgba[index + 2]!;
    bgra[index + 2] = rgba[index]!;
  }
  return bgra;
}

describe("emulator requests", () => {
  it("encodes touches, keys, rotation and image formats", () => {
    const touches = fields(
      touchRequest([
        { x: 10.4, y: 20.6, id: 1, down: true },
        { x: 5, y: 6, id: 2, down: false },
      ]),
    );
    expect(touches.map((entry) => entry.field)).toEqual([1, 1]);
    const first = fields(touches[0]!.bytes!);
    expect(first.map((entry) => [entry.field, entry.number])).toEqual([
      [1, 10],
      [2, 21],
      [3, 1],
      [4, 1],
    ]);
    expect(protoField(fields(touches[1]!.bytes!), 4)!.number).toBe(0);

    const key = fields(keyRequest("GoHome", "keypress"));
    expect(protoField(key, 2)!.number).toBe(2);
    expect(protoField(key, 4)!.bytes!.toString()).toBe("GoHome");

    const rotation = fields(rotationRequest("landscape-right"));
    expect(protoField(rotation, 1)!.number).toBe(1);
    expect(protoField(rotation, 4)!.number).toBe(1);
    const data = protoField(fields(protoField(rotation, 3)!.bytes!), 1)!.bytes!;
    expect([data.readFloatLE(0), data.readFloatLE(4), data.readFloatLE(8)]).toEqual([0, 0, -90]);

    const rgba = fields(imageFormatRequest("rgba", 1200, 1200));
    expect(rgba.map((entry) => [entry.field, entry.number])).toEqual([
      [1, 1],
      [3, 1200],
      [4, 1200],
    ]);
    expect(fields(imageFormatRequest("png")).map((entry) => [entry.field, entry.number])).toEqual([
      [1, 0],
    ]);
  });
});

describe("emulator replies", () => {
  it("reads whether the device has booted", () => {
    expect(readEmulatorStatus(new ProtoWriter().string(1, "37.2").varint(3, true).finish())).toEqual({
      booted: true,
    });
    expect(readEmulatorStatus(Buffer.alloc(0))).toEqual({ booted: false });
  });

  it("reads an image, and skips an empty one", () => {
    const image = readEmulatorImage(imageMessage(3, 2, 1, Buffer.alloc(24, 9)));
    expect(image).toMatchObject({ width: 3, height: 2, turns: 1 });
    expect(image!.bytes.length).toBe(24);
    expect(readEmulatorImage(imageMessage(0, 0, 0, Buffer.alloc(0)))).toBeNull();
    expect(readEmulatorImage(imageMessage(3, 2, 9, Buffer.alloc(24)))).toBeNull();
  });

  it("turns frames back to the natural framebuffer, however the device is held", () => {
    const width = 2;
    const height = 3;
    const natural = naturalRgba(width, height);
    const expected = bgraOf(natural);
    let turned = natural;
    let size = { width, height };
    for (const turns of [0, 1, 2, 3] as ImageTurns[]) {
      const result = naturalBgra({ ...size, turns, bytes: turned });
      expect({ width: result.width, height: result.height }).toEqual({ width, height });
      expect([...result.pixels]).toEqual([...expected]);
      turned = turnLeft(turned, size.width, size.height);
      size = { width: size.height, height: size.width };
    }
  });

  it("reads image bytes that don't start on a word, and reuses a target", () => {
    const natural = naturalRgba(4, 4);
    const unaligned = Buffer.alloc(natural.length + 1);
    natural.copy(unaligned, 1);
    const target = Buffer.alloc(natural.length);
    const result = naturalBgra(
      { width: 4, height: 4, turns: 0, bytes: unaligned.subarray(1) },
      target,
    );
    expect(result.pixels).toBe(target);
    expect([...result.pixels]).toEqual([...bgraOf(natural)]);
    expect(() => naturalBgra({ width: 4, height: 4, turns: 0, bytes: Buffer.alloc(8) })).toThrow();
  });
});

class FakeInput implements EmulatorInputPort {
  readonly calls: string[] = [];
  touch = async (touches: readonly EmulatorTouch[]) => {
    this.calls.push(
      `touch ${touches.map((touch) => `${touch.id}:${Math.round(touch.x)},${Math.round(touch.y)}${touch.down ? "" : " up"}`).join(" ")}`,
    );
  };
  key = async (key: string, event: EmulatorKeyEvent) => {
    this.calls.push(`key ${key} ${event}`);
  };
  text = async (text: string) => {
    this.calls.push(`text ${text}`);
  };
  setClipboard = async (text: string) => {
    this.calls.push(`clipboard ${text}`);
  };
}

describe("performEmulatorInput", () => {
  const screen = { widthPx: 1080, heightPx: 2400, scale: 2.625 };
  const run = async (input: SimulatorInput) => {
    const port = new FakeInput();
    const sleeps: number[] = [];
    await performEmulatorInput(port, input, screen, async (ms) => {
      sleeps.push(Math.round(ms));
      port.calls.push(`sleep ${Math.round(ms)}`);
    });
    return { calls: port.calls, sleeps };
  };

  it("taps in pixels, inside the screen", async () => {
    expect((await run({ kind: "tap", at: { x: 10, y: 20 } })).calls).toEqual([
      "touch 0:26,53",
      "sleep 50",
      "touch 0:26,53 up",
    ]);
    expect((await run({ kind: "tap", at: { x: 9_000, y: 9_000 } })).calls[0]).toBe("touch 0:1079,2399");
  });

  it("drags through the points between, and holds a long press in place", async () => {
    expect((await run({ kind: "drag", from: { x: 0, y: 0 }, to: { x: 64, y: 0 }, durationMs: 64 })).calls).toEqual([
      "touch 0:0,0",
      "sleep 16",
      "touch 0:42,0",
      "sleep 16",
      "touch 0:84,0",
      "sleep 16",
      "touch 0:126,0",
      "sleep 16",
      "touch 0:168,0",
      "touch 0:168,0 up",
    ]);
    expect((await run({ kind: "drag", from: { x: 4, y: 4 }, to: { x: 4, y: 4 }, durationMs: 600 })).calls).toEqual([
      "touch 0:11,11",
      "sleep 600",
      "touch 0:11,11 up",
    ]);
  });

  it("pinches with two fingers around the center", async () => {
    const { calls } = await run({ kind: "pinch", scale: 2 });
    expect(calls[0]).toBe("touch 1:432,1200 2:648,1200");
    expect(calls.at(-2)).toBe("touch 1:324,1200 2:756,1200");
    expect(calls.at(-1)).toBe("touch 1:324,1200 up 2:756,1200 up");
    const out = await run({ kind: "pinch", scale: 0.5 });
    expect(out.calls[0]).toBe("touch 1:108,1200 2:972,1200");
    expect(out.calls.at(-1)).toBe("touch 1:324,1200 up 2:756,1200 up");
  });

  it("types what the keyboard can, and pastes the rest", async () => {
    expect((await run({ kind: "text", text: "hello world\n" })).calls).toEqual(["text hello world\n"]);
    expect((await run({ kind: "text", text: "héllo ✓" })).calls).toEqual([
      "clipboard héllo ✓",
      "sleep 100",
      "key Control keydown",
      "key v keypress",
      "key Control keyup",
    ]);
  });

  it("follows a live finger, or two, in pixels, lifting them for an up or a cancel", () => {
    expect(emulatorTouches({ phase: "down", at: { x: 10, y: 20 } }, screen)).toEqual([
      { x: 26, y: 53, id: 0, down: true },
    ]);
    expect(
      emulatorTouches({ phase: "move", at: { x: 10, y: 20 }, second: { x: 9_000, y: 0 } }, screen),
    ).toEqual([
      { x: 26, y: 53, id: 0, down: true },
      { x: 1079, y: 0, id: 1, down: true },
    ]);
    for (const phase of ["up", "cancel"] as const) {
      expect(emulatorTouches({ phase, at: { x: 10, y: 20 } }, screen)).toEqual([
        { x: 26, y: 53, id: 0, down: false },
      ]);
    }
  });

  it("presses keys and buttons by their W3C names", async () => {
    expect((await run({ kind: "key", key: "enter" })).calls).toEqual(["key Enter keypress"]);
    expect((await run({ kind: "key", key: "space" })).calls).toEqual(["key   keypress"]);
    expect((await run({ kind: "key", key: "arrow-left" })).calls).toEqual(["key ArrowLeft keypress"]);
    expect((await run({ kind: "button", button: "home" })).calls).toEqual(["key GoHome keypress"]);
    expect((await run({ kind: "button", button: "back" })).calls).toEqual(["key GoBack keypress"]);
    expect((await run({ kind: "button", button: "lock" })).calls).toEqual(["key Power keypress"]);
  });
});

function grpcFrame(message: Buffer): Buffer {
  const frame = Buffer.alloc(5 + message.length);
  frame.writeUInt32BE(message.length, 1);
  message.copy(frame, 5);
  return frame;
}

let server: http2.Http2Server | null = null;
let controller: EmulatorController | null = null;

afterEach(async () => {
  controller?.close();
  controller = null;
  const running = server;
  server = null;
  if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
});

type Handler = (method: string, stream: http2.ServerHttp2Stream, request: Buffer, token: unknown) => void;

async function emulator(handler: Handler): Promise<number> {
  server = http2.createServer();
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const body = Buffer.concat(chunks);
      const path = String(headers[":path"]);
      expect(path.startsWith(`/${EMULATOR_SERVICE}/`)).toBe(true);
      handler(path.split("/").pop()!, stream, body.subarray(5), headers.authorization);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as AddressInfo).port;
}

function respond(stream: http2.ServerHttp2Stream, messages: Buffer[], end = true): void {
  stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: end });
  if (end) stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
  for (const message of messages) stream.write(grpcFrame(message));
  if (end) stream.end();
}

describe("EmulatorController", () => {
  it("reads status and screenshots with the emulator's token", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const port = await emulator((method, stream, request, token) => {
      expect(token).toBe("Bearer emulator-token");
      if (method === "getStatus") respond(stream, [new ProtoWriter().varint(3, 1).finish()]);
      else if (method === "getScreenshot") {
        expect(protoField(readProtoFields(request), 1)?.number ?? 0).toBe(0);
        respond(stream, [imageMessage(1080, 2400, 0, png)]);
      } else respond(stream, [Buffer.alloc(0)]);
    });
    controller = new EmulatorController(port, "emulator-token");
    await expect(controller.status()).resolves.toEqual({ booted: true });
    await expect(controller.screenshot()).resolves.toEqual(png);
    await expect(controller.rotate("landscape-left")).resolves.toBeUndefined();
  });

  it("streams natural frames, at most the frame rate, always ending on the latest", async () => {
    const natural = naturalRgba(2, 3);
    let closed!: () => void;
    const serverClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const port = await emulator((method, stream, request) => {
      expect(method).toBe("streamScreenshot");
      const format = readProtoFields(request);
      expect([protoField(format, 1)!.number, protoField(format, 3)!.number, protoField(format, 4)!.number]).toEqual([
        1, 6, 6,
      ]);
      stream.on("close", () => closed());
      respond(
        stream,
        [
          imageMessage(2, 3, 0, natural),
          imageMessage(0, 0, 0, Buffer.alloc(0)),
          imageMessage(2, 3, 0, Buffer.alloc(24, 1)),
          imageMessage(3, 2, 1, turnLeft(natural, 2, 3)),
        ],
        false,
      );
    });
    controller = new EmulatorController(port, null);
    const frames: Array<{ width: number; height: number; first: number }> = [];
    const ended: Array<Error | null> = [];
    const gotTwo = new Promise<void>((resolve) => {
      const feed = controller!.frames({
        maxSide: 6,
        fps: 20,
        onFrame: (pixels, width, height) => {
          frames.push({ width, height, first: pixels[2]! });
          if (frames.length === 2) {
            feed.stop();
            resolve();
          }
        },
        onEnd: (error) => ended.push(error),
      });
    });
    await gotTwo;
    // The frame between was replaced by the last before its turn came.
    expect(frames).toEqual([
      { width: 2, height: 3, first: 0 },
      { width: 2, height: 3, first: 0 },
    ]);
    await serverClosed;
    expect(ended).toEqual([]);
  });

  it("says when the stream ends", async () => {
    const port = await emulator((_method, stream) => respond(stream, []));
    controller = new EmulatorController(port, null);
    const error = await new Promise<Error | null>((resolve) => {
      controller!.frames({ maxSide: 6, fps: 30, onFrame: () => undefined, onEnd: resolve });
    });
    expect(error).toBeNull();
  });
});
