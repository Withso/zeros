import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RuntimeCanaryAuthority, loadRuntimeCanaryPolicy } from "../../apps/control-plane/src/cloud/runtime-canary";
import { createReleaseCanary, cleanupReleaseCanary } from "./runtime-canary";
import { runtimeReleaseConfig } from "./runtime-contracts";

function fixture() {
  const pair = generateKeyPairSync("ed25519"), fixture = { creatorUserId: randomUUID(), organizationId: randomUUID(), repositoryId: "42" };
  const config = { channel: "alpha" as const, action: "publish" as const, repository: "example/project", workflowSha: "1".repeat(40), branch: "main",
    runId: "123", runAttempt: 1, sourceSha: "2".repeat(40), expectedCpSha: "3".repeat(40), expectedRuntimeSha256: "a".repeat(64) };
  const manifest = { version: 1 as const, repository: config.repository, sha256: "b".repeat(64), sourceSha: config.sourceSha, sourceSha256: "c".repeat(64), bytes: 123 };
  const env = { CLOUD_V2_RUNTIME_CANARY_PRIVATE_KEY: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    CLOUD_RUNTIME_CANARY_KEY_ID: "release", CLOUD_V2_RUNTIME_CANARY_CONFIG: JSON.stringify({ keys: [{ id: "release", publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") }], fixture }) };
  const canary = createReleaseCanary(config, manifest, env), c = canary.claims, workspaceId = randomUUID();
  const status = { version: 1, grantId: c.jti, workspaceId, creatorUserId: c.creatorUserId, organizationId: c.organizationId, repositoryId: c.repositoryId,
    runId: c.runId, runAttempt: c.runAttempt, runtimeSha256: c.runtimeSha256, sourceSha: c.sourceSha,
    grantSha256: createHash("sha256").update(canary.token).digest("hex"), createKeySha256: createHash("sha256").update(c.createKey).digest("hex"), state: "deleted", deleted: true };
  const deps = { close: vi.fn(async () => ({ kind: "workspace" as const, workspaceId })), remove: vi.fn(async () => {}), status: vi.fn(async () => status), pause: vi.fn(async () => {}) };
  return { config, manifest, env, canary, status, deps };
}

describe("release canary ownership", () => {
  it("uses the app's actual dedicated-key verifier and exactly bounded fixture/run/digest claims", () => {
    const f = fixture(), policy = loadRuntimeCanaryPolicy(f.env.CLOUD_V2_RUNTIME_CANARY_CONFIG, "alpha")!;
    expect(new RuntimeCanaryAuthority(policy).verify(f.canary.token, f.canary.claims)).toMatchObject({ ...f.canary.claims });
    expect(f.canary.claims.exp - f.canary.claims.iat).toBe(900);
    expect(f.canary.claims).toMatchObject({ runId: f.config.runId, runAttempt: f.config.runAttempt, runtimeSha256: f.manifest.sha256, sourceSha: f.manifest.sourceSha, ...policy.fixture });
    expect(() => createReleaseCanary({ ...f.config, channel: "beta" }, f.manifest, f.env)).toThrow();
  });

  it("rejects an unrelated signer without reflecting key material", () => {
    const f = fixture(), other = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    expect(() => createReleaseCanary(f.config, f.manifest, { ...f.env, CLOUD_V2_RUNTIME_CANARY_PRIVATE_KEY: other })).toThrow("Alpha canary signing configuration is invalid; details withheld");
  });

  it("closes admission before deleting or reading its exact workspace", async () => {
    const f = fixture(); await expect(cleanupReleaseCanary(f.canary, f.deps)).resolves.toEqual({ deleted: true, workspaceId: f.status.workspaceId });
    expect(f.deps.close.mock.invocationCallOrder[0]).toBeLessThan(f.deps.remove.mock.invocationCallOrder[0]);
    expect(f.deps.remove).toHaveBeenCalledExactlyOnceWith(f.status.workspaceId);
  });

  it.each(["close", "remove", "status"] as const)("never converts a failed %s into cleanup proof", async phase => {
    const f = fixture(); f.deps[phase].mockRejectedValueOnce(new Error("synthetic-private-provider-body"));
    await expect(cleanupReleaseCanary(f.canary, f.deps)).rejects.toThrow();
    if (phase === "close") expect(f.deps.remove).not.toHaveBeenCalled();
  });

  it("rejects a 404-shaped, foreign or contradictory deletion response", async () => {
    for (const patch of [{ version: undefined }, { workspaceId: randomUUID() }, { state: "running" }, { runId: "999" }]) {
      const f = fixture(); f.deps.status.mockResolvedValue({ ...f.status, ...patch } as never);
      await expect(cleanupReleaseCanary(f.canary, f.deps)).rejects.toThrow();
    }
  });

  it("accepts a freshly tombstoned unused grant without attempting a workspace action", async () => {
    const f = fixture(); f.deps.close.mockResolvedValue({ kind: "unused" } as never);
    await expect(cleanupReleaseCanary(f.canary, f.deps)).resolves.toEqual({ deleted: true, workspaceId: null });
    expect(f.deps.remove).not.toHaveBeenCalled(); expect(f.deps.status).not.toHaveBeenCalled();
  });
});

describe("runtime dispatch scope", () => {
  const env = { ZEROS_RUNTIME_RELEASE: "enabled", ZEROS_HOSTED_PROMOTION: "enabled", RUNTIME_RELEASE_CHANNEL: "alpha", RUNTIME_RELEASE_ACTION: "publish",
    RUNTIME_RELEASE_SOURCE_SHA: "2".repeat(40), RUNTIME_RELEASE_EXPECTED_CP_SHA: "3".repeat(40), RUNTIME_RELEASE_EXPECTED_SHA256: "a".repeat(64),
    GITHUB_REPOSITORY: "example/project", GITHUB_SHA: "1".repeat(40), GITHUB_WORKFLOW_SHA: "1".repeat(40), GITHUB_REF_NAME: "main", GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: "example/project/.github/workflows/runtime-release.yml@refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" };
  it("keeps the workflow source distinct from the runtime source and unchanged live CP", () => {
    expect(runtimeReleaseConfig(env)).toMatchObject({ workflowSha: env.GITHUB_SHA, sourceSha: env.RUNTIME_RELEASE_SOURCE_SHA, expectedCpSha: env.RUNTIME_RELEASE_EXPECTED_CP_SHA });
  });
  it.each([{ GITHUB_EVENT_NAME: "push" }, { ZEROS_RUNTIME_RELEASE: "" }, { GITHUB_WORKFLOW_SHA: "9".repeat(40) }, { GITHUB_REF: "refs/pull/42/merge" },
    { RUNTIME_RELEASE_ACTION: "rollback" }, { RUNTIME_RELEASE_CHANNEL: "production" }])("refuses an unsupported dispatch boundary (%j)", patch => {
      expect(() => runtimeReleaseConfig({ ...env, ...patch })).toThrow();
    });
});
