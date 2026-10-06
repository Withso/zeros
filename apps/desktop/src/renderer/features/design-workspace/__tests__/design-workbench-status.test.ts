import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../platform/git";
import { DesignWorkbenchSurface } from "../design-workbench-surface";

const mocks = vi.hoisted(() => ({
  target: {
    data: undefined as unknown,
    loading: false,
    refreshing: false,
    error: null as Error | null,
    refresh: vi.fn(),
  },
  checkout: {
    data: undefined as unknown,
    loading: false,
    refreshing: false,
    error: null as Error | null,
    refresh: vi.fn(),
  },
  source: vi.fn(),
  localMain: false,
}));
vi.mock("../../../state/design-directory-target", async (original) => ({
  ...(await original<
    typeof import("../../../state/design-directory-target")
  >()),
  useDesignDirectoryTarget: () => mocks.target,
}));
vi.mock("../design-checkout-state", () => ({
  useDesignCheckoutStatus: () => mocks.checkout,
  DesignCheckoutPause: () => null,
}));
vi.mock("../../../state/local-main-workspace", () => ({
  isLocalMainWorkspace: () => mocks.localMain,
}));
vi.mock("../../../state/use-projects", () => ({
  useProjectForFolder: () => ({ id: "repo", isGitRepository: true }),
}));
vi.mock("../design-workspace", () => ({
  DesignWorkspaceColumn: () => createElement("div", null, "Confirmed canvas"),
}));
vi.mock("../../../shell/workbench/tab-status", async (original) => ({
  ...(await original<typeof import("../../../shell/workbench/tab-status")>()),
  useWorkbenchStatusSource: mocks.source,
}));
const markup = () =>
  renderToStaticMarkup(
    createElement(DesignWorkbenchSurface, {
      workspace: { id: "status-workspace", path: "/repo" } as Workspace,
      folder: "/repo",
      active: true,
    }),
  );

describe("Design workbench status", () => {
  beforeEach(() => {
    mocks.target.data = undefined;
    mocks.target.error = null;
    mocks.checkout.data = undefined;
    mocks.checkout.error = null;
    mocks.localMain = false;
    mocks.source.mockReset();
  });
  it("never claims configuration is missing before the first lookup", () => {
    const html = markup();
    expect(html).toContain("Checking Design directory…");
    expect(html).not.toContain("Choose a Design directory");
    expect(html).not.toContain("Design settings");
  });
  it("publishes a lookup failure and keeps the centre neutral without actions", () => {
    mocks.target.error = new Error("Request timeout: engine disconnected");
    const html = markup();
    expect(mocks.source).toHaveBeenCalledWith(
      expect.objectContaining({ error: mocks.target.error, primary: true }),
      "ws:status-workspace",
    );
    expect(html).toContain("Retry to load Design.");
    expect(html).not.toContain("engine disconnected");
    expect(html).not.toContain("text-red");
    expect(html).not.toContain("<button");
  });
  it("keeps a confirmed canvas while its exact target revalidates unsuccessfully", () => {
    mocks.target.data = { directory: "design", exists: true };
    mocks.checkout.data = { conflicts: [], paused: false, operation: null };
    mocks.checkout.error = new Error("read failed");
    expect(markup()).toContain("Confirmed canvas");
    expect(mocks.source).toHaveBeenCalledWith(
      expect.objectContaining({
        hasContent: true,
        error: mocks.checkout.error,
      }),
      "ws:status-workspace",
    );
  });
  it("offers Create only after a confirmed missing directory", () => {
    mocks.target.data = { directory: "design", exists: false };
    expect(markup()).toContain("Create design directory");
  });
  it("preserves the Local main settings action while workspace lookup is inapplicable", () => {
    mocks.localMain = true;
    expect(markup()).toContain("Design settings");
  });
});
