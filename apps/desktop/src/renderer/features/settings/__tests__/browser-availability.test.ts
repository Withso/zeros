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
import { NativeBrowserAvailability } from "../../agent/native-browser-availability";
import type { CloudBrowserCapability } from "@zeros/protocol/containment";

beforeEach(() => { state.zerosBrowser = true; state.organization = { id: "org-a", isPersonal: false }; state.selected = "org-a"; state.workspace = { path: "cloud://org-a/workspace", organizationId: "org-a", placement: "cloud" }; vi.clearAllMocks(); });
describe("native browser availability rendering", () => {
  it("shares unavailable, disabled and ready presentation without conflating provider scopes", () => {
    const scope = { version: 1, provider: "codex", credentialKind: "codex-chatgpt", runtimeProfile: "zeros-cloud-worker-v3" } as const;
    for (const capability of [undefined, null, { ...scope, state: "ready", qualifiedVersion: "browser-v1", version: 99 } as unknown as CloudBrowserCapability]) {
      expect(renderToStaticMarkup(createElement(NativeBrowserAvailability, { provider: "codex", capability }))).toContain("Native browser is unavailable in cloud workspaces.");
    }
    const ready = { ...scope, state: "ready", qualifiedVersion: "browser-v1" } as const;
    expect(renderToStaticMarkup(createElement(NativeBrowserAvailability, { provider: "codex", capability: ready }))).toContain("Native browser is ready.");
    expect(renderToStaticMarkup(createElement(NativeBrowserAvailability, { provider: "codex", capability: { ...scope, state: "disabled" } }))).toContain("Native browser is disabled.");
    expect(renderToStaticMarkup(createElement(NativeBrowserAvailability, { provider: "claude", capability: ready }))).toContain("Chrome integration requires a direct Claude login");
    expect(renderToStaticMarkup(createElement(NativeBrowserAvailability, { provider: "cursor" }))).toContain("Cursor does not expose a native browser integration.");
  });
  it("shows the cloud provider limits without reading Local settings or offering installation", () => {
    const html = renderToStaticMarkup(createElement(BrowserUsePanel));
    expect(html).toContain("Native browser is unavailable in cloud workspaces.");
    expect(html).toContain("The official browser runtime is not available for Linux VMs.");
    expect(html).toContain("Chrome integration requires a direct Claude login, not an API key or setup token.");
    expect(html).not.toContain("Get extension");
    expect(html).not.toContain('role="switch"');
    expect(state.read).not.toHaveBeenCalled();
    expect(state.layer).not.toHaveBeenCalled();
  });
  it("does not flash Local installation controls while the organization is loading", () => {
    state.organization = null;
    state.workspace = { path: "/workspace", organizationId: "org-a", placement: "local" };
    const html = renderToStaticMarkup(createElement(BrowserUsePanel));
    expect(html).not.toContain("Get extension");
    expect(state.read).not.toHaveBeenCalled();
  });

  it.each(["local", undefined] as const)("offers device controls for an organization-local workspace (placement: %s)", placement => {
    state.workspace = { path: "/workspace", organizationId: "org-a", placement };
    const html = renderToStaticMarkup(createElement(BrowserUsePanel));
    expect(html).toContain("Get extension");
    expect(html).toContain('id="browser-use-claude-enabled"');
    expect(html).not.toContain("unavailable in cloud workspaces");
    expect(state.read).toHaveBeenCalledOnce();
    expect(state.layer).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { path: "/workspace", organizationId: "org-b", placement: "local" },
    { path: "/workspace", organizationId: null, placement: "local" },
    { path: "cloud://org-a/workspace", organizationId: "org-a" },
  ] as const)("keeps organization guidance without a matching local workspace: %j", workspace => {
    state.workspace = workspace;
    const html = renderToStaticMarkup(createElement(BrowserUsePanel));
    expect(html).toContain("Native browser is unavailable in cloud workspaces.");
    expect(html).not.toContain("Get extension");
    expect(state.read).not.toHaveBeenCalled();
    expect(state.layer).not.toHaveBeenCalled();
  });

  it("rechecks placement and exact ownership through Local, cloud and owner switches", () => {
    const render = () => renderToStaticMarkup(createElement(BrowserUsePanel));
    state.workspace = { path: "/workspace", organizationId: "org-a", placement: "local" };
    expect(render()).toContain("Get extension");
    state.workspace = { path: "cloud://org-a/workspace", organizationId: "org-a", placement: "cloud" };
    expect(render()).not.toContain("Get extension");
    state.workspace = { path: "/workspace", organizationId: "org-a", placement: "local" };
    expect(render()).toContain("Get extension");
    state.organization = { id: "org-b", isPersonal: false };
    state.selected = "org-b";
    expect(render()).not.toContain("Get extension");
    state.organization = { id: "personal", isPersonal: true };
    state.selected = "";
    expect(render()).toContain("Get extension");
    state.organization = { id: "org-a", isPersonal: false };
    state.selected = "org-a";
    expect(render()).toContain("Get extension");
  });

  it("preserves Local defaults and installation actions on return to Personal", () => {
    state.organization = { id: "personal", isPersonal: true };
    state.selected = "";
    const html = renderToStaticMarkup(createElement(BrowserUsePanel));
    expect(html).not.toContain("unavailable in cloud workspaces");
    expect(html).toContain("Get extension");
    expect(html).toMatch(/aria-checked="true"[^>]*id="browser-use-codex-enabled"/);
    expect(html).toMatch(/aria-checked="false"[^>]*id="browser-use-claude-enabled"/);
    expect(html).toMatch(/aria-checked="true"[^>]*id="browser-use-codex-native"/);
    expect(html).toMatch(/aria-checked="true"[^>]*id="browser-use-in-app-enabled"/);
    expect(html).toMatch(/aria-checked="true"[^>]*id="browser-use-auto-open"/);
    expect(html).toMatch(/aria-checked="true"[^>]*id="browser-use-show-agent-cursor"/);
  });

  it("shows only Codex's own browser and Claude in Chrome while the Zeros browser is not available", () => {
    state.zerosBrowser = false;
    state.organization = { id: "personal", isPersonal: true };
    state.selected = "";
    const html = renderToStaticMarkup(createElement(BrowserUsePanel));
    expect(html).toMatch(/aria-checked="true"[^>]*id="browser-use-codex-enabled"/);
    expect(html).toMatch(/aria-checked="false"[^>]*id="browser-use-claude-enabled"/);
    expect(html).toMatch(/aria-checked="true"[^>]*id="browser-use-auto-open"/);
    expect(html).toContain("Approval for opening websites");
    expect(html).not.toContain('id="browser-use-codex-native"');
    expect(html).not.toContain('id="browser-use-in-app-enabled"');
    expect(html).not.toContain('id="browser-use-show-agent-cursor"');
  });

  it("lists Cursor's cloud browser limits beside Codex and Claude", () => {
    const html = renderToStaticMarkup(createElement(BrowserUsePanel));
    expect(html).toContain("Cursor does not expose a native browser integration.");
  });
});
