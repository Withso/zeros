import { constants } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_PREVIEW_LINKS_PATH, loadCloudPreviewLinks } from "../cloud-preview-links";

const fixture = vi.hoisted(() => {
  const now = 1_700_000_000_000;
  const document = { version: 1, audience: "zeros-cloud-preview-v1", generation: "preview-generation-1234567890",
    issuedAt: now - 1_000, expiresAt: now + 60_000,
    links: [{ port: 5173, signedUrl: "https://5173-provider.preview.example/" }] };
  return { now, document, bytes: Buffer.from(JSON.stringify(document)), offset: 0,
    opened: {} as Record<string, unknown>, files: new Map<string, Record<string, unknown>>(),
    canonical: CLOUD_PATH(), admitted: true, immutable: true, afterRead: false };
  function CLOUD_PATH() { return "/run/zeros/cloud-preview-links.json"; }
});
const io = vi.hoisted(() => ({ openSync: vi.fn(), closeSync: vi.fn(), fstatSync: vi.fn(), lstatSync: vi.fn(),
  realpathSync: vi.fn(), readFileSync: vi.fn(), readSync: vi.fn() }));
const authority = vi.hoisted(() => ({ hasCloudEngineUserNamespace: vi.fn(), isCloudDeploymentOwner: vi.fn() }));
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>(), ...io }));
vi.mock("../cloud-runtime-root.mjs", () => authority);

function metadata(directory: boolean, uid: number, mode: number, ino = 7) {
  return { uid, gid: uid, mode, ino, dev: 1, nlink: 1, size: fixture.bytes.length,
    isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false };
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const name of ["getuid", "geteuid", "getgid", "getegid"] as const) vi.spyOn(process, name).mockReturnValue(10003);
  fixture.bytes = Buffer.from(JSON.stringify(fixture.document)); fixture.offset = 0;
  fixture.canonical = CLOUD_PREVIEW_LINKS_PATH; fixture.admitted = true; fixture.immutable = true; fixture.afterRead = false;
  fixture.files = new Map([
    [CLOUD_PREVIEW_LINKS_PATH, metadata(false, 10003, 0o100600)],
    ["/run/zeros", metadata(true, 10003, 0o40700)],
    ["/run", metadata(true, 65534, 0o40755)], ["/", metadata(true, 65534, 0o40755)],
  ]);
  fixture.opened = { ...fixture.files.get(CLOUD_PREVIEW_LINKS_PATH)! };
  io.openSync.mockReturnValue(41); io.closeSync.mockImplementation(() => {});
  io.realpathSync.mockImplementation(() => fixture.canonical);
  io.lstatSync.mockImplementation(file => fixture.files.get(file));
  io.fstatSync.mockImplementation(() => fixture.opened);
  io.readFileSync.mockImplementation(() => fixture.bytes.toString("utf8"));
  io.readSync.mockImplementation((_fd, buffer: Buffer, offset: number, length: number) => {
    const read = Math.min(length, fixture.bytes.length - fixture.offset);
    fixture.bytes.copy(buffer, offset, fixture.offset, fixture.offset + read); fixture.offset += read;
    fixture.afterRead = true; return read;
  });
  authority.hasCloudEngineUserNamespace.mockImplementation(() => fixture.admitted);
  authority.isCloudDeploymentOwner.mockImplementation((_file, uid) => uid === 65534 && fixture.immutable);
});
afterEach(() => { vi.restoreAllMocks(); });

describe.skipIf(process.platform !== "linux")("non-root engine-owned preview state", () => {
  it("reads exact private state with independently verified read-only deployment ancestry", () => {
    expect(loadCloudPreviewLinks(CLOUD_PREVIEW_LINKS_PATH, fixture.now)).toEqual(fixture.document);
    expect(authority.hasCloudEngineUserNamespace).toHaveBeenCalledWith(4);
    expect(authority.isCloudDeploymentOwner).toHaveBeenCalledWith("/run", 65534);
    expect(io.openSync).toHaveBeenCalledWith(CLOUD_PREVIEW_LINKS_PATH, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    expect(io.readFileSync).not.toHaveBeenCalled(); expect(io.readSync).toHaveBeenCalled();
    expect(io.closeSync).toHaveBeenCalledOnce();
  });
  it.each(["getuid", "geteuid", "getgid", "getegid"] as const)("refuses wrong actual %s", name => {
    for (const uid of [0, 1000, 10001, 10002, 10004]) {
      vi.spyOn(process, name).mockReturnValue(uid);
      expect(() => loadCloudPreviewLinks(CLOUD_PREVIEW_LINKS_PATH, fixture.now)).toThrow();
    }
  });
  it("refuses an unverified user namespace before using overflow-owned deployment files", () => {
    fixture.admitted = false;
    expect(() => loadCloudPreviewLinks(CLOUD_PREVIEW_LINKS_PATH, fixture.now)).toThrow();
    expect(io.readSync).not.toHaveBeenCalled();
  });
  it.each([0, 10001, 10002, 10004, 65534])("refuses a leaf owned by %s", uid => {
    fixture.files.set(CLOUD_PREVIEW_LINKS_PATH, metadata(false, uid, 0o100600));
    fixture.opened = { ...fixture.files.get(CLOUD_PREVIEW_LINKS_PATH)! };
    expect(() => loadCloudPreviewLinks(CLOUD_PREVIEW_LINKS_PATH, fixture.now)).toThrow();
    expect(io.readSync).not.toHaveBeenCalled();
  });
  it.each([0o100644, 0o100660, 0o100700, 0o104600])("refuses unsafe leaf mode %o", mode => {
    fixture.files.set(CLOUD_PREVIEW_LINKS_PATH, metadata(false, 10003, mode));
    fixture.opened = { ...fixture.files.get(CLOUD_PREVIEW_LINKS_PATH)! };
    expect(() => loadCloudPreviewLinks(CLOUD_PREVIEW_LINKS_PATH, fixture.now)).toThrow();
  });
  it.each([0, 10001, 10002, 10004])("refuses a mutable/foreign parent owned by %s", uid => {
    fixture.files.set("/run/zeros", metadata(true, uid, 0o40700));
    expect(() => loadCloudPreviewLinks(CLOUD_PREVIEW_LINKS_PATH, fixture.now)).toThrow();
  });
  it("refuses overflow ownership on an unverified writable deployment ancestor", () => {
    fixture.immutable = false;
    expect(() => loadCloudPreviewLinks(CLOUD_PREVIEW_LINKS_PATH, fixture.now)).toThrow();
  });
  it.each(["/run/zeros", "/run", "/"])("refuses symlink or writable ancestor %s", file => {
    for (const change of [{ mode: 0o40777 }, { isSymbolicLink: () => true }, { isDirectory: () => false }]) {
      const original = fixture.files.get(file)!; fixture.files.set(file, { ...original, ...change });
      expect(() => loadCloudPreviewLinks(CLOUD_PREVIEW_LINKS_PATH, fixture.now)).toThrow();
      fixture.files.set(file, original);
    }
  });
  it("rejects path aliases, symbolic links and replacement inodes", () => {
    for (const change of [{ ino: 99 }, { dev: 99 }, { isSymbolicLink: () => true }]) {
      const original = fixture.files.get(CLOUD_PREVIEW_LINKS_PATH)!;
      fixture.files.set(CLOUD_PREVIEW_LINKS_PATH, { ...original, ...change });
      expect(() => loadCloudPreviewLinks(CLOUD_PREVIEW_LINKS_PATH, fixture.now)).toThrow();
      fixture.files.set(CLOUD_PREVIEW_LINKS_PATH, original);
    }
    fixture.canonical = "/different/file";
    expect(() => loadCloudPreviewLinks(CLOUD_PREVIEW_LINKS_PATH, fixture.now)).toThrow();
  });
  it.each([{ uid: 0 }, { gid: 10001 }, { mode: 0o100644 }, { nlink: 2 }, { isFile: () => false }])(
    "validates descriptor ownership/type again rather than trusting pathname metadata %j", change => {
      fixture.opened = { ...fixture.opened, ...change };
      expect(() => loadCloudPreviewLinks(CLOUD_PREVIEW_LINKS_PATH, fixture.now)).toThrow();
      expect(io.closeSync).toHaveBeenCalledOnce();
    });
  it.each([1, 128 * 1024 + 1])("refuses size %d before reading", size => {
    fixture.opened = { ...fixture.opened, size };
    expect(() => loadCloudPreviewLinks(CLOUD_PREVIEW_LINKS_PATH, fixture.now)).toThrow();
    expect(io.readSync).not.toHaveBeenCalled();
  });
  it("bounds bytes even when the opened file grows after fstat", () => {
    fixture.bytes = Buffer.concat([fixture.bytes, Buffer.alloc(128 * 1024)]);
    expect(() => loadCloudPreviewLinks(CLOUD_PREVIEW_LINKS_PATH, fixture.now)).toThrow();
    expect(fixture.offset).toBe(128 * 1024 + 1); expect(io.closeSync).toHaveBeenCalledOnce();
  });
  it("refuses metadata changes while reading and closes on a read failure", () => {
    io.fstatSync.mockImplementation(() => ({ ...fixture.opened, uid: fixture.afterRead ? 0 : 10003 }));
    expect(() => loadCloudPreviewLinks(CLOUD_PREVIEW_LINKS_PATH, fixture.now)).toThrow();
    expect(io.closeSync).toHaveBeenCalledOnce();
    io.closeSync.mockClear(); io.readSync.mockImplementation(() => { throw new Error("synthetic read failure"); });
    expect(() => loadCloudPreviewLinks(CLOUD_PREVIEW_LINKS_PATH, fixture.now)).toThrow();
    expect(io.closeSync).toHaveBeenCalledOnce();
  });
});
