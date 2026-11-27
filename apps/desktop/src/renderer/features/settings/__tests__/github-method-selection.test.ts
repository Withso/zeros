// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { GitHubSection } from "../github-section";
import { GithubAppNotifications } from "../../../platform/bridge/github-app-notifications";
import { toast } from "../../../shared/ui/primitives/elements";

const adapters = vi.hoisted(() => ({
  localMethod: "pat",
  cloudMethod: null as "github-app" | "pat" | null,
  localPat: true,
  localApp: true,
  cliLogin: "",
  cloudError: false,
  localError: false,
  patConnect: vi.fn(async () => ({ login: "octocat", snapshot: { selectedMethod: "pat" } })),
  appConnected: new Set<(payload: { login: string; installationCount: number }) => void>(),
  appErrors: new Set<(payload: { reason: string }) => void>(),
  readAfterExchange: vi.fn(async () => ({ selectedMethod: "github-app", generation: "post-exchange", methods: { "github-app": { login: "octocat" } } })),
  changeAfterSave: vi.fn(async () => {}),
  cloudPatConfigured: true,
  empty: false,
  appHealth: "connected",
  patHealth: "invalid",
  hasCloudSnapshot: true,
  connectApp: vi.fn(async () => ({ flowKind: "oauth" })),
  cloud: vi.fn(async () => ({ generation: "post-save", methods: { pat: { login: "octocat" } } })),
  mac: vi.fn(async () => { throw new Error("Mac PAT revoked"); }),
  remove: vi.fn(async () => ({})),
}));
vi.mock("../../../platform/git", async original => ({
  ...(await original<typeof import("../../../platform/git")>()),
  ghMethodSelect: adapters.mac,
  ghMethodDisconnect: adapters.remove,
  ghAppConnect: adapters.connectApp,
  ghPatConnect: adapters.patConnect,
  onGithubAppConnected: async (callback: (payload: { login: string; installationCount: number }) => void) => {
    adapters.appConnected.add(callback);
    return () => adapters.appConnected.delete(callback);
  },
  onGithubAppError: async (callback: (payload: { reason: string }) => void) => {
    adapters.appErrors.add(callback);
    return () => adapters.appErrors.delete(callback);
  },
}));
vi.mock("../../../platform/cloud-github-connection", async original => ({
  ...(await original<typeof import("../../../platform/cloud-github-connection")>()),
  readCloudGithubConnection: adapters.readAfterExchange,
  changeCloudGithubConnection: adapters.changeAfterSave,
}));
vi.mock("../../../state/use-recovering-read", () => ({
  useRecoveringRead: () => adapters.localError ? { data: undefined, readError: new Error("Local read failed") } : ({ data: { selectedMethod: adapters.localMethod, methods: {
    pat: { configured: !adapters.empty && adapters.localPat, method: "pat", login: adapters.empty ? undefined : "octocat", health: adapters.patHealth },
    "github-app": { configured: !adapters.empty && adapters.localApp, method: "github-app", health: adapters.empty ? "not-connected" : adapters.appHealth, login: adapters.empty ? undefined : "octocat" },
    "gh-cli": { configured: !!adapters.cliLogin, login: adapters.cliLogin, method: "gh-cli", health: adapters.cliLogin ? "connected" : adapters.empty ? "not-connected" : "unavailable" },
  } } }),
}));
vi.mock("../inline-login-terminal", () => ({ InlineLoginTerminal: () => "CLI sign-in terminal" }));
vi.mock("../use-shared-github", () => ({
  useSharedGithub: () => ({ change: adapters.cloud, target: () => ({ userId: "a", organizationId: "o", expected: "c".repeat(64) }), read: { readError: adapters.cloudError, data: adapters.hasCloudSnapshot ? {
    selectedMethod: adapters.cloudMethod, methods: { pat: { configured: adapters.cloudPatConfigured, login: "octocat" }, "github-app": { configured: adapters.cloudMethod === "github-app" } },
  } : undefined } }),
}));

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView ??= vi.fn();
  vi.clearAllMocks();
  adapters.cloudPatConfigured = true;
  adapters.hasCloudSnapshot = true;
  adapters.empty = false;
  adapters.cloudError = false;
  adapters.localError = false;
  adapters.localMethod = "pat";
  adapters.cloudMethod = null;
  adapters.localApp = true;
  adapters.localPat = true;
  adapters.cliLogin = "";
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

async function savePat(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Personal access token"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "fixture-token-value");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = [...container.querySelectorAll("button")].find(button => button.textContent === "Validate & save")!;
  expect(save.disabled).toBe(false);
  await act(async () => save.click());
}

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
    expect(page.container.textContent).not.toContain("selects it for Local and Cloud");
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
    await act(async () => [...page.container.querySelectorAll("button")].find(b => b.textContent === "Open GitHub")!.click());
    expect(adapters.connectApp).toHaveBeenCalledExactlyOnceWith({
      installFlow: false, forceInstall: false, shared: { userId: "a", organizationId: "o", expected: "c".repeat(64) },
    });
  } finally { page.close(); }
});

it.each(["Local", "Cloud"])("saving a %s PAT leaves the peer credential bytes and selection unchanged", async target => {
  const local = { token: "existing-local-token", selected: "gh-cli" };
  const cloud = { token: "existing-cloud-token", selected: "github-app" };
  const before = JSON.stringify(target === "Cloud" ? local : cloud);
  adapters.cloudPatConfigured = target !== "Cloud";
  adapters.localPat = target !== "Local";
  adapters.localMethod = "gh-cli";
  adapters.cliLogin = "cli-user";
  adapters.cloudMethod = "github-app";
  adapters.patConnect.mockImplementation(async (...args: unknown[]) => {
    local.token = String(args[0]);
    local.selected = "pat";
    return { login: "octocat", snapshot: { selectedMethod: "pat" } };
  });
  adapters.cloud.mockImplementation(async (...args: unknown[]) => {
    const change = args[0] as { token: string };
    cloud.token = change.token;
    cloud.selected = "pat";
    return { generation: "post-save", methods: { pat: { login: "octocat" } } };
  });
  const page = await workspacePage(org, "a");
  try {
    await page.pick(target, "Personal access token");
    await savePat(page.container);
    expect(JSON.stringify(target === "Cloud" ? local : cloud)).toBe(before);
    expect(target === "Local" ? local : cloud).toEqual({ token: "fixture-token-value", selected: "pat" });
    expect(adapters.mac).not.toHaveBeenCalled();
    expect(adapters.changeAfterSave).not.toHaveBeenCalled();
  } finally { page.close(); adapters.patConnect.mockReset(); adapters.cloud.mockReset(); }
});

it("saves the Cloud PAT without selecting a method on an empty Mac", async () => {
  adapters.empty = true;
  adapters.localMethod = "gh-cli";
  adapters.patHealth = "not-connected";
  adapters.cloudMethod = "github-app";
  adapters.cloudPatConfigured = false;
  adapters.cloud.mockResolvedValueOnce({ generation: "post-save", methods: { pat: { login: "cloud-only" } } });
  const success = vi.spyOn(toast, "success");
  const page = await workspacePage(org, "a");
  try {
    await page.pick("Cloud", "Personal access token");
    await savePat(page.container);
    expect(adapters.cloud).toHaveBeenCalledOnce();
    expect(adapters.patConnect).not.toHaveBeenCalled();
    expect(page.container.querySelector('[aria-label="Local method"]')?.textContent).toContain("Choose method");
    expect(success).toHaveBeenCalledWith("Personal Access Token saved", { description: "Connected as @cloud-only." });
  } finally { page.close(); success.mockRestore(); }
});

it("opens a Local App handoff without changing an empty Cloud selection", async () => {
  adapters.localApp = false;
  const page = await workspacePage(org, "a");
  try {
    await page.pick("Local", "GitHub App");
    const open = [...page.container.querySelectorAll("button")].find(button => button.textContent === "Open GitHub")!;
    await act(async () => open.click());
    expect(adapters.connectApp).toHaveBeenCalledExactlyOnceWith({ installFlow: false, forceInstall: false });
  } finally { page.close(); }
});

it.each([false, true])("restores Cloud PAT after leaving Settings and a stale callback (restore fails=%s)", async fails => {
  adapters.localApp = false;
  adapters.cloudMethod = "pat";
  const error = vi.spyOn(toast, "error");
  if (fails) adapters.changeAfterSave.mockRejectedValueOnce(new Error("Cloud token was revoked"));
  const notifications = createRoot(document.createElement("div"));
  await act(async () => notifications.render(createElement(GithubAppNotifications)));
  const page = await workspacePage(org, "a");
  try {
    await page.pick("Local", "GitHub App");
    const open = [...page.container.querySelectorAll("button")].find(button => button.textContent === "Open GitHub")!;
    await act(async () => open.click());
    expect(adapters.changeAfterSave).not.toHaveBeenCalled();
  } finally { page.close(); }
  try {
    await act(async () => {
      for (const onError of adapters.appErrors) onError({ reason: "nonce_mismatch" });
      for (const connected of adapters.appConnected) connected({ login: "octocat", installationCount: 2 });
    });
    expect(adapters.readAfterExchange).toHaveBeenCalledWith("a", "o");
    expect(adapters.changeAfterSave).toHaveBeenCalledExactlyOnceWith("a", "o", "post-exchange", { action: "select", method: "pat" });
    if (fails) expect(error).toHaveBeenCalledWith(expect.stringContaining("couldn’t restore the Cloud method"), { description: "Cloud token was revoked" });
  } finally { act(() => notifications.unmount()); error.mockRestore(); }
});

it("selects a configured Cloud method while the Local snapshot is unavailable", async () => {
  adapters.localError = true;
  adapters.cloudMethod = "github-app";
  const page = await workspacePage(org, "a");
  try {
    expect(page.container.querySelector<HTMLButtonElement>('[aria-label="Local method"]')!.disabled).toBe(true);
    expect(page.container.querySelector<HTMLButtonElement>('[aria-label="Cloud method"]')!.disabled).toBe(false);
    await page.pick("Cloud", "Personal access token");
    expect(adapters.cloud).toHaveBeenCalledExactlyOnceWith({ action: "select", method: "pat" });
    expect(adapters.mac).not.toHaveBeenCalled();
  } finally { page.close(); }
});

it.each([false, true])("disables only Cloud with an outstanding or failed connection read (error=%s)", async failed => {
  adapters.hasCloudSnapshot = false;
  adapters.cloudError = failed;
  const page = await workspacePage(org, "a");
  try {
    expect(page.container.querySelector<HTMLButtonElement>('[aria-label="Cloud method"]')!.disabled).toBe(true);
    expect(page.container.querySelector<HTMLButtonElement>('[aria-label="Local method"]')!.disabled).toBe(false);
  } finally { page.close(); }
});

it("shows the signed-in CLI account on its authentication row", async () => {
  adapters.cliLogin = "octo-cli";
  const page = await workspacePage(undefined, "a");
  try {
    expect(page.container.textContent).toContain("@octo-cli on this Mac");
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
