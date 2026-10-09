import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  CloudAgentActorConfirmRequest, CloudAgentActorConfirmResponse,
  CloudAgentBootCredentialRequest, CloudAgentBootCredentialResponse,
  CloudAgentBootRefreshRequest, CloudAgentBootRefreshResponse,
  CloudAgentBootSyncRequest, CloudAgentWarmActorRequest, CloudAgentWarmActorResponse,
} from "@zeros/protocol/cloud-agent-bootstrap";
import { cloudMcpDigest } from "../agents/cloud-mcp";
import { requestCloudAgentBoot } from "../cloud-agent-execution-client";

const capabilities = { version: 1 as const, goals: false, nativeFork: false, transcriptFork: false,
  nativeReview: false, connectedApps: false, multiAgent: false };
function fixture() {
  const authority = { heartbeatEndpoint: "https://control.example.test/internal/v1/cloud-workspaces/engine/heartbeat",
    heartbeatToken: "synthetic-private-heartbeat-token", organizationId: randomUUID(), workspaceId: randomUUID(),
    generation: 7, engineInstanceId: randomUUID() };
  const reference = { organizationId: authority.organizationId, workspaceId: authority.workspaceId,
    generation: authority.generation, engineInstanceId: authority.engineInstanceId, bootId: randomUUID(), writerEpoch: randomUUID() };
  const scope = { ...reference, fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 2 };
  const identity = { ...scope, version: 1 as const, mode: "boot-owner-v1" as const,
    fundingScope: "workspace-roles-v1" as const, authorityEpoch: 3 };
  const bootstrap: CloudAgentBootCredentialRequest = { organizationId: authority.organizationId,
    workspaceId: authority.workspaceId, generation: authority.generation, engineInstanceId: authority.engineInstanceId,
    version: 1, mode: "boot-owner-v1" };
  const provider = { status: "ready" as const, provider: "claude" as const, credentialId: randomUUID(),
    credentialRevision: 2, connectionRevision: 3, adoptionId: randomUUID(), displayName: "Test account",
    kind: "claude-api-key" as const, models: ["qualified-model"], nativeCapabilities: capabilities,
    materialVersion: 1, expiresAt: null, refreshAfter: null, authorityExpiresAt: null,
    material: { kind: "claude-api-key" as const, apiKey: "synthetic-private-provider-key" } };
  const credentials: CloudAgentBootCredentialResponse = { ...identity, cacheRevision: 2, desiredCacheRevision: 2,
    initialAdoptions: [{ provider: "claude", status: "known", adoptionId: provider.adoptionId },
      { provider: "cursor", status: "missing" }, { provider: "codex", status: "unknown" }],
    providers: [provider, { status: "unavailable", provider: "cursor", code: "cloud_agent_credential_required" },
      { status: "unavailable", provider: "codex", code: "cloud_agent_credential_required" }] };
  const sync: CloudAgentBootSyncRequest = { ...reference, version: 1, mode: "boot-owner-v1", expectedCacheRevision: 2 };
  const codex = { ...provider, provider: "codex" as const, kind: "codex-chatgpt" as const, materialVersion: 2,
    expiresAt: "2026-10-09T00:00:00.000Z", refreshAfter: "2026-10-08T23:59:00.000Z",
    material: { kind: "codex-chatgpt" as const, accountId: "synthetic-account", accessToken: "synthetic-positive-access",
      expiresAt: Date.parse("2026-10-09T00:00:00.000Z") / 1000 } };
  const refresh: CloudAgentBootRefreshRequest = { ...sync, provider: "codex", credentialId: codex.credentialId,
    credentialRevision: codex.credentialRevision, expectedMaterialVersion: 1 };
  const refreshed: CloudAgentBootRefreshResponse = { ...identity, cacheRevision: 2, desiredCacheRevision: 2, provider: codex };
  const actorSessionId = randomUUID();
  const confirm: CloudAgentActorConfirmRequest = { ...reference, version: 1, mode: "boot-owner-v1", actorSessionId };
  const provenance = { scope, actorSessionId, authorityEpoch: 3, confirmedUntilMs: Date.now() + 10_000,
    fundingConsentVersion: 1 as const, fundingGrant: { kind: "owner" as const },
    actor: { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 2,
      role: "owner" as const, fingerprint: "a".repeat(64) } };
  const confirmed: CloudAgentActorConfirmResponse = { version: 1, mode: "boot-owner-v1", provenance };
  const warm: CloudAgentWarmActorRequest = { ...confirm, provider: "claude", model: "qualified-model",
    conversationId: "conversation", cwd: "/srv/zeros/workspace/nested", repositoryServers: [] };
  const history = { owner: "c".repeat(64), currentKeyVersion: 1, keys: { 1: "a".repeat(43) } };
  const context: CloudAgentWarmActorResponse = { ...identity, contextId: randomUUID(), contextRevision: "b".repeat(64),
    actor: provenance, provider: "claude", model: warm.model, conversationId: warm.conversationId, cwd: warm.cwd,
    gitAuthor: null, customization: null, environment: { version: 1, revision: "d".repeat(64), values: {}, history },
    nativeCapabilities: capabilities };
  const signal = new AbortController().signal;
  return { authority, reference, scope, bootstrap, credentials, sync, refresh, refreshed, confirm, confirmed, warm, context, signal };
}

describe("private negotiated boot client", () => {
  it("activates only the exact ready boot/writer through the separate private endpoint", async () => {
    const f = fixture(), { providers: _providers, initialAdoptions: _baseline, desiredCacheRevision: _desired, ...identity } = f.credentials;
    const result = { ...identity, activated: true }, requestFetch = vi.fn().mockResolvedValue(Response.json({ result }));
    await expect(requestCloudAgentBoot(f.authority, "activate", f.sync, f.signal, requestFetch)).resolves.toEqual(result);
    const [url, options] = requestFetch.mock.calls[0]!;
    expect(String(url)).toBe("https://control.example.test/internal/v2/cloud-workspaces/engine/agent-boot/activate");
    expect(JSON.parse(options.body)).toEqual(f.sync);
    for (const changed of [{ ...result, bootId: randomUUID() }, { ...result, writerEpoch: randomUUID() },
      { ...result, activated: false }, { ...result, cacheRevision: 1 }, { ...result, providers: f.credentials.providers }]) {
      requestFetch.mockResolvedValueOnce(Response.json({ result: changed }));
      await expect(requestCloudAgentBoot(f.authority, "activate", f.sync, f.signal, requestFetch))
        .rejects.toMatchObject({ code: "cloud_validation_authority_response_invalid" });
    }
  });
  it("uses the direct strict bootstrap body and fixed heartbeat-auth endpoint", async () => {
    const f = fixture(), requestFetch = vi.fn().mockResolvedValue(Response.json({ result: f.credentials }));
    await expect(requestCloudAgentBoot(f.authority, "bootstrap", f.bootstrap, f.signal, requestFetch)).resolves.toEqual(f.credentials);
    expect(requestFetch).toHaveBeenCalledOnce();
    const [url, options] = requestFetch.mock.calls[0]!;
    expect(String(url)).toBe("https://control.example.test/internal/v2/cloud-workspaces/engine/agent-boot/bootstrap");
    expect(options).toMatchObject({ method: "POST", redirect: "error", headers: {
      "content-type": "application/json", authorization: `Bearer ${f.authority.heartbeatToken}` } });
    expect(JSON.parse(options.body)).toEqual(f.bootstrap);
    expect(options.body).not.toContain(f.authority.heartbeatToken);
    expect(options.body).not.toContain(f.scope.fundingOwnerUserId);
  });

  it("keeps background sync, access refresh, actor confirmation and warm context separate", async () => {
    const f = fixture(), requestFetch = vi.fn();
    for (const [operation, request, result] of [
      ["sync", f.sync, f.credentials], ["refresh", f.refresh, f.refreshed],
      ["actor-confirm", f.confirm, f.confirmed], ["warm-context", f.warm, f.context],
    ] as const) {
      requestFetch.mockResolvedValueOnce(Response.json({ result }));
      await expect(requestCloudAgentBoot(f.authority, operation, request, f.signal, requestFetch)).resolves.toEqual(result);
      const [url, options] = requestFetch.mock.calls.at(-1)!;
      expect(String(url)).toBe(`https://control.example.test/internal/v2/cloud-workspaces/engine/agent-boot/${operation}`);
      expect(JSON.parse(options.body)).toEqual(request);
    }
    expect(requestFetch).toHaveBeenCalledTimes(4);
  });

  it.each(["organizationId", "workspaceId", "generation", "engineInstanceId"] as const)("refuses a foreign request %s before HTTP", async field => {
    const f = fixture(), requestFetch = vi.fn();
    await expect(requestCloudAgentBoot(f.authority, "bootstrap", { ...f.bootstrap,
      [field]: field === "generation" ? 8 : randomUUID() }, f.signal, requestFetch))
      .rejects.toMatchObject({ code: "cloud_admission_authority_response_invalid" });
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("does not accept renderer identity, funding selectors, legacy grants or another operation body", async () => {
    const f = fixture(), requestFetch = vi.fn();
    for (const request of [{ ...f.bootstrap, fundingOwnerUserId: f.scope.fundingOwnerUserId },
      { ...f.bootstrap, actor: f.context.actor.actor }, { ...f.bootstrap, grant: { token: "synthetic-grant" } }, f.sync]) {
      await expect(requestCloudAgentBoot(f.authority, "bootstrap", request, f.signal, requestFetch))
        .rejects.toMatchObject({ code: "cloud_admission_authority_response_invalid" });
    }
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it.each(["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch"] as const)(
    "binds a sync response to the exact %s", async field => {
      const f = fixture(), requestFetch = vi.fn().mockResolvedValue(Response.json({ result: {
        ...f.credentials, [field]: field === "generation" ? 8 : randomUUID() } }));
      await expect(requestCloudAgentBoot(f.authority, "sync", f.sync, f.signal, requestFetch))
        .rejects.toMatchObject({ code: "cloud_validation_authority_response_invalid" });
    });

  it("does not lower the requested ready revision or accept superseded material while dirty", async () => {
    const f = fixture(), requestFetch = vi.fn();
    for (const result of [{ ...f.credentials, cacheRevision: 1, desiredCacheRevision: 1 },
      { ...f.credentials, desiredCacheRevision: 3 }]) {
      requestFetch.mockResolvedValueOnce(Response.json({ result }));
      await expect(requestCloudAgentBoot(f.authority, "sync", f.sync, f.signal, requestFetch)).rejects.toThrow();
    }
    const pending = { ...f.credentials, desiredCacheRevision: 3,
      providers: f.credentials.providers.map(value => ({ provider: value.provider, status: "unavailable", code: "cloud_agent_credential_refresh_required" })) };
    requestFetch.mockResolvedValueOnce(Response.json({ result: pending }));
    await expect(requestCloudAgentBoot(f.authority, "sync", f.sync, f.signal, requestFetch)).resolves.toEqual(pending);
  });

  it("refresh returns only strictly newer positive material for the requested credential", async () => {
    const f = fixture(), requestFetch = vi.fn();
    for (const provider of [{ ...f.refreshed.provider, credentialId: randomUUID() },
      { ...f.refreshed.provider, credentialRevision: 3 }, { ...f.refreshed.provider, materialVersion: 1 }]) {
      requestFetch.mockResolvedValueOnce(Response.json({ result: { ...f.refreshed, provider } }));
      await expect(requestCloudAgentBoot(f.authority, "refresh", f.refresh, f.signal, requestFetch))
        .rejects.toMatchObject({ code: "cloud_validation_authority_response_invalid" });
    }
    expect(requestFetch).toHaveBeenCalledTimes(3);
  });

  it("actor confirmation binds the recorded session and boot without deciding source revocation locally", async () => {
    const f = fixture(), requestFetch = vi.fn();
    for (const provenance of [{ ...f.confirmed.provenance, actorSessionId: randomUUID() },
      { ...f.confirmed.provenance, scope: { ...f.scope, bootId: randomUUID() } }]) {
      requestFetch.mockResolvedValueOnce(Response.json({ result: { ...f.confirmed, provenance } }));
      await expect(requestCloudAgentBoot(f.authority, "actor-confirm", f.confirm, f.signal, requestFetch)).rejects.toThrow();
    }
    const viewer = { ...f.confirmed, provenance: { ...f.confirmed.provenance,
      actor: { ...f.confirmed.provenance.actor, role: "viewer" }, fundingConsentVersion: null, fundingGrant: null } };
    requestFetch.mockResolvedValueOnce(Response.json({ result: viewer }));
    await expect(requestCloudAgentBoot(f.authority, "actor-confirm", f.confirm, f.signal, requestFetch)).resolves.toEqual(viewer);
  });

  it.each(["provider", "model", "conversationId", "cwd"] as const)("warm material cannot cross the requested %s", async field => {
    const f = fixture(), requestFetch = vi.fn().mockResolvedValue(Response.json({ result: {
      ...f.context, [field]: field === "provider" ? "cursor" : field === "cwd" ? "/srv/zeros/workspace/other" : "other" } }));
    await expect(requestCloudAgentBoot(f.authority, "warm-context", f.warm, f.signal, requestFetch))
      .rejects.toMatchObject({ code: "cloud_admission_authority_response_invalid" });
  });

  it("warm material requires the exact recorded actor session", async () => {
    const f = fixture(), requestFetch = vi.fn().mockResolvedValue(Response.json({ result: {
      ...f.context, actor: { ...f.context.actor, actorSessionId: randomUUID() } } }));
    await expect(requestCloudAgentBoot(f.authority, "warm-context", f.warm, f.signal, requestFetch)).rejects.toThrow();
  });

  it("checks accepted repository echo and public snapshot digest before returning context secrets", async () => {
    const f = fixture(), requestFetch = vi.fn();
    const server = { name: "0canvas", transport: "http" as const, url: "https://tools.example.test/mcp" };
    const warm = { ...f.warm, repositoryServers: [server] };
    const snapshot = { version: 1 as const, repositoryDigest: "b".repeat(64), history: f.context.environment.history,
      servers: [{ server, scope: "repository" as const, secretRef: null, revision: 0 }], skills: [], cursorTeamSettings: "disabled" as const };
    const customization = { ...snapshot, digest: cloudMcpDigest(snapshot) };
    const context = { ...f.context, customization };
    requestFetch.mockResolvedValueOnce(Response.json({ result: context }));
    await expect(requestCloudAgentBoot(f.authority, "warm-context", warm, f.signal, requestFetch)).resolves.toEqual(context);
    for (const customization of [null, { ...context.customization, digest: "f".repeat(64) },
      { ...context.customization, servers: [] }]) {
      requestFetch.mockResolvedValueOnce(Response.json({ result: { ...context, customization } }));
      await expect(requestCloudAgentBoot(f.authority, "warm-context", warm, f.signal, requestFetch)).rejects.toThrow();
    }
  });

  it.each([401, 403, 404, 409, 429, 503])("retains only closed typed HTTP %s causes and never retries", async status => {
    const f = fixture(), requestFetch = vi.fn().mockResolvedValue(Response.json({ error: "cloud_validation_credential_refresh_rejected" }, { status }));
    await expect(requestCloudAgentBoot(f.authority, "sync", f.sync, f.signal, requestFetch))
      .rejects.toMatchObject({ code: "cloud_validation_credential_refresh_rejected", message: "Cloud agent execution authority is unavailable" });
    expect(requestFetch).toHaveBeenCalledOnce();
  });

  it("preserves credential and upgrade guidance on private refusal, without fallback", async () => {
    const f = fixture(), requestFetch = vi.fn();
    for (const code of ["cloud_runtime_upgrade_required", "cloud_agent_credential_required", "cloud_agent_credential_revoked", "cloud_agent_credential_refresh_required"]) {
      requestFetch.mockResolvedValueOnce(Response.json({ error: code }, { status: 409 }));
      await expect(requestCloudAgentBoot(f.authority, "bootstrap", f.bootstrap, f.signal, requestFetch)).rejects.toMatchObject({ code });
    }
    requestFetch.mockResolvedValueOnce(Response.json({ error: "cloud_runtime_upgrade_required" }, { status: 422 }));
    await expect(requestCloudAgentBoot(f.authority, "bootstrap", f.bootstrap, f.signal, requestFetch)).rejects.toMatchObject({ code: "cloud_runtime_upgrade_required" });
    expect(requestFetch).toHaveBeenCalledTimes(5);
  });

  it.each([[429, "rate_limited"], [503, "authority_http_5xx"], [403, "authority_http_4xx"]] as const)(
    "never copies untyped HTTP %s error bodies", async (status, category) => {
      const f = fixture(), requestFetch = vi.fn();
      for (const body of ["synthetic-private-server-diagnostic", JSON.stringify({ error: "cloud_validation_access_denied", details: "private" }),
        JSON.stringify({ error: "cloud_validation_private_reason" }), "x".repeat(1025)]) {
        requestFetch.mockResolvedValueOnce(new Response(body, { status }));
        await expect(requestCloudAgentBoot(f.authority, "sync", f.sync, f.signal, requestFetch))
          .rejects.toMatchObject({ code: `cloud_validation_${category}`, message: "Cloud agent execution authority is unavailable" });
      }
    });

  it("rejects oversized, malformed UTF8 and non-strict result envelopes", async () => {
    const f = fixture(), requestFetch = vi.fn();
    for (const response of [Response.json({ result: f.credentials, diagnostic: "private" }),
      Response.json({ result: { ...f.credentials, adminToken: "synthetic-private-admin" } }),
      new Response(new Uint8Array([0xff, 0xfe])), new Response("x".repeat(256 * 1024 + 1)),
      new Response("{}", { headers: { "content-length": String(256 * 1024 + 1) } }), new Response(null)]) {
      requestFetch.mockResolvedValueOnce(response);
      await expect(requestCloudAgentBoot(f.authority, "bootstrap", f.bootstrap, f.signal, requestFetch))
        .rejects.toMatchObject({ code: "cloud_admission_authority_response_invalid" });
    }
  });

  it("allows HTTPS and loopback development, but refuses redirects, URL credentials and remote HTTP", async () => {
    const f = fixture(), requestFetch = vi.fn();
    for (const heartbeatEndpoint of ["http://untrusted.example.test/heartbeat", "https://user:private@control.example.test/heartbeat", "file:///tmp/heartbeat"]) {
      await expect(requestCloudAgentBoot({ ...f.authority, heartbeatEndpoint }, "bootstrap", f.bootstrap, f.signal, requestFetch)).rejects.toThrow();
    }
    expect(requestFetch).not.toHaveBeenCalled();
    requestFetch.mockResolvedValueOnce(Response.json({ result: f.credentials }));
    await expect(requestCloudAgentBoot({ ...f.authority, heartbeatEndpoint: "http://localhost:3000/heartbeat" },
      "bootstrap", f.bootstrap, f.signal, requestFetch)).resolves.toEqual(f.credentials);
    expect(requestFetch.mock.calls[0]![1].redirect).toBe("error");
  });

  it.each(["TimeoutError", "TypeError"])("retains a closed %s transport cause and performs no retry", async name => {
    const f = fixture(), error = Object.assign(new Error("synthetic-private-transport"), { name });
    const requestFetch = vi.fn().mockRejectedValue(error);
    await expect(requestCloudAgentBoot(f.authority, "sync", f.sync, f.signal, requestFetch))
      .rejects.toMatchObject({ code: `cloud_validation_${name === "TimeoutError" ? "authority_timeout" : "authority_transport"}` });
    expect(requestFetch).toHaveBeenCalledOnce();
  });

  it("pre-aborted background work performs no request and never reports a successful install", async () => {
    const f = fixture(), controller = new AbortController(), requestFetch = vi.fn(); controller.abort();
    await expect(requestCloudAgentBoot(f.authority, "sync", f.sync, controller.signal, requestFetch))
      .rejects.toMatchObject({ code: "cloud_validation_lifecycle_superseded" });
    expect(requestFetch).not.toHaveBeenCalled();
  });
});
