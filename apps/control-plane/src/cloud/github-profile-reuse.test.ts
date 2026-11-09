import { expect, it } from "vitest";
import { GITHUB_PROFILE_REUSE_MS, RecentGithubProfiles } from "./github-connections.js";

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
