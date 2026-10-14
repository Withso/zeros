import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, mkdir, readFile, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { initializeActionsFixture, runActions } from "../zeros-dev/hourly-main";
import { ZerosDevError } from "../zeros-dev/errors";
import { RunStore, type RunHandle } from "../zeros-dev/receipts";
import { exportHourlyArtifact } from "../zeros-dev/hourly-artifact";
import { ProductApi } from "../zeros-dev/product";
import { AlphaTransport } from "../zeros-dev/transport";
import { parseFixture } from "../zeros-dev/config";
import { computerBuild } from "../../apps/desktop/src/renderer/features/settings/__tests__/cloud-computer-v2-fixtures";

const roots: string[] = [];
const stdout: string[] = [];
beforeEach(() => {
  stdout.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation(chunk => { stdout.push(String(chunk)); return true; });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no live calls in Actions tests"); }));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const maskLine = (value: string) => `::add-mask::${value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}\n`;
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zd-actions-")); roots.push(root); await mkdir(path.join(root, ".git"));
  const accountId = randomUUID(), credential = { ...createCloudReplicaDeviceCredential(accountId), deviceId: randomUUID() };
  const values = { ZEROS_DEV_PASSWORD: "synthetic-password-value", ZEROS_DEV_WORKOS_SUBJECT: "user_fixture", ZEROS_DEV_ACCOUNT_ID: accountId,
    ZEROS_DEV_EMAIL: "fixture@example.test", ZEROS_DEV_ORGANIZATION_ID: randomUUID(), ZEROS_DEV_REPOSITORY: "fixture/repository", ZEROS_DEV_REPOSITORY_ID: "123",
    ZEROS_DEV_GITHUB_INSTALLATION_ID: randomUUID(), ZEROS_DEV_DEVICE_PRIVATE_KEY_B64: Buffer.from(JSON.stringify(credential)).toString("base64") };
  const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "Withso/zeros", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "17", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF: "Withso/zeros/.github/workflows/zeros-dev-e2e.yml@refs/heads/main", GITHUB_SHA: "a".repeat(40), ZEROS_DEV_FIXTURE_B64: Buffer.from(JSON.stringify(values)).toString("base64") };
  return { root, env, values, credential };
}
describe("ephemeral Actions fixture credentials", () => {
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

async function actionsFixture() {
  const f = await fixture(), temp = path.join(f.root, "temporary"); await mkdir(temp, { mode: 0o700 });
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
    assertFixtureEmpty: vi.fn(async () => {}), ensureRepository: vi.fn(async () => {}),
    computerState: vi.fn(async () => ({ active: computerBuild() })), verifyComputerRuntime: vi.fn(async () => "confirmed"),
    createWorkspace: vi.fn(async (handle: RunHandle) => {
      handle.run.create = { key: randomUUID(), body: { name: `zd-${handle.run.runId}`, repository: { forge: "github.com", owner: "fixture", name: "repository", revision: "main", githubInstallationId: f.values.ZEROS_DEV_GITHUB_INSTALLATION_ID } } };
      await handle.save();
      expect((await checkpoint()).payload.runs.find((row: any) => row.runId === handle.run.runId).create).toEqual(handle.run.create);
      handle.run.create.result = { id: randomUUID(), createdBy: f.values.ZEROS_DEV_ACCOUNT_ID, createdAt: new Date().toISOString(), generation: 1 };
      await handle.save();
    }),
    waitWorkspace: vi.fn(async () => {}), lifecycle: vi.fn(async () => {}),
    cleanup: vi.fn(async (handle: RunHandle, _apply: boolean, signal: AbortSignal) => {
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
  it.each(["runtime", "setup"] as const)("keeps the first %s observation in the public result and signed artifact after logout fails", async kind => {
    const f = await actionsFixture();
    const runtime = { phase: "admission" as const, class: "admission_unavailable" as const, status: 500 };
    const setup = { attempt: 5, claimCount: 2, state: "queued" as const, errorCode: "setup_provider_bootstrap_cleanup_unconfirmed" as const };
    const code = kind === "runtime" ? "runtime_unavailable" : "deadline";
    const diagnostic = kind === "runtime" ? { runtime } : { setup };
    f.services.connect.mockRejectedValue(new ZerosDevError(code, undefined, undefined, kind === "setup" ? setup : undefined, kind === "runtime" ? runtime : undefined));
    f.services.session.logout.mockRejectedValue(new Error("synthetic-private-logout"));
    expect(await runActions(f.env, f.options as never)).toBe(1);
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "runtime_connect", code, ...diagnostic }));
    expect(f.output).toContainEqual(expect.objectContaining({ schema: "zeros.dev-hourly-result/v1", success: false, code, ...diagnostic }));
    const artifact = await f.checkpoint();
    expect(artifact.payload.result).toMatchObject({ success: false, code, ...diagnostic });
    expect(artifact.payload.runs[0].evidence).toContainEqual(expect.objectContaining({ phase: "runtime_connect", code, ...diagnostic }));
    expect(JSON.stringify([artifact, ...f.output])).not.toContain("synthetic-private");
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
});
