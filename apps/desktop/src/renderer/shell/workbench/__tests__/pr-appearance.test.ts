import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { observePullRequestAppearance } from "../pr-appearance";

describe("a pull request appearing", () => {
  it("is a seen null turning into a number under the same key, never a switch to another repository that has one", () => {
    const seen = new Map<string, number | null>();
    const key = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    expect(observePullRequestAppearance(seen, `${key}/web`, null)).toBe(false);
    // Switching to api, which already has #4: first sight of api's key.
    expect(observePullRequestAppearance(seen, `${key}/api`, 4)).toBe(false);
    // Back to web, then web's own pull request opens.
    expect(observePullRequestAppearance(seen, `${key}/web`, null)).toBe(false);
    expect(observePullRequestAppearance(seen, `${key}/web`, 9)).toBe(true);
    expect(observePullRequestAppearance(seen, `${key}/web`, 9)).toBe(false);
  });

  it("is watched under the current repository's key in the workbench", () => {
    const pane = readFileSync(new URL("../workbench-pane.tsx", import.meta.url), "utf8");
    expect(pane).toContain("const prWatchKey = repositoryWorkspace?.id ?? activeWorkspace?.id ?? null;");
    expect(pane).toContain("observePullRequestAppearance(seenPrByWorkspace.current, prWatchKey, prNumber)");
  });
});
