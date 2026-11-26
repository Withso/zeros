// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { GitHubSection } from "../github-section";

const adapters = vi.hoisted(() => ({
  cloud: vi.fn(async () => {}),
  mac: vi.fn(async () => { throw new Error("Mac PAT revoked"); }),
  remove: vi.fn(async () => ({})),
}));
vi.mock("../../../platform/git", async original => ({
  ...(await original<typeof import("../../../platform/git")>()),
  ghMethodSelect: adapters.mac,
  ghMethodDisconnect: adapters.remove,
}));
vi.mock("../../../state/use-recovering-read", () => ({
  useRecoveringRead: () => ({ data: { selectedMethod: "pat", methods: {
    pat: { configured: true, method: "pat", login: "octocat", health: "expired" },
    "github-app": { configured: true, method: "github-app", health: "connected", login: "octocat" },
    "gh-cli": { configured: false, method: "gh-cli", health: "unavailable" },
  } } }),
}));
vi.mock("../use-shared-github", () => ({
  useSharedGithub: () => ({ change: adapters.cloud, read: { data: {
    selectedMethod: null, methods: { pat: { configured: true, login: "octocat" }, "github-app": { configured: false } },
  } } }),
}));

it("invalidates a pending Cloud App exchange even when only the Mac has a saved App", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(GitHubSection, {
      owner: { userId: "a", organizationId: "o", name: "Team" },
    })));
    const trigger = container.querySelector('[aria-label="More actions for GitHub App"]') as HTMLElement;
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent === "Disconnect");
    await act(async () => item!.click());
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(el => el.textContent === "Disconnect");
    await act(async () => confirm!.click());
    expect(adapters.cloud).toHaveBeenCalledWith({ action: "disconnect", method: "github-app" });
    expect(adapters.remove).toHaveBeenCalledWith("github-app", "a");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

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
