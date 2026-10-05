import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import type { Workspace } from "../../platform/git";

const state = vi.hoisted(() => ({ document: null as CloudWorkspaceDocument | null }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("../../platform/git", () => ({ workspaceSetupInfo: vi.fn(), workspaceRerunSetup: vi.fn(), workspaceStopSetup: vi.fn() }));
vi.mock("../../state/store", () => ({ useWorkspaceDispatch: () => vi.fn() }));
vi.mock("../../state/use-active-workspace", () => ({ useActiveWorkspace: () => ({ workspace: null }) }));
vi.mock("../../state/use-projects", () => ({ useProjects: () => ({ projects: [] }) }));
vi.mock("../../platform/bridge/use-bridge", () => ({ useBridge: () => ({}) }));
vi.mock("../../shared/theme/use-theme-variant", () => ({ useThemeId: () => "dark" }));
vi.mock("../../state/cloud-workspace-catalog", () => ({
  subscribeCloudWorkspaces: () => () => {},
  cloudWorkspaceDocument: (target: { workspaceId: string }) => target.workspaceId === state.document?.id ? state.document : undefined,
}));
import { SetupView } from "../workbench/tabs/setup-tab";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const key = `cloud://${organizationId}/${workspaceId}`;
const workspace = { id: key, repoRoot: key, placement: "cloud", setupState: "failed" } as Workspace;
function render(row = workspace) {
  return renderToStaticMarkup(createElement(SetupView, { workspace: row, visible: true, onBusyChange: vi.fn() }));
}
beforeEach(() => {
  state.document = { id: workspaceId, organizationId, status: "stopped",
    setupFailure: { code: "setup_image_contract_invalid", hasLog: false } } as unknown as CloudWorkspaceDocument;
});
describe("cloud Setup tab failures", () => {
  it("renders a durable pre-script failure instead of the engine loading state", () => {
    const html = render();
    expect(html).toContain("Setup failed");
    expect(html).toContain("setup_image_contract_invalid");
    expect(html).toContain("The workspace image could not be verified.");
    expect(html).toContain("The failure happened before your setup script ran.");
    expect(html).not.toContain('aria-busy="true"');
    expect(html).not.toContain("Rerun setup");
  });
  it("does not apply another cloud workspace's failure to the selected workspace", () => {
    expect(render({ ...workspace, id: `cloud://${organizationId}/33333333-3333-4333-8333-333333333333` })).not.toContain("Setup failed");
    expect(render({ ...workspace, id: "local:fixture", placement: "local" })).not.toContain("Setup failed");
  });
  it("omits pre-script copy when the failed setup produced logs", () => {
    Object.assign(state.document!, { setupFailure: { code: "setup_command_failed", hasLog: true } });
    const html = render();
    expect(html).toContain("Setup failed");
    expect(html).toContain("setup_command_failed");
    expect(html).not.toContain("The failure happened before your setup script ran.");
  });
});
