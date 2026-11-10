import type pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { GithubTemporaryError } from "../github-availability.js";
import { CLOUD_SOURCE_ADMISSION_MS, CLOUD_SOURCE_RENEWAL_MS, CloudV2SourceAuthority } from "./source-authority.js";
import type { GithubVerification, GithubVerificationStore } from "./github-verification-store.js";
import type { CloudV2Workspace } from "./store.js";

vi.mock("../db.js", () => ({ withSystemTx: async (pool: unknown, run: (tx: unknown) => unknown) => run(pool) }));
afterEach(() => { vi.useRealTimers(); });

// A positive this old has just entered its final renewal window.
const AGING = CLOUD_SOURCE_ADMISSION_MS - CLOUD_SOURCE_RENEWAL_MS + 1000;

function fixture(age: number) {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  // One durable row per repository, as PostgresGithubVerificationStore keeps.
  let record: GithubVerification = { verifiedAt: Date.now() - age, retryAt: 0, failures: 0, failure: null,
    claimId: null, claimUntil: 0, claimStartedAt: 0 };
  const store = {
    read: vi.fn(async () => ({ ...record })),
    backoff: vi.fn(async () => null),
    claim: vi.fn(async (_scope: unknown, renewAfterMs = CLOUD_SOURCE_ADMISSION_MS) => {
      if (record.claimId && record.claimUntil > Date.now()) return null;
      if (record.verifiedAt !== null && !record.failure && record.verifiedAt > Date.now() - renewAfterMs) return null;
      record = { ...record, claimId: "renewal", claimUntil: Date.now() + 60_000, claimStartedAt: Date.now() };
      return { ...record };
    }),
    finish: vi.fn(async (_scope: unknown, _claim: string, result: Parameters<GithubVerificationStore["finish"]>[2]) => {
      record = { ...record, verifiedAt: result.allowed ? record.claimStartedAt : result.temporary ? record.verifiedAt : null,
        failure: result.allowed ? null : result.error, retryAt: result.allowed ? 0 : Date.now() + result.retryAfterMs,
        claimId: null, claimUntil: 0 };
      return { ...record };
    }),
    release: vi.fn(async () => { record = { ...record, claimId: null, claimUntil: 0, claimStartedAt: 0 }; }),
  } satisfies GithubVerificationStore;
  const github = { fingerprintFor: vi.fn(async () => "fingerprint"), check: vi.fn(async () => "fingerprint") };
  const pool = { query: vi.fn(async () => ({ rows: [{ source_repositories: ["o/r"] }] })) } as unknown as pg.Pool;
  const source = new CloudV2SourceAuthority(pool, github, () => Date.now(),
    async () => [{ repository: "o/r", repositoryId: "42" }], store, () => 0);
  const workspace = (state: CloudV2Workspace["state"]) =>
    ({ id: "w", organizationId: "org", creatorUserId: "user", repository: "o/r", state }) as CloudV2Workspace;
  return { source, store, github, workspace, record: () => record, update: (value: Partial<GithubVerification>) => { record = { ...record, ...value }; } };
}

// The lifecycle checks a booting workspace's sources seconds before its
// worker's hello. A positive that expires in between left that hello to
// verify GitHub on the critical path. Only the lifecycle asks to renew.
it.each(["creating", "starting"] as const)("renews a %s workspace's positive in its final seconds without waiting for GitHub", async state => {
  const f = fixture(AGING);
  let verified!: (fingerprint: string) => void;
  f.github.check.mockImplementationOnce(() => new Promise(resolve => { verified = resolve; }));
  await f.source.workspace(f.workspace(state), true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.github.check).toHaveBeenCalledTimes(1);
  verified("fingerprint");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.claim).toHaveBeenCalledWith(expect.objectContaining({ repositoryId: "42" }), CLOUD_SOURCE_ADMISSION_MS - CLOUD_SOURCE_RENEWAL_MS);
  expect(f.store.finish).toHaveBeenCalledWith(expect.anything(), "renewal", { allowed: true });
  expect(f.record()).toMatchObject({ verifiedAt: 100_000, failure: null, claimId: null });
  // The hello arrives after the original positive would have expired.
  await vi.advanceTimersByTimeAsync(CLOUD_SOURCE_RENEWAL_MS - 500);
  expect(Date.now() - (100_000 - AGING)).toBeGreaterThan(CLOUD_SOURCE_ADMISSION_MS);
  await f.source.workspace(f.workspace(state), true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.github.check).toHaveBeenCalledTimes(1);
});

it.each([
  ["creating", AGING - 2000], ["running", CLOUD_SOURCE_ADMISSION_MS - 1000], ["stopped", CLOUD_SOURCE_ADMISSION_MS - 1000],
] as const)("keeps a %s workspace's %i ms old positive without a renewal", async (state, age) => {
  const f = fixture(age);
  await f.source.workspace(f.workspace(state), true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.store.claim).not.toHaveBeenCalled();
  expect(f.github.check).not.toHaveBeenCalled();
});

it.each([new GithubTemporaryError("github_unavailable"), new GithubTemporaryError("github_rate_limited", 120_000)])(
  "keeps the positive in force after a temporary renewal failure (%s), retrying only once it expires", async failure => {
  const f = fixture(AGING);
  f.github.check.mockRejectedValueOnce(failure);
  await f.source.workspace(f.workspace("creating"), true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.release).toHaveBeenCalledWith(expect.objectContaining({ repositoryId: "42" }), "renewal");
  expect(f.store.finish).not.toHaveBeenCalled();
  expect(f.record()).toMatchObject({ verifiedAt: 100_000 - AGING, failure: null, claimId: null, retryAt: 0 });
  // Later booting checks inside the original positive pass without a retry.
  await vi.advanceTimersByTimeAsync(5000);
  await f.source.workspace(f.workspace("creating"), true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.github.check).toHaveBeenCalledTimes(1);
  // Once it expires, admission verifies as before.
  await vi.advanceTimersByTimeAsync(CLOUD_SOURCE_RENEWAL_MS);
  await f.source.workspace(f.workspace("creating"), true);
  expect(f.github.check).toHaveBeenCalledTimes(2);
});

it("withdraws the positive as soon as a renewal confirms the creator lost access", async () => {
  const f = fixture(AGING);
  const denied = new HttpError(404, "github_repository_not_found", "Repository access could not be verified.");
  f.github.check.mockRejectedValueOnce(denied);
  await f.source.workspace(f.workspace("creating"), true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.finish).toHaveBeenCalledWith(expect.anything(), "renewal", expect.objectContaining({ allowed: false, temporary: false, error: denied }));
  expect(f.store.release).not.toHaveBeenCalled();
  await expect(f.source.workspace(f.workspace("creating"), true)).rejects.toBe(denied);
  expect(f.github.check).toHaveBeenCalledTimes(1);
});

it("leaves a renewal another replica already claimed to that replica", async () => {
  const f = fixture(AGING);
  f.update({ claimId: "peer", claimUntil: Date.now() + 60_000, claimStartedAt: Date.now() });
  await f.source.workspace(f.workspace("creating"), true);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.github.check).not.toHaveBeenCalled();
  expect(f.store.release).not.toHaveBeenCalled();
});

it("starts one renewal for concurrent booting checks", async () => {
  const f = fixture(AGING);
  let verified!: (fingerprint: string) => void;
  f.github.check.mockImplementationOnce(() => new Promise(resolve => { verified = resolve; }));
  await Promise.all([f.source.workspace(f.workspace("creating"), true), f.source.workspace(f.workspace("creating"), true)]);
  await vi.advanceTimersByTimeAsync(0);
  await f.source.workspace(f.workspace("starting"), true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.github.check).toHaveBeenCalledTimes(1);
  verified("fingerprint");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.finish).toHaveBeenCalledTimes(1);
});

it("never queues the creator's other verifications behind a held renewal", async () => {
  const f = fixture(AGING);
  let verified!: (fingerprint: string) => void;
  f.github.check.mockImplementationOnce(() => new Promise(resolve => { verified = resolve; }));
  await f.source.workspace(f.workspace("creating"), true);
  await vi.advanceTimersByTimeAsync(0);
  const other = f.source.repository("org", "user", "o/other");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.github.check).toHaveBeenCalledTimes(2);
  await other;
  verified("fingerprint");
});

it("keeps a booting workspace's other checks, such as its hello and status polls, from renewing", async () => {
  const f = fixture(AGING);
  await f.source.workspace(f.workspace("creating"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.store.claim).not.toHaveBeenCalled();
  expect(f.github.check).not.toHaveBeenCalled();
});

// Co-master review 7: when every booting check could renew, a workspace polled
// every 2 s renewed every ~15 s, doubling GitHub verifications on long boots.
it("adds at most one verification to a booting workspace polled every 2 s for two minutes", async () => {
  const verifications = async (lifecycleRenews: boolean) => {
    const f = fixture(AGING);
    await f.source.workspace(f.workspace("starting"), lifecycleRenews);
    for (let elapsed = 0; elapsed < 120_000; elapsed += 2000) {
      await vi.advanceTimersByTimeAsync(2000);
      await f.source.workspace(f.workspace("starting"));
    }
    return f.github.check.mock.calls.length;
  };
  // Without renewal, polling verifies once per expired 30 s window.
  const windows = Math.ceil(120_000 / CLOUD_SOURCE_ADMISSION_MS);
  expect(await verifications(false)).toBe(windows);
  expect(await verifications(true)).toBeLessThanOrEqual(windows + 1);
});

// A create request checks its requested repository by target, before any
// workspace exists; it asks to renew as the lifecycle does.
it("renews a create's requested repository by target only when asked", async () => {
  const quiet = fixture(AGING);
  await quiet.source.targets("org", "user", [{ repository: "o/r", repositoryId: "42" }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(quiet.store.claim).not.toHaveBeenCalled();
  const f = fixture(AGING);
  await f.source.targets("org", "user", [{ repository: "o/r", repositoryId: "42" }], true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.github.check).toHaveBeenCalledTimes(1);
  expect(f.store.finish).toHaveBeenCalledWith(expect.anything(), "renewal", { allowed: true });
});

// A create that returned before its GitHub checks has no scope yet. Any check
// that doesn't skip it on purpose refuses it, without asking GitHub.
it.each([[false], [true]])("refuses a pending create's sources without a GitHub check (renew %s)", async renew => {
  const f = fixture(AGING);
  const pool = { query: vi.fn(async () => ({ rows: [{ source_repositories: null, source_pending: true }] })) } as unknown as pg.Pool;
  const source = new CloudV2SourceAuthority(pool, f.github, () => Date.now(), async () => [{ repository: "o/r", repositoryId: "42" }], f.store, () => 0);
  await expect(source.workspace(f.workspace("creating"), renew)).rejects.toMatchObject({ status: 409, code: "cloud_source_pending" });
  await expect(source.continueWorkspace(f.workspace("creating"))).rejects.toMatchObject({ code: "cloud_source_pending" });
  expect(f.github.check).not.toHaveBeenCalled();
  expect(f.store.read).not.toHaveBeenCalled();
});
