import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { runAlphaRuntimeCanary } from "../../apps/control-plane/src/cloud/runtime-canary-gate0";
import type { ReleaseCanary } from "./runtime-canary";
import type { RuntimeEventDetail } from "./runtime-journal";
import { qualifyRuntime } from "./runtime-qualification";

function fixture() {
  const key = generateKeyPairSync("ed25519"), owner = { creatorUserId: randomUUID(), organizationId: randomUUID(), repositoryId: "42" };
  const config = { channel: "alpha" as const, action: "publish" as const, repository: "example/project", workflowSha: "1".repeat(40), branch: "main",
    runId: "123", runAttempt: 1, sourceSha: "2".repeat(40), expectedCpSha: "3".repeat(40), expectedRuntimeSha256: "a".repeat(64) };
  const manifest = { version: 1 as const, repository: config.repository, sha256: "b".repeat(64), sourceSha: config.sourceSha, sourceSha256: "c".repeat(64), bytes: 100 };
  const env = { CLOUD_V2_RUNTIME_CANARY_PRIVATE_KEY: key.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    CLOUD_RUNTIME_CANARY_KEY_ID: "fixture", CLOUD_V2_RUNTIME_CANARY_CONFIG: JSON.stringify({ keys: [{ id: "fixture", publicKey: key.publicKey.export({ format: "der", type: "spki" }).toString("base64") }], fixture: owner }),
    WORKOS_CLIENT_ID: "client_fixture", WORKOS_API_KEY: "synthetic-private-workos-key", CLOUD_RUNTIME_FIXTURE_EMAIL: "fixture@example.test",
    CLOUD_RUNTIME_FIXTURE_PASSWORD: "synthetic-password", CLOUD_RUNTIME_FIXTURE_WORKOS_USER_ID: "user_fixture", CLOUD_RUNTIME_CANARY_REPOSITORY: "fixture/repository" };
  const workspaceId = randomUUID(), events: string[] = [], records: RuntimeEventDetail[] = [];
  let canary: ReleaseCanary, deleted = true, staffRole: string | null = null;
  const session = { accessToken: async () => "synthetic-cleanup-session", close: vi.fn(async () => { events.push("logout"); }) };
  const run = vi.fn<typeof runAlphaRuntimeCanary>(async input => {
    events.push("gate0"); canary = input.canary; const c = input.canary.claims;
    return { version: 1, channel: "alpha", cpSourceSha: config.expectedCpSha, previousRuntimeSha256: config.expectedRuntimeSha256,
      runtimeSha256: manifest.sha256, sourceSha: manifest.sourceSha, grantId: c.jti, workspaceId, ...owner,
      runId: config.runId, runAttempt: 1, agents: ["codex", "claude", "cursor"], deleted: true, completedAt: new Date().toISOString() };
  });
  const close = vi.fn(async (value: ReleaseCanary) => { canary = value; events.push("retire-nonce"); return { kind: "workspace" as const, workspaceId }; });
  const signIn = vi.fn(async () => { events.push("login"); return session; });
  const record = vi.fn(async (value: RuntimeEventDetail) => { records.push(value); events.push(value.kind); });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(init?.headers).toEqual({ authorization: "Bearer synthetic-cleanup-session" });
    if (String(input).endsWith("/v1/me")) return Response.json({ user: { id: owner.creatorUserId, staffRole }, organizations: [{ id: owner.organizationId, isPersonal: false }] });
    if (init?.method === "DELETE") { events.push("delete"); expect(String(input)).toBe(`https://api-alpha.zeros.build/v1/cloud-v2/workspaces/${workspaceId}`); return new Response(null, { status: 204 }); }
    const c = canary.claims; events.push("status");
    return Response.json({ version: 1, grantId: c.jti, workspaceId, ...owner, runId: c.runId, runAttempt: c.runAttempt,
      runtimeSha256: c.runtimeSha256, sourceSha: c.sourceSha, grantSha256: createHash("sha256").update(canary.token).digest("hex"),
      createKeySha256: createHash("sha256").update(c.createKey).digest("hex"), deleted, state: deleted ? "deleted" : "deleting" });
  });
  const deps = { run, close, signIn, record, fetch: fetcher, pause: async () => {} };
  return { config, manifest, env, events, records, deps, session, setDeleted: (value: boolean) => { deleted = value; },
    setStaffRole: (value: string) => { staffRole = value; }, execute: () => qualifyRuntime(config, manifest, env, {} as never, deps) };
}

describe("runtime qualification cleanup composition", () => {
  it("requires gate0, nonce closure, exact deletion and logout before returning pin evidence", async () => {
    const f = fixture(), result = await f.execute();
    expect(result.release.sha256).toBe(f.manifest.sha256);
    expect(f.events).toEqual(["canary", "gate0", "retire-nonce", "login", "delete", "status", "logout", "canary-cleanup"]);
    const saved = JSON.stringify(f.records);
    for (const secret of [f.env.WORKOS_API_KEY, f.env.CLOUD_RUNTIME_FIXTURE_PASSWORD, f.env.CLOUD_V2_RUNTIME_CANARY_PRIVATE_KEY, "synthetic-cleanup-session"])
      expect(saved).not.toContain(secret);
    expect(saved).not.toContain('"token"');
  });
  it("still closes and deletes a canary after a failed or lost gate0 response", async () => {
    const f = fixture(); f.deps.run.mockRejectedValueOnce(new Error("synthetic-private-response"));
    await expect(f.execute()).rejects.toThrow("Alpha qualification or cleanup failed; no pin authority was produced, details withheld");
    expect(f.events).toContain("delete"); expect(f.session.close).toHaveBeenCalledOnce();
  });
  it("retires an unused grant without signing in when admission never happened", async () => {
    const f = fixture(); f.deps.run.mockRejectedValueOnce(new Error("no-create")); f.deps.close.mockResolvedValueOnce({ kind: "unused" } as never);
    await expect(f.execute()).rejects.toThrow(/no pin authority/);
    expect(f.deps.signIn).not.toHaveBeenCalled(); expect(f.deps.fetch).not.toHaveBeenCalled();
    expect(f.records.at(-1)).toMatchObject({ kind: "canary-cleanup", deleted: true, workspaceId: null });
  });
  it("never starts gate0 if its durable intent fails", async () => {
    const f = fixture(); f.deps.record.mockRejectedValueOnce(new Error("private-storage-error")); f.deps.close.mockResolvedValueOnce({ kind: "unused" } as never);
    await expect(f.execute()).rejects.toThrow(/no pin authority/);
    expect(f.deps.run).not.toHaveBeenCalled(); expect(f.deps.close).toHaveBeenCalledOnce();
  });
  it.each(["close", "logout", "status", "staff"])("withholds pin proof when %s cannot be confirmed", async phase => {
    const f = fixture();
    if (phase === "close") f.deps.close.mockRejectedValueOnce(new Error("private-database-error"));
    if (phase === "logout") f.session.close.mockRejectedValueOnce(new Error("private-workos-error"));
    if (phase === "status") f.setDeleted(false);
    if (phase === "staff") f.setStaffRole("admin");
    await expect(f.execute()).rejects.toThrow(/no pin authority/);
    if (phase === "close") expect(f.deps.signIn).not.toHaveBeenCalled();
    else expect(f.session.close).toHaveBeenCalledOnce();
    if (phase === "staff") expect(f.events).not.toContain("delete");
  });
});
