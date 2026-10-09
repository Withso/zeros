import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ root: "", owners: new Map<string, number>() }));
vi.mock("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs", async original => ({
  ...await original<typeof import("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime")).testCloudRuntime,
}));
vi.mock("node:fs", async original => {
  const actual = await original<typeof fs>();
  const mapped = (file: fs.PathLike) => String(file).startsWith("/run/zeros/") ? fixture.root + String(file).slice(10) : String(file) === "/run/zeros" ? fixture.root : file;
  return { ...actual,
    existsSync: (file: fs.PathLike) => actual.existsSync(mapped(file)),
    lstatSync: (file: fs.PathLike) => Object.assign(actual.lstatSync(mapped(file)), { uid: fixture.owners.get(String(file)) ?? 0, gid: 0 }),
    realpathSync: (file: fs.PathLike) => {
      const resolved = actual.realpathSync(mapped(file));
      return resolved === fixture.root || resolved.startsWith(fixture.root + "/") ? "/run/zeros" + resolved.slice(fixture.root.length) : resolved;
    },
    openSync: (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => actual.openSync(mapped(file), flags, mode),
    fstatSync: (fd: number) => Object.assign(actual.fstatSync(fd), { uid: 0, gid: 0 }),
    chownSync: (file: fs.PathLike, uid: number) => { fixture.owners.set(String(file), uid); },
    chmodSync: (file: fs.PathLike, mode: fs.Mode) => actual.chmodSync(mapped(file), mode),
    renameSync: (source: fs.PathLike, target: fs.PathLike) => {
      actual.renameSync(mapped(source), mapped(target));
      fixture.owners.set(String(target), fixture.owners.get(String(source)) ?? 0);
    },
    rmSync: (file: fs.PathLike, options: fs.RmOptions) => actual.rmSync(mapped(file), options),
  };
});

import * as setup from "../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs";
import { readCloudRuntimeResourceContract } from "../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs";
import * as launcher from "../cloud-workspace-validation/sandbox/cloud-engine-launcher.mjs";
import { cloudEngineViewArguments } from "../cloud-workspace-validation/sandbox/cloud-engine-view.mjs";
import { testCloudRuntime } from "../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime";
const resources = { architecture: "linux/amd64", cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 20480 };
const material = { version: 2, image: { resources }, repository: { credential: { token: "fixture-private-token" } } };
const document = () => path.join(fixture.root, "cloud-resource-contract.json");

beforeEach(async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  fixture.root = actual.mkdtempSync(path.join(os.tmpdir(), "zeros-resource-contract-"));
  fixture.owners.clear();
});
afterEach(async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  actual.rmSync(fixture.root, { recursive: true, force: true });
});

it("publishes only the admitted nonsecret SKU as a private atomic root document", () => {
  setup.publishCloudRuntimeResourceContract(material);
  const value = fs.readFileSync(document(), "utf8");
  expect(JSON.parse(value)).toEqual({ version: 1, resources });
  expect(value).not.toContain("fixture-private-token");
  expect(fs.lstatSync(document()).mode & 0o7777).toBe(0o600);
  expect(readCloudRuntimeResourceContract()).toEqual(resources);
  expect(fs.readdirSync(fixture.root)).toEqual(["cloud-resource-contract.json"]);
});

it("removes a prior nominal SKU when the archived material has no resource contract", () => {
  setup.publishCloudRuntimeResourceContract(material);
  setup.publishCloudRuntimeResourceContract({ version: 1, image: {} });
  expect(readCloudRuntimeResourceContract()).toBeNull();
});

it.each([{ ...resources, memoryMiB: 0 }, { ...resources, token: "private" }, { ...resources, cpuMillicores: "4000" }])("refuses invalid admitted resource material without overwriting the original (%#)", invalid => {
  setup.publishCloudRuntimeResourceContract(material);
  const before = fs.readFileSync(document(), "utf8");
  expect(() => setup.publishCloudRuntimeResourceContract({ version: 2, image: { resources: invalid } })).toThrow();
  expect(fs.readFileSync(document(), "utf8")).toBe(before);
});

it("does not replace a shared-user or symlinked resource document", async () => {
  setup.publishCloudRuntimeResourceContract(material);
  fixture.owners.set("/run/zeros/cloud-resource-contract.json", 10003);
  expect(() => setup.publishCloudRuntimeResourceContract(material)).toThrow();
  fixture.owners.clear();
  const actual = await vi.importActual<typeof fs>("node:fs");
  actual.unlinkSync(document());
  actual.writeFileSync(path.join(fixture.root, "foreign"), "keep");
  actual.symlinkSync(path.join(fixture.root, "foreign"), document());
  expect(() => setup.publishCloudRuntimeResourceContract(material)).toThrow();
  expect(actual.readFileSync(path.join(fixture.root, "foreign"), "utf8")).toBe("keep");
});

it("publishes the new SKU only after all old scopes retire and legacy ownership is adopted", async () => {
  const events: string[] = [];
  const prepare = vi.fn(async () => { events.push("all-scopes-retired"); return "original-session"; });
  const adopt = vi.fn(() => { events.push("adopt"); });
  const publish = vi.fn(() => { events.push("publish"); });
  expect(await setup.prepareCloudWorkspaceRuntime(material, { prepare, adopt, publish })).toBe("original-session");
  expect(events).toEqual(["all-scopes-retired", "adopt", "publish"]);
  expect(publish).toHaveBeenCalledWith(material);
});

it.each(["prepare", "adopt"] as const)("never publishes a new SKU after unconfirmed %s", async failing => {
  const prepare = vi.fn(async () => "original-session"), adopt = vi.fn(), publish = vi.fn();
  if (failing === "prepare") prepare.mockRejectedValueOnce(new Error("old resident survives"));
  else adopt.mockImplementationOnce(() => { throw new Error("ownership not admitted"); });
  await expect(setup.prepareCloudWorkspaceRuntime(material, { prepare, adopt, publish })).rejects.toThrow();
  expect(publish).not.toHaveBeenCalled();
});

const view = "/run/zeros/view/runtime-12345678-1234-4234-8234-123456789abc";
const projection = { version: 1, resources,
  memoryBudget: { nominalMemoryBytes: String(8 * 1024 ** 3), measuredMemoryBytes: String(8 * 1024 ** 3),
    hostMemoryMax: String(256 * 1024 ** 2), source: "nominal", capped: false } };
it("publishes the exact original broker budget at the fixed readonly engine path", () => {
  const publish = vi.fn(), verify = vi.fn();
  launcher.publishCloudEngineResourceProjection(view, projection, { publish, verify });
  expect(verify).toHaveBeenCalledWith(`${view}/etc`, true);
  expect(publish).toHaveBeenCalledWith(`${view}/etc/cloud-resource-contract.json`, JSON.stringify(projection), 0, 0, 0o444);
  const args = cloudEngineViewArguments("serve", 4, testCloudRuntime(), view);
  expect(args.join("\n")).toContain(`--ro-bind\n${view}/etc\n/etc/zeros`);
});
it("projects unknown nominal allocation explicitly without synthesizing the default SKU", () => {
  const publish = vi.fn();
  const fallback = { version: 1, resources: null,
    memoryBudget: { nominalMemoryBytes: null, measuredMemoryBytes: null, hostMemoryMax: "268435456", source: "fallback", capped: false } };
  launcher.publishCloudEngineResourceProjection(view, fallback, { publish, verify: vi.fn() });
  expect(JSON.parse(publish.mock.calls[0][1]).resources).toBeNull();
});
it.each([
  { ...projection, boundsMode: "nominal" },
  { ...projection, resources: { ...resources, memoryMiB: 16384 } },
  { ...projection, token: "private" },
])("refuses inconsistent or private resource projection before writing (%#)", value => {
  const publish = vi.fn();
  expect(() => launcher.publishCloudEngineResourceProjection(view, value, { publish, verify: vi.fn() })).toThrow();
  expect(publish).not.toHaveBeenCalled();
});
