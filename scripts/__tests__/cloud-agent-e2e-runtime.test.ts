import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { copyRuntimeFixture, initializeFixtureCheckout, snapshotSystemExecutable } from "../cloud-workspace-validation/cloud-agent-e2e/projection";
import { execFileSync } from "node:child_process";
import { assertPrivateNamespace, assertPrivateRoot, fixtureFacade, fixtureOuterArguments, fixtureDescriptor, fixtureCredentialEnv, fixtureMountPlan, hostActiveFileOptions } from "../cloud-workspace-validation/cloud-agent-e2e/runtime-contract";
import { parseCloudActiveRuntime } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { CloudTransport } from "../../apps/desktop/src/engine/transport/cloud";
import { fixtureTransportToken } from "../cloud-workspace-validation/cloud-agent-e2e/runtime-contract";
import { readOriginUrl, repoSlugFromOriginUrl } from "../../apps/desktop/src/engine/git/repo";
import * as runtimeContract from "../cloud-workspace-validation/cloud-agent-e2e/runtime-contract";
import { diagnoseHarnessFailure, HarnessFailure } from "../cloud-workspace-validation/cloud-agent-e2e/assertions";

describe("private SOURCE-MODE runtime contract", () => {
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
    expect(fixture.uidMap).toEqual([[0, 10003, 1], [10001, 10001, 2], [10004, 10004, 1]]);
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
