import { describe, expect, it } from "vitest";
import { ClosedDiagnosticSchema } from "../../packages/protocol/src/cloud-runtime-bundle";
import { parseLifecycleConfig, runRuntimeLifecycle } from "../cloud-workspace-validation/runtime-bundle/lifecycle.mjs";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const transitionId = "33333333-3333-4333-8333-333333333333";
const privateValue = "private.fixture.account.access.value";
const nextRuntimeId = `r1-${"b".repeat(64)}`;
const dotenv = [
  "ZEROS_B8_ALPHA_ORIGIN=https://alpha.example.test",
  `ZEROS_B8_ALPHA_ACCESS_TOKEN=${privateValue}`,
  `ZEROS_B8_ALPHA_ORGANIZATION_ID=${organizationId}`,
  `ZEROS_B8_ALPHA_GITHUB_INSTALLATION_ID=${organizationId}`,
  "ZEROS_B8_ALPHA_REPOSITORY_OWNER=fixture",
  "ZEROS_B8_ALPHA_REPOSITORY_NAME=zeros-v2-test-repository",
  `ZEROS_B8_ALPHA_NEXT_RUNTIME_ID=${nextRuntimeId}`,
  "ZEROS_B8_ALPHA_QUALIFICATION_MODE=smoke",
].join("\n");

function fixture(options: { channel?: string; corruptWake?: boolean; rejectUpgrade?: boolean; lostCreateReplies?: number; pendingCleanup?: boolean } = {}) {
  const pin = { runtimeId: `r1-${"a".repeat(64)}`, manifestSha256: "a".repeat(64), baseImageId: "zeros-v2-test-base",
    baseCompatibilityId: `bc1-${"c".repeat(64)}`, profile: "zeros-cloud-worker-v4", engineProtocolVersion: 20 };
  let current = { number: 1, runtime: pin }, state = "ready", receipt: Record<string, unknown> | undefined;
  let creates = 0, deletes = 0, clock = 0;
  const requests: { path: string; method: string; key: string | undefined; body?: Record<string, unknown> }[] = [];
  const reportSnapshots: unknown[] = [];
  const json = (body: unknown, status = 200, replay = false) => new Response(JSON.stringify(body), {
    status, headers: replay ? { "Idempotency-Replayed": "true" } : {},
  });
  const workspace = () => ({ id: workspaceId, status: state, generation: current });
  const fetchImpl = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname, method = init.method!;
    const headers = init.headers as Record<string, string>;
    expect(init.redirect).toBe("error");
    expect(headers.authorization).toBe(`Bearer ${privateValue}`);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, key: headers["idempotency-key"], body });
    if (path === "/v1/release-identity") return json({ channel: options.channel ?? "alpha", ready: true, runtimeV4: { newWorkspaceProfile: "v4" } });
    if (path === "/v1/internal/cloud-runtime/status") return json({ channel: "alpha",
      runtimes: [{ runtimeId: nextRuntimeId, revokedAt: null, engineProtocolVersion: 20 }],
      channelReleases: [{ runtimeId: nextRuntimeId, confirmedAt: "2026-10-04T00:00:00Z", revokedAt: null }],
      qualifications: ["claude-setup-token", "codex-chatgpt", "cursor-api-key"].map(credentialKind => ({ credentialKind,
        runtimeId: nextRuntimeId, baseCompatibilityId: pin.baseCompatibilityId, profile: pin.profile,
        enabled: true, revokedAt: null, evidenceMode: "smoke" })) });
    if (path.endsWith("/pending-deletion")) return json({ truncated: false, pendingDeletion: options.pendingCleanup ? [{ workspaceId }] : [] });
    if (method === "DELETE") { deletes++; state = "deleted"; return json({ workspace: workspace() }, 202); }
    if (path.endsWith("/cloud-workspaces") && method === "POST") {
      creates++;
      expect(body.name).toMatch(/^zeros-v2-test-/);
      if (creates <= (options.lostCreateReplies ?? 0)) throw new Error(privateValue);
      return json({ workspace: workspace() }, creates > 1 ? 200 : 202);
    }
    if (method === "GET") return json({ workspace: workspace() });
    if (path.endsWith("/stop")) { state = "stopped"; return json({}, 202); }
    if (path.endsWith("/wake")) {
      state = "ready";
      if (options.corruptWake) current = { number: 1, runtime: { ...pin, runtimeId: nextRuntimeId, manifestSha256: "b".repeat(64) } };
      return json({}, 202);
    }
    if (path.endsWith("/runtime-upgrade")) {
      if (options.rejectUpgrade) return json({ error: { message: privateValue } }, 500);
      if (receipt?.operationId === body.operationId) return json(receipt, 200, true);
      if (body.expectedGeneration !== current.number) return json({ error: { code: "cloud_generation_changed" } }, 409);
      receipt = { operationId: body.operationId, sourceGeneration: 1, generation: 2, runtimeId: nextRuntimeId, transitionId, unchanged: false };
      current = { number: 2, runtime: { ...pin, runtimeId: nextRuntimeId, manifestSha256: "b".repeat(64) } };
      return json(receipt, 202);
    }
    throw new Error("Unexpected fixture request");
  };
  return { requests, run: () => runRuntimeLifecycle({ ...parseLifecycleConfig(dotenv), timeoutMs: 10_000 }, {
    fetchImpl, now: () => clock, pause: async (ms: number) => { clock += ms; },
    reportProgress: async (value: unknown) => { reportSnapshots.push(structuredClone(value)); },
  }), deletes: () => deletes, reportSnapshots };
}

describe("Alpha runtime lifecycle runbook", () => {
  it("uses ordinary workspace APIs, compares all pins, upgrades once, replays and deletes", async () => {
    const test = fixture(), result = await test.run();
    expect(ClosedDiagnosticSchema.parse(result.diagnostic).ok).toBe(true);
    expect(result).toMatchObject({ workspaceId, transitionId, sourceGeneration: 1, upgradedGeneration: 2, providerCleanupConfirmed: true });
    expect(result.checks).toContain("wake_pins");
    expect(result.checks).toContain("upgrade_replay");
    expect(result.checks).toContain("generation_cas");
    expect(test.deletes()).toBe(1);
    expect(test.requests.filter(value => value.method === "DELETE")[0]!.body).toEqual({ discardUncheckpointed: true });
    expect(JSON.stringify([result, ...test.reportSnapshots])).not.toMatch(/private\.fixture|Bearer|https:|r1-|bc1-/);
    expect(test.requests.every(value => !/revoke|publish|deploy/.test(value.path))).toBe(true);
  });
  it("refuses a non-Alpha deployment before creating or deleting anything", async () => {
    const test = fixture({ channel: "beta" }), result = await test.run();
    expect(result.diagnostic.failedChecks).toEqual(["alpha_v4_guard"]);
    expect(test.requests.every(value => value.method === "GET")).toBe(true);
    expect(test.deletes()).toBe(0);
  });
  it.each([{ corruptWake: true, check: "wake_pins" }, { rejectUpgrade: true, check: "http_status" }])(
    "cleans its workspace after $check fails without reflecting secret response text", async ({ check, ...options }) => {
      const test = fixture(options), result = await test.run();
      expect(result.diagnostic.failedChecks).toEqual([check]);
      expect(result.providerCleanupConfirmed).toBe(true);
      expect(test.deletes()).toBe(1);
      expect(JSON.stringify(result)).not.toContain(privateValue);
    });
  it("recovers an accepted workspace after lost create replies using the same idempotency key", async () => {
    const test = fixture({ lostCreateReplies: 3 }), result = await test.run();
    const creates = test.requests.filter(value => value.path.endsWith("/cloud-workspaces") && value.method === "POST");
    expect(creates).toHaveLength(4);
    expect(new Set(creates.map(value => value.key)).size).toBe(1);
    expect(result.diagnostic.failedChecks).toEqual(["request_failed"]);
    expect(result.providerCleanupConfirmed).toBe(true);
    expect(test.deletes()).toBe(1);
    expect(test.reportSnapshots[0]).toMatchObject({ workspaceId: null, operations: { create: creates[0]!.key } });
    expect(JSON.stringify(result)).not.toContain(privateValue);
  });
  it("does not claim cleanup while the provider still has pending generations", async () => {
    const test = fixture({ pendingCleanup: true }), result = await test.run();
    expect(result.providerCleanupConfirmed).toBe(false);
    expect(result.diagnostic.ok).toBe(false);
    expect(result.diagnostic.failedChecks).toEqual(["cleanup_unconfirmed"]);
  });
  it("rejects malformed private configuration with a fixed diagnostic", () => {
    for (const text of [dotenv.replace("https:", "http:"), `${dotenv}\nnot_an_assignment`, `${dotenv}\nZEROS_B8_ALPHA_ORIGIN=${privateValue}`]) {
      expect(() => parseLifecycleConfig(text)).toThrow("configuration");
    }
  });
});
