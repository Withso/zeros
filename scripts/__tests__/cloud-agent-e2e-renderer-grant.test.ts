import { describe, expect, it, vi } from "vitest";
import { createRendererGrant, type RendererGrantRequestOptions } from "../cloud-workspace-validation/cloud-agent-e2e/renderer-grant";

const actor = "11111111-1111-4111-8111-111111111111";
const workspace = "22222222-2222-4222-8222-222222222222";
const own = "33333333-3333-4333-8333-333333333333";
const foreign = "44444444-4444-4444-8444-444444444444";
const now = Date.parse("2026-10-08T13:00:00Z");
const compute = { fingerprint: "a".repeat(64), trust: "zeros-managed" };
const row = (changes = {}) => ({ id: own, ownerUserId: actor, kind: "codex-api-key", models: ["fixture-model"],
  expiresAt: "2026-10-08T13:01:00Z", ...changes });
function fixture(body: unknown = { compute, delegations: [row()] }, status = 200) {
  const requestJson = vi.fn(async (_url: URL, _options: RendererGrantRequestOptions) => ({ status, body }));
  const options = { baseUrl: "https://127.0.0.1:43210/", workspaceId: workspace, actorUserId: actor,
    bearerToken: "fixture-renderer-authority", ca: Buffer.from("fixture-ca"), now: () => now, requestJson };
  return { options, requestJson, grant: createRendererGrant(options) };
}

describe("actual baseline renderer prepare request", () => {
  it("performs the real prepare route with empty body and a fresh idempotency identity", async () => {
    const f = fixture();
    await expect(f.grant("codex", "fixture-model")).resolves.toBe(own);
    const [url, options] = f.requestJson.mock.calls[0];
    expect(url.toString()).toBe(`https://127.0.0.1:43210/v1/cloud-workspaces/${workspace}/agent-credentials/prepare`);
    expect(options.method).toBe("POST"); expect(options.body).toEqual({});
    expect(options.headers["content-type"]).toBe("application/json");
    expect(options.headers.authorization === `Bearer ${f.options.bearerToken}`).toBe(true);
    expect(options.headers["idempotency-key"]).toMatch(/^[a-f0-9-]{36}$/);
    await f.grant("codex", "fixture-model");
    expect(f.requestJson.mock.calls[1][1].headers["idempotency-key"]).not.toBe(options.headers["idempotency-key"]);
  });
  it("cannot silently substitute another actor's grant", async () => {
    const f = fixture({ delegations: [row({ id: foreign, ownerUserId: foreign })] });
    await expect(f.grant("codex", "fixture-model")).rejects.toThrow("cloud_agent_credential_required");
    expect(f.requestJson).toHaveBeenCalledOnce();
  });
  it("binds provider and exact model even for an allModels metadata flag", async () => {
    const f = fixture({ delegations: [row({ allModels: true, models: ["other-model"] })] });
    await expect(f.grant("codex", "fixture-model")).rejects.toThrow("cloud_agent_model_not_authorized");
    await expect(f.grant("claude", "fixture-model")).rejects.toThrow("cloud_agent_credential_required");
  });
  it("never uses an expired grant", async () => {
    const f = fixture({ delegations: [row({ expiresAt: new Date(now).toISOString() })] });
    await expect(f.grant("codex", "fixture-model")).rejects.toThrow("cloud_agent_credential_required");
  });
  it("prefers current qualified metadata while preserving the actual renderer selection", async () => {
    const f = fixture({ delegations: [row(), row({ id: foreign, runtimeQualified: true })] });
    await expect(f.grant("codex", "fixture-model")).resolves.toBe(foreign);
  });
  it("accepts the actual CP compute metadata and strict native capability shape", async () => {
    const f = fixture({ compute, delegations: [row({ nativeCapabilities: { version: 1, goals: false,
      nativeFork: false, transcriptFork: false, nativeReview: false, connectedApps: false, multiAgent: false } })] });
    await expect(f.grant("codex", "fixture-model")).resolves.toBe(own);
  });
  it("retains the typed upgrade refusal instead of inventing runtime qualification", async () => {
    const f = fixture({ delegations: [row({ runtimeQualified: false, runtimeUpgradeRequired: true })] });
    await expect(f.grant("codex", "fixture-model")).rejects.toThrow("cloud_runtime_upgrade_required");
  });
  it.each([
    { delegations: [row({ apiKey: "private-sentinel" })] },
    { delegations: [row()], material: "private-sentinel" },
    { delegations: [row({ nativeCapabilities: { version: 1, arbitrary: "private-sentinel" } })] },
    { compute: { ...compute, material: "private-sentinel" }, delegations: [row()] },
  ])("refuses any authority/material outside strict metadata without retaining it", async body => {
    const f = fixture(body);
    let error: unknown;
    try { await f.grant("codex", "fixture-model"); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("renderer_grant_invalid");
    expect(JSON.stringify(error)).not.toContain("private-sentinel");
  });
  it("preserves only a known typed prepare denial", async () => {
    const f = fixture({ error: { code: "cloud_agent_model_not_authorized", message: "private-sentinel" } }, 403);
    await expect(f.grant("codex", "fixture-model")).rejects.toThrow("cloud_agent_model_not_authorized");
    await expect(f.grant("codex", "fixture-model")).rejects.toMatchObject({ code: "cloud_agent_model_not_authorized" });
  });
  it("collapses unknown HTTP errors without exposing body text", async () => {
    const f = fixture({ error: { code: "private-sentinel", message: "private-sentinel" } }, 500);
    await expect(f.grant("codex", "fixture-model")).rejects.toThrow("renderer_prepare_denied");
  });
  it.each(["https://provider.example.test/", "https://127.0.0.1:43210/?token=private", "http://127.0.0.1:43210/", "https://127.0.0.1:43210/prefix"])
    ("refuses a nonprivate fixture origin before a request", baseUrl => {
      const f = fixture();
      expect(() => createRendererGrant({ ...f.options, baseUrl })).toThrow("renderer_grant_origin_invalid");
      expect(f.requestJson).not.toHaveBeenCalled();
    });
  it("does not request a grant for an already cancelled observation", async () => {
    const f = fixture(); const abort = new AbortController(); abort.abort();
    await expect(f.grant("codex", "fixture-model", abort.signal)).rejects.toThrow();
    expect(f.requestJson).not.toHaveBeenCalled();
  });
  it("keeps initiating fixture identity when caller options change during prepare", async () => {
    const f = fixture();
    let release!: (value: { status: number; body: unknown }) => void;
    const requestJson = vi.fn((_url: URL, _options: RendererGrantRequestOptions) =>
      new Promise<{ status: number; body: unknown }>(resolve => { release = resolve; }));
    const options = { ...f.options, requestJson };
    const prepared = createRendererGrant(options);
    const flight = prepared("codex", "fixture-model");
    options.actorUserId = foreign;
    options.workspaceId = foreign;
    options.bearerToken = "different-fixture-authority";
    release({ status: 200, body: { compute, delegations: [row()] } });
    await expect(flight).resolves.toBe(own);
    expect(requestJson.mock.calls[0][0].pathname).toContain(workspace);
    expect(requestJson.mock.calls[0][1].headers.authorization === "Bearer " + f.options.bearerToken).toBe(true);
  });
});
