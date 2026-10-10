import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudRuntimeResolver, cloudProfileIdentityMapVersion, parseCloudActiveRuntime } from "../cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "./cloud-runtime-fixture";

const fixtures: ReturnType<typeof cloudRuntimeFixture>[] = [];
function fixture() {
  const tree = cloudRuntimeFixture(); fixtures.push(tree);
  const resolver = createCloudRuntimeResolver({ filesystem: tree.filesystem });
  return { ...tree, resolver };
}
afterEach(() => { vi.unstubAllEnvs(); for (const tree of fixtures.splice(0)) tree.dispose(); });

describe("verified cloud runtime root", () => {
  it("replaces read-only fixture files while preserving their admitted modes and simulated owner", () => {
    const tree = fixture();
    for (const [file, mode] of [
      ["/etc/zeros/cloud-worker.json", 0o444],
      ["/run/zeros/active-runtime.json", 0o600],
      [`${tree.descriptor.root}/bin/node`, 0o555],
    ] as const) {
      const content = fs.readFileSync(tree.physical(file), "utf8");
      tree.write(file, content, mode);
      expect(fs.readFileSync(tree.physical(file), "utf8")).toBe(content);
      expect(fs.statSync(tree.physical(file)).uid).toBe(process.getuid?.());
      expect(tree.filesystem.lstatSync(file).uid).toBe(0);
      expect(tree.filesystem.lstatSync(file).mode & 0o777).toBe(mode);
    }
    expect(tree.resolver.resolve().profile).toBe("v4");
  });
  it("never selects executable cloud paths when the cloud marker is absent", () => {
    const tree = fixture();
    fs.unlinkSync(tree.physical("/etc/zeros/cloud-worker.json"));
    expect(() => tree.resolver.resolve()).toThrow(/runtime/);
  });
  it.each([1, 2, 3])("refuses a present worker-v%i marker before resolving executable paths", version => {
    const tree = fixture();
    tree.write("/etc/zeros/cloud-worker.json", { ...tree.marker, version, profile: `zeros-cloud-worker-v${version}` });
    expect(() => tree.resolver.resolve()).toThrow(/runtime/);
  });
  it.each(["/opt/zeros-runtime/bin/node", "/usr/local/bin/node"])("refuses retired child executable %s", node => {
    const tree = fixture();
    expect(() => createCloudRuntimeResolver({ filesystem: tree.filesystem, executable: () => node }).resolveChild()).toThrow(/runtime/);
  });
  it("resolves the allowed facade before applying the strict physical-entrypoint guard", () => {
    const { resolver, descriptor } = fixture();
    const runtime = resolver.resolve();
    expect(runtime).toMatchObject({ ...descriptor, profile: "v4", workerRoot: `${descriptor.root}/worker`,
      libRoot: `${descriptor.root}/lib/zeros`, node: `${descriptor.root}/bin/node`, startEngine: `${descriptor.root}/bin/start-engine.sh` });
    expect(() => resolver.assertPath("/zeros/bin/node")).toThrow(/canonical/);
    expect(() => resolver.assertPath(runtime.node)).not.toThrow();
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime.helpers)).toBe(true);
  });
  it("pins once per process when current and the active descriptor change", () => {
    const tree = fixture(), selected = tree.resolver.resolve();
    const runtimeId = `r1-${"d".repeat(64)}`, root = `/opt/zeros-infra/${runtimeId}`;
    tree.install(root);
    fs.unlinkSync(tree.physical("/opt/zeros/current")); tree.link("/opt/zeros/current", `../zeros-infra/${runtimeId}`);
    tree.write("/run/zeros/active-runtime.json", { ...tree.descriptor, runtimeId, root, manifestSha256: "d".repeat(64) }, 0o600);
    expect(tree.resolver.resolve()).toBe(selected);
    expect(selected.node).toBe(`${tree.descriptor.root}/bin/node`);
    expect(createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve().root).toBe(root);
  });
  it("ignores forged environment paths", () => {
    for (const key of ["ZEROS_RUNTIME_ROOT", "ZEROS_ACTIVE_RUNTIME", "ZEROS_PTY_HOST_RUNTIME", "ZEROS_ZSR_SUPERVISOR_RUNTIME", "NODE_PATH"])
      vi.stubEnv(key, "/tmp/attacker");
    const { resolver, descriptor } = fixture();
    expect(resolver.resolve().root).toBe(descriptor.root);
  });
  it("never repins a concrete v4 executable to a different descriptor or a legacy marker", () => {
    const tree = fixture();
    const resolve = () => createCloudRuntimeResolver({ filesystem: tree.filesystem,
      executable: () => `/opt/zeros-infra/r1-${"d".repeat(64)}/bin/node` }).resolve();
    expect(resolve).toThrow(/runtime/);
    fs.unlinkSync(tree.physical("/etc/zeros/cloud-worker.json"));
    expect(resolve).toThrow(/runtime/);
    tree.write("/etc/zeros/cloud-worker.json", { ...tree.marker, version: 3, profile: "zeros-cloud-worker-v3" });
    expect(resolve).toThrow(/runtime/);
  });
  it.each([
    { root: "/zeros/current" }, { root: "/opt/zeros-infra/../elsewhere" }, { runtimeId: `r1-${"d".repeat(64)}` },
    { manifestSha256: "A".repeat(64) }, { baseCompatibilityId: "invalid" }, { bootId: "unknown" },
    { supervisorSessionId: "unknown" }, { installerReceiptSha256: "short" }, { schema: "future" },
    { cgroupRoot: "/sys/fs/cgroup" }, { cgroupRoot: "/sys/fs/cgroup/user.slice/zeros-host.service/../other" },
    { cgroupRoot: "/sys/fs/cgroup/system.slice/other.service" }, { rootOverride: "/tmp/attacker" },
  ])("rejects malformed or mismatched descriptor fields %j", change => {
    const tree = fixture(); tree.write("/run/zeros/active-runtime.json", { ...tree.descriptor, ...change }, 0o600);
    expect(() => tree.resolver.resolve()).toThrow(/runtime/);
  });
  it("fails closed for duplicate keys, oversized documents and missing v4 descriptors", () => {
    for (const source of [`{"schema":"wrong",${JSON.stringify(fixture().descriptor).slice(1)}`, " ".repeat(16385)]) {
      const tree = fixture(); tree.write("/run/zeros/active-runtime.json", source, 0o600);
      expect(() => tree.resolver.resolve()).toThrow(/runtime/);
    }
    const tree = fixture(); fs.unlinkSync(tree.physical("/run/zeros/active-runtime.json"));
    expect(() => tree.resolver.resolve()).toThrow();
  });
  it("never treats a dangling marker symlink as an absent legacy marker", () => {
    const tree = fixture();
    fs.unlinkSync(tree.physical("/etc/zeros/cloud-worker.json"));
    tree.link("/etc/zeros/cloud-worker.json", "missing.json");
    expect(() => tree.resolver.resolve()).toThrow();
  });
  it("rejects trailing line terminators in every descriptor identity and cgroup path", () => {
    const { descriptor } = fixture();
    for (const suffix of ["\n", "\r", "\u2028", "\u2029"]) {
      for (const field of ["baseCompatibilityId", "installerReceiptSha256", "bootId", "supervisorSessionId", "cgroupRoot"] as const)
        expect(() => parseCloudActiveRuntime({ ...descriptor, [field]: descriptor[field] + suffix })).toThrow();
      const manifestSha256 = descriptor.manifestSha256 + suffix;
      const runtimeId = `r1-${manifestSha256}`;
      expect(() => parseCloudActiveRuntime({ ...descriptor, manifestSha256, runtimeId, root: `/opt/zeros-infra/${runtimeId}` })).toThrow();
    }
  });
  it("rejects writable or non-root ancestry and hard-linked entrypoints", () => {
    for (const file of ["/opt", "/opt/zeros-infra", "/run/zeros", "/etc/zeros"]) {
      const tree = fixture(); fs.chmodSync(tree.physical(file), 0o777);
      expect(() => tree.resolver.resolve()).toThrow(/runtime/);
    }
    const tree = fixture(); tree.owners.set(tree.descriptor.root, 10001);
    expect(() => tree.resolver.resolve()).toThrow(/runtime/);
    tree.owners.clear(); fs.linkSync(tree.physical(`${tree.descriptor.root}/bin/node`), tree.physical(`${tree.descriptor.root}/node-alias`));
    expect(() => tree.resolver.resolve()).toThrow(/runtime/);
  });
  it("accepts only a root 0600 descriptor or a verified read-only projection", () => {
    const tree = fixture(); fs.chmodSync(tree.physical("/run/zeros/active-runtime.json"), 0o444);
    expect(() => tree.resolver.resolve()).toThrow(/runtime/);
    const resolver = createCloudRuntimeResolver({ filesystem: tree.filesystem, isReadOnly: file => file === "/run/zeros/active-runtime.json" });
    expect(resolver.resolve().profile).toBe("v4");
    for (const mode of [0o4600, 0o2444]) {
      fs.chmodSync(tree.physical("/run/zeros/active-runtime.json"), mode);
      expect(() => createCloudRuntimeResolver({ filesystem: tree.filesystem, isReadOnly: () => true }).resolve()).toThrow();
    }
  });
  it("rejects a read-only descriptor fail-closed when mount evidence is unavailable", async () => {
    // macOS has no procfs: the default mount check must reject, not throw ENOENT.
    const tree = fixture(); fs.chmodSync(tree.physical("/run/zeros/active-runtime.json"), 0o444);
    const nodeFs = createRequire(import.meta.url)("node:fs") as typeof fs;
    const openSync = nodeFs.openSync;
    nodeFs.openSync = ((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (file === "/proc/self/mountinfo") throw Object.assign(new Error("no procfs"), { code: "ENOENT" });
      return openSync(file, flags, mode);
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
    try {
      vi.resetModules();
      const { createCloudRuntimeResolver: create } = await import("../cloud-runtime-root.mjs");
      expect(() => create({ filesystem: tree.filesystem }).resolve()).toThrow(/runtime/);
    } finally {
      nodeFs.openSync = openSync;
      syncBuiltinESMExports();
    }
  });
  it("refuses an archived worker projection as the current engine contract", () => {
    const tree=fixture(),root=tree.descriptor.root;
    tree.write("/etc/zeros/cloud-worker.json",{...tree.marker,toolchain:{node:`${root}/bin/node`,
      supervisor:`${root}/worker/apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs`,bwrap:"/usr/bin/bwrap",setpriv:"/usr/bin/setpriv"}});
    tree.write("/run/zeros/active-runtime.json",tree.descriptor,0o444);
    tree.owners.set("/run/zeros/active-runtime.json",65534);
    const resolve=(readOnly=true)=>createCloudRuntimeResolver({filesystem:tree.filesystem,
      isOwner:(_file,uid)=>uid===0||uid===65534,isEngine:()=>true,isReadOnly:()=>readOnly}).resolve();
    expect(()=>resolve()).toThrow(/runtime/);
    expect(()=>resolve(false)).toThrow(/runtime/);
    tree.owners.set("/run/zeros/active-runtime.json",0);
    expect(()=>resolve()).toThrow(/runtime/);
  });
  it("resolves the same-user Host projection without any agent sandbox assets", () => {
    const tree = fixture(), root = tree.descriptor.root;
    const supervisor = `${root}/worker/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs`;
    tree.write(supervisor, "pinned Host supervisor", 0o444);
    tree.write("/etc/zeros/cloud-worker.json", { ...tree.marker, uid: 10003, gid: 10003,
      toolchain: { node: `${root}/bin/node`, supervisor } });
    tree.write("/run/zeros/active-runtime.json", tree.descriptor, 0o444);
    tree.owners.set("/run/zeros/active-runtime.json", 65534);
    for (const file of [`${root}/bin/cloud-process-supervisor`,
      `${root}/worker/apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs`])
      fs.rmSync(tree.physical(file));
    const resolver = createCloudRuntimeResolver({ filesystem: tree.filesystem,
      isOwner: (_file, uid) => uid === 0 || uid === 65534, isEngine: () => true, isReadOnly: () => true });
    expect(resolver.resolve().profile).toBe("v4");
    tree.write(supervisor, "changed", 0o666);
    expect(() => createCloudRuntimeResolver({ filesystem: tree.filesystem,
      isOwner: (_file, uid) => uid === 0 || uid === 65534, isEngine: () => true, isReadOnly: () => true }).resolve()).toThrow();
  });
  it("admits only the engine view's own private /run/zeros around the read-only descriptor", () => {
    const tree = fixture(), root = tree.descriptor.root;
    const supervisor = `${root}/worker/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs`;
    tree.write(supervisor, "pinned Host supervisor", 0o444);
    tree.write("/etc/zeros/cloud-worker.json", { ...tree.marker, uid: 10003, gid: 10003,
      toolchain: { node: `${root}/bin/node`, supervisor } });
    tree.write("/run/zeros/active-runtime.json", tree.descriptor, 0o444);
    tree.owners.set("/run/zeros/active-runtime.json", 65534);
    // The launcher mounts the engine's 0700 tmpfs at /run/zeros in its view.
    tree.owners.set("/run/zeros", 10003); fs.chmodSync(tree.physical("/run/zeros"), 0o700);
    const resolve = () => createCloudRuntimeResolver({ filesystem: tree.filesystem,
      isOwner: (_file, uid) => uid === 0 || uid === 65534, isEngine: () => true, isReadOnly: () => true }).resolve();
    expect(resolve().profile).toBe("v4");
    fs.chmodSync(tree.physical("/run/zeros"), 0o770);
    expect(resolve).toThrow(/runtime/);
    fs.chmodSync(tree.physical("/run/zeros"), 0o700);
    for (const file of ["/run", "/etc/zeros", root]) {
      tree.owners.set(file, 10003);
      expect(resolve).toThrow(/runtime/);
      tree.owners.delete(file);
    }
    tree.owners.set("/run/zeros/active-runtime.json", 10003);
    expect(resolve).toThrow(/runtime/);
    const host = fixture(); host.owners.set("/run/zeros", 10003); fs.chmodSync(host.physical("/run/zeros"), 0o700);
    expect(() => host.resolver.resolve()).toThrow(/runtime/);
  });
  it("reads the immutable base marker with the new pinned Host assets without requiring a retired agent reaper", () => {
    const tree = fixture(), root = tree.descriptor.root;
    tree.write(`${root}/worker/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs`, "pinned Host supervisor", 0o444);
    fs.rmSync(tree.physical(`${root}/bin/cloud-process-supervisor`));
    expect(tree.resolver.resolve().profile).toBe("v4");
  });
  it("refuses arbitrary facade links and symlinked physical runtime ancestry", () => {
    for (const file of ["/zeros", "/opt/zeros/current", "/opt/zeros/bin", "/opt/zeros/worker", "/opt/zeros/manifest.json", "/opt/zeros/logs", "/opt/zeros/state"]) {
      const tree = fixture(); fs.unlinkSync(tree.physical(file)); tree.link(file, "/tmp/attacker");
      expect(() => tree.resolver.resolve()).toThrow(/runtime/);
    }
    const tree = fixture(); fs.renameSync(tree.physical(tree.descriptor.root), tree.physical(`${tree.descriptor.root}-moved`));
    tree.link(tree.descriptor.root, `${tree.descriptor.runtimeId}-moved`);
    expect(() => tree.resolver.resolve()).toThrow(/canonical/);
  });
  it("allows internal package links but rejects absolute, chained external links and hard links", () => {
    const tree = fixture(), runtime = tree.resolver.resolve(), root = runtime.workerRoot;
    tree.write(`${root}/node_modules/.pnpm/pkg/index.js`, "package");
    tree.link(`${root}/node_modules/pkg`, ".pnpm/pkg");
    expect(tree.resolver.packagePath(`${root}/node_modules/pkg/index.js`)).toBe(`${root}/node_modules/.pnpm/pkg/index.js`);
    tree.write("/outside/index.js", "external");
    tree.link(`${root}/node_modules/escape`, "../../../../outside");
    tree.link(`${root}/node_modules/chain`, "escape");
    expect(() => tree.resolver.packagePath(`${root}/node_modules/chain/index.js`)).toThrow(/runtime/);
    tree.link(`${root}/node_modules/absolute`, `${root}/node_modules/.pnpm/pkg`);
    expect(() => tree.resolver.packagePath(`${root}/node_modules/absolute/index.js`)).toThrow(/runtime/);
    fs.linkSync(tree.physical(`${root}/node_modules/.pnpm/pkg/index.js`), tree.physical(`${root}/other.js`));
    expect(() => tree.resolver.packagePath(`${root}/node_modules/pkg/index.js`)).toThrow(/runtime/);
  });
  it("rejects an external package link before consuming a subsequent parent component", () => {
    const tree = fixture(), runtime = tree.resolver.resolve();
    const scope = `${runtime.workerRoot}/node_modules/@anthropic-ai`;
    tree.write(`${scope}/sdk-safe/package.json`, { main: "internal" });
    tree.mkdir("/outside/step");
    tree.write("/outside/sdk-safe/package.json", { main: "external" });
    tree.link(`${scope}/escape`, path.posix.relative(scope, "/outside/step"));
    tree.link(`${scope}/claude-agent-sdk`, "escape/../sdk-safe");
    const file = `${scope}/claude-agent-sdk/package.json`;
    expect(fs.realpathSync.native(tree.physical(file))).toBe(tree.physical("/outside/sdk-safe/package.json"));
    expect(JSON.parse(fs.readFileSync(tree.physical(file), "utf8"))).toEqual({ main: "external" });
    expect(() => tree.resolver.packagePath(file)).toThrow(/runtime/);
  });
  it("follows an internal package link before consuming a subsequent parent component", () => {
    const tree = fixture(), runtime = tree.resolver.resolve();
    const scope = `${runtime.workerRoot}/node_modules/@anthropic-ai`;
    tree.write(`${scope}/sdk-safe/package.json`, { main: "lexical-decoy" });
    tree.mkdir(`${runtime.root}/packages/step`);
    const actual = `${runtime.root}/packages/sdk-safe/package.json`;
    tree.write(actual, { main: "physical-target" });
    tree.link(`${scope}/redirect`, path.posix.relative(scope, `${runtime.root}/packages/step`));
    tree.link(`${scope}/claude-agent-sdk`, "redirect/../sdk-safe");
    const file = `${scope}/claude-agent-sdk/package.json`;
    expect(fs.realpathSync.native(tree.physical(file))).toBe(tree.physical(actual));
    expect(tree.resolver.packagePath(file)).toBe(actual);
  });
  it("maps the declared v4 profile to the exact non-root map without inferring a profile from maps", () => {
    expect(cloudProfileIdentityMapVersion(4)).toBe(5);
    expect(cloudProfileIdentityMapVersion(3)).toBeNull();
    expect(cloudProfileIdentityMapVersion(2)).toBeNull();
    expect(cloudProfileIdentityMapVersion(5)).toBeNull();
  });
  it("rejects runtime paths and unknown fields in the base-owned host marker", () => {
    for (const change of [{ toolchain: {} }, { runtimeRoot: "/tmp" }, { profile: "zeros-cloud-worker-v3" }, { uid: 0 }]) {
      const tree = fixture(); tree.write("/etc/zeros/cloud-worker.json", { ...tree.marker, ...change });
      expect(() => tree.resolver.resolve()).toThrow(/runtime/);
    }
  });
  it("derives restricted child paths only from the pinned physical executable", () => {
    const tree = fixture();
    fs.rmSync(tree.physical("/etc/zeros"), { recursive: true });
    fs.rmSync(tree.physical("/run/zeros"), { recursive: true });
    const child = createCloudRuntimeResolver({ filesystem: tree.filesystem, executable: () => `${tree.descriptor.root}/bin/node` });
    expect(child.resolveChild()).toMatchObject({ profile: "v4", root: tree.descriptor.root, workerRoot: `${tree.descriptor.root}/worker` });
    for (const node of ["/zeros/bin/node", "/opt/zeros/current/bin/node", "/tmp/node", `${tree.descriptor.root}/bin/../bin/node`, `${tree.descriptor.root}/bin/node\n`])
      expect(() => createCloudRuntimeResolver({ filesystem: tree.filesystem, executable: () => node }).resolveChild()).toThrow(/runtime/);
    tree.owners.set(tree.descriptor.root, 10001);
    expect(() => createCloudRuntimeResolver({ filesystem: tree.filesystem, executable: () => `${tree.descriptor.root}/bin/node` }).resolveChild()).toThrow(/runtime/);
  });
});
