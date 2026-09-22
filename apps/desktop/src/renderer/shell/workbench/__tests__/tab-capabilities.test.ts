import { describe, expect, it } from "vitest";
import { availableWorkspaceTabs } from "../tab-capabilities";
import { defaultTabs } from "../tab-model";

describe("Review tab availability", () => {
  it.each([
    null,
    { isGitRepository: false, originUrl: null },
    { isGitRepository: true, originUrl: null },
    {
      isGitRepository: true,
      originUrl: "https://gitlab.com/example/project.git",
    },
    { isGitRepository: false, originUrl: "git@github.com:example/project.git" },
  ])(
    "hides Review without Git and a supported review remote: %j",
    (project) => {
      const { tabs } = defaultTabs();
      const visible = availableWorkspaceTabs(tabs, project);
      expect(visible.some((tab) => tab.type === "review")).toBe(false);
      expect(
        visible.filter((tab) => tab.type !== "terminal").map((tab) => tab.type),
      ).toEqual(
        tabs
          .filter((tab) => tab.type !== "review" && tab.type !== "terminal")
          .map((tab) => tab.type),
      );
    },
  );

  it.each([true, undefined])(
    "keeps Review for GitHub repositories, including legacy metadata (%s)",
    (isGitRepository) => {
      const { tabs } = defaultTabs();
      expect(
        availableWorkspaceTabs(tabs, {
          isGitRepository,
          originUrl: "git@github.com:example/project.git",
        }).find((tab) => tab.type === "review"),
      ).toBe(tabs.find((tab) => tab.type === "review"));
    },
  );

  it("preserves stored Review identity and choices through capability changes without exposing docked terminals", () => {
    const { tabs } = defaultTabs();
    const review = tabs.find((tab) => tab.type === "review")!;
    review.reviewSubtab = "checks";
    const terminal = tabs.find((tab) => tab.type === "terminal")!;
    terminal.terminalPlacement = "panel";
    const original = structuredClone(tabs);
    const github = {
      isGitRepository: true,
      originUrl: "https://github.com/example/project.git",
    };
    expect(
      availableWorkspaceTabs(tabs, { ...github, isGitRepository: false }),
    ).not.toContain(review);
    const restored = availableWorkspaceTabs(tabs, github);
    expect(restored).toContain(review);
    expect(restored).not.toContain(terminal);
    expect(tabs).toEqual(original);
  });
});
