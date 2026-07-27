// O4c — the team layer: precedence (user < TEAM < repo) and the
// in-memory team-context slot the renderer couriers into.

import { describe, expect, it } from "vitest";
import { resolveSettings } from "../resolve";
import {
  clearTeamContext,
  getTeamContextMeta,
  getTeamDoc,
  setTeamContext,
} from "../team-context";

describe("team settings layer", () => {
  it("sits between user and repo in precedence", () => {
    // Probed with [git] keys — a table every layer still carries (env left the
    // repo files in the 2026-07-17 slimming, so it can't probe the repo side).
    const resolved = resolveSettings({
      user: {
        git: { remote: "user", base_branch: "user", branch_prefix_type: "user" },
      },
      team: { git: { base_branch: "team", branch_prefix_type: "team" } },
      repo: { git: { branch_prefix_type: "repo" } },
    });
    const git = resolved.effective.git as Record<string, string>;
    expect(git.remote).toBe("user");
    expect(git.base_branch).toBe("team"); // team overrides user
    expect(git.branch_prefix_type).toBe("repo"); // repo overrides team
    expect(resolved.sources["git.base_branch"]).toBe("team");
  });

  it("drops user-only keys from the team layer with a warning", () => {
    const resolved = resolveSettings({
      team: { providers: { claude: { auth: "api-key" } }, env: { X: "1" } },
    });
    expect(resolved.effective.providers).toBeUndefined();
    expect((resolved.effective.env as Record<string, string>).X).toBe("1");
    expect(resolved.warnings.some((w) => w.startsWith("team:"))).toBe(true);
  });
});

describe("team context slot", () => {
  it("stores and clears", () => {
    setTeamContext({
      teamId: "team-1",
      doc: { env: { A: "1" } },
    });
    expect(getTeamContextMeta()).toEqual({ teamId: "team-1" });
    expect(getTeamDoc()).toEqual({ env: { A: "1" } });
    clearTeamContext();
    expect(getTeamDoc()).toBeNull();
    expect(getTeamContextMeta()).toEqual({ teamId: null });
  });
});
