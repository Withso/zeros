import type pg from "pg";
import { expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { GithubTemporaryError } from "../github-availability.js";
import { CloudV2SourceAuthority, CLOUD_SOURCE_GRACE_MS, CLOUD_SOURCE_REFRESH_MS } from "./source-authority.js";
import type { CloudV2Workspace } from "./store.js";
import type { GithubVerification, GithubVerificationStore } from "./github-verification-store.js";

vi.mock("../db.js", () => ({ withSystemTx: async (pool: unknown, run: (tx: unknown) => unknown) => run(pool) }));

function fixture(store?: GithubVerificationStore) {
  let now = 1000, generation = "original", repositoryId = "42";
  const pool = { query: vi.fn(async () => ({ rows: [{ source_repositories: ["former/project"] }] })) };
  const github = { fingerprintFor: vi.fn(async () => generation), check: vi.fn(async () => generation) };
  const targets = vi.fn(async () => [{ repository: "former/project", repositoryId }]);
  const source = new CloudV2SourceAuthority(pool as unknown as pg.Pool, github, () => now, targets, store, () => 0);
  const workspace = { id: "workspace", organizationId: "org", creatorUserId: "user", repository: "former/project", state: "running" } as CloudV2Workspace;
  const proof = { accessEpoch: "1", loginRevision: "2" };
  return { source, workspace, proof, github, pool, targets,
    time: (value: number) => { now = value; }, reconnect: () => { generation = "successor"; },
    replace: () => { repositoryId = "99"; } };
}

it("reuses the exact admitted workspace proof without GitHub or additional database reads", async () => {
  const f = fixture();
  await f.source.workspace(f.workspace);
  await f.source.continueWorkspace(f.workspace, f.proof);
  vi.clearAllMocks();
  for (let second = 1; second < 10 * 60; second++) {
    f.time(1000 + second * 1000);
    await f.source.continueWorkspace(f.workspace, f.proof);
  }
  expect(f.github.check).not.toHaveBeenCalled();
  expect(f.github.fingerprintFor).not.toHaveBeenCalled();
  expect(f.pool.query).not.toHaveBeenCalled();
  expect(f.targets).not.toHaveBeenCalled();
});

it.each(["github_unavailable", "github_rate_limited"] as const)("keeps work responsive while %s refreshes in the background, with bounded retries", async code => {
  const f = fixture();
  await f.source.workspace(f.workspace);
  let reject!: (error: unknown) => void;
  f.github.check.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  f.time(1001 + CLOUD_SOURCE_REFRESH_MS);
  const lease = await f.source.continueWorkspace(f.workspace, f.proof);
  expect(lease.refresh).toBeDefined();
  expect(f.github.check).toHaveBeenCalledTimes(2);
  reject(new GithubTemporaryError(code, 120_000));
  await expect(lease.refresh).rejects.toMatchObject({ code });
  const grace = await f.source.continueWorkspace(f.workspace, f.proof);
  expect(grace.recheckAt).toBe(1001 + CLOUD_SOURCE_REFRESH_MS + 120_000);
  vi.clearAllMocks();
  for (let i = 0; i < 100; i++) await f.source.continueWorkspace(f.workspace, f.proof);
  expect(f.github.check).not.toHaveBeenCalled();
  expect(f.pool.query).not.toHaveBeenCalled();
  await expect(f.source.workspace(f.workspace)).rejects.toMatchObject({ code });
  expect(f.github.check).not.toHaveBeenCalled();
});

it("does not extend the original grace deadline after repeated outages or idle activity", async () => {
  const f = fixture();
  await f.source.workspace(f.workspace);
  f.github.check.mockRejectedValue(new GithubTemporaryError("github_unavailable"));
  for (const elapsed of [10, 20, 40, 59]) {
    f.time(1000 + elapsed * 60_000);
    const lease = await f.source.continueWorkspace(f.workspace, f.proof);
    await lease.refresh?.catch(() => {});
    expect(lease.recheckAt).toBeLessThanOrEqual(1000 + CLOUD_SOURCE_GRACE_MS);
  }
  f.time(1000 + CLOUD_SOURCE_GRACE_MS);
  await expect(f.source.continueWorkspace(f.workspace, f.proof)).rejects.toMatchObject({ code: "github_unavailable" });
});

it.each(["github_refresh_pending", "github_refresh_uncertain", "github_oauth_failed", "github_bad_response"])(
  "retains an existing grant during %s without treating it as an explicit GitHub denial", async code => {
    const f = fixture();
    await f.source.workspace(f.workspace);
    f.time(1001 + CLOUD_SOURCE_REFRESH_MS);
    f.github.check.mockRejectedValue(new HttpError(503, code, "temporary verification failure"));
    const lease = await f.source.continueWorkspace(f.workspace, f.proof);
    await expect(lease.refresh).rejects.toMatchObject({ code });
    await expect(f.source.continueWorkspace(f.workspace, f.proof)).resolves.toMatchObject({ recheckAt: expect.any(Number) });
    await expect(f.source.workspace(f.workspace)).rejects.toMatchObject({ code });
  });

it.each([
  [403, "github_cloud_access_denied"], [404, "github_repository_unavailable"],
  [409, "github_authorization_expired"], [403, "github_sso_required"],
] as const)("never retains a grant after a confirmed %s/%s response", async (status, code) => {
  const f = fixture();
  await f.source.workspace(f.workspace);
  f.time(1001 + CLOUD_SOURCE_REFRESH_MS);
  f.github.check.mockRejectedValue(new HttpError(status, code, "Access refused"));
  await expect(f.source.continueWorkspace(f.workspace, f.proof).then(lease => lease.refresh)).rejects.toMatchObject({ code });
  await expect(f.source.continueWorkspace(f.workspace, f.proof)).rejects.toMatchObject({ code });
});

it("cannot use a previous connection's grace after its durable login revision changes", async () => {
  const f = fixture();
  await f.source.workspace(f.workspace);
  await f.source.continueWorkspace(f.workspace, f.proof);
  f.reconnect();
  f.github.check.mockRejectedValue(new GithubTemporaryError("github_unavailable"));
  await expect(f.source.continueWorkspace(f.workspace, { ...f.proof, loginRevision: "3" })).rejects.toMatchObject({ code: "github_unavailable" });
});

it("rechecks positive source observations when the server revision changes without a notification", async () => {
  const f = fixture();
  await f.source.workspace(f.workspace);
  await f.source.continueWorkspace(f.workspace, f.proof);
  f.github.check.mockRejectedValue(new HttpError(403, "github_cloud_access_denied", "denied"));
  await expect(f.source.continueWorkspace(f.workspace, { ...f.proof, loginRevision: "3" })).rejects.toMatchObject({ code: "github_cloud_access_denied" });
});

it("requires positive authority for every original ID, including after cache invalidation", async () => {
  const f = fixture();
  await f.source.workspace(f.workspace);
  await f.source.continueWorkspace(f.workspace, f.proof);
  f.replace(); f.source.invalidate({ organizationId: "org", userId: "user" });
  f.github.check.mockRejectedValue(new GithubTemporaryError("github_unavailable"));
  await expect(f.source.continueWorkspace(f.workspace, f.proof)).rejects.toMatchObject({ code: "github_unavailable" });
  expect(f.github.check).toHaveBeenLastCalledWith(expect.objectContaining({ repositoryIds: ["99"] }));
});

it("does not offer outage grace to a cold or stopped workspace", async () => {
  const f = fixture();
  f.github.check.mockRejectedValue(new GithubTemporaryError("github_unavailable"));
  await expect(f.source.continueWorkspace(f.workspace, f.proof)).rejects.toMatchObject({ code: "github_unavailable" });
  const warmed = fixture();
  await warmed.source.workspace(warmed.workspace);
  warmed.time(1001 + CLOUD_SOURCE_REFRESH_MS);
  warmed.github.check.mockRejectedValue(new GithubTemporaryError("github_unavailable"));
  await expect(warmed.source.continueWorkspace({ ...warmed.workspace, state: "stopped" }, warmed.proof)).rejects.toMatchObject({ code: "github_unavailable" });
});

it("coalesces a refresh across concurrent continuations and keeps a fresh admission strict", async () => {
  const f = fixture();
  await f.source.workspace(f.workspace);
  f.time(1001 + CLOUD_SOURCE_REFRESH_MS);
  let finish!: (value: string) => void;
  f.github.check.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const leases = await Promise.all(Array.from({ length: 50 }, () => f.source.continueWorkspace(f.workspace, f.proof)));
  expect(f.github.check).toHaveBeenCalledTimes(2);
  let admitted = false;
  const admission = f.source.workspace(f.workspace).then(() => { admitted = true; });
  await Promise.resolve();
  expect(admitted).toBe(false);
  finish("original");
  await Promise.all([admission, ...leases.map(lease => lease.refresh)]);
  expect(admitted).toBe(true);
  expect(f.github.check).toHaveBeenCalledTimes(2);
});

it("cannot publish a continuation captured before an invalidation arrived", async () => {
  const f = fixture();
  await f.source.workspace(f.workspace);
  let release!: () => void;
  f.github.fingerprintFor.mockResolvedValueOnce("original").mockImplementationOnce(() => new Promise(resolve => {
    release = () => resolve("original");
  }));
  const pending = f.source.continueWorkspace(f.workspace, f.proof);
  const rejected = expect(pending).rejects.toMatchObject({ code: "github_authorization_changed" });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  f.source.invalidate({ organizationId: "org", userId: "user" });
  f.github.check.mockRejectedValue(new GithubTemporaryError("github_unavailable"));
  release();
  await rejected;
  await expect(f.source.continueWorkspace(f.workspace, f.proof)).rejects.toMatchObject({ code: "github_unavailable" });
});

it("withdraws sibling workspace leases immediately when a shared source is denied", async () => {
  const f = fixture(), sibling = { ...f.workspace, id: "sibling" };
  await f.source.workspace(f.workspace);
  await f.source.continueWorkspace(sibling, f.proof);
  f.time(32_000);
  f.github.check.mockRejectedValue(new HttpError(403, "github_cloud_access_denied", "denied"));
  await expect(f.source.workspace(f.workspace)).rejects.toMatchObject({ code: "github_cloud_access_denied" });
  await expect(f.source.continueWorkspace(sibling, f.proof)).rejects.toMatchObject({ code: "github_cloud_access_denied" });
});

it("backs off different repositories on the same connection after a provider limit", async () => {
  const f = fixture();
  f.github.check.mockRejectedValue(new GithubTemporaryError("github_rate_limited", 300_000));
  await expect(f.source.repository("org", "user", "former/project")).rejects.toMatchObject({ code: "github_rate_limited" });
  await expect(f.source.repository("org", "user", "former/another")).rejects.toMatchObject({ code: "github_rate_limited" });
  expect(f.github.check).toHaveBeenCalledTimes(1);
});

it("keeps a multi-repository workspace hot during an actor-wide cooldown", async () => {
  const now = 1001 + CLOUD_SOURCE_REFRESH_MS;
  const positive: GithubVerification = { verifiedAt: 1000, retryAt: 0, failure: null, failures: 0, claimId: null, claimUntil: 0, claimStartedAt: 0 };
  const records = new Map([["42", { ...positive }], ["43", { ...positive }]]);
  const store: GithubVerificationStore = {
    read: vi.fn(async scope => records.get(scope.repositoryId) ?? null),
    backoff: vi.fn(async () => null),
    claim: vi.fn(async scope => ({ ...records.get(scope.repositoryId)!, claimId: "claim", claimUntil: now + 60_000, claimStartedAt: now })),
    finish: vi.fn(async (scope, _claim, result) => {
      if (result.allowed) throw new Error("fixture expects a provider outage");
      const value = { ...positive, failure: result.error, failures: 1, retryAt: now + result.retryAfterMs };
      records.set(scope.repositoryId, value); return value;
    }),
  };
  const f = fixture(store);
  f.pool.query.mockResolvedValue({ rows: [{ source_repositories: ["former/project", "former/another"] }] });
  f.targets.mockResolvedValue([{ repository: "former/project", repositoryId: "42" }, { repository: "former/another", repositoryId: "43" }]);
  await f.source.continueWorkspace(f.workspace, f.proof);
  f.time(now);
  f.github.check.mockRejectedValue(new GithubTemporaryError("github_rate_limited", 300_000));
  const first = await f.source.continueWorkspace(f.workspace, f.proof);
  await first.refresh?.catch(() => {});
  const cooled = await f.source.continueWorkspace(f.workspace, f.proof);
  expect(cooled.refresh).toBeUndefined();
  expect(cooled.recheckAt).toBe(now + 300_000);
  vi.clearAllMocks();
  for (let i = 0; i < 50; i++) await f.source.continueWorkspace(f.workspace, f.proof);
  expect(f.github.check).not.toHaveBeenCalled();
  expect(store.read).not.toHaveBeenCalled();
  expect(store.backoff).not.toHaveBeenCalled();
  expect(f.pool.query).not.toHaveBeenCalled();
});
