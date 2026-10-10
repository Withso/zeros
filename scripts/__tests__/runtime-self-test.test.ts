import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { RUNTIME_SELF_TEST_CHECKS, selfTestDiagnostic, parseSelfTestDiagnostic, supervisorIsIdle,
  verifySelfTestIdentity, versionMatches, containmentSmokePassed, runSelfTestChecks } from "../cloud-workspace-validation/sandbox/runtime-self-test.mjs";
import { RUNTIME_SMOKE_CHECKS } from "../../apps/control-plane/src/cloud-workspaces/cloud-builder-commands";
import * as selfTest from "../cloud-workspace-validation/sandbox/runtime-self-test.mjs";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const fixture = () => {
  const manifest = Buffer.from(JSON.stringify({ schema: "zeros.runtime-manifest/v1", entrypoints: { selfTest: "lib/zeros/runtime-self-test.mjs" } }));
  const runtimeId = `r1-${hash(manifest)}`, baseCompatibilityId = `bc1-${"b".repeat(64)}`;
  const receipt = Buffer.from(JSON.stringify({ schema: "zeros.runtime-install-receipt/v1", runtimeId, manifestSha256: hash(manifest), baseCompatibilityId }));
  const root = `/opt/zeros-infra/${runtimeId}`;
  return { manifest, receipt, runtime: { profile: "v4", root, node: `${root}/bin/node`, runtimeId, baseCompatibilityId,
    manifestSha256: hash(manifest), installerReceiptSha256: hash(receipt), bootId: "11111111-1111-4111-8111-111111111111" } };
};
describe("credential-free installed runtime self-test", () => {
  it("requires all four IDs to be the non-root engine before loading Cursor", () => {
    const methods = ["getuid", "geteuid", "getgid", "getegid"] as const;
    const spies = methods.map(name => vi.spyOn(process, name).mockReturnValue(10003));
    try {
      expect(() => selfTest.probeCursorPlatformPayload("/unadmitted-runtime")).toThrow(/Cannot find module|ENOENT/);
      for (let index = 0; index < spies.length; index++) {
        spies[index].mockReturnValue(0);
        expect(() => selfTest.probeCursorPlatformPayload("/unadmitted-runtime")).toThrow(/non-root engine identity/);
        spies[index].mockReturnValue(10003);
      }
    } finally { spies.forEach(spy => spy.mockRestore()); }
  });
  it("executes provider and owned-process checks without producing sandbox qualification", () => {
    expect(RUNTIME_SELF_TEST_CHECKS).toContain("engine_lifecycle");
    expect(RUNTIME_SELF_TEST_CHECKS).not.toContain("containment_smoke");
    const value = selfTestDiagnostic(Object.fromEntries(RUNTIME_SELF_TEST_CHECKS.map(name => [name, true])));
    expect(value).toMatchObject({ ok: true, failedChecks: [] });
    // An archived v1 failure remains readable, never emitted by the new checks.
    expect(parseSelfTestDiagnostic(JSON.stringify({ ...value, ok: false, exitCode: 1,
      failedChecks: ["containment_smoke"] }), 1)).toMatchObject({ failedChecks: ["containment_smoke"] });
  });
  it("requires the shared non-root engine and sandboxed Chromium identities with positive retirement", () => {
    const lifecycle = (selfTest as unknown as { engineLifecyclePassed: (value: string) => boolean }).engineLifecyclePassed;
    const value = { version: 2, boundary: "workspace-vm", qualified: true, identity: { qualified:true, hostUid: 10003, namespaceUid: 10003, noNewPrivs:1,seccompMode:2,capabilities:{effective:0,permitted:0,inheritable:0,bounding:0,ambient:0} },
      execution: { sameEngineIdentity: true, noSandbox: true, ownedProcessGroups: true, originalProcessGroupsRetired: true, timeoutRetired: true, workloadCgroup: true, vmWorkloadDrain: true },
      capture: { sameEngineIdentity: true, chromiumSandbox: true },
      humanServices: { sameEngineIdentity: true, noSandbox: true },
      actorTools: { sameEngineIdentity: true, noSandbox: true } };
    expect(lifecycle(JSON.stringify(value))).toBe(true);
    expect(lifecycle(JSON.stringify({...value,qualified:false}))).toBe(false);
    expect(lifecycle(JSON.stringify({...value,engineChecksPassed:true}))).toBe(false);
    const { originalProcessGroupsRetired: _group, workloadCgroup: _custody, vmWorkloadDrain: _drain, ...oldExecution } = value.execution;
    expect(lifecycle(JSON.stringify({...value,execution:{...oldExecution,detachedDescendantsRetired:true}}))).toBe(false);
    expect(lifecycle(JSON.stringify({...value,identity:{...value.identity,qualified:false}}))).toBe(false);
    for (const name of Object.keys(value.identity.capabilities))
      expect(lifecycle(JSON.stringify({...value,identity:{...value.identity,capabilities:{...value.identity.capabilities,[name]:1}}}))).toBe(false);
    expect(lifecycle(JSON.stringify({...value,identity:{...value.identity,namespaceUid:0}}))).toBe(false);
    for (const name of Object.keys(value.execution))
      expect(lifecycle(JSON.stringify({ ...value, execution: { ...value.execution, [name]: false } }))).toBe(false);
    expect(lifecycle(JSON.stringify({ ...value, identity: { hostUid: 10001, namespaceUid: 0 } }))).toBe(false);
    for (const section of ["capture", "humanServices", "actorTools"] as const) {
      for (const name of Object.keys(value[section]))
        expect(lifecycle(JSON.stringify({ ...value, [section]: { ...value[section], [name]: false } }))).toBe(false);
    }
    expect(lifecycle(JSON.stringify({ version: 1, secure: true }))).toBe(false);
  });
  it("keeps the worker's successful check inventory identical to the executed checks", () => {
    expect(RUNTIME_SELF_TEST_CHECKS).toEqual(RUNTIME_SMOKE_CHECKS);
    expect(selfTestDiagnostic(Object.fromEntries(RUNTIME_SELF_TEST_CHECKS.map(name => [name, true])))).toEqual({
      schema: "zeros.diagnostic/v1", component: "qualification", stage: "self_test", ok: true, exitCode: 0, timedOut: false, failedChecks: [],
    });
  });
  it("runs every check, rejects missing or non-true results, and never retains exception text", async () => {
    const calls: string[] = [];
    const checks = Object.fromEntries(RUNTIME_SELF_TEST_CHECKS.map(name => [name, () => {
      calls.push(name); if (name === "sqlite_query") throw new Error("private-provider-value"); return name === "pty_load" ? "true" : true;
    }]));
    const value = await runSelfTestChecks(checks);
    expect(calls).toEqual(RUNTIME_SELF_TEST_CHECKS);
    expect(value.failedChecks).toEqual(["sqlite_query", "pty_load"]);
    expect(value.ok).toBe(false);
    expect(JSON.stringify(value)).not.toContain("private-provider-value");
    expect((await runSelfTestChecks({})).failedChecks).toEqual(RUNTIME_SELF_TEST_CHECKS);
  });
  it("pins executable, raw manifest and receipt identities without a facade or environment fallback", () => {
    const f = fixture();
    expect(verifySelfTestIdentity(f.runtime, f.manifest, f.receipt, f.runtime.node).schema).toBe("zeros.runtime-manifest/v1");
    for (const executable of ["/opt/zeros/current/bin/node", "/usr/bin/node", `${f.runtime.root}/../bin/node`])
      expect(() => verifySelfTestIdentity(f.runtime, f.manifest, f.receipt, executable)).toThrow();
    expect(() => verifySelfTestIdentity(f.runtime, Buffer.concat([f.manifest, Buffer.from("\n")]), f.receipt, f.runtime.node)).toThrow();
    expect(() => verifySelfTestIdentity(f.runtime, f.manifest, Buffer.concat([f.receipt, Buffer.from("\n")]), f.runtime.node)).toThrow();
    expect(() => verifySelfTestIdentity({ ...f.runtime, baseCompatibilityId: `bc1-${"c".repeat(64)}` }, f.manifest, f.receipt, f.runtime.node)).toThrow();
  });
  it("requires exact idle runtime/base/boot identity", () => {
    const { runtime } = fixture();
    const status = { schema: "zeros.base-status/v1", hostState: "idle", currentRuntimeId: runtime.runtimeId,
      baseCompatibilityId: runtime.baseCompatibilityId, bootId: runtime.bootId };
    expect(supervisorIsIdle(status, runtime)).toBe(true);
    for (const extra of [{ hostState: "waiting_for_runtime" }, { currentRuntimeId: null }, { bootId: "other" }, { note: "private" }])
      expect(supervisorIsIdle({ ...status, ...extra }, runtime)).toBe(false);
  });
  it("requires native provider versions and complete credential-free containment evidence", () => {
    expect(versionMatches("2.1.288 (Claude Code)\n", "2.1.288", "claude")).toBe(true);
    expect(versionMatches("codex-cli 0.160.0\n", "0.160.0", "codex")).toBe(true);
    expect(versionMatches("private 0.160.0", "0.160.0", "codex")).toBe(false);
    expect(versionMatches("2.1.288 (Claude Code) extra", "2.1.288", "claude")).toBe(false);
    const value = { version: 1, secure: true, identity: { secure: true }, workload: { secure: true },
      capture: { secure: true }, humanServices: { secure: true }, actorTools: { secure: true } };
    expect(containmentSmokePassed(JSON.stringify(value))).toBe(true);
    for (const name of ["identity", "workload", "capture", "humanServices", "actorTools"])
      expect(containmentSmokePassed(JSON.stringify({ ...value, [name]: { secure: false } }))).toBe(false);
    for (const output of [JSON.stringify({ secure: true }), JSON.stringify({ ...value, version: 4 }),
      `${JSON.stringify(value)}\nprivate-error`]) expect(containmentSmokePassed(output)).toBe(false);
  });
  it("ignores earlier output, validates the last diagnostic and rejects unexpected fields or checks", () => {
    const value = selfTestDiagnostic({});
    expect(parseSelfTestDiagnostic(`private-output\n${JSON.stringify(value)}\n`, 1)).toEqual(value);
    expect(parseSelfTestDiagnostic(JSON.stringify({ ...value, failedChecks: ["private_message"] }), 1)).toBeNull();
    expect(parseSelfTestDiagnostic(JSON.stringify({ ...value, note: "private" }), 1)).toBeNull();
    expect(parseSelfTestDiagnostic(JSON.stringify(value), 0)).toBeNull();
    expect(parseSelfTestDiagnostic("x".repeat(65537), 1)).toBeNull();
  });
  it("fails outside an installed v4 runtime with one closed line and no raw stderr", () => {
    const child = spawnSync(process.execPath, ["scripts/cloud-workspace-validation/sandbox/runtime-self-test.mjs"], {
      encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 5000,
    });
    expect(child.status).toBe(1); expect(child.stderr).toBe("");
    expect(child.stdout.trim().split("\n")).toHaveLength(1);
    expect(parseSelfTestDiagnostic(child.stdout, 1)).toMatchObject({ ok: false, failedChecks: RUNTIME_SELF_TEST_CHECKS });
  });
});
