import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as artifacts from "../cloud-workspace-validation/cloud-agent-e2e/artifacts";

const roots: string[] = [];
const owner = { uid: process.getuid!(), gid: process.getgid!() };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), "zeros-native-artifact-"));
  roots.push(root);
  const file = path.join(root, "tool-output.txt");
  fs.writeFileSync(file, "native result\n");
  return { root, file };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("native fixture artifact observations", () => {
  it("retains metadata and bounded bytes from one real regular-file descriptor", () => {
    const { file } = fixture();
    expect(artifacts.readFixtureNativeFile(file, owner)).toEqual({ ...owner, bytes: 14, sha256: hash("native result\n") });
  });

  it("refuses a real symbolic link rather than joining link metadata to target bytes", () => {
    const { root, file } = fixture(), link = path.join(root, "link.txt");
    fs.symlinkSync(file, link);
    expect(() => artifacts.readFixtureNativeFile(link, owner)).toThrow("fixture_contract_invalid");
  });

  it("keeps the original inode's bytes if the pathname is replaced after fstat", () => {
    const { file } = fixture(); let swapped = false;
    const io = { ...fs, fstatSync: vi.fn((descriptor: number) => {
      const original = fs.fstatSync(descriptor);
      if (!swapped) { swapped = true; fs.renameSync(file, `${file}.original`); fs.writeFileSync(file, "replacement result\n"); }
      return original;
    }) };
    expect(artifacts.readFixtureNativeFile(file, owner, io)).toEqual({ ...owner, bytes: 14, sha256: hash("native result\n") });
    expect(hash(fs.readFileSync(file, "utf8"))).not.toBe(hash("native result\n"));
  });

  it("refuses hardlinked state and directories", () => {
    const { root, file } = fixture(); fs.linkSync(file, path.join(root, "alias.txt"));
    expect(() => artifacts.readFixtureNativeFile(file, owner)).toThrow("fixture_contract_invalid");
    expect(() => artifacts.readFixtureNativeFile(root, owner)).toThrow("fixture_contract_invalid");
  });

  it.each(["uid", "gid"] as const)("refuses a wrong numeric %s without returning an observation", field => {
    const { file } = fixture();
    expect(() => artifacts.readFixtureNativeFile(file, { ...owner, [field]: owner[field] + 1 })).toThrow("fixture_contract_invalid");
  });

  it("refuses oversized state before reading any bytes", () => {
    const { file } = fixture(); fs.writeFileSync(file, Buffer.alloc(128 * 1024));
    const io = { ...fs, readSync: vi.fn((descriptor: number, buffer: Buffer, offset: number, length: number, position: number | null) =>
      fs.readSync(descriptor, buffer, offset, length, position)), closeSync: vi.fn(fs.closeSync) };
    expect(() => artifacts.readFixtureNativeFile(file, owner, io)).toThrow("fixture_contract_invalid");
    expect(io.readSync).not.toHaveBeenCalled(); expect(io.closeSync).toHaveBeenCalledOnce();
  });

  it("refuses a file that grows past the bounded read after initial metadata", () => {
    const { file } = fixture(); let changed = false;
    const io = { ...fs, fstatSync: vi.fn((descriptor: number) => {
      const original = fs.fstatSync(descriptor);
      if (!changed) { changed = true; fs.appendFileSync(file, Buffer.alloc(128 * 1024)); }
      return original;
    }), closeSync: vi.fn(fs.closeSync) };
    expect(() => artifacts.readFixtureNativeFile(file, owner, io)).toThrow("fixture_contract_invalid");
    expect(io.closeSync).toHaveBeenCalledOnce();
  });

  it("closes the descriptor and emits no observation on read failure", () => {
    const { file } = fixture();
    const io = { ...fs, readSync: vi.fn(() => { throw new Error("synthetic read failure"); }), closeSync: vi.fn(fs.closeSync) };
    expect(() => artifacts.readFixtureNativeFile(file, owner, io)).toThrow("fixture_contract_invalid");
    expect(io.closeSync).toHaveBeenCalledOnce();
  });
});
