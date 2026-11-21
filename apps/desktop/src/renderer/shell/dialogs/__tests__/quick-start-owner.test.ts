// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
  unified: true,
  organization: { id: "11111111-1111-4111-8111-111111111111", isPersonal: false } as { id: string; isPersonal: boolean } | null,
  init: vi.fn(async () => ({ repoRoot: "/projects/new-app" })),
  toastError: vi.fn(),
}));
vi.mock("../../../config/release-channel", async (original) => ({
  ...(await original<typeof import("../../../config/release-channel")>()),
  isFeatureEnabled: (feature: string) => (feature === "unified-workspaces" ? s.unified : true),
}));
vi.mock("../../../features/team/team-store", async (original) => ({
  ...(await original<typeof import("../../../features/team/team-store")>()),
  getActiveOrganizationSnapshot: () => s.organization,
}));
vi.mock("../../../platform/git", async (original) => ({
  ...(await original<typeof import("../../../platform/git")>()),
  workspaceInitRepo: s.init,
  dialogPickFolder: vi.fn(),
}));
vi.mock("../../../state/use-projects", () => ({ notifyProjectsChanged: vi.fn(), notifyWorkspacesChanged: vi.fn() }));
vi.mock("../../../state/projects-store", () => ({ upsertProject: vi.fn() }));
vi.mock("../../../shared/ui/primitives/elements", async (original) => ({
  ...(await original<typeof import("../../../shared/ui/primitives/elements")>()),
  toast: { error: s.toastError, success: vi.fn(), info: vi.fn() },
}));

import { QuickStartDialog } from "../quick-start";
import { TooltipProvider } from "../../../shared/ui/primitives/tooltip";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  s.unified = true;
  s.organization = { id: "11111111-1111-4111-8111-111111111111", isPersonal: false };
  s.init.mockClear();
  s.toastError.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(createElement(TooltipProvider, null,
    createElement(QuickStartDialog, { open: true, onOpenChange: () => {}, createWorkspace: false }))));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

function type(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  type("qs-name", "new-app");
  type("qs-parent", "/projects");
  const create = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Create")!;
  await act(async () => { create.click(); });
}

describe("Start from scratch", () => {
  it("creates the local project under an organization with unified-workspaces", async () => {
    await submit();
    expect(s.init).toHaveBeenCalledWith({ name: "new-app", parentFolder: "/projects", template: "empty" });
    expect(s.toastError).not.toHaveBeenCalled();
  });

  it("still refuses under an organization without it", async () => {
    s.unified = false;
    await submit();
    expect(s.init).not.toHaveBeenCalled();
    expect(s.toastError).toHaveBeenCalledWith(expect.stringContaining("Organization workspaces run in the cloud"));
  });

  it("creates under Personal either way", async () => {
    s.unified = false;
    s.organization = { id: "local-personal", isPersonal: true };
    await submit();
    expect(s.init).toHaveBeenCalled();
  });
});
