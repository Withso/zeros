import { describe, expect, it, vi } from "vitest";
import { DevAgentRequestSchema, assertDevAgentEnvironment, devAgentModel } from "./dev-agent-qualification.js";
import { startNativeDevCanary } from "./cloud-workspaces/dev-native-canary.js";

const request = { owner: "a".repeat(24), generation: "11111111-1111-4111-8111-111111111111",
  fixture: { workosUserId: "user_fixture", workosOrganizationId: "org_fixture", expectedEmail: "dev@example.test", expectedOrganizationSlug: "dev-test" },
  image: { snapshotId: "dev-test-image", buildSha256: "b".repeat(64), sourceCommit: "c".repeat(40) } };
const env = { ZEROS_DEV_ENVIRONMENT: "hosted", ZEROS_DEV_OWNER: request.owner, ZEROS_DEV_GENERATION: request.generation,
  BOAT_SNAPSHOT_ID: request.image.snapshotId, BOAT_IMAGE_BUILD_SHA256: request.image.buildSha256, ZEROS_CLOUD_SOURCE_COMMIT: request.image.sourceCommit };
describe("Dev native agent operator boundaries", () => {
  it("rejects release backends, other generations and stale deployed images", () => {
    expect(() => assertDevAgentEnvironment(request, env)).not.toThrow();
    for (const field of Object.keys(env)) expect(() => assertDevAgentEnvironment(request, { ...env, [field]: "other" })).toThrow();
    expect(DevAgentRequestSchema.safeParse({ ...request, fixture: { ...request.fixture, apiKey: "never-accepted" } }).success).toBe(false);
  });
  it("chooses a small explicitly consented model and never adds a model to consent", () => {
    expect(devAgentModel("claude", ["claude-opus-4-6", "claude-haiku-4-5"])).toBe("claude-haiku-4-5");
    expect(devAgentModel("codex", ["user-selected-model"])).toBe("user-selected-model");
    expect(() => devAgentModel("cursor", [])).toThrow();
  });
  it("keeps the backend base, account and Dev reference flag fenced for organization images", () => {
    const organizationImage = { ...request.image, id: "33333333-3333-4333-8333-333333333333", snapshotId: `zeros-org-${"3".repeat(32)}`, buildSha256: "d".repeat(64) };
    const input = { ...request, organizationImage, accountScope: "fixture", referenceMode: true as const };
    const hosted = { ...env, BOAT_ACCOUNT_SCOPE: "fixture", ZEROS_DEPLOY_ENV: "dev", ZEROS_DEV_CONNECTIONS_ENABLED: "true" };
    expect(() => assertDevAgentEnvironment(input, hosted)).not.toThrow();
    expect(() => assertDevAgentEnvironment(input, { ...hosted, BOAT_ACCOUNT_SCOPE: "foreign" })).toThrow();
    expect(() => assertDevAgentEnvironment(input, { ...hosted, ZEROS_DEV_CONNECTIONS_ENABLED: "false" })).toThrow();
    expect(() => assertDevAgentEnvironment({ ...input, image: organizationImage }, hosted)).toThrow();
  });
  it("stages access only through a private file and returns no credential or native output", async () => {
    const secret = "synthetic-provider-token-for-test";
    const command = vi.fn(async () => "started");
    const upload = vi.fn(async () => {});
    const target = { id: "bx_test123", attempt: "22222222-2222-4222-8222-222222222222", ...request.image };
    await startNativeDevCanary({ command, upload }, target, { version: 1, expiresAtMs: Date.now() + 600_000,
      buildSha256: target.buildSha256, sourceCommit: target.sourceCommit, model: "claude-haiku-4-5",
      material: { kind: "claude-setup-token", accessToken: secret } });
    expect(upload).toHaveBeenCalledOnce();
    expect(JSON.stringify(command.mock.calls)).not.toContain(secret);
    expect(command.mock.calls.map(call => String(call[0])).join("\n")).toContain("O_NOFOLLOW");
    expect(command.mock.calls.map(call => String(call[0])).join("\n")).toContain(target.buildSha256);
    expect(command.mock.calls.map(call => String(call[0])).join("\n")).toContain("item.get('version')==3");
  });
});

it.each([-60_000, 60_000, 600_000])("bootstraps access with %s ms remaining before proving a separate native renewal", async remaining => {
  const operator = await import("./dev-agent-qualification.js");
  const now = Date.now(); let version = 1;
  const read = vi.fn(async () => ({ credential: { current_version: version }, material: { kind: "codex-chatgpt" as const,
    accountId: "synthetic-account", accessToken: `synthetic-${version}`, expiresAt: Math.floor((now + (version === 1 ? remaining : 3600_000)) / 1000) } }));
  const renew = vi.fn(async () => { version++; });
  const result = await (operator as any).prepareDevCanaryAccess(read, renew, () => now);
  expect(renew).toHaveBeenCalledTimes(remaining <= 120_000 ? 2 : 1);
  expect(result.before.material.expiresAt * 1000).toBeGreaterThan(now + 120_000);
  expect(result.renewedCodex.accessToken).not.toBe(result.before.material.accessToken);
  expect(result.renewal).toEqual({ accountBinding: true, accessChanged: true, cachePublished: true, consentPreserved: true });
});
