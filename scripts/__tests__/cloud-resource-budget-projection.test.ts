import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import * as reader from "../cloud-workspace-validation/sandbox/cloud-resource-budget.mjs";
import { validCloudResourceBudgetProjection } from "../cloud-workspace-validation/sandbox/cloud-resource-admission.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const projection = () => ({ version: 1, resources: { architecture: "linux/amd64", cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 40960 },
  memoryBudget: { nominalMemoryBytes: String(8 * 1024 ** 3), measuredMemoryBytes: String(8131788 * 1024),
    hostMemoryMax: String(256 * 1024 ** 2), source: "nominal", capped: false } });
const logical = "/etc/zeros/cloud-resource-contract.json";
it("imports the actual copied lib/zeros helper graph without source-only app paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-resource-library-")); roots.push(root);
  const library = path.join(root, "lib/zeros"); fs.mkdirSync(library, { recursive: true });
  for (const name of ["cloud-resource-budget.mjs", "cloud-resource-admission.mjs", "cgroup-resources.mjs", "cloud-runtime-root.mjs"])
    fs.copyFileSync(path.resolve("scripts/cloud-workspace-validation/sandbox", name), path.join(library, name));
  const copied = await import(pathToFileURL(path.join(library, "cloud-resource-budget.mjs")).href);
  expect(copied.parseCloudResourceBudgetProjection(Buffer.from(JSON.stringify(projection())))).toEqual(projection());
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-resource-projection-")); roots.push(root);
  const physical = (file: string) => path.join(root, file);
  fs.mkdirSync(physical("/etc/zeros"), { recursive: true });
  fs.writeFileSync(physical(logical), JSON.stringify(projection()), { mode: 0o444 });
  const io = { ...fs, realpathSync: (file: string) => {
    const actual = fs.realpathSync(physical(file)); return actual === root ? "/" : actual.slice(root.length);
  }, lstatSync: (file: string) => fs.lstatSync(physical(file)),
  openSync: (file: string, flags: number) => fs.openSync(physical(file), flags) };
  return { physical, io, read: () => reader.readCloudResourceBudgetProjection(io, () => true) };
}
it("reads one immutable regular descriptor and preserves the actual nonsecret measurements", () => {
  expect(fixture().read()).toEqual(projection());
});
it.each([undefined, null, { extra: true }, { version: 2 }, { resources: null },
  { resources: { ...projection().resources, memoryMiB: 4096 } }, { memoryBudget: {} }])("refuses changed exact projection scope %j", change => {
  const value = change === undefined || change === null ? change : { ...projection(), ...change };
  expect(validCloudResourceBudgetProjection(value)).toBe(false);
});
it("retains an honest unknown nominal only in explicit fallback", () => {
  const value = { ...projection(), resources: null, memoryBudget: { ...projection().memoryBudget, nominalMemoryBytes: null, source: "fallback" } };
  expect(validCloudResourceBudgetProjection(value)).toBe(true);
});
it("refuses a symlink instead of joining its metadata to another target", () => {
  const value = fixture(), target = value.physical("/etc/zeros/other.json");
  fs.renameSync(value.physical(logical), target); fs.symlinkSync("other.json", value.physical(logical));
  expect(value.read).toThrow();
});
it("refuses an inode swapped after no-follow open", () => {
  const value = fixture(), originalOpen = value.io.openSync;
  value.io.openSync = (file, flags) => {
    const fd = originalOpen(file, flags); fs.renameSync(value.physical(file), value.physical(`${file}.retired`));
    fs.writeFileSync(value.physical(file), JSON.stringify(projection()), { mode: 0o444 }); return fd;
  };
  expect(value.read).toThrow();
});
it.each([0o600, 0o644, 0o666])("refuses mutable or non-projection leaf mode %i", mode => {
  const value = fixture(); fs.chmodSync(value.physical(logical), mode); expect(value.read).toThrow();
});
it("refuses an owner that is outside the verified readonly deployment ancestry", () => {
  const value = fixture(); expect(() => reader.readCloudResourceBudgetProjection(value.io, () => false)).toThrow();
});
it.each(["{", " ", "x".repeat(16385), '{"version":2,"version":1,"resources":null,"memoryBudget":null}'])(
  "refuses bounded malformed or duplicate-key bytes without returning a partial observation", source => {
    const value = fixture(); fs.writeFileSync(value.physical(logical), source); expect(value.read).toThrow();
  });
it("refuses an escaped duplicate key even when the final parsed object would be valid", () => {
  const value = fixture(), source = JSON.stringify(projection());
  fs.writeFileSync(value.physical(logical), '{"\\u0076ersion":2,' + source.slice(1)); expect(value.read).toThrow();
});
