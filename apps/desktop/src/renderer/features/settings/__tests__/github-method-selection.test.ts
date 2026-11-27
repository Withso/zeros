// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { GitHubSection } from "../github-section";
import { toast } from "../../../shared/ui/primitives/elements";

const adapters = vi.hoisted(() => ({
  cloudPatConfigured: true,
  empty: false,
  appHealth: "connected",
  patHealth: "invalid",
  hasCloudSnapshot: true,
  connectApp: vi.fn(async () => ({ flowKind: "oauth" })),
  cloud: vi.fn(async () => {}),
  mac: vi.fn(async () => { throw new Error("Mac PAT revoked"); }),
  remove: vi.fn(async () => ({})),
}));
vi.mock("../../../platform/git", async original => ({
  ...(await original<typeof import("../../../platform/git")>()),
  ghMethodSelect: adapters.mac,
  ghMethodDisconnect: adapters.remove,
  ghAppConnect: adapters.connectApp,
}));
vi.mock("../../../state/use-recovering-read", () => ({
  useRecoveringRead: () => ({ data: { selectedMethod: "pat", methods: {
    pat: { configured: !adapters.empty, method: "pat", login: adapters.empty ? undefined : "octocat", health: adapters.patHealth },
    "github-app": { configured: !adapters.empty, method: "github-app", health: adapters.empty ? "not-connected" : adapters.appHealth, login: adapters.empty ? undefined : "octocat" },
    "gh-cli": { configured: false, method: "gh-cli", health: adapters.empty ? "not-connected" : "unavailable" },
  } } }),
}));
vi.mock("../inline-login-terminal", () => ({ InlineLoginTerminal: () => "CLI sign-in terminal" }));
vi.mock("../use-shared-github", () => ({
  useSharedGithub: () => ({ change: adapters.cloud, target: () => ({ userId: "a", organizationId: "o", expected: "c".repeat(64) }), read: { data: adapters.hasCloudSnapshot ? {
    selectedMethod: null, methods: { pat: { configured: adapters.cloudPatConfigured, login: "octocat" }, "github-app": { configured: false } },
  } : undefined } }),
}));

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView ??= vi.fn();
  vi.clearAllMocks();
  adapters.cloudPatConfigured = true;
  adapters.hasCloudSnapshot = true;
  adapters.empty = false;
  adapters.appHealth = "connected";
  adapters.patHealth = "invalid";
});

it.each([
  ["missing", false, "Refresh the cloud GitHub connection and try again."],
  ["stale", true, "Your cloud GitHub connection changed."],
] as const)("removes the Mac PAT and reports unconfirmed Cloud removal with a %s snapshot", async (_name, hasSnapshot, reason) => {
  adapters.hasCloudSnapshot = hasSnapshot;
  adapters.cloudPatConfigured = false;
  adapters.cloud.mockRejectedValueOnce(new Error(reason));
  const error = vi.spyOn(toast, "error");
  const info = vi.spyOn(toast, "info");
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
    expect(adapters.cloud).toHaveBeenCalledWith({ action: "disconnect", method: "pat" });
    expect(error).toHaveBeenCalledWith("Token removed from this Mac. Cloud removal is unconfirmed.", { description: reason });
    expect(info).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
    adapters.cloud.mockReset();
    error.mockRestore();
    info.mockRestore();
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

it.each(["Local CLI", "shared App"] as const)("preserves %s setup while removing a Mac-only PAT", async setup => {
  adapters.cloudPatConfigured = false;
  const owner = setup === "shared App" ? { userId: "a", organizationId: "o", name: "Team" } : undefined;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(GitHubSection, { owner })));
    const click = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(button => button.textContent?.includes(label))!;
      await act(async () => button.click());
    };
    if (owner) {
      await click("GitHub App");
      await click("Open GitHub");
    } else {
      await click("gh CLI auth");
      await click("Run gh auth login");
    }
    const expectedSetup = owner ? "Finish on GitHub" : "CLI sign-in terminal";
    expect(container.textContent).toContain(expectedSetup);
    const trigger = container.querySelector<HTMLElement>('[aria-label="More actions for Personal Access Token"]')!;
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "Remove token")!;
    await act(async () => remove.click());
    expect(adapters.remove).toHaveBeenCalledWith("pat", owner?.userId);
    expect(container.textContent).toContain(expectedSetup);
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

const org = { userId: "a", organizationId: "o", name: "Team" };

async function workspacePage(owner?: typeof org, accountId?: string, personalCloud = false) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await act(async () => root.render(createElement(GitHubSection, {
    workspaceIdentity: true, owner, accountId, personalCloud,
  })));
  const pick = async (place: string, method: string) => {
    const trigger = container.querySelector<HTMLElement>(`[aria-label="${place} method"]`)!;
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === method);
    expect(option).toBeTruthy();
    await act(async () => option!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  };
  return { container, pick, close() { act(() => root.unmount()); container.remove(); } };
}

it.each([
  [undefined, undefined, false, false],
  [undefined, "a", false, false],
  [org, "a", true, true],
  [org, "a", false, true],
] as const)("shows the exact workspace controls for owner %j and account %s, personal=%s", async (owner, account, personal, cloud) => {
  const page = await workspacePage(owner, account, personal);
  try {
    expect(page.container.textContent).toContain("Workspace identity");
    expect(page.container.textContent).toContain("Authentication methods");
    expect(page.container.querySelector('[aria-label="Local method"]')).toBeTruthy();
    expect(!!page.container.querySelector('[aria-label="Cloud method"]')).toBe(cloud);
    expect(page.container.textContent?.includes("Cloud · Team")).toBe(cloud && !personal);
    expect(page.container.textContent?.includes("GitHub App")).toBe(!!account);
    expect(page.container.textContent).toContain("Local only");
    expect(page.container.querySelector('[aria-label^="Disconnect Local"], [aria-label^="Disconnect Cloud"]')).toBeNull();
  } finally { page.close(); }
});

it("selects a configured method only on the addressed workspace", async () => {
  const page = await workspacePage(org, "a");
  try {
    await page.pick("Cloud", "Personal access token");
    expect(adapters.cloud).toHaveBeenCalledWith({ action: "select", method: "pat" });
    expect(adapters.mac).not.toHaveBeenCalled();
    adapters.cloud.mockClear();
    await page.pick("Local", "GitHub App");
    expect(adapters.mac).toHaveBeenCalledWith("github-app", "a");
    expect(adapters.cloud).not.toHaveBeenCalled();
  } finally { page.close(); }
});

it("opens missing Cloud PAT setup inline without selecting either workspace", async () => {
  adapters.cloudPatConfigured = false;
  const page = await workspacePage(org, "a");
  try {
    await page.pick("Cloud", "Personal access token");
    expect(page.container.querySelector('input[aria-label="Personal access token"]')).toBeTruthy();
    expect(page.container.textContent).toContain("Saving this token selects it for Local and Cloud");
    expect(adapters.mac).not.toHaveBeenCalled();
    expect(adapters.cloud).not.toHaveBeenCalled();
  } finally { page.close(); }
});

it("offers a single first-run action before showing shared setup", async () => {
  adapters.empty = true;
  adapters.patHealth = "not-connected";
  adapters.cloudPatConfigured = false;
  const page = await workspacePage(org, "a");
  try {
    const buttons = page.container.querySelectorAll("button");
    expect([...buttons].map(button => button.textContent?.trim())).toEqual(["Connect GitHub"]);
    await act(async () => buttons[0].click());
    expect(page.container.textContent).toContain("Open GitHub");
    expect(page.container.textContent).toContain("Personal access token");
  } finally { page.close(); }
});

it("keeps a failed credential probe visible when no method is configured", async () => {
  adapters.empty = true;
  adapters.patHealth = "unavailable";
  const page = await workspacePage(undefined, "a");
  try {
    expect(page.container.textContent).toContain("Couldn’t check this connection.");
  } finally { page.close(); }
});

it("reports revoked Local credentials even when a different method is selected", async () => {
  adapters.appHealth = "invalid";
  adapters.patHealth = "connected";
  const page = await workspacePage(org, "a");
  try {
    expect(page.container.textContent).toContain("GitHub revoked this connection.");
  } finally { page.close(); }
});

it("sets up a missing Cloud App through the shared exchange while preserving Local selection", async () => {
  const page = await workspacePage(org, "a");
  try {
    await page.pick("Cloud", "GitHub App");
    const open = [...page.container.querySelectorAll("button")].find(node => node.textContent?.trim() === "Open GitHub");
    await act(async () => open!.click());
    expect(adapters.connectApp).toHaveBeenCalledWith({
      installFlow: false, forceInstall: false, preserveSelectedMethod: true,
      shared: { userId: "a", organizationId: "o", expected: "c".repeat(64) },
    });
    expect(adapters.mac).not.toHaveBeenCalled();
  } finally { page.close(); }
});
