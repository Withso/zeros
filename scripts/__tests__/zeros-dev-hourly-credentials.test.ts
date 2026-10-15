import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HourlyCredentials, actionsMaterials } from "../zeros-dev/hourly-credentials";
import { ProductApi } from "../zeros-dev/product";
import { AlphaTransport } from "../zeros-dev/transport";
import type { RunHandle } from "../zeros-dev/receipts";

function fixture() {
  const org = randomUUID(), account = randomUUID(), materials = actionsMaterials({ GITHUB_ACTIONS: "true",
    AGENT_RUNTIME_ANTHROPIC_API_KEY: "synthetic-claude-credential", AGENT_RUNTIME_OPENAI_API_KEY: "synthetic-openai-credential", AGENT_RUNTIME_CURSOR_API_KEY: "synthetic-cursor-credential" });
  const handle = { run: { runId: randomUUID(), hourly: { version: 1, workflowRunId: "17", attempt: 1, sourceSha: "c".repeat(40),
    credentials: [], histories: [], activeWindows: [], complete: false } }, save: vi.fn(async () => {}) } as unknown as RunHandle;
  const rows = new Map<string, Record<string, unknown>>(), connections = new Map<string, Record<string, unknown>>();
  const writes: Array<{ path: string; method: string; body: Record<string, unknown> | null }> = [];
  let uncertain = false;
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : null;
    if (method !== "GET") { expect(handle.save).toHaveBeenCalled(); writes.push({ path, method, body }); }
    if (method === "GET") return Response.json(path.endsWith("agent-connections") ? { credentials: [...rows.values()], connections: [...connections.values()] } : { credentials: [...rows.values()] });
    const id = path.split("/").at(-1)!;
    if (method === "DELETE") { rows.delete(id); return Response.json({ revoked: true }); }
    if (path.includes("agent-connections/")) {
      if (body.expectedRevision !== (connections.get(id)?.revision ?? 0)) return Response.json({}, { status: 409 });
      connections.set(id, { provider: id, revision: body.expectedRevision + 1, credentialId: body.credentialId, models: body.models ?? [], connected: body.credentialId !== null });
      return Response.json({ revision: body.expectedRevision + 1 });
    }
    if (uncertain) return Response.json({}, { status: 503 });
    const credential = { id, kind: body.material.kind, displayName: body.displayName, revision: 1, revoked: false };
    rows.set(id, credential); return Response.json({ credential, replayed: false });
  });
  const api = new ProductApi({ fixture: async () => ({ organizationId: org, accountId: account }) as never, accessToken: async () => "synthetic-bearer", whoami: async () => ({}) as never }, new AlphaTransport(fetcher as typeof fetch));
  return { api, handle, rows, connections, writes, fetcher, credentials: new HourlyCredentials(api, materials), uncertain: () => { uncertain = true; } };
}

describe("Actions-only product credentials", () => {
  it("refuses new agent work without release-check material before any product read or write", async () => {
    const f = fixture(), credentials = new HourlyCredentials(f.api);
    await expect(credentials.install(f.handle, AbortSignal.timeout(1000))).rejects.toThrow("zeros_dev_release_checks_unavailable");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.handle.save).not.toHaveBeenCalled();
  });

  it("can retire only its signed predecessor credentials without needing new credential material", async () => {
    const f = fixture(); await f.credentials.install(f.handle, AbortSignal.timeout(1000));
    f.writes.length = 0;
    await new HourlyCredentials(f.api).cleanup(f.handle, AbortSignal.timeout(1000));
    expect(f.rows.size).toBe(0);
    expect(f.writes.every(row => row.method === "DELETE" || row.body?.credentialId === null)).toBe(true);
  });

  it("publishes exactly three fresh account credentials with bounded models, then clears and revokes them", async () => {
    const f = fixture(); await f.credentials.install(f.handle, AbortSignal.timeout(1000));
    expect(f.rows.size).toBe(3); expect(f.handle.run.hourly?.credentials).toHaveLength(3);
    expect(JSON.stringify(f.handle.run)).not.toContain("synthetic-");
    for (const row of f.writes.filter(row => row.path.includes("cloud-agent-credentials/"))) expect(row.body).toMatchObject({ expectedRevision: 0, organizationId: expect.any(String) });
    for (const row of f.writes.filter(row => row.path.includes("agent-connections/"))) expect(row.body).toMatchObject({ models: [expect.any(String)], consent: "zeros-managed" });
    await f.credentials.cleanup(f.handle, AbortSignal.timeout(1000));
    expect(f.rows.size).toBe(0); expect([...f.connections.values()].every(row => row.credentialId === null)).toBe(true);
    const count = f.writes.length; await f.credentials.cleanup(f.handle, AbortSignal.timeout(1000)); expect(f.writes).toHaveLength(count);
  });

  it("does not replace an existing selection", async () => {
    const f = fixture(); f.connections.set("claude", { provider: "claude", revision: 1, credentialId: randomUUID(), models: [], connected: true });
    await expect(f.credentials.install(f.handle, AbortSignal.timeout(1000))).rejects.toThrow("zeros_dev_operation_conflict");
    expect(f.writes).toEqual([]);
  });

  it("never treats an uncertain credential publication as proven absent", async () => {
    const f = fixture(); f.uncertain();
    await expect(f.credentials.install(f.handle, AbortSignal.timeout(1000))).rejects.toThrow("zeros_dev_service_unavailable");
    await expect(f.credentials.cleanup(f.handle, AbortSignal.timeout(1000))).rejects.toThrow("zeros_dev_cleanup_pending");
    expect(f.writes.filter(row => row.method === "DELETE")).toEqual([]);
  });

  it("does not disconnect a selection changed by another session during the run", async () => {
    const f = fixture(); await f.credentials.install(f.handle, AbortSignal.timeout(1000));
    const foreign = randomUUID(); f.connections.set("claude", { provider: "claude", revision: 7, credentialId: foreign, models: [], connected: true });
    await f.credentials.cleanup(f.handle, AbortSignal.timeout(1000));
    expect(f.connections.get("claude")?.credentialId).toBe(foreign);
    expect(f.writes.some(row => row.method === "DELETE" && row.path.endsWith(foreign))).toBe(false);
  });

  it("rejects a changed credential kind before issuing a delete", async () => {
    const f = fixture(); await f.credentials.install(f.handle, AbortSignal.timeout(1000));
    const own = f.handle.run.hourly!.credentials[0]!; f.rows.get(own.id)!.kind = "codex-api-key";
    await expect(f.credentials.cleanup(f.handle, AbortSignal.timeout(1000))).rejects.toThrow("zeros_dev_identity_changed");
    expect(f.writes.some(row => row.method === "DELETE" && row.path.endsWith(own.id))).toBe(false);
  });

  it("requires Actions and refuses missing or malformed provider material without echoing it", () => {
    expect(() => actionsMaterials({})).toThrow("zeros_dev_actions_required");
    expect(() => actionsMaterials({ GITHUB_ACTIONS: "true", AGENT_RUNTIME_CODEX_AUTH_JSON: "secret-invalid-json" })).toThrow("zeros_dev_agent_credential_required");
  });
});
