// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const organization = {
  id: "11111111-1111-4111-8111-111111111111", slug: "withso", name: "Withso", logo: null, role: "member",
  isPersonal: false, defaultTeamId: null,
  workspaceCapabilities: { local: false, cloud: true },
  teamCapabilities: { multiple: false, canCreate: false },
};
vi.mock("../../../features/team/team-store", async (original) => ({
  ...(await original<typeof import("../../../features/team/team-store")>()),
  useActiveOrganization: () => organization,
  getActiveOrganizationSnapshot: () => organization,
  useTeams: () => ({ me: { user: { id: "member" } } }),
}));
vi.mock("../../../features/team/cloud-workspace-pause", () => ({ useOrganizationCloudPaused: () => false }));

import { OpenGithubProjectDialog } from "../open-github-project";
import { TooltipProvider } from "../../../shared/ui/primitives/tooltip";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
});

const render = (local: boolean) =>
  act(() => {
    root.render(createElement(TooltipProvider, null,
      createElement(OpenGithubProjectDialog, { open: true, onOpenChange: () => {}, local })));
  });

describe("Open GitHub project from Create's This Mac side", () => {
  it("clones onto this Mac under an organization", () => {
    render(true);
    expect(document.body.textContent).toContain("Clone a remote repository onto this Mac.");
    expect(document.body.textContent).not.toContain("Create a cloud workspace in Withso");
  });

  it("keeps the organization's cloud flow otherwise", () => {
    render(false);
    expect(document.body.textContent).toContain("Create a cloud workspace in Withso");
  });
});
