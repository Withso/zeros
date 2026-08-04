import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// H3: read_file now anchors the renderer-supplied cwd to the engine's
// currentRoot() (the open project / a worktree) so it can't read arbitrary host
// paths. In production the Files-tab cwd is always that root; here we simulate
// it by pointing currentRoot() at the per-test temp dir.
const sidecarMock = vi.hoisted(() => ({ root: null as string | null }));
vi.mock("../../../sidecar", () => ({ currentRoot: () => sidecarMock.root }));

const nativeImageMock = vi.hoisted(() => {
  const thumbnail = {
    isEmpty: vi.fn(() => false),
    getSize: vi.fn(() => ({ width: 192, height: 108 })),
    resize: vi.fn(),
    toDataURL: vi.fn(() => "data:image/png;base64,THUMBNAIL"),
  };
  thumbnail.resize.mockReturnValue(thumbnail);
  return {
    thumbnail,
    createThumbnailFromPath: vi.fn(async () => thumbnail),
    createFromPath: vi.fn(() => thumbnail),
  };
});
vi.mock("electron", () => ({
  nativeImage: {
    createThumbnailFromPath: nativeImageMock.createThumbnailFromPath,
    createFromPath: nativeImageMock.createFromPath,
  },
}));

import {
  readFile,
  readImageThumbnail,
  type ReadFileResult,
  type ReadImageThumbnailResult,
} from "../files";

// CommandHandler is (args, event) — we only use args here. read_file never
// throws; it always returns a ReadFileResult (errors use kind:"error").
const call = (args: Record<string, unknown>): ReadFileResult =>
  (readFile as unknown as (a: Record<string, unknown>) => ReadFileResult)(args);

const callThumbnail = (
  args: Record<string, unknown>,
): Promise<ReadImageThumbnailResult> =>
  (
    readImageThumbnail as unknown as (
      a: Record<string, unknown>,
    ) => Promise<ReadImageThumbnailResult>
  )(args);

function pngFixture(bytes: number, width: number, height: number): Buffer {
  const buffer = Buffer.alloc(bytes, 1);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function rotatedJpegFixture(width: number, height: number): Buffer {
  const exif = Buffer.alloc(32);
  exif.write("Exif\0\0", 0, "ascii");
  exif.write("II", 6, "ascii");
  exif.writeUInt16LE(42, 8);
  exif.writeUInt32LE(8, 10);
  exif.writeUInt16LE(1, 14);
  exif.writeUInt16LE(0x0112, 16);
  exif.writeUInt16LE(3, 18);
  exif.writeUInt32LE(1, 20);
  exif.writeUInt16LE(6, 24);
  const app1 = Buffer.alloc(4);
  app1.set([0xff, 0xe1]);
  app1.writeUInt16BE(exif.length + 2, 2);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0]);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, exif, sof]);
}

describe("read_file", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "zeros-files-"));
    sidecarMock.root = dir; // engine "rooted" at the test dir → reads are in-workspace
    nativeImageMock.thumbnail.isEmpty.mockReset().mockReturnValue(false);
    nativeImageMock.thumbnail.getSize
      .mockReset()
      .mockReturnValue({ width: 192, height: 108 });
    nativeImageMock.thumbnail.resize
      .mockReset()
      .mockReturnValue(nativeImageMock.thumbnail);
    nativeImageMock.thumbnail.toDataURL
      .mockReset()
      .mockReturnValue("data:image/png;base64,THUMBNAIL");
    nativeImageMock.createThumbnailFromPath
      .mockReset()
      .mockResolvedValue(nativeImageMock.thumbnail);
    nativeImageMock.createFromPath
      .mockReset()
      .mockReturnValue(nativeImageMock.thumbnail);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    sidecarMock.root = null;
  });

  it("reads a text file", () => {
    writeFileSync(path.join(dir, "hello.ts"), "const a = 1;\nconst b = 2;\n");
    const res = call({ cwd: dir, path: "hello.ts" });
    expect(res.kind).toBe("text");
    expect(res.content).toContain("const a = 1;");
    expect(res.bytes).toBeGreaterThan(0);
  });

  it("reads a secret-NAMED file that lives inside the workspace (local = full access)", () => {
    // Regression: the local read path must NOT apply the remote secret denylist.
    // A committed `.npmrc` / `.env` inside the owner's own project is readable in
    // the Files tab — the same as the "Local main" trunk and the file tree show.
    // The secret/credential denylist is the REMOTE boundary only; forcing
    // remote:true here produced a misleading "refusing … over a remote connection"
    // error on a purely local worktree read.
    writeFileSync(
      path.join(dir, ".npmrc"),
      "//registry.npmjs.org/:_authToken=secret\n",
    );
    const npmrc = call({ cwd: dir, path: ".npmrc" });
    expect(npmrc.kind).toBe("text");
    expect(npmrc.content).toContain("_authToken");

    writeFileSync(path.join(dir, ".env"), "API_KEY=abc123\n");
    const env = call({ cwd: dir, path: ".env" });
    expect(env.kind).toBe("text");
    expect(env.content).toContain("API_KEY");
  });

  it("reports missing cwd / path as a clear error (never throws)", () => {
    const noCwd = call({ path: "x" });
    expect(noCwd.kind).toBe("error");
    expect(noCwd.error).toMatch(/workspace/);
    expect(call({ cwd: dir }).error).toMatch(/missing path/);
  });

  it("refuses a relative path that escapes the workspace", () => {
    // A real file just outside cwd, so the gate (not a missing-file error)
    // is what rejects it.
    const outsideDir = mkdtempSync(path.join(tmpdir(), "zeros-file-outside-"));
    const escape = path.join(outsideDir, "escape.ts");
    writeFileSync(escape, "secret");
    try {
      const res = call({ cwd: dir, path: path.relative(dir, escape) });
      expect(res.kind).toBe("error");
      expect(res.error).toMatch(/outside the workspace/);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("refuses an absolute path outside the workspace", () => {
    const res = call({ cwd: dir, path: "/etc/hosts" });
    expect(res.kind).toBe("error");
    expect(res.error).toMatch(/outside the workspace/);
  });

  it("reports a missing file with a clear reason", () => {
    const res = call({ cwd: dir, path: "does-not-exist.ts" });
    expect(res.kind).toBe("error");
    expect(res.error).toMatch(/no longer exists/);
  });

  it("reports a directory as not a file", () => {
    mkdirSync(path.join(dir, "subdir"));
    const res = call({ cwd: dir, path: "subdir" });
    expect(res.kind).toBe("error");
    expect(res.error).toMatch(/folder/);
  });

  it("reports binary files instead of decoding them", () => {
    writeFileSync(path.join(dir, "blob.dat"), Buffer.from([0x68, 0x00, 0x69]));
    const res = call({ cwd: dir, path: "blob.dat" });
    expect(res.kind).toBe("binary");
    expect(res.content).toBeUndefined();
  });

  it("reports files over the size cap as too-large", () => {
    writeFileSync(path.join(dir, "big.txt"), "a".repeat(2_100_000));
    const res = call({ cwd: dir, path: "big.txt" });
    expect(res.kind).toBe("too-large");
    expect(res.bytes).toBeGreaterThan(2_000_000);
  });

  it("returns images as a data URL", () => {
    writeFileSync(
      path.join(dir, "pic.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    const res = call({ cwd: dir, path: "pic.png" });
    expect(res.kind).toBe("image");
    expect(res.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("returns a bounded native thumbnail instead of the full image bytes", async () => {
    const imagePath = path.join(dir, "large.png");
    writeFileSync(imagePath, pngFixture(6_000_000, 1_600, 900));

    const res = await callThumbnail({ cwd: dir, path: "large.png" });

    expect(res).toEqual({
      kind: "image",
      path: "large.png",
      bytes: 6_000_000,
      width: 192,
      height: 108,
      sourceWidth: 1_600,
      sourceHeight: 900,
      dataUrl: "data:image/png;base64,THUMBNAIL",
    });
    expect(nativeImageMock.createThumbnailFromPath).toHaveBeenCalledWith(
      imagePath,
      { width: 256, height: 144 },
    );
  });

  it("preserves a portrait source ratio in the native thumbnail request", async () => {
    const imagePath = path.join(dir, "portrait.png");
    writeFileSync(imagePath, pngFixture(32, 900, 1_600));

    await callThumbnail({ cwd: dir, path: "portrait.png" });

    expect(nativeImageMock.createThumbnailFromPath).toHaveBeenCalledWith(
      imagePath,
      { width: 144, height: 256 },
    );
    expect(nativeImageMock.thumbnail.resize).toHaveBeenCalledWith({
      width: 144,
      height: 256,
      quality: "good",
    });
  });

  it("requests a larger bounded thumbnail when close zoom needs more detail", async () => {
    const imagePath = path.join(dir, "retina.png");
    writeFileSync(imagePath, pngFixture(64, 2_400, 1_350));

    await callThumbnail({
      cwd: dir,
      path: "retina.png",
      maxDimension: 1_024,
    });

    expect(nativeImageMock.createThumbnailFromPath).toHaveBeenCalledWith(
      imagePath,
      { width: 1_024, height: 576 },
    );
  });

  it("supports a sharper close-up bucket without decoding beyond its bound", async () => {
    const imagePath = path.join(dir, "close-up.png");
    writeFileSync(imagePath, pngFixture(64, 2_400, 1_350));

    await callThumbnail({
      cwd: dir,
      path: "close-up.png",
      maxDimension: 1_536,
    });

    expect(nativeImageMock.createThumbnailFromPath).toHaveBeenCalledWith(
      imagePath,
      { width: 1_536, height: 864 },
    );
  });

  it("re-decodes a safe source when the OS returns a stale undersized preview", async () => {
    const imagePath = path.join(dir, "stale-preview.png");
    writeFileSync(imagePath, pngFixture(64, 2_400, 1_350));
    const osPreview = {
      isEmpty: vi.fn(() => false),
      getSize: vi.fn(() => ({ width: 256, height: 144 })),
      resize: vi.fn(),
      toDataURL: vi.fn(() => "data:image/png;base64,BLURRY"),
    };
    osPreview.resize.mockReturnValue(osPreview);
    const sharpPreview = {
      isEmpty: vi.fn(() => false),
      getSize: vi.fn(() => ({ width: 1_536, height: 864 })),
      resize: vi.fn(),
      toDataURL: vi.fn(() => "data:image/png;base64,SHARP"),
    };
    sharpPreview.resize.mockReturnValue(sharpPreview);
    const sourceImage = {
      isEmpty: vi.fn(() => false),
      getSize: vi.fn(() => ({ width: 2_400, height: 1_350 })),
      resize: vi.fn(() => sharpPreview),
      toDataURL: vi.fn(() => "data:image/png;base64,SOURCE"),
    };
    nativeImageMock.createThumbnailFromPath.mockResolvedValueOnce(osPreview);
    nativeImageMock.createFromPath.mockReturnValueOnce(sourceImage);

    const res = await callThumbnail({
      cwd: dir,
      path: "stale-preview.png",
      maxDimension: 1_536,
    });

    expect(nativeImageMock.createFromPath).toHaveBeenCalledWith(imagePath);
    expect(sourceImage.resize).toHaveBeenCalledWith({
      width: 1_536,
      height: 864,
      quality: "good",
    });
    expect(res).toMatchObject({
      kind: "image",
      width: 1_536,
      height: 864,
      dataUrl: "data:image/png;base64,SHARP",
    });
  });

  it("retains an undersized OS preview when a full quality retry is unsafe", async () => {
    const imagePath = path.join(dir, "huge-safe-preview.png");
    writeFileSync(imagePath, pngFixture(64, 8_000, 8_000));
    nativeImageMock.thumbnail.getSize.mockReturnValue({
      width: 256,
      height: 256,
    });

    const res = await callThumbnail({
      cwd: dir,
      path: "huge-safe-preview.png",
      maxDimension: 1_536,
    });

    expect(res).toMatchObject({
      kind: "image",
      width: 256,
      height: 256,
    });
    expect(nativeImageMock.createFromPath).not.toHaveBeenCalled();
  });

  it("rejects arbitrary thumbnail dimensions before native decoding", async () => {
    const imagePath = path.join(dir, "invalid-size.png");
    writeFileSync(imagePath, pngFixture(64, 2_400, 1_350));

    const res = await callThumbnail({
      cwd: dir,
      path: "invalid-size.png",
      maxDimension: 20_000,
    });

    expect(res.kind).toBe("error");
    expect("error" in res ? res.error : "").toMatch(/thumbnail size/);
    expect(nativeImageMock.createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it("repairs a platform thumbnail that arrives stretched to a square", async () => {
    const imagePath = path.join(dir, "stretched.png");
    writeFileSync(imagePath, pngFixture(32, 1_600, 900));
    nativeImageMock.thumbnail.getSize
      .mockReturnValueOnce({ width: 256, height: 256 })
      .mockReturnValueOnce({ width: 256, height: 144 });

    const res = await callThumbnail({ cwd: dir, path: "stretched.png" });

    expect(nativeImageMock.thumbnail.resize).toHaveBeenCalledWith({
      width: 256,
      height: 144,
      quality: "good",
    });
    expect(res).toMatchObject({ kind: "image", width: 256, height: 144 });
  });

  it("trusts the platform provider to orient square EXIF JPEGs exactly once", async () => {
    const imagePath = path.join(dir, "square-oriented.jpg");
    writeFileSync(imagePath, rotatedJpegFixture(800, 800));
    nativeImageMock.thumbnail.getSize.mockReturnValue({
      width: 256,
      height: 256,
    });

    const res = await callThumbnail({ cwd: dir, path: "square-oriented.jpg" });

    expect(res).toMatchObject({
      kind: "image",
      width: 256,
      height: 256,
    });
    expect("orientation" in res ? res.orientation : undefined).toBeUndefined();
  });

  it("never squeezes raw EXIF pixels returned by the direct decoder", async () => {
    const imagePath = path.join(dir, "oriented.jpg");
    writeFileSync(imagePath, rotatedJpegFixture(800, 600));
    nativeImageMock.createThumbnailFromPath.mockRejectedValueOnce(
      new Error("thumbnail service unavailable"),
    );
    nativeImageMock.thumbnail.getSize.mockReturnValue({
      width: 256,
      height: 192,
    });

    const res = await callThumbnail({ cwd: dir, path: "oriented.jpg" });

    expect(nativeImageMock.thumbnail.resize).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      kind: "image",
      width: 256,
      height: 192,
      orientation: 6,
    });
  });

  it("uses the requested extension when an in-workspace image symlink resolves to an extensionless file", async () => {
    const sourcePath = path.join(dir, "image-bytes");
    writeFileSync(sourcePath, pngFixture(32, 640, 360));
    symlinkSync(sourcePath, path.join(dir, "linked.png"));

    const res = await callThumbnail({ cwd: dir, path: "linked.png" });

    expect(res).toMatchObject({
      kind: "image",
      sourceWidth: 640,
      sourceHeight: 360,
    });
    expect(nativeImageMock.createThumbnailFromPath).toHaveBeenCalledWith(
      sourcePath,
      { width: 256, height: 144 },
    );
  });

  it("refuses thumbnail reads that escape the trusted workspace", async () => {
    const res = await callThumbnail({ cwd: dir, path: "/etc/hosts" });

    expect(res.kind).toBe("error");
    expect("error" in res ? res.error : "").toMatch(/outside the workspace/);
    expect(nativeImageMock.createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it("refuses a thumbnail symlink that resolves outside the workspace", async () => {
    const outsideDir = mkdtempSync(
      path.join(tmpdir(), "zeros-thumbnail-outside-"),
    );
    const outside = path.join(outsideDir, "outside.png");
    writeFileSync(outside, "outside");
    symlinkSync(outside, path.join(dir, "outside-linked.png"));
    try {
      const res = await callThumbnail({
        cwd: dir,
        path: "outside-linked.png",
      });

      expect(res.kind).toBe("error");
      expect("error" in res ? res.error : "").toMatch(/symlink outside/);
      expect(nativeImageMock.createThumbnailFromPath).not.toHaveBeenCalled();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported and oversized sources before native decoding", async () => {
    writeFileSync(path.join(dir, "not-an-image.txt"), "hello");
    const unsupported = await callThumbnail({
      cwd: dir,
      path: "not-an-image.txt",
    });

    const oversizedPath = path.join(dir, "oversized.png");
    writeFileSync(oversizedPath, "");
    truncateSync(oversizedPath, 100_000_001);
    const oversized = await callThumbnail({
      cwd: dir,
      path: "oversized.png",
    });

    expect(unsupported.kind).toBe("error");
    expect(oversized.kind).toBe("too-large");
    expect(nativeImageMock.createThumbnailFromPath).not.toHaveBeenCalled();
  });

  it("rejects a small compressed file with unsafe decoded dimensions", async () => {
    writeFileSync(
      path.join(dir, "pixel-bomb.png"),
      pngFixture(32, 500_000, 500_000),
    );

    const res = await callThumbnail({ cwd: dir, path: "pixel-bomb.png" });

    expect(res.kind).toBe("too-large");
    expect(nativeImageMock.createThumbnailFromPath).not.toHaveBeenCalled();
    expect(nativeImageMock.createFromPath).not.toHaveBeenCalled();
  });

  it("does not send corrupt image headers to a full native decoder", async () => {
    writeFileSync(path.join(dir, "corrupt.png"), "not a png");

    const res = await callThumbnail({ cwd: dir, path: "corrupt.png" });

    expect(res.kind).toBe("error");
    expect(nativeImageMock.createThumbnailFromPath).not.toHaveBeenCalled();
    expect(nativeImageMock.createFromPath).not.toHaveBeenCalled();
  });

  it("does not use the full-decoder fallback for very large pixel buffers", async () => {
    writeFileSync(
      path.join(dir, "large-decoded.png"),
      pngFixture(32, 8_000, 8_000),
    );
    nativeImageMock.createThumbnailFromPath.mockRejectedValueOnce(
      new Error("thumbnail service unavailable"),
    );

    const res = await callThumbnail({ cwd: dir, path: "large-decoded.png" });

    expect(res.kind).toBe("too-large");
    expect(nativeImageMock.createFromPath).not.toHaveBeenCalled();
  });

  it("falls back to the direct decoder when the OS thumbnail is empty", async () => {
    writeFileSync(path.join(dir, "fallback.png"), pngFixture(32, 640, 360));
    nativeImageMock.createThumbnailFromPath.mockResolvedValueOnce({
      isEmpty: vi.fn(() => true),
      getSize: vi.fn(() => ({ width: 0, height: 0 })),
      resize: vi.fn(),
      toDataURL: vi.fn(() => ""),
    });

    const res = await callThumbnail({ cwd: dir, path: "fallback.png" });

    expect(nativeImageMock.createFromPath).toHaveBeenCalledWith(
      path.join(dir, "fallback.png"),
    );
    expect(res.kind).toBe("image");
  });

  it("bounds a large direct-decoder fallback before serialising it", async () => {
    const imagePath = path.join(dir, "fallback-large.png");
    writeFileSync(imagePath, pngFixture(32, 800, 400));
    nativeImageMock.createThumbnailFromPath.mockRejectedValueOnce(
      new Error("thumbnail service unavailable"),
    );
    nativeImageMock.thumbnail.getSize
      .mockReturnValueOnce({ width: 800, height: 400 })
      .mockReturnValueOnce({ width: 256, height: 128 });

    const res = await callThumbnail({ cwd: dir, path: "fallback-large.png" });

    expect(nativeImageMock.thumbnail.resize).toHaveBeenCalledWith({
      width: 256,
      height: 128,
      quality: "good",
    });
    expect(res).toMatchObject({ kind: "image", width: 256, height: 128 });
  });
});
