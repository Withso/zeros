import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { copyRuntimeFixture, initializeFixtureCheckout, snapshotSystemExecutable } from "../cloud-workspace-validation/cloud-agent-e2e/projection";
import { execFileSync } from "node:child_process";
import { assertPrivateNamespace, assertPrivateRoot, fixtureFacade, fixtureOuterArguments, fixtureDescriptor, fixtureCredentialEnv, fixtureMountPlan, hostActiveFileOptions } from "../cloud-workspace-validation/cloud-agent-e2e/runtime-contract";
import { parseCloudActiveRuntime } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { CloudTransport } from "../../apps/desktop/src/engine/transport/cloud";
import { fixtureTransportToken } from "../cloud-workspace-validation/cloud-agent-e2e/runtime-contract";
import { readOriginUrl, repoSlugFromOriginUrl } from "../../apps/desktop/src/engine/git/repo";
import * as runtimeContract from "../cloud-workspace-validation/cloud-agent-e2e/runtime-contract";
import { diagnoseHarnessFailure, HarnessFailure } from "../cloud-workspace-validation/cloud-agent-e2e/assertions";
import { CLOUD_ENGINE_MUTABLE_LAYOUT, adoptCloudEngineRuntimeGroups } from "../cloud-workspace-validation/sandbox/prepare-cloud-image-files.mjs";
import { CloudRuntimeCgroup } from "../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs";
import * as filesystem from "node:fs";
import { buildInstalledHarnessOperators } from "../cloud-workspace-validation/cloud-agent-e2e/runtime";
import { cloudEngineViewArguments, cloudEngineViewEnvironment } from "../cloud-workspace-validation/sandbox/cloud-engine-view.mjs";

describe("private SOURCE-MODE runtime contract", () => {
  it("stages the product ripgrep and Host runtime, without retired execution payloads", () => {
    const builder=readFileSync(new URL("../cloud-workspace-validation/cloud-agent-e2e/runtime.ts",import.meta.url),"utf8");
    expect(builder).toContain("stage-ripgrep.mjs");
    expect(builder).toContain("worker/binaries/rg");
    expect(builder).not.toMatch(/zsr-supervisor|zsr-rg|cloud-process-supervisor/);
  });
  it("refuses an output-parent alias into the source before operator compilation", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zeros-operator-output-")), source = path.join(directory, "source"), alias = path.join(directory, "output");
    mkdirSync(source); symlinkSync(source, alias, "dir");
    try {
      await expect(buildInstalledHarnessOperators(source, path.join(alias, "operators"), "a".repeat(40)))
        .rejects.toThrow("operator_input_invalid");
      expect(filesystem.existsSync(path.join(source, "operators"))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  const procObservation = { uid: 0, mountNamespace: "mnt:[124]", pidNamespace: "pid:[224]", pid: 1,
    rootType: 0x01021994, procType: 0x9fa0, initNamespace: "pid:[223]" };
  const outerNamespaces = { mountNamespace: "mnt:[123]", pidNamespace: "pid:[223]" };
  it("retains a closed failure when real private proc ownership cannot be confirmed", () => {
    expect(diagnoseHarnessFailure(new HarnessFailure("private_proc_view_required"))).toEqual({ code: "private_proc_view_required" });
  });
  it("preserves the parent's private proc without bubblewrap's locked read-only child mounts", () => {
    const args = fixtureOuterArguments("/workspace", "/vercel/node", "/scratch/entry.mjs", "/scratch/config.json");
    expect(args).not.toContain("--proc");
    expect(args.some((value, index) => value === "--bind" && args[index + 1] === "/proc" && args[index + 2] === "/proc")).toBe(true);
  });
  it("mounts fresh real proc for its own guarded PID1 namespace before relying on process ownership", () => {
    const mountProc = vi.fn();
    const observe = vi.fn().mockReturnValueOnce(procObservation)
      .mockReturnValueOnce({ ...procObservation, initNamespace: procObservation.pidNamespace });
    runtimeContract.preparePrivateProcView(outerNamespaces, { observe, mountProc });
    expect(mountProc).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledTimes(2);
    expect(observe.mock.invocationCallOrder[0]).toBeLessThan(mountProc.mock.invocationCallOrder[0]);
    expect(observe.mock.invocationCallOrder[1]).toBeGreaterThan(mountProc.mock.invocationCallOrder[0]);
  });
  it.each([
    ["host mount namespace", { mountNamespace: "mnt:[123]" }, "private_mount_namespace_required"],
    ["host PID namespace", { pidNamespace: "pid:[223]" }, "private_pid_namespace_required"],
    ["non-init process", { pid: 2 }, "private_pid_namespace_required"],
    ["non-root identity", { uid: 10003 }, "namespace_root_required"],
    ["host root", { rootType: 0xef53 }, "private_root_required"],
    ["synthetic proc", { procType: 0x01021994 }, "private_proc_view_required"],
  ])("refuses fresh proc before any mount in an unsafe %s", (_label, invalid, code) => {
    const mountProc = vi.fn();
    expect(() => runtimeContract.preparePrivateProcView(outerNamespaces,
      { observe: () => ({ ...procObservation, ...invalid }), mountProc })).toThrow(code);
    expect(mountProc).not.toHaveBeenCalled();
  });
  it.each([
    ["parent proc still visible", {}],
    ["namespace changed", { mountNamespace: "mnt:[125]", initNamespace: "pid:[224]" }],
    ["synthetic proc after mount", { procType: 0x01021994, initNamespace: "pid:[224]" }],
  ])("refuses an unconfirmed fresh proc: %s", (_label, invalid) => {
    const observe = vi.fn().mockReturnValueOnce(procObservation).mockReturnValueOnce({ ...procObservation, ...invalid });
    expect(() => runtimeContract.preparePrivateProcView(outerNamespaces, { observe, mountProc: vi.fn() }))
      .toThrow("private_proc_view_required");
  });
  it("keeps the installed which executable when a private etc view removes its alternatives alias", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "zeros-source-which-"));
    try {
      const which = path.join(scratch, "which"), alternatives = path.join(scratch, "alternatives"), binary = path.join(scratch, "which.real");
      writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$1"\n', { mode: 0o755 });
      symlinkSync(binary, alternatives); symlinkSync(alternatives, which);
      const bytes = snapshotSystemExecutable(which);
      rmSync(alternatives); rmSync(which);
      writeFileSync(which, bytes, { mode: 0o555 });
      expect(execFileSync(which, ["socat"], { env: {}, encoding: "utf8" })).toBe("socat\n");
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
  it("can bind the verified private Ubuntu system view while retaining real proc/sysfs and fresh root", () => {
    const args = fixtureOuterArguments("/workspace", "/vercel/node", "/scratch/entry.mjs", "/scratch/config.json", "/scratch/ubuntu/rootfs");
    expect(args).toContain("/scratch/ubuntu/rootfs/usr");
    expect(args).toContain("/scratch/ubuntu/rootfs/etc");
    expect(args).toContain("/sys/fs/cgroup");
    expect(args).toContain("/proc");
    expect(args.some((value, index) => ["--bind", "--ro-bind"].includes(value) && args[index + 1] === "/")).toBe(false);
  });
  it("creates a committed main checkout and inert origin for the real cloud startup contract", async () => {
    const checkout = mkdtempSync(path.join(tmpdir(), "zeros-source-checkout-"));
    try {
      writeFileSync(path.join(checkout, "tool-input.txt"), "fixture input\n");
      initializeFixtureCheckout(checkout);
      expect(execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toMatch(/^[a-f0-9]{40,64}$/);
      expect(execFileSync("git", ["-C", checkout, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim()).toBe("main");
      expect(repoSlugFromOriginUrl(await readOriginUrl(checkout))).toBe("fixture-repo");
    } finally { rmSync(checkout, { recursive: true, force: true }); }
  });
  it("retains pnpm-relative dependency links when R is copied into a different private root", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "zeros-source-projection-"));
    const source = path.join(scratch, "source"), target = path.join(scratch, "private-root");
    try {
      mkdirSync(`${source}/worker/node_modules/.pnpm/zod-fixture/node_modules/zod`, { recursive: true });
      writeFileSync(`${source}/worker/package.json`, "{}");
      writeFileSync(`${source}/worker/node_modules/.pnpm/zod-fixture/node_modules/zod/package.json`, '{"name":"zod","main":"index.cjs"}');
      writeFileSync(`${source}/worker/node_modules/.pnpm/zod-fixture/node_modules/zod/index.cjs`, 'module.exports="fixture dependency"');
      symlinkSync(".pnpm/zod-fixture/node_modules/zod", `${source}/worker/node_modules/zod`);
      copyRuntimeFixture(source, target);
      rmSync(source, { recursive: true });
      expect(readlinkSync(`${target}/worker/node_modules/zod`)).toBe(".pnpm/zod-fixture/node_modules/zod");
      expect(createRequire(`${target}/worker/package.json`)("zod")).toBe("fixture dependency");
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
  it("fails before mounts or mkdir when the mount namespace is the original host namespace", () => {
    expect(() => assertPrivateNamespace({ outer: "mnt:[123]", current: "mnt:[123]", uid: 0 })).toThrow("private_mount_namespace_required");
    expect(() => assertPrivateNamespace({ outer: "mnt:[123]", current: "mnt:[124]", uid: 1000 })).toThrow("namespace_root_required");
    expect(() => assertPrivateNamespace({ outer: "mnt:[123]", current: "mnt:[124]", uid: 0 })).not.toThrow();
  });
  it("overlays existing parents before creating missing host target directories", () => {
    const plan = fixtureMountPlan();
    for (const target of ["/opt/zeros-infra", "/opt/zeros", "/etc/zeros", "/run/zeros", "/srv/zeros"]) {
      const create = plan.findIndex(step => step.kind === "mkdir" && step.target === target);
      const parent = target.substring(0, target.lastIndexOf("/"));
      const overlay = plan.findIndex(step => step.kind === "tmpfs" && step.target === parent);
      expect(overlay).toBeGreaterThanOrEqual(0); expect(create).toBeGreaterThan(overlay);
    }
  });
  it("honestly identifies the source fixture while satisfying the exact v4 active contract", () => {
    const fixture = fixtureDescriptor("a".repeat(64));
    expect(fixture.active).toMatchObject({ schema: "zeros.active-runtime/v1", runtimeId: `r1-${"a".repeat(64)}`,
      root: `/opt/zeros-infra/r1-${"a".repeat(64)}`, manifestSha256: "a".repeat(64) });
    expect(fixture.marker).toEqual({ backend: "cloud-worker", uid: 10001, gid: 10001, profile: "zeros-cloud-worker-v4", version: 4 });
    expect(fixture.evidenceKind).toBe("source_mode_fixture");
    expect(fixture.uidMap).toEqual([[10003, 10003, 1]]);
  });
  it("uses the current physical engine HOME sources and root-controlled staging", () => {
    expect(runtimeContract.fixtureMutableOwnership()).toEqual([
      { target: "/srv/zeros/files/workspace", mode: 0o755, uid: 10003, gid: 10003 },
      { target: CLOUD_ENGINE_MUTABLE_LAYOUT.agentHome, mode: 0o755, uid: 10003, gid: 10003 },
      { target: CLOUD_ENGINE_MUTABLE_LAYOUT.captureHome, mode: 0o700, uid: 10003, gid: 10003 },
      { target: "/srv/zeros/state", mode: 0o700, uid: 10003, gid: 10003 },
      { target: CLOUD_ENGINE_MUTABLE_LAYOUT.stagingParent, mode: 0o710, uid: 0, gid: 10003 },
    ]);
  });
  it("retains the frozen base parents accepted by the actual runtime group reader", () => {
    const base = runtimeContract.fixtureBaseOwnership();
    expect(base).toEqual([
      { target: "/srv/zeros/home/agent", mode: 0o755, uid: 10001, gid: 10001 },
      { target: "/srv/zeros/home/capture", mode: 0o700, uid: 10002, gid: 10002 },
      { target: "/srv/zeros/files/.zeros-setup", mode: 0o710, uid: 0, gid: 10001 },
      { target: "/srv/zeros/log", mode: 0o750, uid: 0, gid: 10001 },
      { target: "/srv/zeros/managed-settings", mode: 0o750, uid: 0, gid: 10001 },
    ]);
    const files = [
      { target: "/srv/zeros/log/engine.log", mode: 0o640, uid: 0, gid: 10001 },
      { target: "/srv/zeros/managed-settings/settings.managed.toml", mode: 0o640, uid: 0, gid: 10001 },
    ];
    const entries = new Map([...base, ...files].map((entry, index) => [entry.target, {
      dev: 1, ino: index + 1, uid: entry.uid, gid: entry.gid, mode: entry.mode, nlink: 1,
      isDirectory: () => index < base.length, isFile: () => index >= base.length, isSymbolicLink: () => false,
    }]));
    const before = new Map(entries);
    const io = {
      lstatSync: (file: string) => { const entry = entries.get(file); if (!entry) throw Object.assign(new Error(), { code: "ENOENT" }); return entry; },
      realpathSync: (file: string) => file,
      openSync: (file: string) => [...entries.keys()].indexOf(file),
      fstatSync: (fd: number) => [...entries.values()][fd],
      closeSync: () => {},
    };
    const root = vi.spyOn(process, "geteuid").mockReturnValue(0);
    try { expect(() => adoptCloudEngineRuntimeGroups(io)).not.toThrow(); }
    finally { root.mockRestore(); }
    expect(entries).toEqual(before);
    const mutable = new Set(runtimeContract.fixtureMutableOwnership().map(entry => entry.target));
    expect(base.every(entry => !mutable.has(entry.target))).toBe(true);
  });
  it("never implicitly imports ambient provider credentials", () => {
    expect(fixtureCredentialEnv("invalid", { CLAUDE_CODE_OAUTH_TOKEN: "private", OPENAI_API_KEY: "private", CURSOR_API_KEY: "private" }))
      .toEqual({ ANTHROPIC_API_KEY: "fixture-invalid-key", OPENAI_API_KEY: "fixture-invalid-key", CURSOR_API_KEY: "fixture-invalid-key" });
    expect(() => fixtureCredentialEnv("environment", { ANTHROPIC_API_KEY: "private" })).toThrow("owner_authorization_required");
  });
  it("passes the production v4 descriptor parser rather than a harness-only approximation", () => {
    expect(() => parseCloudActiveRuntime(fixtureDescriptor("a".repeat(64)).active)).not.toThrow();
  });
  it("creates facade aliases only on a fresh tmpfs root, never the host root bind", () => {
    expect(() => assertPrivateRoot(0xef53)).toThrow("private_root_required");
    expect(() => assertPrivateRoot(0x01021994)).not.toThrow();
    const args = fixtureOuterArguments("/workspace", "/vercel/node", "/scratch/entry.mjs", "/scratch/config.json");
    expect(args).toContain("--as-pid-1");
    expect(args.some((value, index) => ["--bind", "--ro-bind"].includes(value) && args[index + 1] === "/")).toBe(false);
    expect(fixtureFacade(`r1-${"a".repeat(64)}`)).toMatchObject({ "/zeros": "/opt/zeros", "/opt/zeros/current": `../zeros-infra/r1-${"a".repeat(64)}` });
  });
  it("creates the host active-runtime with private mode 0600 (0444 on writable tmpfs is rejected by v4)", () => {
    expect(hostActiveFileOptions()).toEqual({ mode: 0o600 });
  });
  it("supplies the mandatory transport constructor token alongside the actor verifier", () => {
    const token = fixtureTransportToken();
    expect(() => new CloudTransport({ port: 0, token, verifyToken: async () => null, renewToken: async () => null })).not.toThrow();
    expect(token).not.toBe(fixtureTransportToken());
  });
});

describe("installed-runtime harness handover", () => {
  const service = "/sys/fs/cgroup/system.slice/zeros-host.service";
  const handover = () => ({ schema: "zeros.installed-agent-e2e/v1" as const, sandboxId: "qualification-vm-only",
    active: fixtureDescriptor("a".repeat(64), service).active });
  const common = { directory: `${service}/engine-runtime`, dev: "43", ino: "105" };

  it("requires every genuine installation pin and the one preserved service path", () => {
    const expected = handover();
    expect(runtimeContract.parseInstalledHarnessHandover(expected)).toEqual(expected);
    const options = runtimeContract.selectHarnessRuntimeMode(["--runtime-mode", "installed", "--installed-handover", "/private/handover.json"]);
    expect(options).toEqual({ mode: "installed", handoverFile: "/private/handover.json" });
    expect(runtimeContract.selectHarnessRuntimeMode([])).toEqual({ mode: "source" });
    expect(runtimeContract.installedHarnessPaths(expected.active)).toEqual({ service, host: `${service}/host`,
      common: common.directory, workload: `${common.directory}/engine-workload-shared/workload`,
      active: "/run/zeros/active-runtime.json", resourceMaterial: "/run/zeros/cloud-resource-contract.json",
      resourceProjection: "/etc/zeros/cloud-resource-contract.json" });
  });

  it.each(["manifestSha256", "installerReceiptSha256", "bootId", "supervisorSessionId", "baseCompatibilityId"])("refuses an unset installation %s", field => {
    const expected = handover(); delete (expected.active as Record<string, unknown>)[field];
    expect(() => runtimeContract.parseInstalledHarnessHandover(expected)).toThrow("fixture_contract_invalid");
  });

  it.each([
    ["SOURCE default domain", { cgroupRoot: "/sys/fs/cgroup/zeros-agent-e2e/zeros-host.service" }],
    ["alternate native venue", { cgroupRoot: "/sys/fs/cgroup/zeros-c4-qual/zeros-host.service" }],
    ["mutable runtime root", { root: "/srv/zeros/runtime" }],
    ["extra mode field", { boundsMode: "nominal" }],
  ])("refuses %s instead of changing roots or falling back to SOURCE", (_label, changed) => {
    const expected = handover();
    expect(() => runtimeContract.parseInstalledHarnessHandover({ ...expected, active: { ...expected.active, ...changed } }))
      .toThrow("fixture_contract_invalid");
  });

  it.each([
    ["--runtime-mode", "installed"],
    ["--runtime-mode", "other"],
    ["--installed-handover", "/private/pins.json"],
    ["--runtime-mode", "installed", "--runtime-mode", "source", "--installed-handover", "/private/pins.json"],
    ["--runtime-mode", "installed", "--installed-handover", "/private/pins.json", "--credentials", "environment"],
    ["--runtime-mode", "installed", "--installed-handover", "/private/pins.json", "--scope", "cpu-private-pid-fixture"],
    ["--runtime-mode", "installed", "--installed-handover", "/private/pins.json", "--linux-view", "ubuntu-24.04"],
    ["--runtime-mode", "installed", "--installed-handover", "/private/pins.json", "--measurement", "none"],
    ["--runtime-mode", "installed", "--installed-handover", "/private/pins.json", "--measurement", "current"],
    ["--runtime-mode", "installed", "--installed-handover", "/private/pins.json", "--cp-request-delay-ms", "100"],
  ].map(args => [args]))("refuses a conflicting or incomplete installed invocation %j", args => {
    expect(() => runtimeContract.selectHarnessRuntimeMode(args)).toThrow("operator_input_invalid");
  });

  it("compares actual fixed-descriptor readback and the physical pinned executable with every handover field", () => {
    const expected = handover();
    expect(runtimeContract.requireInstalledHarnessBinding(expected, expected.active, `${expected.active.root}/bin/node`)).toEqual(expected.active);
    for (const changed of [{ bootId: "32345678-1234-4234-8234-123456789abc" },
      { supervisorSessionId: "32345678-1234-4234-8234-123456789abc" }, { installerReceiptSha256: "b".repeat(64) },
      { baseCompatibilityId: `bc1-${"b".repeat(64)}` }])
      expect(() => runtimeContract.requireInstalledHarnessBinding(expected, { ...expected.active, ...changed }, `${expected.active.root}/bin/node`))
        .toThrow("fixture_contract_invalid");
    expect(() => runtimeContract.requireInstalledHarnessBinding(expected, expected.active, "/usr/bin/node"))
      .toThrow("fixture_contract_invalid");
  });

  it("selects the private installed config reader before opening any bytes", () => {
    const io = { installed: vi.fn(() => ({ mode: "installed" })), source: vi.fn(() => ({})) };
    expect(runtimeContract.readHarnessEntryConfiguration(["/root/private/config.json", "--installed"], io))
      .toEqual({ mode: "installed", config: { mode: "installed" } });
    expect(io.installed).toHaveBeenCalledExactlyOnceWith("/root/private/config.json");
    expect(io.source).not.toHaveBeenCalled();
    expect(runtimeContract.readHarnessEntryConfiguration(["/source/config.json"], io)).toEqual({ mode: "source", config: {} });
    expect(io.source).toHaveBeenCalledExactlyOnceWith("/source/config.json");
  });
  it("rejects flag/body conflicts and extra entry arguments without a mode fallback", () => {
    const io = { installed: vi.fn(() => ({ mode: "source" })), source: vi.fn(() => ({ mode: "installed" })) };
    for (const argv of [["/config.json", "--installed"], ["/config.json"], ["/config.json", "--installed", "--source"], []])
      expect(() => runtimeContract.readHarnessEntryConfiguration(argv, io)).toThrow("fixture_contract_invalid");
  });

  const inventory = () => ({ schema: "zeros.installed-agent-e2e-operator/v1", sourceCommit: "f".repeat(40), files: [
    { path: "run.mjs", bytes: 300, sha256: "d".repeat(64) },
    { path: "namespace-entry.mjs", bytes: 200, sha256: "e".repeat(64) },
  ] });
  it("binds a two-file private operator inventory to the installed source commit", () => {
    const value = inventory();
    expect(runtimeContract.parseInstalledHarnessOperatorInventory(value, value.sourceCommit)).toEqual(value);
    const directory = "/root/zeros-c4-qualification/32345678-1234-4234-8234-123456789abc";
    expect(runtimeContract.installedHarnessOperatorPaths(`${directory}/run.mjs`))
      .toEqual({ directory, run: `${directory}/run.mjs`, entry: `${directory}/namespace-entry.mjs`, inventory: `${directory}/operator-inventory.json` });
    for (const entry of ["/tmp/run.mjs", `${directory}/other.mjs`, `${directory}/../run.mjs`])
      expect(() => runtimeContract.installedHarnessOperatorPaths(entry)).toThrow("fixture_contract_invalid");
  });
  it.each(["source", "extra", "missing", "duplicate", "traversal", "size", "hash"])("refuses operator inventory %s drift", kind => {
    const value = inventory();
    if (kind === "source") value.sourceCommit = "b".repeat(40);
    if (kind === "extra") Object.assign(value, { qualified: true });
    if (kind === "missing") value.files.pop();
    if (kind === "duplicate") value.files[1] = value.files[0]!;
    if (kind === "traversal") value.files[1]!.path = "../namespace-entry.mjs";
    if (kind === "size") value.files[0]!.bytes = 64 * 1024 * 1024 + 1;
    if (kind === "hash") value.files[0]!.sha256 = "x".repeat(64);
    expect(() => runtimeContract.parseInstalledHarnessOperatorInventory(value, "f".repeat(40))).toThrow("fixture_contract_invalid");
  });
  function uploadedOperator() {
    const directory = "/root/zeros-c4-qualification/32345678-1234-4234-8234-123456789abc", expected = handover();
    const run = Buffer.from("original uploaded run operator"), entry = Buffer.from("original uploaded namespace entry");
    const value = { ...inventory(), files: [
      { path: "run.mjs", bytes: run.length, sha256: createHash("sha256").update(run).digest("hex") },
      { path: "namespace-entry.mjs", bytes: entry.length, sha256: createHash("sha256").update(entry).digest("hex") },
    ] };
    const documents = new Map([[`${directory}/operator-inventory.json`, Buffer.from(JSON.stringify(value))],
      [`${directory}/run.mjs`, run], [`${directory}/namespace-entry.mjs`, entry]]);
    const workerRoot = `${expected.active.root}/worker`;
    const io = { read: vi.fn((file: string) => { const bytes = documents.get(file); if (!bytes) throw new Error(); return bytes; }),
      metadata: vi.fn((): { uid: number; gid: number; isSymbolicLink(): boolean } => ({ uid: 0, gid: 0, isSymbolicLink: () => true })),
      link: vi.fn(() => `${workerRoot}/node_modules`), realpath: vi.fn(() => `${workerRoot}/node_modules`), assertDirectory: vi.fn() };
    return { directory, workerRoot, value, documents, io };
  }
  it("checks the original uploaded script bytes and pins native dependencies to the installed worker", () => {
    const f = uploadedOperator();
    expect(runtimeContract.readInstalledHarnessOperator(`${f.directory}/run.mjs`, f.value.sourceCommit, { workerRoot: f.workerRoot }, f.io).inventory)
      .toEqual(f.value);
    expect(f.io.read.mock.calls.map(([file]) => file)).toEqual([`${f.directory}/operator-inventory.json`, `${f.directory}/run.mjs`, `${f.directory}/namespace-entry.mjs`]);
    expect(f.io.read).toHaveBeenNthCalledWith(2, `${f.directory}/run.mjs`, 64 * 1024 * 1024, 0o500);
    expect(f.io.assertDirectory).toHaveBeenCalledExactlyOnceWith(`${f.workerRoot}/node_modules`);
  });
  it.each(["bytes", "mode-port", "owner", "gid", "link-kind", "foreign-link", "alias", "ancestry"])("refuses uploaded %s drift", kind => {
    const f = uploadedOperator();
    if (kind === "bytes") f.documents.set(`${f.directory}/namespace-entry.mjs`, Buffer.from("changed uploaded namespace entry"));
    if (kind === "mode-port") f.io.read.mockImplementation(() => { throw new Error("private unsafe mode"); });
    if (kind === "owner") f.io.metadata.mockReturnValue({ uid: 10003, gid: 0, isSymbolicLink: () => true });
    if (kind === "gid") f.io.metadata.mockReturnValue({ uid: 0, gid: 10003, isSymbolicLink: () => true });
    if (kind === "link-kind") f.io.metadata.mockReturnValue({ uid: 0, gid: 0, isSymbolicLink: () => false });
    if (kind === "foreign-link") f.io.link.mockReturnValue("/tmp/node_modules");
    if (kind === "alias") f.io.realpath.mockReturnValue("/tmp/node_modules");
    if (kind === "ancestry") f.io.assertDirectory.mockImplementation(() => { throw new Error("private unsafe ancestry"); });
    expect(() => runtimeContract.readInstalledHarnessOperator(`${f.directory}/run.mjs`, f.value.sourceCommit, { workerRoot: f.workerRoot }, f.io))
      .toThrow("fixture_contract_invalid");
    if (kind !== "mode-port") expect(f.io.read).toHaveBeenCalledTimes(3);
  });

  it("reads the bounded private record from one real no-follow file descriptor", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zeros-installed-record-"));
    const file = path.join(directory, "active.json"), bytes = Buffer.from('{"fixed":"record"}');
    writeFileSync(file, bytes, { mode: 0o600 });
    // Explicit portable metadata seam. Real file/open/fstat/read/close still
    // exercises symlinks and replacements; this never attests a VM install.
    const rootMetadata = (stat: filesystem.Stats) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 0, gid: 0 });
    const io = { ...filesystem, assertPath: vi.fn(),
      lstatSync: (filename: string) => rootMetadata(filesystem.lstatSync(filename)),
      fstatSync: (fd: number) => rootMetadata(filesystem.fstatSync(fd)) };
    try {
      expect(runtimeContract.readRootHarnessFile(file, 32, 0o600, io)).toEqual(bytes);
      const link = path.join(directory, "link.json"); symlinkSync(file, link);
      expect(() => runtimeContract.readRootHarnessFile(link, 32, 0o600, io)).toThrow("fixture_contract_invalid");
      let replaced = false;
      const replacement = { ...io, fstatSync: (fd: number) => {
        const original = io.fstatSync(fd);
        if (!replaced) { replaced = true; filesystem.renameSync(file, `${file}.old`); writeFileSync(file, bytes, { mode: 0o600 }); }
        return original;
      } };
      expect(() => runtimeContract.readRootHarnessFile(file, 32, 0o600, replacement)).toThrow("fixture_contract_invalid");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("refuses oversize, broad-mode and unsafe-owner installation records before reading bytes", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zeros-installed-record-")), file = path.join(directory, "active.json");
    writeFileSync(file, "x".repeat(40), { mode: 0o600 });
    const rootMetadata = (stat: filesystem.Stats) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 0, gid: 0 });
    const io = { ...filesystem, assertPath: vi.fn(),
      lstatSync: (filename: string) => rootMetadata(filesystem.lstatSync(filename)),
      fstatSync: (fd: number) => rootMetadata(filesystem.fstatSync(fd)),
      readSync: vi.fn((fd: number, buffer: Buffer, offset: number, length: number, position: null) => filesystem.readSync(fd, buffer, offset, length, position)),
      closeSync: vi.fn(filesystem.closeSync) };
    try {
      expect(() => runtimeContract.readRootHarnessFile(file, 32, 0o600, io)).toThrow("fixture_contract_invalid");
      expect(io.readSync).not.toHaveBeenCalled(); expect(io.closeSync).toHaveBeenCalledOnce();
      writeFileSync(file, "{}"); filesystem.chmodSync(file, 0o644);
      expect(() => runtimeContract.readRootHarnessFile(file, 32, 0o600, io)).toThrow("fixture_contract_invalid");
      filesystem.chmodSync(file, 0o600);
      expect(() => runtimeContract.readRootHarnessFile(file, 32, 0o600,
        { ...io, fstatSync: (fd: number) => ({ ...io.fstatSync(fd), uid: 10003 }) })).toThrow("fixture_contract_invalid");
      expect(io.readSync).not.toHaveBeenCalled();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("retains exact wide inode identities and refuses rounded number metadata", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zeros-installed-wide-inode-")), file = path.join(directory, "active.json");
    writeFileSync(file, "{}", { mode: 0o600 });
    const ino = (1n << 53n) + 10n;
    const rooted = (stat: filesystem.BigIntStats) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 0n, gid: 0n, ino });
    const io = { ...filesystem, assertPath: vi.fn(),
      lstatSync: (filename: string) => rooted(filesystem.lstatSync(filename, { bigint: true })),
      fstatSync: (fd: number) => rooted(filesystem.fstatSync(fd, { bigint: true })) };
    try {
      expect(runtimeContract.readRootHarnessFile(file, 32, 0o600, io).toString()).toBe("{}");
      const changed = { ...io, lstatSync: (filename: string) => Object.assign(io.lstatSync(filename), { ino: ino + 1n }) };
      expect(() => runtimeContract.readRootHarnessFile(file, 32, 0o600, changed)).toThrow("fixture_contract_invalid");
      const rounded = (stat: filesystem.Stats) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 0, gid: 0, ino: Number(ino) });
      expect(() => runtimeContract.readRootHarnessFile(file, 32, 0o600, { ...filesystem, assertPath: vi.fn(),
        lstatSync: (filename: string) => rounded(filesystem.lstatSync(filename)), fstatSync: (fd: number) => rounded(filesystem.fstatSync(fd)) }))
        .toThrow("fixture_contract_invalid");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it.each(["read", "close"])("closes a failed %s without exposing filesystem diagnostics", (failure) => {
    const directory = mkdtempSync(path.join(tmpdir(), "zeros-installed-record-failure-")), file = path.join(directory, "active.json");
    writeFileSync(file, "{}", { mode: 0o600 });
    const rooted = (stat: filesystem.Stats) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 0, gid: 0 });
    const closeSync = vi.fn((fd: number) => {
      filesystem.closeSync(fd);
      if (failure === "close") throw new Error("private filesystem diagnostic");
    });
    const io = { ...filesystem, assertPath: vi.fn(), closeSync,
      lstatSync: (filename: string) => rooted(filesystem.lstatSync(filename)),
      fstatSync: (fd: number) => rooted(filesystem.fstatSync(fd)),
      readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: null) => {
        if (failure === "read") throw new Error("private filesystem diagnostic");
        return filesystem.readSync(fd, buffer, offset, length, position);
      } };
    try {
      expect(() => runtimeContract.readRootHarnessFile(file, 32, 0o600, io)).toThrow(new HarnessFailure("fixture_contract_invalid"));
      expect(closeSync).toHaveBeenCalledOnce();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  function kernel() {
    const expected = handover(), retained = [service, `${service}/host`];
    const state = new Map([service, `${service}/host`, common.directory, `${common.directory}/engine-workload-shared`,
      `${common.directory}/engine-workload-shared/workload`, `${common.directory}/engine-workload-shared/workload/detached`]
      .map(directory => [directory, new Map([["cgroup.events", "populated 1"], ["cgroup.procs", "25"]])]));
    const identity = vi.fn((directory: string) => ({ ...common, directory }));
    const io = {
      exists: (directory: string) => state.has(directory), identity,
      children: (directory: string) => [...state.keys()].filter(candidate => path.dirname(candidate) === directory).map(candidate => path.basename(candidate)),
      read: (directory: string, control: string) => state.get(directory)?.get(control) ?? "",
      write: vi.fn((directory: string, control: string, value: string) => {
        if (control !== "cgroup.kill" || value !== "1") throw new Error("unexpected write");
        for (const [candidate, controls] of state) if (candidate === directory || candidate.startsWith(`${directory}/`)) {
          controls.set("cgroup.events", "populated 0"); controls.set("cgroup.procs", "");
        }
      }),
      remove: vi.fn((directory: string) => { state.delete(directory); }),
    };
    const tree = new CloudRuntimeCgroup({ runtime: { ...expected.active, profile: "v4" }, io });
    const assertOutside = vi.fn(), assertPreserved = vi.fn();
    const retirement = { assertOutside, identity, retire: () => tree.retire(), drain: vi.fn(async () => {}),
      exists: io.exists, assertPreserved };
    return { state, retained, io, retirement };
  }

  it("awaits original launcher completion and obtains the actual common-tree kill/empty/prune receipt", async () => {
    const { state, retained, io, retirement } = kernel();
    let complete!: (outcome: { code: number; signal: null }) => void;
    const completion = new Promise<{ code: number; signal: null }>(resolve => { complete = resolve; });
    const retiring = runtimeContract.retireInstalledHarnessTree(common, completion, retirement);
    await Promise.resolve(); expect(io.write).not.toHaveBeenCalled();
    complete({ code: 0, signal: null });
    await expect(retiring).resolves.toEqual({ launcherExit: { code: 0, signal: null },
      receipt: { ...common, populated: 0, pruned: true } });
    expect(io.write).toHaveBeenCalledExactlyOnceWith(common.directory, "cgroup.kill", "1");
    expect([...state.keys()]).toEqual(retained);
    expect(retirement.assertOutside).toHaveBeenCalledTimes(2);
    expect(retirement.assertPreserved).toHaveBeenCalledOnce();
  });

  it("drains retained stdio after common kill and withholds release until actual close", async () => {
    const { state, io, retirement } = kernel();
    let closed!: () => void;
    const stdioClose = new Promise<void>(resolve => { closed = resolve; });
    const drain = vi.fn(() => stdioClose);
    let released = false;
    const retiring = runtimeContract.retireInstalledHarnessTree(common, Promise.resolve({ code: 0, signal: null }),
      { ...retirement, drain }).then(value => { released = true; return value; });
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    expect(io.write).toHaveBeenCalledExactlyOnceWith(common.directory, "cgroup.kill", "1");
    expect(state.has(common.directory)).toBe(false);
    expect(drain).toHaveBeenCalledOnce(); expect(released).toBe(false);
    closed(); await retiring; expect(released).toBe(true);
  });

  it("retains the original launch failure separately from positive whole-tree cleanup", async () => {
    const { retirement } = kernel();
    const evidence = await runtimeContract.retireInstalledHarnessTree(common, Promise.resolve({ code: 125, signal: null }), retirement);
    expect(evidence.launcherExit).toEqual({ code: 125, signal: null });
    expect(evidence.receipt).toEqual({ ...common, populated: 0, pruned: true });
  });
  it("releases installed outer evidence only after actual child close and fresh root verification", async () => {
    const assertCurrent = vi.fn();
    let close!: (outcome: { code: number; signal: null }) => void;
    const completion = new Promise<{ code: number; signal: null }>(resolve => { close = resolve; });
    const retired = { launcherExit: { code: 125, signal: null }, receipt: { ...common, populated: 0 as const, pruned: true as const } };
    const pending = runtimeContract.awaitInstalledHarnessRetirement(completion, () => ({ common, retired }), assertCurrent);
    await Promise.resolve(); expect(assertCurrent).not.toHaveBeenCalled();
    close({ code: 125, signal: null });
    await expect(pending).resolves.toEqual({ outcome: { code: 125, signal: null }, ...retired });
    expect(assertCurrent).toHaveBeenCalledOnce();
  });
  it("makes concurrent Stop/finally callers await the same full cleanup, including failure", async () => {
    let drain!: () => void;
    const action = vi.fn(() => new Promise<void>(resolve => { drain = resolve; }));
    const close = runtimeContract.createHarnessClose(action), first = close(), second = close();
    expect(second).toBe(first);
    await Promise.resolve(); expect(action).toHaveBeenCalledOnce();
    let released = false; void second.then(() => { released = true; });
    await Promise.resolve(); expect(released).toBe(false);
    drain(); await first; expect(released).toBe(true);
    const refusal = new Error("cleanup_unconfirmed"), failing = runtimeContract.createHarnessClose(async () => { throw refusal; });
    await expect(failing()).rejects.toBe(refusal);
    await expect(failing()).rejects.toBe(refusal);
  });
  it.each(["missing", "replaced", "failed", "signal", "root"])("refuses installed outer %s completion", async kind => {
    const retired = { launcherExit: { code: 0, signal: null }, receipt: { ...common, populated: 0 as const, pruned: true as const } };
    const assertCurrent = vi.fn(() => { if (kind === "root") throw new Error("private root drift"); });
    const evidence = { common, retired: kind === "missing" ? undefined : retired, cleanupFailed: kind === "failed" };
    if (kind === "replaced") retired.receipt = { ...retired.receipt, ino: "106" };
    const outcome = { code: kind === "signal" ? null : 0, signal: kind === "signal" ? "SIGKILL" as const : null };
    await expect(runtimeContract.awaitInstalledHarnessRetirement(Promise.resolve(outcome), () => evidence, assertCurrent))
      .rejects.toThrow("cleanup_unconfirmed");
  });

  it("refuses a replaced common inode before any kill and refuses root inside delegation", async () => {
    for (const changed of [{ dev: "44" }, { ino: "106" }]) {
      const { retirement, io } = kernel(); retirement.identity.mockReturnValue({ ...common, ...changed });
      await expect(runtimeContract.retireInstalledHarnessTree(common, Promise.resolve({ code: 0, signal: null }), retirement))
        .rejects.toThrow("cleanup_unconfirmed");
      expect(io.write).not.toHaveBeenCalled();
    }
    const { retirement, io } = kernel(); retirement.assertOutside.mockImplementation(() => { throw new Error("inside tree"); });
    await expect(runtimeContract.retireInstalledHarnessTree(common, Promise.resolve({ code: 0, signal: null }), retirement))
      .rejects.toThrow("cleanup_unconfirmed");
    expect(io.write).not.toHaveBeenCalled();
  });

  it.each([
    null, { populated: 0, pruned: true }, { ...common, ino: "106", populated: 0, pruned: true },
    { ...common, populated: 1, pruned: true }, { ...common, populated: 0, pruned: false },
    { ...common, directory: `${service}/host`, populated: 0, pruned: true },
  ])("refuses missing, substituted or incomplete root receipt %j", receipt => {
    const { retirement } = kernel();
    return expect(runtimeContract.retireInstalledHarnessTree(common, Promise.resolve({ code: 0, signal: null }),
      { ...retirement, retire: async () => receipt })).rejects.toThrow("cleanup_unconfirmed");
  });

  it("cannot infer common-tree proof from serve exit, absent scope, or leaf retirement", async () => {
    const { retirement, io } = kernel();
    await expect(runtimeContract.retireInstalledHarnessTree(common, Promise.resolve({ code: 0, signal: null }),
      { ...retirement, exists: () => false })).rejects.toThrow("cleanup_unconfirmed");
    expect(io.write).not.toHaveBeenCalled();
    await expect(runtimeContract.retireInstalledHarnessTree({ ...common, directory: `${service}/engine-runtime/engine-only-leaf` },
      Promise.resolve({ code: 0, signal: null }), retirement)).rejects.toThrow("cleanup_unconfirmed");
    expect(io.write).not.toHaveBeenCalled();
  });
});

describe("installed fixture CA through the original engine view", () => {
  const publicCa = Buffer.from("explicit fake public CA bytes");

  // Invoke the actual entry function body through an AST port, with explicit
  // fake privileged/process IO. Production view/environment exports supply
  // the projection; no candidate build, namespace or real cgroup is used.
  async function observeEntry(failure?: "write" | "mode") {
    const sourceFile = new URL("../cloud-workspace-validation/cloud-agent-e2e/namespace-entry.ts", import.meta.url);
    const parsed = ts.createSourceFile(sourceFile.pathname, readFileSync(sourceFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const fn = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "runInstalledFixture");
    if (!fn) throw new Error("Actual installed entry missing");
    const javascript = ts.transpileModule(fn.getText(parsed), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const service = "/sys/fs/cgroup/system.slice/zeros-host.service", runtimeId = `r1-${"a".repeat(64)}`;
    const root = `/opt/zeros-infra/${runtimeId}`, id = "11111111-1111-4111-8111-111111111111";
    const active = { schema: "zeros.active-runtime/v1", runtimeId, root, cgroupRoot: service,
      manifestSha256: "a".repeat(64), baseCompatibilityId: `bc1-${"b".repeat(64)}`,
      installerReceiptSha256: "c".repeat(64), bootId: id, supervisorSessionId: id } as const;
    const runtime = { ...active, profile: "v4", libRoot: `${root}/lib/zeros`, binRoot: `${root}/bin`,
      workerRoot: `${root}/worker`, node: `${root}/bin/node`, engineNamespace: `${root}/bin/cloud-engine-namespace`,
      helpers: { launcher: `${root}/lib/zeros/cloud-engine-launcher.mjs` } };
    const common = { directory: `${service}/engine-runtime`, dev: "29", ino: "400" }, viewDirectory = `/run/zeros/view/runtime-${id}`;
    const files = new Map<string, Buffer>(), modes = new Map<string, number>(), messages: Record<string, unknown>[] = [];
    let prepared = false, engine: FakeEngine | undefined;
    const writes: { file: string; mode?: number; flag?: string }[] = [];
    const releaseView = vi.fn();
    const profile = { runtime, version: 4, viewDirectory, releaseView };
    let launched: { file: string; args: string[]; environment: Record<string, string> } | undefined;
    class FakeEngine extends EventEmitter {
      pid = 789; exitCode: number | null = null; signalCode = null;
      stdout = new EventEmitter(); stderr = new EventEmitter();
    }
    class FakeScope {
      directory = `${common.directory}/engine-${id}`;
      prepare() { prepared = true; }
    }
    class FakeCommon {
      async retire() { prepared = false; return { ...common, populated: 0, pruned: true }; }
    }
    type Launch = { scope: FakeScope; source: Record<string, string>;
      prepare(...args: unknown[]): typeof profile;
      spawnProcess(file: string, args: string[], options: { env: Record<string, string> }): FakeEngine };
    const launcher = {
      prepareCloudEngineView: () => profile,
      async launchCloudEngine(options: Launch) {
        options.scope.prepare();
        const placement = `${options.scope.directory}@29:401`;
        const view = options.prepare(runtime, options.source, "serve", { common }, placement, {});
        try {
          const args = cloudEngineViewArguments("serve", view.version, runtime, view.viewDirectory, undefined, undefined, placement);
          options.spawnProcess(runtime.engineNamespace, ["--await-launch", ...args], { env: cloudEngineViewEnvironment(options.source, "serve", runtime) });
          await Promise.resolve();
          if (!engine) throw new Error("Fake engine missing");
          engine.exitCode = 0; engine.emit("exit", 0, null); engine.emit("close", 0, null);
          return 0;
        } finally { view.releaseView(); }
      },
    };
    const modules = new Map<string, unknown>([
      [pathToFileURL(runtime.helpers.launcher).href, launcher],
      [pathToFileURL(`${runtime.libRoot}/cloud-engine-cgroup.mjs`).href, { CloudEngineCgroup: FakeScope, CloudRuntimeCgroup: FakeCommon }],
      [pathToFileURL(`${runtime.libRoot}/prepare-cloud-image-files.mjs`).href, { CLOUD_ENGINE_MUTABLE_LAYOUT: runtimeContract.FIXTURE_MUTABLE_LAYOUT }],
    ]);
    const fakeProcess = { exitCode: undefined as number | undefined, stdin: new EventEmitter(),
      stdout: { write: (line: string) => { messages.push(JSON.parse(line)); } },
      kill: () => { throw new Error("Unexpected fake signal"); } };
    const context = {
      ...runtimeContract, Buffer, pathToFileURL, HarnessFailure,
      require: (name: string) => { if (!modules.has(name)) throw new Error("Unexpected fake import"); return modules.get(name); },
      process: fakeProcess,
      readInstalledHarnessRuntime: async () => ({ runtime, active, activeRecordSha256: "d".repeat(64) }),
      assertInstalledHarnessRuntimeCurrent: vi.fn(),
      observedInstalledRootIdentity: () => ({ pid: 700, marker: "explicit fake outside-root observation" }),
      observedInstalledCgroupIdentity: () => common,
      randomUUID: () => id,
      lstatSync: (name: string) => {
        if (name === runtimeContract.FIXTURE_MUTABLE_LAYOUT.stagingParent)
          return { isDirectory: () => true, isSymbolicLink: () => false, uid: 0, gid: 10003, mode: 0o40710 };
        if (name === common.directory && prepared) return { isDirectory: () => true };
        throw Object.assign(new Error("Explicit fake absent file"), { code: "ENOENT" });
      },
      mkdirSync: vi.fn(), chownSync: vi.fn(), rmSync: vi.fn(),
      chmodSync: (file: string, mode: number) => {
        if (failure === "mode") throw new Error("private fake publication diagnostic");
        modes.set(file, mode);
      },
      readRootHarnessFile: () => publicCa,
      writeFileSync: (file: string, content: Buffer, options: { mode?: number; flag?: string }) => {
        writes.push({ file, ...options });
        if (failure === "write") throw new Error("private fake publication diagnostic");
        files.set(file, Buffer.from(content));
        // Root umask077 is a portable permission model, not a host mutation.
        modes.set(file, (options.mode ?? 0o666) & ~0o077);
      },
      spawn: (file: string, args: string[], options: { env: Record<string, string> }) => {
        launched = { file, args, environment: options.env }; engine = new FakeEngine(); return engine;
      },
      createInterface: () => Object.assign(new EventEmitter(), { close(this: EventEmitter) { this.emit("close"); } }),
      cloudPreflightDiagnostic: () => null, zsrAdmissionDiagnostic: () => null,
    };
    const invoke = runInNewContext(`${javascript}\nrunInstalledFixture;`, context, { timeout: 1000 }) as (config: unknown) => Promise<void>;
    await invoke({ mode: "installed", handover: { schema: "zeros.installed-agent-e2e/v1", sandboxId: "fake-only", active },
      ca: "/root/explicit-fake-ca.pem", source: { ZEROS_CLOUD_RUNTIME_B64: Buffer.from(JSON.stringify({ engine: { instanceId: id } })).toString("base64url"),
        ZEROS_ACCOUNT_JWT_PUBLIC_KEY: "explicit fake public verification key" } });
    type Mount = { kind: string; source: string | null; target: string };
    const mounts = launched?.args.flatMap<Mount>((argument, index) => argument === "--bind" || argument === "--ro-bind"
      ? [{ kind: argument, source: launched!.args[index + 1]!, target: launched!.args[index + 2]! }]
      : argument === "--tmpfs" ? [{ kind: argument, source: null, target: launched!.args[index + 1]! }] : []) ?? [];
    const mountFor = (filename: string) => mounts.filter(mount => filename === mount.target || filename.startsWith(`${mount.target}/`)).at(-1);
    const resolve = (filename: string) => {
      const selected = mountFor(filename);
      if (!selected?.source) return undefined;
      const physical = path.join(selected.source, path.relative(selected.target, filename)), mode = modes.get(physical);
      // Published files are root-owned; unmapped root requires other-read.
      return mode === undefined || mode & 0o004 ? files.get(physical) : undefined;
    };
    return { launched, files, modes, writes, messages, mountFor, resolve, releaseView, fakeProcess, viewDirectory };
  }

  it("projects only the public CA readonly through the actual installed entry and production view", async () => {
    const observed = await observeEntry(), ca = observed.launched!.environment.NODE_EXTRA_CA_CERTS;
    expect(observed.fakeProcess.exitCode).toBe(0);
    expect(observed.resolve(ca)).toEqual(publicCa);
    expect(ca).toBe("/etc/zeros/fixture-ca.pem");
    expect(observed.mountFor(ca)?.kind).toBe("--ro-bind");
    expect(observed.writes).toEqual([{ file: `${observed.viewDirectory}/etc/fixture-ca.pem`, mode: 0o444, flag: "wx" }]);
    expect(observed.modes.get(`${observed.viewDirectory}/etc/fixture-ca.pem`)).toBe(0o444);
    expect(observed.launched!.environment.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    expect(observed.messages.some(message => message.type === "retired")).toBe(true);
    expect(observed.releaseView).toHaveBeenCalledOnce();
  });
  it("retains the visible checkout projection control", async () => {
    const observed = await observeEntry();
    observed.files.set("/srv/zeros/files/workspace/tool-input.txt", Buffer.from("fixture input"));
    expect(observed.resolve("/srv/zeros/workspace/tool-input.txt")).toEqual(Buffer.from("fixture input"));
  });
  it("retains both staging masks instead of exposing their backing files", async () => {
    const observed = await observeEntry();
    for (const name of [".zeros-setup", ".zeros-engine-setup"]) {
      const physical = `/srv/zeros/files/${name}/fixture-ca.pem`, logical = `/srv/zeros/${name}/fixture-ca.pem`;
      observed.files.set(physical, publicCa);
      expect(observed.resolve(physical)).toBeUndefined(); expect(observed.resolve(logical)).toBeUndefined();
      expect(observed.mountFor(logical)?.kind).toBe("--tmpfs");
      expect(observed.launched!.args.join("\0")).toContain(["--chmod", "0000", `/srv/zeros/${name}`, "--remount-ro", `/srv/zeros/${name}`].join("\0"));
    }
  });
  it.each(["write", "mode"] as const)("releases the original view after CA %s failure before target exec", async (failure) => {
    const observed = await observeEntry(failure);
    expect(observed.fakeProcess.exitCode).toBe(1); expect(observed.launched).toBeUndefined();
    expect(observed.releaseView).toHaveBeenCalledOnce();
    expect(observed.files.size).toBe(failure === "write" ? 0 : 1);
    expect(observed.messages.some(message => message.type === "failure" && message.code === "namespace_launch_failed")).toBe(true);
    expect(JSON.stringify(observed.messages)).not.toContain("private fake publication diagnostic");
  });
});
