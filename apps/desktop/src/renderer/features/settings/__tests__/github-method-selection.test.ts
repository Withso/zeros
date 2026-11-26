// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { GitHubSection } from "../github-section";

const adapters = vi.hoisted(() => ({
  cloudPatConfigured: true,
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
vi.mock("../inline-login-terminal", () => ({ InlineLoginTerminal: () => "CLI sign-in terminal" }));
vi.mock("../use-shared-github", () => ({
  useSharedGithub: () => ({ change: adapters.cloud, read: { data: {
    selectedMethod: null, methods: { pat: { configured: adapters.cloudPatConfigured, login: "octocat" }, "github-app": { configured: false } },
  } } }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  adapters.cloudPatConfigured = true;
});

it("removes a Mac-only PAT when Cloud is offline", async () => {
  adapters.cloudPatConfigured = false;
  adapters.cloud.mockRejectedValueOnce(new Error("Cloud is offline"));
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(GitHubSection, {
      owner: { userId: "a", organizationId: "o", name: "Team" },
    })));
    const trigger = container.querySelector<HTMLElement>('[aria-label="More actions for Personal Access Token"]')!;
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "Remove token")!;
    await act(async () => remove.click());
    expect(adapters.remove).toHaveBeenCalledWith("pat", "a");
    expect(adapters.cloud).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
    adapters.cloud.mockReset();
  }
});

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
    const button = (text: string) => [...container.querySelectorAll("button")].find(el => el.textContent?.includes(text))!;
    await act(async () => button("gh CLI auth").click());
    await act(async () => button("Run gh auth login").click());
    expect(container.textContent).toContain("CLI sign-in terminal");
    const label = button("Personal Access Token");
    expect(label).toBeDefined();
    await act(async () => label!.click());
    expect(adapters.cloud).toHaveBeenCalledWith({ action: "select", method: "pat" });
    expect(adapters.mac).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("CLI sign-in terminal");
  } finally {
    act(() => root.unmount());
  }
});
