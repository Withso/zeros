// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { GitHubSection } from "../github-section";

const adapters = vi.hoisted(() => ({
  cloud: vi.fn(async () => {}),
  mac: vi.fn(async () => { throw new Error("Mac PAT revoked"); }),
}));
vi.mock("../../../platform/git", async original => ({
  ...(await original<typeof import("../../../platform/git")>()),
  ghMethodSelect: adapters.mac,
}));
vi.mock("../../../state/use-recovering-read", () => ({
  useRecoveringRead: () => ({ data: { selectedMethod: "pat", methods: {
    pat: { configured: true, method: "pat", login: "octocat", health: "expired" },
    "github-app": { configured: false, method: "github-app", health: "not-connected" },
    "gh-cli": { configured: false, method: "gh-cli", health: "unavailable" },
  } } }),
}));
vi.mock("../use-shared-github", () => ({
  useSharedGithub: () => ({ change: adapters.cloud, read: { data: {
    selectedMethod: "github-app", methods: { pat: { configured: true, login: "octocat" }, "github-app": { configured: true, login: "octocat" } },
  } } }),
}));

it("selects a working Cloud PAT when the Mac already selected its own PAT", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(GitHubSection, {
      owner: { userId: "a", organizationId: "o", name: "Team" },
    })));
    const label = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Personal Access Token"));
    expect(label).toBeDefined();
    await act(async () => label!.click());
    expect(adapters.cloud).toHaveBeenCalledWith({ action: "select", method: "pat" });
    expect(adapters.mac).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});
