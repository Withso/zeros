import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";
vi.mock("../pty/node-pty-spawn", () => ({ createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn() }));
vi.mock("../agents/adapters/cursor-sdk/host/host-client", () => ({ disposeCursorHost: vi.fn() }));
import { ZerosEngine } from "../zeros-engine";

const roots: string[] = [];
function temporary() { const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "zeros-legacy-security-"))); roots.push(directory); return directory; }
function sweep(root: string) { Object.assign(Object.create(ZerosEngine.prototype), { root }).sweepLegacyDotZeros(); }
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("retains external legacy-named files when .zeros is a symlink", () => {
  const root = temporary(), outside = temporary();
  for (const name of [".port", ".token", ".busy"]) fs.writeFileSync(path.join(outside, name), "outside-canary");
  fs.symlinkSync(outside, path.join(root, ".zeros"));
  sweep(root);
  for (const name of [".port", ".token", ".busy"]) expect(fs.readFileSync(path.join(outside, name), "utf8")).toBe("outside-canary");
});

it("keeps cleanup inside the held directory if its ancestor is replaced at unlink", () => {
  const root = temporary(), outside = temporary(), legacy = path.join(root, ".zeros");
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, ".port"), "stale");
  fs.writeFileSync(path.join(outside, ".port"), "outside-canary");
  const unlink = fs.unlinkSync;
  let swapped = false;
  vi.spyOn(fs, "unlinkSync").mockImplementation(file => {
    if (!swapped) { swapped = true; fs.renameSync(legacy, `${legacy}-saved`); fs.symlinkSync(outside, legacy); }
    unlink(file);
  });
  syncBuiltinESMExports();
  sweep(root);
  expect(swapped).toBe(true);
  expect(fs.readFileSync(path.join(outside, ".port"), "utf8")).toBe("outside-canary");
});

it("removes only stale runtime markers and retains attachments and setup", () => {
  const root = temporary(), legacy = path.join(root, ".zeros");
  fs.mkdirSync(legacy);
  for (const name of [".port", ".token", ".busy", "setup.sh"]) fs.writeFileSync(path.join(legacy, name), "saved");
  fs.mkdirSync(path.join(legacy, "attachments"));
  sweep(root);
  for (const name of [".port", ".token", ".busy"]) expect(fs.existsSync(path.join(legacy, name))).toBe(false);
  expect(fs.readFileSync(path.join(legacy, "setup.sh"), "utf8")).toBe("saved");
  expect(fs.existsSync(path.join(legacy, "attachments"))).toBe(true);
});
