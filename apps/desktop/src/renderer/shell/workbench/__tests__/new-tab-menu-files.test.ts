// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkbenchNewTabMenu } from "../new-tab-menu";
import { cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";

const fixture = vi.hoisted(() => ({
  folder: "",
  status: "disconnected",
  access: true,
  listeners: new Set<() => void>(),
  accessListeners: new Set<() => void>(),
  load: vi.fn(),
}));

vi.mock("../../use-chat-cwd", () => ({ useChatCwd: () => fixture.folder }));
vi.mock("../../../state/use-active-workspace", () => ({ useActiveWorkspace: () => ({ workspace: null }) }));
vi.mock("../../../features/settings/use-settings", () => ({ prefetchSettingsForRepo: () => {} }));
vi.mock("../../../features/settings/agent-control-rollout", () => ({ useAgentControlFeatureActive: () => false }));
vi.mock("../../../platform/bridge/use-bridge", () => ({
  useBridge: () => bridge,
}));
const bridge = {
  get status() { return fixture.status; },
  onStatusChange(listener: () => void) {
    fixture.listeners.add(listener);
    return () => fixture.listeners.delete(listener);
  },
};
vi.mock("../../../state/cloud-file-list-presentation", () => ({
  cloudFileListAccess: () => fixture.access ? { key: "cloud-owner", ready: true } : null,
  subscribeCloudFileListAccess(listener: () => void) {
    fixture.accessListeners.add(listener);
    return () => fixture.accessListeners.delete(listener);
  },
}));
vi.mock("../../workspace-files-cache", () => ({
  loadWorkspaceFiles: fixture.load,
  peekWorkspaceFiles: () => null,
  workspaceCacheKey: (folder: string) => folder,
}));
vi.mock("../new-tab-environment-menu", () => ({
  NEW_TAB_MENU_CHROME: "",
  NewTabEnvironmentMenu: () => null,
  NewTabEnvironmentSearchResults: () => null,
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView ??= () => {};
  fixture.load.mockReset().mockImplementation(async () => {
    if (fixture.folder.startsWith("cloud://") && fixture.status !== "connected")
      throw new Error("Cloud workspace is disconnected");
    return ["ready.ts"];
  });
  fixture.status = "disconnected";
  fixture.access = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function openMenu() {
  await act(async () => root.render(createElement(WorkbenchNewTabMenu, {
    scope: fixture.folder, terminalFolder: fixture.folder,
  })));
  const trigger = host.querySelector("button")!;
  await act(async () => trigger.click());
  expect(document.querySelector("[cmdk-input]")).not.toBeNull();
}

it("loads cloud search results when an already open menu gets a connection", async () => {
  fixture.folder = cloudWorkspaceKey({
    organizationId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
  });
  await openMenu();
  expect(fixture.load).not.toHaveBeenCalled();
  const input = document.querySelector<HTMLInputElement>("[cmdk-input]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "ready");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const result = () => document.querySelector("[role=option]")?.textContent;
  expect(result()).toBeUndefined();
  await act(async () => {
    fixture.status = "connected";
    for (const listener of fixture.listeners) listener();
  });
  expect(fixture.load).toHaveBeenCalledExactlyOnceWith(fixture.folder);
  expect(result()).toContain("ready.ts");
  await act(async () => {
    fixture.access = false;
    for (const listener of fixture.accessListeners) listener();
  });
  expect(result()).toBeUndefined();
});

it("loads Local search immediately without a cloud connection", async () => {
  fixture.folder = "/local";
  await openMenu();
  expect(fixture.load).toHaveBeenCalledExactlyOnceWith(fixture.folder);
});
