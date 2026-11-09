import type pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { CloudV2SourceAuthority } from "./source-authority.js";
import type { GithubVerification, GithubVerificationStore } from "./github-verification-store.js";

vi.mock("../db.js", () => ({ withSystemTx: async (pool: unknown, run: (tx: unknown) => unknown) => run(pool) }));
afterEach(() => { vi.useRealTimers(); });
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(claimed = true) {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  let fingerprint = "original";
  let record: GithubVerification | null = claimed ? {
    verifiedAt: null, retryAt: 0, failures: 0, failure: null,
    claimId: "peer-claim", claimUntil: 61_000, claimStartedAt: 1000,
  } : null;
  const read = gate<void>(), verifying = gate<void>(), release = gate<string>();
  const store: GithubVerificationStore = {
    read: vi.fn(async () => { read.resolve(); return record && { ...record }; }),
    backoff: vi.fn(async () => null),
    claim: vi.fn(async () => {
      if (record?.claimId) return null;
      record = { verifiedAt: null, retryAt: 0, failures: 0, failure: null,
        claimId: "our-claim", claimUntil: Date.now() + 60_000, claimStartedAt: Date.now() };
      return { ...record };
    }),
    finish: vi.fn(async (_scope, _id, result) => {
      record = { ...record!, verifiedAt: result.allowed ? record!.claimStartedAt : null,
        failure: result.allowed ? null : result.error, claimId: null, claimUntil: 0 };
      return { ...record };
    }),
  };
  const github = { fingerprintFor: vi.fn(async () => fingerprint), check: vi.fn(async () => {
    verifying.resolve(); return release.promise;
  }) };
  const source = new CloudV2SourceAuthority({} as pg.Pool, github, () => Date.now(), undefined, store, () => 0);
  const request = () => source.targets("org", "user", [{ repository: "o/r", repositoryId: "42" }]);
  return { source, store, github, read, verifying, release, request,
    complete: (failure: HttpError | null = null) => {
      record = { ...record!, verifiedAt: failure ? null : record!.claimStartedAt,
        failure, retryAt: failure ? Date.now() + 60_000 : 0, claimId: null, claimUntil: 0 };
    },
    reconnect: () => { fingerprint = "successor"; },
  };
}

it("joins a local verification even after its durable claim becomes visible to another admission", async () => {
  const f = fixture(false);
  const first = f.request();
  await f.verifying.promise;
  const second = f.request().then(() => ({ ok: true }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.github.check).toHaveBeenCalledTimes(1);
  f.release.resolve("original");
  await first;
  await vi.advanceTimersByTimeAsync(1000);
  expect(await second).toEqual({ ok: true });
  expect(f.github.check).toHaveBeenCalledTimes(1);
});

it("waits for the exact peer claim and reuses its fresh result without another provider request", async () => {
  const f = fixture();
  const pending = f.request().then(() => ({ ok: true }), error => ({ error }));
  await f.read.promise;
  await vi.advanceTimersByTimeAsync(0);
  f.complete();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toEqual({ ok: true });
  expect(f.github.check).not.toHaveBeenCalled();
});

it("propagates a peer's terminal refusal instead of converting contention into busy", async () => {
  const f = fixture();
  const pending = f.request().catch(error => error);
  await f.read.promise;
  await vi.advanceTimersByTimeAsync(0);
  f.complete(new HttpError(403, "github_cloud_access_denied", "Refused"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({ code: "github_cloud_access_denied", status: 403 });
  expect(f.github.check).not.toHaveBeenCalled();
});

it.each(["revision", "fingerprint"])("fences a shared result after %s changes while waiting", async change => {
  const f = fixture();
  const pending = f.request().catch(error => error);
  await f.read.promise;
  await vi.advanceTimersByTimeAsync(0);
  if (change === "revision") f.source.invalidate({ organizationId: "org", userId: "user" });
  else f.reconnect();
  f.complete();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({ code: "github_authorization_changed" });
});

it("bounds peer-claim waiting without stealing a live claim or extending its deadline", async () => {
  const f = fixture();
  let settled = false;
  const pending = f.request().catch(error => { settled = true; return error; });
  await f.read.promise;
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
  expect(await pending).toMatchObject({ code: "github_verification_busy" });
  expect(f.store.claim).not.toHaveBeenCalled();
  expect(f.github.check).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("includes a slow fingerprint read in the original verification wait budget", async () => {
  const f = fixture(), fingerprint = gate<string>();
  f.github.fingerprintFor.mockReturnValueOnce(fingerprint.promise);
  let settled = false;
  const pending = f.request().catch(error => { settled = true; return error; });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(settled).toBe(true);
  expect(await pending).toMatchObject({ code: "github_verification_busy" });
  fingerprint.resolve("original"); await vi.advanceTimersByTimeAsync(0);
  expect(f.store.claim).not.toHaveBeenCalled(); expect(f.github.check).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("shares one deadline across multiple repository waits", async () => {
  const f = fixture(false), first = gate<string>(), second = gate<string>();
  f.github.check.mockImplementationOnce(async () => first.promise).mockImplementationOnce(async () => second.promise);
  let settled = false;
  const pending = f.source.repositories("org", "user", ["o/first", "o/second"]).catch(error => { settled = true; return error; });
  await vi.advanceTimersByTimeAsync(4_000); first.resolve("original");
  await vi.advanceTimersByTimeAsync(0); expect(f.github.check).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(999); expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(settled).toBe(true);
  expect(await pending).toMatchObject({ code: "github_verification_busy" });
  second.resolve("original"); await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("handles a fingerprint rejection when an earlier source exhausted the shared deadline", async () => {
  const f = fixture(false);
  f.github.check.mockImplementationOnce(async () => { await f.release.promise; vi.setSystemTime(6_000); return "original"; });
  f.github.fingerprintFor.mockResolvedValueOnce("original").mockResolvedValueOnce("original")
    .mockRejectedValueOnce(new Error("late fingerprint read failed"));
  // Another owner: one owner's repositories share a single fingerprint read.
  const pending = f.source.repositories("org", "user", ["o/first", "p/second"]).catch(error => error);
  await vi.advanceTimersByTimeAsync(0); f.release.resolve("original");
  expect(await pending).toMatchObject({ code: "github_verification_busy" });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.github.fingerprintFor).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
