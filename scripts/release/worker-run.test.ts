import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newHostedGeneration } from "../dev-environment/hosted-state.mjs";
import type { Channel } from "./contracts";
import { workerOwner } from "./worker-admission";
import { workerExecutionConfig } from "./worker-config";
import { executeWorkerPromotion, reconcileWorkerNativeStorage } from "./worker-run";
import { RELEASE_WORKER_IMAGES_RETIRED } from "../../apps/control-plane/src/cloud-workspaces/release-worker-retirement";
import { workerConnections, workerEnvironment } from "./worker-test-fixtures";

const dependencies = vi.hoisted(() => ({ registry: vi.fn(), requiredChecks: vi.fn(), current: vi.fn() }));
vi.mock("../dev-environment/hosted-state.mjs", async importOriginal => ({
  ...await importOriginal<typeof import("../dev-environment/hosted-state.mjs")>(),
  r2Registry: dependencies.registry,
}));
vi.mock("./github", () => ({ githubClient: () => ({ assertRequiredChecks: dependencies.requiredChecks, assertCurrent: dependencies.current }) }));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

function fixture(channel: Channel = "production", existing = true) {
  const env = { ...workerEnvironment(), RELEASE_CHANNEL: channel, RELEASE_BRANCH: channel === "alpha" ? "main" : "release/1.2.3",
    PLANETSCALE_DATABASE: `zeros-control-plane-${channel}` };
  const profile = { boat: { accountScope: env.BOAT_ACCOUNT_SCOPE, billingOrg: env.BOAT_BILLING_ORG, baseSnapshot: env.BOAT_BASE_SNAPSHOT },
    railway: { projectId: env.RAILWAY_PROJECT_ID }, planetscale: { organization: "synthetic-org", database: "synthetic-db" },
    cloudflare: { accountId: "synthetic-account" } };
  env.WORKER_ADMISSION_CONFIG_JSON = JSON.stringify({ version: 1, profile, registry: {
    endpoint: "https://synthetic-r2.invalid", bucket: "synthetic-registry", accessKeyId: "synthetic-access-key",
    secretAccessKey: "synthetic-secret-key", encryptionKey: "c".repeat(64),
  } });
  const { config } = workerExecutionConfig(env), owner = workerOwner(channel);
  const identity = createHash("sha256").update(JSON.stringify(["release-worker", config.repository, channel])).digest("hex");
  const state: any = newHostedGeneration({ owner, identity });
  state.releaseRuns = [];
  let durable: any = existing ? state : undefined, revision = existing ? "1" : undefined;
  const key = `release-workers/v1/${channel}.json`;
  const accountBinding = createHash("sha256").update(JSON.stringify([profile.boat.accountScope, profile.boat.billingOrg,
    profile.railway.projectId, profile.planetscale.organization, profile.planetscale.database, profile.cloudflare.accountId])).digest("hex");
  const registry = {
    readDocument: vi.fn(async (requestedKey: string, requestedOwner: string, project: (value: any) => any) => {
      expect(requestedKey).toBe(key); expect(requestedOwner).toBe(owner);
      return durable ? { state: project(structuredClone(durable)), etag: revision } : null;
    }),
    writeDocument: vi.fn(async (requestedKey: string, next: any, etag?: string) => {
      expect(requestedKey).toBe(key); expect(etag).toBe(revision);
      durable = structuredClone(next); revision = String(Number(revision ?? "0") + 1); return revision;
    }),
    readAdmission: vi.fn(async () => ({ state: { version: 1, owner: "account-admission", account: accountBinding, reservations: [] }, etag: "1" })),
    writeAdmission: vi.fn(async () => { throw new Error("Unexpected admission mutation in synthetic preflight test"); }),
    close: vi.fn(),
  };
  dependencies.registry.mockReturnValue(registry);
  const preflight = vi.fn(async (scope: unknown) => {
    expect(scope).toMatchObject({ channel, sourceSha: config.sourceSha, runId: config.runId, runAttempt: config.runAttempt });
    return Response.json({ error: { code: "release_canary_unavailable", message: "Release canary designation missing for claude-setup-token" } }, { status: 409 });
  });
  const fetcher = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    if (String(url) === `${config.api}/v1/release-identity`) return Response.json({
      version: 1, ready: true, sourceSha: config.sourceSha, channel, maintenance: false,
      migrations: { state: "current", head: "0123_synthetic_expand.sql", expectedHead: "0123_synthetic_expand.sql", manifestSha256: "e".repeat(64) },
      cloud: { enabled: false, ready: true, state: "disabled" }, worker: null, workerQualified: false,
    });
    if (String(url) === `${config.api}/internal/v1/release-canaries/preflight`) {
      expect(init.method).toBe("POST"); return preflight(JSON.parse(String(init.body)));
    }
    throw new Error("Unexpected provider request in synthetic preflight test");
  });
  vi.stubGlobal("fetch", fetcher);
  const run = { runId: "122", sourceSha: config.sourceSha, inputsSha256: "f".repeat(64), actorUserId: env.RUNTIME_QUALIFICATION_ACTOR_USER_ID,
    qualificationProfile: "full", operationId: "77777777-7777-4777-8777-777777777777", releaseCanaryBindings: workerConnections(), canaries: [] as any[] };
  return { env, state, run, registry, preflight, fetcher, saved: () => durable,
    execute: () => executeWorkerPromotion(env, "f".repeat(64), "full") };
}

describe("retired worker runner", () => {
  it.each(["alpha", "beta", "production"] as const)("refuses new %s execution before opening a registry, CI or provider", async channel => {
    const test = fixture(channel);
    await expect(test.execute()).rejects.toThrow(RELEASE_WORKER_IMAGES_RETIRED);
    expect(dependencies.registry).not.toHaveBeenCalled(); expect(dependencies.requiredChecks).not.toHaveBeenCalled();
    expect(test.fetcher).not.toHaveBeenCalled(); expect(test.saved()).toEqual(test.state);
  });
});

describe("reconciliation-only worker runner", () => {
  it("does not create a registry generation when the exact release receipt is absent", async () => {
    const test = fixture("alpha", false);
    await expect(reconcileWorkerNativeStorage(test.env)).resolves.toBe(0);
    expect(test.saved()).toBeUndefined(); expect(test.registry.writeDocument).not.toHaveBeenCalled();
    expect(test.registry.writeAdmission).not.toHaveBeenCalled(); expect(test.preflight).not.toHaveBeenCalled();
    expect(test.fetcher).toHaveBeenCalledOnce(); expect(test.registry.close).toHaveBeenCalledOnce();
  });
  it("observes existing empty history under its real lease without preflight, admission changes or qualification", async () => {
    const test = fixture("alpha"); test.state.resources.images = [];
    test.env.ZEROS_WORKER_PROMOTION = "disabled";
    await expect(reconcileWorkerNativeStorage(test.env)).resolves.toBe(0);
    expect(dependencies.requiredChecks).toHaveBeenCalledTimes(2); expect(dependencies.current).toHaveBeenCalledTimes(2);
    expect(test.preflight).not.toHaveBeenCalled(); expect(test.registry.writeAdmission).not.toHaveBeenCalled();
    expect(test.fetcher).toHaveBeenCalledTimes(2); expect(test.saved().releaseRuns).toEqual([]);
    expect(test.saved().resources.images).toEqual([]); expect(test.saved()).not.toHaveProperty("lease");
    expect(test.saved().generation).toBe(test.state.generation);
  });
  it("keeps a missing starting allocation fenced without creating or executing work", async () => {
    const test = fixture("alpha"); test.state.resources.images = [];
    test.run.canaries.push({ ...workerConnections()[0], id: "88888888-8888-4888-8888-888888888888", startedAt: Date.now(),
      phase: "starting", qualificationProfile: "full", image: { snapshotId: "synthetic-image", sourceCommit: test.run.sourceSha, buildSha256: "b".repeat(64) } });
    test.state.releaseRuns.push(test.run);
    await expect(reconcileWorkerNativeStorage(test.env)).rejects.toThrow("historical allocation journal is missing or ambiguous");
    expect(test.preflight).not.toHaveBeenCalled(); expect(test.registry.writeAdmission).not.toHaveBeenCalled();
    expect(test.saved().releaseRuns).toEqual([test.run]); expect(test.saved().resources.images).toEqual([]);
  });
});
