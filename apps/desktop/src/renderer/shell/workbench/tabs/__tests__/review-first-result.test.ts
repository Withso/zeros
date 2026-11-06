import { expect, it, vi } from "vitest";
import type { PR, PrChecksResult } from "../../../../platform/git";
import type { ReviewProvider } from "../../../pr/review-provider";
import { peekReviewLiveData, prefetchReviewLiveData } from "../review-data";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const cloud = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const pr = { number: 42, title: "Confirmed PR", state: "ready", headBranch: "topic", baseBranch: "main" } as PR;
const checks = { checks: [], deployments: [], total: 0, passed: 0, pending: 0, failed: 0 } as PrChecksResult;
function provider(cacheKey: string): ReviewProvider {
  return { family: "github", hostOrigin: "github.com", hostLabel: "GitHub", cacheKey,
    capabilities: { reviewNoun: "pull request", mergeMethods: [] },
    authStatus: vi.fn(async () => ({ authenticated: true, login: "contributor" })),
    getPr: vi.fn(async () => pr), getChecks: vi.fn(async () => checks), getCommits: vi.fn(async () => []), getTimeline: vi.fn(async () => []),
    addComment: async () => ({ id: 1, url: "" }), merge: async () => ({ sha: "abc" }), markReady: async () => pr };
}

it("starts a cloud PR read without waiting for a separate authentication request", async () => {
  const auth = deferred<{ authenticated: boolean }>(), source = provider("first-result-cloud");
  source.authStatus = vi.fn(() => auth.promise);
  const pending = prefetchReviewLiveData(source, cloud, 42);
  try {
    await flush();
    expect(source.getPr).toHaveBeenCalledOnce();
    expect(peekReviewLiveData(source, cloud, 42).pr).toBe(pr);
  } finally { auth.resolve({ authenticated: true }); await pending; }
});

it.each(["personal-workspace", "organization-local-workspace", cloud])(
  "publishes the confirmed PR while its checks are still pending for %s", async workspaceId => {
    const held = deferred<PrChecksResult>(), source = provider(`first-result-${workspaceId}`);
    source.getChecks = vi.fn(() => held.promise);
    const pending = prefetchReviewLiveData(source, workspaceId, 42);
    try {
      await flush();
      expect(source.getChecks).toHaveBeenCalledOnce();
      expect(peekReviewLiveData(source, workspaceId, 42)).toMatchObject({ pr, checks: null, refreshing: true });
    } finally { held.resolve(checks); await pending; }
  },
);

it.each(["personal-workspace", "organization-local-workspace", cloud])(
  "keeps an authentication failure visible when a sibling PR read finishes later for %s", async workspaceId => {
    const held = deferred<PR>(), source = provider(`auth-race-${workspaceId}`);
    source.getPr = vi.fn(() => held.promise);
    source.getChecks = vi.fn(async () => { throw { code: "NOT_AUTHENTICATED", message: "Sign in again" }; });
    const pending = prefetchReviewLiveData(source, workspaceId, 42);
    await flush();
    expect(peekReviewLiveData(source, workspaceId, 42).authed).toBe(false);
    held.resolve(pr); await pending;
    expect(peekReviewLiveData(source, workspaceId, 42).authed).toBe(false);
  },
);
