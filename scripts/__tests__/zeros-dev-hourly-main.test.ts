import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, mkdir, readFile, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { initializeActionsFixture, runActions } from "../zeros-dev/hourly-main";
import { ZerosDevError } from "../zeros-dev/errors";
import { RunStore, type Run, type RunHandle } from "../zeros-dev/receipts";
import { exportHourlyArtifact } from "../zeros-dev/hourly-artifact";
import { exportCleanupHandoff } from "../zeros-dev/cleanup-handoff";
import { retireFixtureCompute } from "./zeros-dev-cleanup-fixture";
import { ProductApi } from "../zeros-dev/product";
import { AlphaTransport } from "../zeros-dev/transport";
import { parseFixture } from "../zeros-dev/config";
import { computerBuild } from "../../apps/desktop/src/renderer/features/settings/__tests__/cloud-computer-v2-fixtures";
import { PRESTART_RECOVERY } from "../zeros-dev/prestart-recovery.mjs";
import { CHAIN_RESTART } from "../zeros-dev/chain-restart.mjs";

// The real retired receipt is not a test fixture. Pin synthetic bytes by digest
// so the restart path is exercised end to end; every other pin stays real.
const retiredReceipt = vi.hoisted(() => `{"synthetic":"retired chain receipt"}\n`);
vi.mock("../zeros-dev/chain-restart.mjs", async importOriginal => {
  const { createHash } = await import("node:crypto"), original = await importOriginal<typeof import("../zeros-dev/chain-restart.mjs")>();
  return { ...original, CHAIN_RESTART: Object.freeze({ ...original.CHAIN_RESTART, receiptSha256: createHash("sha256").update(retiredReceipt).digest("hex") }) };
});

const roots: string[] = [];
const stdout: string[] = [];
beforeEach(() => {
  stdout.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation(chunk => { stdout.push(String(chunk)); return true; });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no live calls in Actions tests"); }));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const maskLine = (value: string) => `::add-mask::${value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}\n`;
async function fixture(deviceId: string = randomUUID()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zd-actions-")); roots.push(root); await mkdir(path.join(root, ".git"), { mode: 0o700 });
  const accountId = randomUUID(), credential = { ...createCloudReplicaDeviceCredential(accountId), deviceId };
  const values = { ZEROS_DEV_PASSWORD: "synthetic-password-value", ZEROS_DEV_WORKOS_SUBJECT: "user_fixture", ZEROS_DEV_ACCOUNT_ID: accountId,
    ZEROS_DEV_EMAIL: "fixture@example.test", ZEROS_DEV_ORGANIZATION_ID: randomUUID(), ZEROS_DEV_REPOSITORY: "fixture/repository", ZEROS_DEV_REPOSITORY_ID: "123",
    ZEROS_DEV_GITHUB_INSTALLATION_ID: randomUUID(), ZEROS_DEV_DEVICE_PRIVATE_KEY_B64: Buffer.from(JSON.stringify(credential)).toString("base64") };
  const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "Withso/zeros", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "17", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF: "Withso/zeros/.github/workflows/zeros-dev-e2e.yml@refs/heads/main", GITHUB_SHA: "a".repeat(40), ZEROS_DEV_FIXTURE_B64: Buffer.from(JSON.stringify(values)).toString("base64") };
  return { root, env, values, credential };
}
describe("ephemeral Actions fixture credentials", () => {
  it.each([0o002, 0o022, 0o077])("initializes a safe checkout under umask %i", async umask => {
    const previous = process.umask(umask);
    try {
      const f = await fixture();
      const store = await initializeActionsFixture(f.root, f.env);
      expect((await store.read()).values).toEqual(f.values);
    } finally { process.umask(previous); }
  });
  it("masks decoded fixture and device secrets plus nested auth tokens directly on stdout", async () => {
    const f = await fixture(), tokens = { access_token: randomUUID(), refresh_token: randomUUID(), id_token: randomUUID() };
    const codex = JSON.stringify({ tokens });
    await initializeActionsFixture(f.root, { ...f.env, AGENT_RUNTIME_CODEX_AUTH_JSON: codex });
    const required = [f.values.ZEROS_DEV_PASSWORD, f.values.ZEROS_DEV_DEVICE_PRIVATE_KEY_B64, JSON.stringify(f.credential), f.credential.privateKey,
      codex, ...Object.values(tokens)];
    // Boolean assertions keep test credentials out of failure diagnostics too.
    expect(required.every(value => stdout.includes(maskLine(value)))).toBe(true);
    expect(stdout.every(line => line.startsWith("::add-mask::") && line.endsWith("\n") && line.split("\n").length === 2)).toBe(true);
  });
  it("masks the cleanup handoff secret before fixture validation without emitting it as evidence", async () => {
    const f = await fixture(), handoff = Buffer.from(`synthetic-cleanup-${randomUUID()}`).toString("base64");
    await initializeActionsFixture(f.root, { ...f.env, ZEROS_DEV_CLEANUP_HANDOFF_B64: handoff });
    expect(stdout.includes(maskLine(handoff))).toBe(true);
    expect(stdout.filter(line => !line.startsWith("::add-mask::")).some(line => line.includes(handoff))).toBe(false);
  });
  it("masks even rejected decoded tokens before fixture validation and escapes workflow commands", async () => {
    const f = await fixture(), token = `synthetic-${randomUUID()}%\r\n::error::not-a-command`;
    const values = { ...f.values, ZEROS_DEV_ACCESS_TOKEN: token };
    await expect(initializeActionsFixture(f.root, { ...f.env, ZEROS_DEV_FIXTURE_B64: Buffer.from(JSON.stringify(values)).toString("base64") }))
      .rejects.toThrow("zeros_dev_credentials_invalid");
    expect([f.values.ZEROS_DEV_PASSWORD, f.credential.privateKey, token].every(value => stdout.includes(maskLine(value)))).toBe(true);
    expect(stdout.every(line => line.split("\n").length === 2 && !line.includes("\r"))).toBe(true);
    await expect(readFile(path.join(f.root, ".env.agent"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not emit secret mask commands outside the trusted Actions context", async () => {
    const f = await fixture();
    await expect(initializeActionsFixture(f.root, { ...f.env, GITHUB_ACTIONS: "false" })).rejects.toThrow("zeros_dev_actions_required");
    expect(stdout).toHaveLength(0);
  });
  it("creates exactly one canonical 0600 file with fixture secrets and no provider keys", async () => {
    const f = await fixture(); const store = await initializeActionsFixture(f.root, f.env);
    expect((await store.read()).values).toEqual(f.values);
    const input = await open(path.join(f.root, ".env.agent"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      expect((await input.stat()).mode & 0o777).toBe(0o600);
      expect(await input.readFile("utf8")).not.toContain("AGENT_RUNTIME");
    } finally { await input.close(); }
  });
  it("never overwrites an existing credential store or writes on a non-main invocation", async () => {
    const f = await fixture(); const file = path.join(f.root, ".env.agent"); await writeFile(file, "owned", { mode: 0o600 });
    await expect(initializeActionsFixture(f.root, f.env)).rejects.toThrow("zeros_dev_credentials_unsafe");
    expect(await readFile(file, "utf8")).toBe("owned");
    await expect(initializeActionsFixture(f.root, { ...f.env, GITHUB_REF: "refs/heads/repair" })).rejects.toThrow("zeros_dev_actions_required");
  });
  it("refuses foreign keys, session material, newlines and a device from another account", async () => {
    for (const change of [{ AGENT_RUNTIME_OPENAI_API_KEY: "synthetic-value" }, { ZEROS_DEV_ACCESS_TOKEN: "synthetic-value" },
      { ZEROS_DEV_PASSWORD: "synthetic\nINJECT=oops" }, { ZEROS_DEV_DEVICE_PRIVATE_KEY_B64: Buffer.from(JSON.stringify(createCloudReplicaDeviceCredential(randomUUID()))).toString("base64") }]) {
      const f = await fixture();
      await expect(initializeActionsFixture(f.root, { ...f.env, ZEROS_DEV_FIXTURE_B64: Buffer.from(JSON.stringify({ ...f.values, ...change })).toString("base64") })).rejects.toThrow("zeros_dev_credentials_invalid");
    }
  });
});

async function actionsFixture(deviceId?: string) {
  const f = await fixture(deviceId), temp = path.join(f.root, "temporary"); await mkdir(temp, { mode: 0o700 });
  const execution = { workflowRunId: "17", attempt: 1, sourceSha: "a".repeat(40) };
  const env = { ...f.env, GITHUB_WORKSPACE: f.root, RUNNER_TEMP: temp, ZEROS_DEV_E2E_START_MS: String(Date.now()),
    ZEROS_DEV_E2E_PLAN: JSON.stringify({ execution, bootstrap: true, previous: null, artifactId: null }) };
  const artifact = path.join(temp, "zeros-dev-output", "receipt.json"), output: unknown[] = [];
  const checkpoint = async () => JSON.parse(await readFile(artifact, "utf8"));
  const session = { login: vi.fn(async () => { expect((await checkpoint()).payload.result).toMatchObject({ success: false, code: "command_uncertain" }); }),
    whoami: vi.fn(async () => {}), logout: vi.fn(async () => {}) };
  const credentials = { install: vi.fn(async (handle: RunHandle) => {
    handle.run.hourly!.credentials.push({ agent: "claude", id: randomUUID(), operationId: randomUUID(), kind: "claude-api-key", selectionRevision: 0,
      published: false, selected: false, disconnected: false, revoked: false });
    await handle.save();
    // The same save awaited before credential publication must checkpoint the
    // intent outside the runner-local store, even if the process is killed next.
    expect((await checkpoint()).payload.runs.find((row: any) => row.runId === handle.run.runId).hourly.credentials).toHaveLength(1);
  }), cleanup: vi.fn(async (handle: RunHandle, signal: AbortSignal) => {
    expect(signal.aborted).toBe(false);
    for (const row of handle.run.hourly!.credentials) { row.disconnected = true; row.revoked = true; }
    await handle.save();
  }) };
  const api = {
    assertFixtureEmpty: vi.fn(async (_signal?: AbortSignal, _predecessors: readonly Run[] = []) => {}), ensureRepository: vi.fn(async () => {}),
    computerState: vi.fn(async () => ({ active: computerBuild() })), verifyComputerRuntime: vi.fn(async () => "confirmed"),
    readComputerRuntime: vi.fn(async () => ({ buildId: computerBuild().id, version: computerBuild().version,
      runtimeId: `r1-${"a".repeat(64)}`, baseImageId: "fixture-base", selected: {
        runtimeId: `r1-${"a".repeat(64)}`, baseImageId: "fixture-base", sourceCommit: "b".repeat(40), qualificationMode: "smoke" as const,
      } })),
    buildComputer: vi.fn(async (_handle: RunHandle) => { throw new ZerosDevError("computer_failed"); }),
    waitComputer: vi.fn(async () => { throw new ZerosDevError("computer_failed"); }),
    createWorkspace: vi.fn(async (handle: RunHandle) => {
      handle.run.create = { key: randomUUID(), body: { name: `zd-${handle.run.runId}`, repository: { forge: "github.com", owner: "fixture", name: "repository", revision: "main", githubInstallationId: f.values.ZEROS_DEV_GITHUB_INSTALLATION_ID } } };
      await handle.save();
      expect((await checkpoint()).payload.runs.find((row: any) => row.runId === handle.run.runId).create).toEqual(handle.run.create);
      handle.run.create.result = { id: randomUUID(), createdBy: f.values.ZEROS_DEV_ACCOUNT_ID, createdAt: new Date().toISOString(), generation: 1 };
      await handle.save();
    }),
    waitWorkspace: vi.fn(async () => {}), lifecycle: vi.fn(async () => {}),
    cleanup: vi.fn(async (handle: RunHandle, _apply: boolean, signal: AbortSignal, _options?: { allowStoragePending?: boolean }) => {
      expect(signal.aborted).toBe(false); handle.run.deletionConfirmed = true; await handle.save(); return { planned: 1, confirmed: 1 };
    }),
  };
  const services = { session, api, credentials,
    health: vi.fn(async () => ({ ready: true, cloud: { enabled: true }, sourceSha: "a".repeat(40) })),
    connect: vi.fn(async () => { throw new ZerosDevError("runtime_unavailable"); }),
  };
  const options = { factory: () => services, write: (row: unknown) => { output.push(row); } };
  return { ...f, env, services, options, checkpoint, output };
}

describe("Actions orchestration through signed files", () => {
  it.each(["storage pending", "physically deleted", "compute unconfirmed"])(
    "reports cleanup debt separately from a working lifecycle: %s", async cleanupState => {
      const f = await actionsFixture();
      const runtime = {
        terminal: vi.fn(async () => ({ exitCode: 0, truncated: false, output: "" })),
        prompt: vi.fn(async (handle: RunHandle, input: { id: string; agent: "claude" | "codex" | "cursor"; model: string }) => {
          const prompt = { id: input.id, agent: input.agent, model: input.model, conversationId: randomUUID(), sha256: "c".repeat(64), state: "succeeded" as const };
          handle.run.prompts.push(prompt); return prompt;
        }),
        tail: vi.fn(async () => [{ msgId: "fixture", kind: "text", payload: JSON.stringify({ role: "assistant", text: "ZEROS_DEV_OK" }), createdAt: 1 }]),
        dispose: vi.fn(async () => {}),
      };
      f.services.connect.mockResolvedValue(runtime as never);
      if (cleanupState !== "physically deleted") f.services.api.cleanup.mockImplementation(async handle => {
        if (cleanupState === "storage pending") retireFixtureCompute(handle, new Date().toISOString());
        await handle.save(); return { planned: 1, confirmed: 0 };
      });
      const success = cleanupState !== "compute unconfirmed";
      expect(await runActions(f.env, f.options as never)).toBe(success ? 0 : 1);
      const artifact = await f.checkpoint();
      expect(artifact.payload.result).toMatchObject({ success, code: success ? null : "cleanup_pending" });
      expect(artifact.payload.cleanup).toMatchObject({
        pendingWorkspaces: cleanupState === "storage pending" ? 1 : 0,
        deletionConfirmed: cleanupState === "physically deleted",
        unconfirmedWorkspaces: success ? 0 : 1,
      });
      const notices = stdout.filter(line => line.startsWith("::warning title=Zeros dev cleanup backlog::"));
      if (cleanupState === "storage pending") {
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain("1 workspace(s), 1 generation(s), 16384 MiB reserved");
        expect(notices[0]).toContain("8 workspace(s), 561800 MiB, 8 hours");
        expect(artifact.payload.runs[0].lifecycle.at(-1)).toMatchObject({ operation: "delete", confirmed: false });
      } else expect(notices).toHaveLength(0);
      expect(f.services.connect).toHaveBeenCalledTimes(2);
      expect(f.services.credentials.cleanup).toHaveBeenCalledOnce();
    },
  );

  it("keeps the first native predicate in the public result and artifact when logout also fails", async () => {
    const f = await actionsFixture();
    const env = { ...f.env, ZEROS_DEV_PROFILE: "infrastructure",
      ZEROS_DEV_E2E_PLAN: JSON.stringify({ ...JSON.parse(f.env.ZEROS_DEV_E2E_PLAN), profile: "infrastructure", prestartRecovery: PRESTART_RECOVERY }) };
    const nativeProof = { predicate: "pty_create_unavailable" as const };
    const failure = new ZerosDevError("detached_proof_incomplete", undefined, undefined, undefined, undefined, undefined, undefined, nativeProof);
    Object.assign(f.services.session, { prepareLaunchAuth: vi.fn() });
    f.services.session.logout.mockRejectedValue(new Error("synthetic-private-logout"));
    const infrastructure = async (options: any) => {
      await options.evidence.step("detached_native_proof", async () => { throw failure; });
    };
    expect(await runActions(env, { ...f.options, infrastructure } as never)).toBe(1);
    const artifact = await f.checkpoint();
    expect(artifact.payload.result).toMatchObject({ success: false, code: "detached_proof_incomplete", nativeProof });
    expect(artifact.payload.runs[0].evidence).toContainEqual(expect.objectContaining({ phase: "detached_native_proof", nativeProof }));
    expect(f.output).toContainEqual(expect.objectContaining({ schema: "zeros.dev-infrastructure-result/v1",
      success: false, code: "detached_proof_incomplete", nativeProof }));
    expect(f.services.session.logout).toHaveBeenCalledOnce();
    expect(JSON.stringify([artifact, ...f.output])).not.toContain("synthetic-private");
  });
  it("checkpoints infrastructure separately before any native work and never installs agent material", async () => {
    const f = await actionsFixture();
    const launchAuth = { observedAt: "2026-10-15T00:00:00.000Z", expiresAt: "2026-10-15T00:05:00.000Z", remainingMs: 300_000 };
    const prepareLaunchAuth = vi.fn(async () => launchAuth);
    const env = { ...f.env, ZEROS_DEV_PROFILE: "infrastructure",
      ZEROS_DEV_E2E_PLAN: JSON.stringify({ ...JSON.parse(f.env.ZEROS_DEV_E2E_PLAN), profile: "infrastructure", prestartRecovery: PRESTART_RECOVERY }) };
    const infrastructure = vi.fn(async (options: any) => {
      const artifact = await f.checkpoint();
      expect(artifact.payload.schema).toBe("zeros.dev-infrastructure/v1");
      expect(artifact.payload.prestartRecovery).toEqual(PRESTART_RECOVERY);
      expect(options.handle.run.hourly.infrastructure).toMatchObject({ complete: false,
        coverage: { agents: "not_covered_owner_section7" }, cycles: [], terminalChecks: 0 });
      expect(options.handle.run.hourly.complete).toBe(false);
      expect(await options.prepareLaunchAuth(120_000)).toEqual(launchAuth);
      await options.evidence.step("detached_start", async () => { throw new ZerosDevError("detached_task_not_active"); });
    });
    Object.assign(f.services.session, { prepareLaunchAuth, prepareDetachedAuth: vi.fn(async () => 3_600_000) });
    expect(await runActions(env, { ...f.options, infrastructure } as never)).toBe(1);
    expect(infrastructure).toHaveBeenCalledOnce();
    expect(prepareLaunchAuth).toHaveBeenCalledExactlyOnceWith(120_000);
    expect(f.services.credentials.install).not.toHaveBeenCalled(); expect(f.services.connect).not.toHaveBeenCalled();
    expect((await f.checkpoint()).payload).toMatchObject({ schema: "zeros.dev-infrastructure/v1",
      result: { success: false, code: "detached_task_not_active" }, coverage: { detachedAgent: "not_covered_owner_section7" } });
    expect(f.output).toContainEqual(expect.objectContaining({ schema: "zeros.dev-infrastructure-result/v1", success: false,
      code: "detached_task_not_active", coverage: expect.objectContaining({ agents: "not_covered_owner_section7" }) }));
  });
  it("checks and carries an explicit local cleanup handoff before allocation without taking over its credentials", async () => {
    const f = await actionsFixture(), pins = parseFixture(f.values), localId = randomUUID();
    const local = new RunStore(path.join(f.env.RUNNER_TEMP, "local-runs"), pins, f.credential);
    await local.withRun(localId, { revision: "b".repeat(40), dirty: true }, async handle => {
      handle.run.create = { key: randomUUID(), body: { name: `zd-${localId}`, repository: { forge: "github.com", owner: "fixture", name: "repository",
        revision: "main", githubInstallationId: pins.repository.installationId } },
      result: { id: randomUUID(), createdBy: pins.accountId, createdAt: new Date().toISOString(), generation: 1 } };
      retireFixtureCompute(handle).organizationId = pins.organizationId;
      handle.run.evidence.push({ phase: "terminal_run", outcome: "ok", durationMs: 7 }); await handle.save();
    });
    const file = path.join(f.env.RUNNER_TEMP, "handoff.b64");
    const exported = await exportCleanupHandoff({ file, runIds: [localId], store: local, credential: f.credential,
      api: { readRetirement: async run => run.retirement! }, signal: new AbortController().signal });
    const env = { ...f.env, ZEROS_DEV_CLEANUP_HANDOFF_B64: await readFile(file, "utf8") };
    const cleanup = f.services.api.cleanup.getMockImplementation()!, reference = { sha256: exported.sha256, runIds: [localId] };
    let recovered = false;
    f.services.api.cleanup.mockImplementation(async (handle, apply, signal, options) => {
      if (handle.run.runId !== localId) return cleanup(handle, apply, signal, options);
      expect(options).toEqual({ allowStoragePending: true });
      const checkpoint = await f.checkpoint();
      expect(checkpoint.payload.handoff).toEqual(reference);
      expect(checkpoint.payload.runs.find((run: Run) => run.runId === localId)).toMatchObject({ cleanupOnly: { handoffSha256: exported.sha256 }, evidence: [] });
      handle.run.retirement!.observedAt = new Date().toISOString();
      await handle.save(); recovered = true;
      return { planned: 0, confirmed: 0, storagePending: 1 };
    });
    f.services.api.assertFixtureEmpty.mockImplementation(async (_signal, predecessors) => {
      expect(recovered).toBe(true); expect(predecessors).toHaveLength(1);
      expect(predecessors![0]).toMatchObject({ runId: localId, cleanupOnly: { handoffSha256: exported.sha256 }, deletionConfirmed: false });
    });
    const create = f.services.api.createWorkspace.getMockImplementation()!;
    f.services.api.createWorkspace.mockImplementation(async handle => { expect(recovered).toBe(true); await create(handle); });
    expect(await runActions(env, f.options as never)).toBe(1); // Deliberate first runtime failure remains visible.
    expect(f.services.api.assertFixtureEmpty).toHaveBeenCalledTimes(2);
    expect(f.services.credentials.cleanup).toHaveBeenCalledOnce();
    expect(f.services.credentials.cleanup.mock.calls[0]![0].run.runId).not.toBe(localId);
    const artifact = await f.checkpoint();
    expect(artifact.payload.handoff).toEqual(reference);
    expect(artifact.payload.result).toMatchObject({ success: false, code: "runtime_unavailable" });
    expect(artifact.payload.cleanup).toMatchObject({ pendingWorkspaces: 1, reservedStorageMiB: 16_384 });
    expect(artifact.payload.runs.find((run: Run) => run.runId === localId)).toMatchObject({ deletionConfirmed: false,
      retirement: { status: "compute_retired_storage_pending" }, cleanupOnly: { handoffSha256: exported.sha256 } });
    expect(f.output).toContainEqual(expect.objectContaining({ runId: localId, phase: "storage_pending", outcome: "pending" }));
    expect(f.output).toContainEqual(expect.objectContaining({ schema: "zeros.dev-hourly-result/v1", code: "runtime_unavailable",
      cleanup: expect.objectContaining({ pendingWorkspaces: 1 }) }));
    expect(stdout.filter(line => line.startsWith("::warning title=Zeros dev cleanup backlog::"))).toHaveLength(1);
  });

  it("refuses an unverified handoff before login or any product operation", async () => {
    const f = await actionsFixture();
    expect(await runActions({ ...f.env, ZEROS_DEV_CLEANUP_HANDOFF_B64: Buffer.from("{}").toString("base64") }, f.options as never)).toBe(1);
    expect(f.services.session.login).not.toHaveBeenCalled(); expect(f.services.api.cleanup).not.toHaveBeenCalled();
    expect(f.services.api.createWorkspace).not.toHaveBeenCalled();
    expect((await f.checkpoint()).payload.result).toMatchObject({ success: false, code: "artifact_invalid" });
  });

  it("selects the manual rehearsal with its original enlarged budget and signed incomplete proof", async () => {
    const f = await actionsFixture();
    const env = { ...f.env, GITHUB_EVENT_NAME: "workflow_dispatch", ZEROS_DEV_PROFILE: "gate0",
      ZEROS_DEV_E2E_START_MS: String(Date.now() - 1_000_000),
      ZEROS_DEV_E2E_PLAN: JSON.stringify({ ...JSON.parse(f.env.ZEROS_DEV_E2E_PLAN), profile: "gate0" }) };
    const rehearse = vi.fn(async (options: any) => {
      expect(options.budgetMs).toBeGreaterThan(6_000_000); expect(options.budgetMs).toBeLessThan(7_000_000);
      expect(options.handle.run.hourly.rehearsal).toMatchObject({ complete: false, models: [], cycles: [] });
      await options.evidence.step("detached_start", async () => { throw new ZerosDevError("detached_task_not_active"); });
    });
    Object.assign(f.services.session, { prepareDetachedAuth: vi.fn(async () => 3_600_000) });
    expect(await runActions(env, { ...f.options, rehearse } as never)).toBe(1);
    expect(rehearse).toHaveBeenCalledOnce(); expect(f.services.api.createWorkspace).not.toHaveBeenCalled();
    expect((await f.checkpoint()).payload).toMatchObject({ result: { success: false, code: "detached_task_not_active" },
      runs: [expect.objectContaining({ hourly: expect.objectContaining({ rehearsal: expect.objectContaining({ complete: false }) }) })] });
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "detached_start", outcome: "failed", code: "detached_task_not_active" }));
  });
  it.each(["scheduled", "mismatch"])("refuses a %s rehearsal before credentials or login", async kind => {
    const f = await actionsFixture();
    const env = { ...f.env, ZEROS_DEV_PROFILE: "gate0", GITHUB_EVENT_NAME: kind === "scheduled" ? "schedule" : "workflow_dispatch" };
    expect(await runActions(env, f.options as never)).toBe(1); expect(f.services.session.login).not.toHaveBeenCalled();
    await expect(readFile(path.join(f.root, ".env.agent"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(stdout).toHaveLength(0);
  });
  it.each(["runtime", "setup", "admission"] as const)("keeps the first %s observation in the public result and signed artifact after logout fails", async kind => {
    const f = await actionsFixture();
    const runtime = { phase: "admission" as const, class: "admission_unavailable" as const, status: 500 };
    const setup = { attempt: 5, claimCount: 2, state: "queued" as const, errorCode: "setup_provider_bootstrap_cleanup_unconfirmed" as const };
    const firstFailure = { status: 503 as const, code: "cloud_runtime_temporarily_unavailable" as const, phase: "provider_endpoint" as const, retryAfterMs: 1000 };
    const admission = { sequence: 1, firstFailure, retryCount: 1, retries: [{ ...firstFailure, attempt: 2 as const, delayMs: 1000 }] };
    const code = kind === "setup" ? "deadline" : "runtime_unavailable";
    const diagnostic = kind === "runtime" ? { runtime } : kind === "setup" ? { setup } : { admission };
    f.services.connect.mockRejectedValue(new ZerosDevError(code, undefined, undefined, kind === "setup" ? setup : undefined,
      kind === "runtime" ? runtime : undefined, kind === "admission" ? admission : undefined));
    f.services.session.logout.mockRejectedValue(new Error("synthetic-private-logout"));
    expect(await runActions(f.env, f.options as never)).toBe(1);
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "runtime_connect", code, ...diagnostic }));
    expect(f.output).toContainEqual(expect.objectContaining({ schema: "zeros.dev-hourly-result/v1", success: false, code, ...diagnostic }));
    const artifact = await f.checkpoint();
    expect(artifact.payload.result).toMatchObject({ success: false, code, ...diagnostic });
    expect(artifact.payload.runs[0].evidence).toContainEqual(expect.objectContaining({ phase: "runtime_connect", code, ...diagnostic }));
    expect(JSON.stringify([artifact, ...f.output])).not.toContain("synthetic-private");
  });

  it("keeps a one-build intent in the public signed receipt before a failed build observation", async () => {
    const f = await actionsFixture(), api = f.services.api;
    const proof = await api.readComputerRuntime();
    api.readComputerRuntime.mockResolvedValue({ ...proof, selected: { ...proof.selected, runtimeId: `r1-${"c".repeat(64)}` } });
    api.buildComputer.mockImplementation(async (handle: RunHandle) => {
      const build = computerBuild();
      handle.run.computer = { operationId: randomUUID(), expectedRevision: 1 }; await handle.save();
      expect((await f.checkpoint()).payload.runs.find((row: any) => row.runId === handle.run.runId).computer).toEqual(handle.run.computer);
      handle.run.computer.result = { id: build.id, version: build.version }; await handle.save();
      return build as never;
    });
    f.services.session.logout.mockRejectedValue(new ZerosDevError("service_unavailable"));
    expect(await runActions(f.env, f.options as never)).toBe(1);
    expect(api.buildComputer).toHaveBeenCalledOnce(); expect(api.waitComputer).toHaveBeenCalledOnce();
    expect(f.services.credentials.install).not.toHaveBeenCalled(); expect(api.createWorkspace).not.toHaveBeenCalled();
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "computer_build", code: "computer_failed" }));
    const artifact = await f.checkpoint();
    expect(artifact.payload.result).toMatchObject({ success: false, code: "computer_failed" });
    expect(artifact.payload.runs[0].computer.result).toMatchObject({ id: computerBuild().id });
  });

  it("uses the enlarged overall allowance after installation while retaining its original start", async () => {
    const f = await actionsFixture();
    f.env.ZEROS_DEV_E2E_START_MS = String(Date.now() - 600_000);
    expect(await runActions(f.env, f.options as never)).toBe(1);
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "runtime_connect", code: "runtime_unavailable" }));
    expect((await f.checkpoint()).payload.result.code).toBe("runtime_unavailable");
  });

  it("keeps mask commands and every secret out of public evidence and the signed receipt", async () => {
    const f = await actionsFixture(), tokens = { access_token: randomUUID(), refresh_token: randomUUID(), id_token: randomUUID() };
    const env = { ...f.env, AGENT_RUNTIME_CODEX_AUTH_JSON: JSON.stringify({ tokens }), AGENT_RUNTIME_CURSOR_API_KEY: randomUUID() };
    const secrets = [f.env.ZEROS_DEV_FIXTURE_B64, f.values.ZEROS_DEV_PASSWORD, f.values.ZEROS_DEV_DEVICE_PRIVATE_KEY_B64,
      JSON.stringify(f.credential), f.credential.privateKey, env.AGENT_RUNTIME_CODEX_AUTH_JSON, env.AGENT_RUNTIME_CURSOR_API_KEY, ...Object.values(tokens)];
    f.services.connect.mockImplementation(async () => { throw new Error(secrets.join(" ")); });
    expect(await runActions(env, f.options as never)).toBe(1);
    const artifact = JSON.stringify(await f.checkpoint()), evidence = f.output.map(row => JSON.stringify(row));
    expect([artifact, ...evidence].every(line => !line.includes("::add-mask::") &&
      secrets.every(secret => !line.includes(secret) && !line.includes(JSON.stringify(secret).slice(1, -1))))).toBe(true);
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "runtime_connect", outcome: "failed", code: "internal" }));
    expect([f.values.ZEROS_DEV_PASSWORD, f.credential.privateKey, ...Object.values(tokens)].every(value => stdout.includes(maskLine(value)))).toBe(true);
  });
  it.each(["stopped", "setting_up"] as const)("recovers a signed failed wake in %s before considering a new allocation", async status => {
    const f = await actionsFixture(), pins = parseFixture(f.values), previousId = randomUUID(), id = randomUUID();
    const previous = { workflowRunId: "16", attempt: 1, sourceSha: "a".repeat(40) };
    const temporary = f.env.RUNNER_TEMP, incoming = path.join(temporary, "zeros-dev-previous"); await mkdir(incoming, { mode: 0o700 });
    const old = new RunStore(path.join(temporary, "previous-runs"), pins, f.credential);
    const createdAt = new Date().toISOString(), name = `zd-${previousId}`;
    await old.withRun(previousId, { revision: previous.sourceSha, dirty: false }, async h => {
      h.run.hourly = { version: 1, ...previous, credentials: [], histories: [], activeWindows: [], complete: false };
      h.run.create = { key: randomUUID(), body: { name, repository: { forge: "github.com", owner: "fixture", name: "repository", revision: "main", githubInstallationId: pins.repository.installationId } },
        result: { id, createdBy: pins.accountId, createdAt, generation: 1 } };
      h.run.lifecycle.push({ operation: "wake", key: randomUUID(), generation: 1, confirmed: false }); await h.save();
    });
    await exportHourlyArtifact(path.join(incoming, "receipt.json"), old, f.credential, previous, { runId: previousId, success: false, code: "workspace_failed" });
    const plan = JSON.parse(f.env.ZEROS_DEV_E2E_PLAN); f.env.ZEROS_DEV_E2E_PLAN = JSON.stringify({ ...plan, bootstrap: false, previous, artifactId: "99" });
    let row = { id, organizationId: pins.organizationId, teamId: randomUUID(), name, createdBy: pins.accountId, ownerUserId: pins.accountId,
      placement: "cloud", status: status as string, capabilities: { canWrite: true, canEdit: true, canManage: true, canStart: true, startUnavailableReason: null },
      repository: { forge: "github.com", owner: "fixture", name: "repository", revision: "a".repeat(40) },
      generation: { number: 1, architecture: "linux/amd64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 16384 },
        observedState: status === "stopped" ? "stopped" : "running", lastObservedAt: null },
      version: 1, error: null, createdAt, updatedAt: createdAt, deletedAt: null as string | null };
    const fetcher = vi.fn<typeof fetch>(async (url, input) => {
      if (String(url).endsWith("/pending-deletion")) return Response.json({ truncated: false, pendingDeletion: [] });
      expect(new URL(String(url)).pathname).toBe(input?.method === "DELETE" ? `/v1/organizations/${pins.organizationId}/cloud-workspaces/${id}` : `/v1/cloud-workspaces/${id}`);
      if (input?.method === "DELETE") row = { ...row, status: "deleted", deletedAt: createdAt, generation: { ...row.generation, observedState: "deleted" } };
      return Response.json({ workspace: row });
    });
    const product = new ProductApi({ whoami: async () => pins, fixture: async () => pins, accessToken: async () => "synthetic-bearer" },
      new AlphaTransport(fetcher), { sleep: async () => {}, now: () => 0 });
    const cleanup = f.services.api.cleanup.getMockImplementation()!;
    f.services.api.cleanup.mockImplementation((handle, apply, signal) => handle.run.runId === previousId ? product.cleanup(handle, apply, signal) : cleanup(handle, apply, signal));
    const create = f.services.api.createWorkspace.getMockImplementation()!;
    f.services.api.createWorkspace.mockImplementation(async handle => {
      expect(row.status).toBe("deleted");
      expect(fetcher.mock.calls.filter(([, input]) => input?.method === "DELETE")).toHaveLength(1);
      await create(handle);
    });
    expect(await runActions(f.env, f.options as never)).toBe(1); // The synthetic new runtime is deliberately unavailable.
    const restored = new RunStore(path.join(f.root, ".context", "zeros-dev"), pins, f.credential), saved = await restored.read(previousId);
    if (status === "stopped") {
      expect(f.output).toContainEqual(expect.objectContaining({ phase: "prior_cleanup", outcome: "ok" }));
      expect(f.services.api.createWorkspace).toHaveBeenCalledOnce();
      expect(saved).toMatchObject({ deletionConfirmed: true, lifecycle: [
        { operation: "wake", confirmed: false, settled: { status: "stopped", generation: 1 } }, { operation: "delete", confirmed: true },
      ] });
      expect(f.output).toContainEqual(expect.objectContaining({ phase: "prior_cleanup", outcome: "ok" }));
    } else {
      expect(f.services.api.createWorkspace).not.toHaveBeenCalled(); expect(f.services.credentials.install).not.toHaveBeenCalled();
      expect(fetcher.mock.calls.every(([, input]) => input?.method === "GET")).toBe(true);
      expect(saved.lifecycle).toHaveLength(1); expect(saved.deletionConfirmed).toBe(false);
      expect((await f.checkpoint()).payload.result).toMatchObject({ code: "cleanup_pending" });
      expect(f.output).toContainEqual(expect.objectContaining({ phase: "prior_cleanup", code: "cleanup_pending" }));
    }
  });

  it("checkpoints each intent before side effects and preserves the primary failed stage", async () => {
    const f = await actionsFixture();
    expect(await runActions(f.env, f.options as never)).toBe(1);
    expect(f.services.credentials.install).toHaveBeenCalledOnce(); expect(f.services.api.createWorkspace).toHaveBeenCalledOnce();
    expect(f.services.api.cleanup).toHaveBeenCalledOnce(); expect(f.services.credentials.cleanup).toHaveBeenCalledOnce();
    expect(f.services.session.logout).toHaveBeenCalledOnce();
    const artifact = await f.checkpoint();
    expect(artifact.payload.result).toMatchObject({ success: false, code: "runtime_unavailable" });
    expect(artifact.payload.runs[0]).toMatchObject({ deletionConfirmed: true, hourly: { complete: false } });
    expect(artifact.payload.runs[0].hourly.credentials[0]).toMatchObject({ revoked: true, disconnected: true });
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "runtime_connect", outcome: "failed", code: "runtime_unavailable" }));
  });

  it("an external interruption stops work but still checkpoints deletion and revocation", async () => {
    const f = await actionsFixture(), controller = new AbortController(), create = f.services.api.createWorkspace.getMockImplementation()!;
    f.services.api.createWorkspace.mockImplementation(async h => { await create(h); controller.abort(); });
    expect(await runActions(f.env, { ...f.options, signal: controller.signal } as never)).toBe(1);
    expect(f.services.api.createWorkspace).toHaveBeenCalledOnce(); expect(f.services.connect).not.toHaveBeenCalled();
    expect(f.services.api.cleanup).toHaveBeenCalledOnce(); expect(f.services.credentials.cleanup).toHaveBeenCalledOnce();
    expect((await f.checkpoint()).payload.result).toMatchObject({ success: false, code: "deadline" });
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "workspace_create", code: "deadline" }));
  });

  async function restartFixture(options: { deviceId?: string; receipt?: string | null } = {}) {
    const f = await actionsFixture(options.deviceId), incoming = path.join(f.env.RUNNER_TEMP, "zeros-dev-previous");
    await mkdir(incoming, { mode: 0o700 });
    if (options.receipt !== null) await writeFile(path.join(incoming, "receipt.json"), options.receipt ?? retiredReceipt, { mode: 0o600 });
    f.env.ZEROS_DEV_E2E_PLAN = JSON.stringify({ ...JSON.parse(f.env.ZEROS_DEV_E2E_PLAN), chainRestart: CHAIN_RESTART });
    return f;
  }
  it("starts a new signed chain from the exact retired receipt without importing it or skipping prior cleanup", async () => {
    const f = await restartFixture();
    f.services.api.assertFixtureEmpty.mockImplementation(async (_signal, predecessors) => {
      expect(predecessors).toEqual([]);
      const checkpoint = await f.checkpoint();
      expect(checkpoint.payload).toMatchObject({ deviceId: f.credential.deviceId, chainRestart: CHAIN_RESTART });
      expect(checkpoint.payload.runs.map((run: Run) => run.hourly?.workflowRunId)).toEqual(["17"]);
    });
    expect(await runActions(f.env, f.options as never)).toBe(1); // The synthetic new runtime is deliberately unavailable.
    expect(f.services.session.login).toHaveBeenCalledOnce(); expect(f.services.api.assertFixtureEmpty).toHaveBeenCalled();
    const artifact = await f.checkpoint();
    expect(artifact.payload).toMatchObject({ deviceId: f.credential.deviceId, chainRestart: CHAIN_RESTART,
      result: { success: false, code: "runtime_unavailable" } });
    expect(artifact.payload.runs).toHaveLength(1);
  });
  it("keeps a chain restart blocked while an old fixture workspace remains", async () => {
    const f = await restartFixture();
    f.services.api.assertFixtureEmpty.mockRejectedValue(new ZerosDevError("cleanup_pending"));
    expect(await runActions(f.env, f.options as never)).toBe(1);
    expect(f.services.api.createWorkspace).not.toHaveBeenCalled(); expect(f.services.credentials.install).not.toHaveBeenCalled();
    expect((await f.checkpoint()).payload).toMatchObject({ chainRestart: CHAIN_RESTART, result: { code: "cleanup_pending" } });
  });
  it.each([
    { label: "the retired device", deviceId: CHAIN_RESTART.retiredDeviceId, code: "chain_restart_device_retired" },
    { label: "changed retired receipt bytes", receipt: `${retiredReceipt} `, code: "chain_restart_mismatch" },
    { label: "a missing retired receipt", receipt: null, code: "artifact_invalid" },
    { label: "a restart that is not a bootstrap", plan: { bootstrap: false, previous: { workflowRunId: "16", attempt: 1, sourceSha: "a".repeat(40) }, artifactId: "99" },
      code: "artifact_invalid" },
  ])("refuses a chain restart with $label before login or any receipt", async ({ deviceId, receipt, plan, code }) => {
    const f = await restartFixture({ deviceId, receipt });
    if (plan) f.env.ZEROS_DEV_E2E_PLAN = JSON.stringify({ ...JSON.parse(f.env.ZEROS_DEV_E2E_PLAN), ...plan });
    expect(await runActions(f.env, f.options as never)).toBe(1);
    expect(f.services.session.login).not.toHaveBeenCalled(); expect(f.services.api.assertFixtureEmpty).not.toHaveBeenCalled();
    await expect(f.checkpoint()).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.output).toContainEqual(expect.objectContaining({ schema: "zeros.dev-hourly-result/v1", success: false, code }));
  });
});
