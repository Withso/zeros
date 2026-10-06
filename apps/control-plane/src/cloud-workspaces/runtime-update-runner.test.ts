import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRuntimeUpdateConversation, runtimeUpdateCommand } from "./runtime-update-runner.js";

const source = {
  schema: "zeros.active-runtime/v1" as const, runtimeId: `r1-${"a".repeat(64)}`, manifestSha256: "a".repeat(64),
  root: `/opt/zeros-infra/r1-${"a".repeat(64)}`, baseCompatibilityId: `bc1-${"b".repeat(64)}`,
  installerReceiptSha256: "c".repeat(64), bootId: "12345678-1234-4234-8234-123456789abc",
  supervisorSessionId: "22345678-1234-4234-8234-123456789abc", cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service",
};
const target = { runtimeId: `r1-${"d".repeat(64)}`, manifestSha256: "d".repeat(64), archiveSha256: "e".repeat(64),
  archiveBytes: 100, expandedBytes: 200, sourceCommit: "f".repeat(40), nodeModulesAbi: 127,
  bootstrapProtocolVersion: 1 as const, engineProtocolVersion: 20 };
const active = { ...source, runtimeId: target.runtimeId, root: `/opt/zeros-infra/${target.runtimeId}`,
  manifestSha256: target.manifestSha256, supervisorSessionId: "32345678-1234-4234-8234-123456789abc" };
const now = Date.parse("2026-10-06T00:00:00Z");
const request = { schema: "zeros.runtime-update/v1" as const, operation: "activate" as const,
  transitionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", fence: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  scope: { workspaceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", organizationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    sourceGeneration: 1, candidateGeneration: 2, sourceEngineInstanceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
  mode: "engine" as const, source, target, expiresAt: "2026-10-06T00:10:00Z" };
const scope = { schema: request.schema, transitionId: request.transitionId, fence: request.fence, scope: request.scope };
const report = { version: 1, profile: "zeros-cloud-worker-v4", qualified: true, runtime: {
  runtimeId: active.runtimeId, manifestSha256: active.manifestSha256, baseCompatibilityId: active.baseCompatibilityId,
  installerReceiptSha256: active.installerReceiptSha256, bootId: active.bootId,
  supervisorSessionId: active.supervisorSessionId,
} };
const frame = (phase: string, fields = {}) => JSON.stringify({ ...scope, phase, ...fields });
function fixture() {
  const handlers = { authorize: vi.fn(async () => true), authorizeRollback: vi.fn(async () => true),
    enroll: vi.fn(async () => ({ privateFixture: "memory-only-canary" })), health: vi.fn(async () => true) };
  return { handlers, dialog: createRuntimeUpdateConversation(request, handlers, () => now) };
}

describe("runtime update root channel", () => {
  it("authorizes only after the VM's verified ready frame and never places grants in the command", async () => {
    const { dialog, handlers } = fixture();
    expect(handlers.authorize).not.toHaveBeenCalled();
    const answer = JSON.parse((await dialog.onFrame(frame("authorize", { controller: source })))!);
    expect(answer).toEqual({ ...scope, phase: "authorize", allow: true });
    expect(handlers.authorize).toHaveBeenCalledOnce();
    const command = runtimeUpdateCommand();
    expect(command).toMatch(/^\/usr\/bin\/python3 -I -c /);
    expect(command).not.toContain(request.transitionId);
    expect(command).not.toContain("memory-only-canary");
    expect(command).not.toContain("\n");
    // sshd limits an authorized_keys line to 8 KiB. Leave room for the
    // restriction, expiry, public key and timeout wrapper around this loader.
    expect(Buffer.byteLength(command)).toBeLessThan(4096);
  });

  it("requires exact enrollment, then authenticated health, before successful completion", async () => {
    const { dialog } = fixture();
    await dialog.onFrame(frame("authorize", { controller: source }));
    const reply = await dialog.onFrame(frame("enroll", { active, controller: source, report }));
    expect(JSON.parse(reply!)).toMatchObject({ allow: true, environment: { privateFixture: "memory-only-canary" } });
    await dialog.onFrame(frame("health", { active }));
    await dialog.onFrame(JSON.stringify({ ...scope, operation: "activate", outcome: "healthy", active }));
    expect(dialog.result()).toMatchObject({ outcome: "healthy", active });
    expect(JSON.stringify(dialog.result())).not.toContain("memory-only-canary");
  });

  it("executes only the digest-pinned adapter bytes and leaves its request on stdin", () => {
    const source = readFileSync(new URL("./runtime-update-adapter.py", import.meta.url));
    const run = (input: Buffer) => spawnSync("/bin/sh", ["-c", runtimeUpdateCommand()], {
      input, encoding: "utf8", timeout: 10_000, maxBuffer: 4096,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    // An invalid request reaches the adapter's closed diagnostics without
    // calling the installer, even on a root test host with a real base.
    expect(run(Buffer.concat([source, Buffer.from("{}\n")]))).toMatchObject({
      status: 1, stdout: '{"schema":"zeros.runtime-update/v1","outcome":"failed"}\n', stderr: "",
    });
    const changed = Buffer.alloc(source.length, " ");
    changed.write("raise SystemExit(42)\n");
    for (const rejected of [changed, source.subarray(0, source.length - 1)])
      expect(run(rejected)).toMatchObject({ status: 1, stdout: "", stderr: "" });
  });

  it("rejects out-of-order, replayed, foreign, oversized and unexpected-field frames without calling handlers", async () => {
    for (const invalid of [frame("health", { active }), frame("authorize", { controller: source, fence: "foreign" }),
      frame("authorize", { controller: source, command: "arbitrary" }), "x".repeat(128 * 1024 + 1)]) {
      const { dialog, handlers } = fixture();
      await expect(dialog.onFrame(invalid)).rejects.toThrow("Runtime update response is invalid");
      expect(handlers.authorize).not.toHaveBeenCalled();
      expect(handlers.health).not.toHaveBeenCalled();
    }
    const { dialog } = fixture();
    await dialog.onFrame(frame("authorize", { controller: source }));
    await expect(dialog.onFrame(frame("authorize", { controller: source }))).rejects.toThrow();
  });

  it("rejects a runtime, boot or base mismatch before issuing an enrollment", async () => {
    for (const change of [{ runtimeId: source.runtimeId, manifestSha256: source.manifestSha256, root: source.root },
      { baseCompatibilityId: `bc1-${"e".repeat(64)}` },
      { bootId: "42345678-1234-4234-8234-123456789abc" }]) {
      const { dialog, handlers } = fixture();
      await dialog.onFrame(frame("authorize", { controller: source }));
      await expect(dialog.onFrame(frame("enroll", { active: { ...active, ...change }, controller: source, report }))).rejects.toThrow();
      expect(handlers.enroll).not.toHaveBeenCalled();
    }
  });

  it("requires a new rollback decision and a fresh source session on health failure", async () => {
    const { dialog, handlers } = fixture();
    handlers.health.mockResolvedValueOnce(false);
    await dialog.onFrame(frame("authorize", { controller: source }));
    await dialog.onFrame(frame("enroll", { active, controller: source, report }));
    await dialog.onFrame(frame("health", { active }));
    await dialog.onFrame(frame("authorize_rollback"));
    const restored = { ...source, supervisorSessionId: "52345678-1234-4234-8234-123456789abc" };
    await dialog.onFrame(frame("rollback_enroll", { active: restored, controller: source, report: {
      ...report, runtime: { ...report.runtime, runtimeId: source.runtimeId, manifestSha256: source.manifestSha256,
        supervisorSessionId: restored.supervisorSessionId },
    } }));
    await dialog.onFrame(frame("rollback_health", { active: restored }));
    await dialog.onFrame(JSON.stringify({ ...scope, operation: "activate", outcome: "rolled_back", active: restored }));
    expect(dialog.result()).toMatchObject({ outcome: "rolled_back" });
    expect(handlers.enroll.mock.calls).toHaveLength(2);
  });

  it("does not accept completion without a final receipt, or an expired activation", async () => {
    const { dialog } = fixture();
    expect(() => dialog.result()).toThrow("Runtime update response is invalid");
    expect(() => createRuntimeUpdateConversation(request, fixture().handlers, () => now + 900_000)).toThrow();
    await expect(dialog.onFrame(JSON.stringify({ ...scope, operation: "activate", outcome: "healthy", active }))).rejects.toThrow();
  });

  it("closes admission on callback failure and never checks health after a denied enrollment", async () => {
    const { dialog, handlers } = fixture();
    handlers.enroll.mockImplementation(async () => { throw new Error("private-canary"); });
    await dialog.onFrame(frame("authorize", { controller: source }));
    expect(await dialog.onFrame(frame("enroll", { active, controller: source, report }))).not.toContain("private-canary");
    await expect(dialog.onFrame(frame("health", { active }))).rejects.toThrow();
    expect(handlers.health).not.toHaveBeenCalled();
  });
});
