import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../platform/git";

const state = vi.hoisted(() => ({ organization: { id: "org-a", isPersonal: false } as { id: string; isPersonal: boolean } | null, selected: "org-a", workspace: null as Pick<Workspace, "path" | "organizationId" | "placement"> | null, read: vi.fn(), layer: vi.fn(), zerosBrowser: true }));
vi.mock("../../team/team-store", () => ({ useActiveOrganization: () => state.organization, getActiveOrganizationIdSnapshot: () => state.selected }));
vi.mock("../../../state/use-active-workspace", () => ({ useActiveWorkspace: () => ({ workspace: state.workspace }) }));
vi.mock("../use-settings", () => ({ useResolvedSettings: () => { state.read(); return { resolved: { effective: {} }, refresh() {} }; }, useSettingsLayer: () => { state.layer(); return { write: vi.fn() }; } }));
vi.mock("../../../platform/app", () => ({ shellOpenUrl: vi.fn() }));
vi.mock("../../../shared/ui/primitives/elements", () => ({ toast: { error: vi.fn() } }));
vi.mock("../agent-control-rollout", () => ({ useAgentControlFeatureActive: () => state.zerosBrowser }));
import { BrowserUsePanel } from "../browser-use-panel";

beforeEach(() => { state.zerosBrowser = true; state.organization = { id: "org-a", isPersonal: false }; state.selected = "org-a"; state.workspace = { path: "cloud://org-a/workspace", organizationId: "org-a", placement: "cloud" }; vi.clearAllMocks(); });
describe("Browser as a unified device page", () => {
  it.each([["an organization with a cloud workspace open", false], ["an organization still loading", true]])("shows this Mac's controls under %s", (_name, loading) => {
    if (loading) state.organization = null;
    const html = renderToStaticMarkup(createElement(BrowserUsePanel, { unified: true }));
    expect(html).toContain('id="browser-use-claude-enabled"');
    expect(html).not.toContain("unavailable in cloud workspaces");
    expect(state.read).toHaveBeenCalledOnce();
  });
  it("keeps the organization state in the old rail", () => {
    expect(renderToStaticMarkup(createElement(BrowserUsePanel))).toContain("Native browser is unavailable in cloud workspaces.");
  });
});
