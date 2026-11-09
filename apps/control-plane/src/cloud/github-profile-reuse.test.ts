import { expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { CloudGithubConnections, GITHUB_PROFILE_REUSE_MS, RecentGithubProfiles } from "./github-connections.js";

it("reuses a token's /user answer for 30 s, per token, and bounds what it keeps", () => {
  let now = 0;
  const profiles = new RecentGithubProfiles(() => now, 2);
  profiles.remember("token-a", { id: "1", login: "a" });
  now = GITHUB_PROFILE_REUSE_MS - 1;
  expect(profiles.recent("token-a")).toEqual({ id: "1", login: "a" });
  expect(profiles.recent("token-b")).toBeUndefined();
  now = GITHUB_PROFILE_REUSE_MS;
  expect(profiles.recent("token-a")).toBeUndefined();
  profiles.remember("token-a", { id: "1", login: "a" });
  profiles.remember("token-b", { id: "2", login: "b" });
  profiles.remember("token-c", { id: "3", login: "c" });
  expect([profiles.recent("token-a"), profiles.recent("token-b")?.id, profiles.recent("token-c")?.id]).toEqual([undefined, "2", "3"]);
});

function connections(fetcher: ReturnType<typeof vi.fn>) {
  const snapshot = (token: string, id = "12") => ({ material: { accessToken: token, expiresAt: null }, identity: { id, login: "contributor" }, generation: "g", assertCurrent: async () => {} });
  const store = { credential: vi.fn(async () => snapshot("token-a")) };
  return { github: new CloudGithubConnections(store as never, null, fetcher as unknown as typeof fetch), snapshot };
}
const userFetcher = () => vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
  const token = new Headers(init?.headers).get("authorization") ?? "";
  if (new URL(String(value)).pathname !== "/user") throw new Error("unexpected");
  return Response.json(token.includes("token-b") ? { id: 13, login: "other" } : { id: 12, login: "contributor", name: "Fixture" });
});

it("runs the caller's fence on a reused profile, and fails closed when it throws", async () => {
  const fetcher = userFetcher(), { github, snapshot } = connections(fetcher);
  await github.access({ organizationId: "org", userId: "user" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const fence = new Error("fence");
  await expect(github.workerProfile(snapshot("token-a") as never, async () => { throw fence; })).rejects.toBe(fence);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("never serves one token's profile for another token, and still checks the credential's GitHub identity", async () => {
  const fetcher = userFetcher(), { github, snapshot } = connections(fetcher);
  await github.access({ organizationId: "org", userId: "user" });
  expect(await github.workerProfile(snapshot("token-b", "13") as never, async () => {})).toMatchObject({ id: "13", login: "other" });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await expect(github.workerProfile(snapshot("token-a", "99") as never, async () => {})).rejects.toBeInstanceOf(HttpError);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
