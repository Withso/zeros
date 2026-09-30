import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ organization: { id: "org-a", isPersonal: false } as { id: string; isPersonal: boolean } | null, selected: "org-a", read: vi.fn(), layer: vi.fn() }));
vi.mock("../../team/team-store", () => ({ useActiveOrganization: () => state.organization, getActiveOrganizationIdSnapshot: () => state.selected }));
vi.mock("../use-settings", () => ({ useResolvedSettings: () => { state.read(); return { resolved: { effective: {} }, refresh() {} }; }, useSettingsLayer: () => { state.layer(); return { write: vi.fn() }; } }));
vi.mock("../../../platform/app", () => ({ shellOpenUrl: vi.fn() }));
vi.mock("../../../shared/ui/primitives/elements", () => ({ toast: { error: vi.fn() } }));
import { BrowserUsePanel } from "../browser-use-panel";
import { NativeBrowserAvailability } from "../../agent/native-browser-availability";
import type { CloudBrowserCapability } from "@zeros/protocol/containment";

beforeEach(() => { state.organization = { id: "org-a", isPersonal: false }; state.selected = "org-a"; vi.clearAllMocks(); });
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
    const html = renderToStaticMarkup(createElement(BrowserUsePanel));
    expect(html).not.toContain("Get extension");
    expect(state.read).not.toHaveBeenCalled();
  });
  it("preserves Local defaults and installation actions on return to Personal", () => {
    state.organization = { id: "personal", isPersonal: true };
    state.selected = "";
    const html = renderToStaticMarkup(createElement(BrowserUsePanel));
    expect(html).not.toContain("unavailable in cloud workspaces");
    expect(html).toContain("Get extension");
    expect(html).toMatch(/aria-checked="true"[^>]*id="browser-use-codex-enabled"/);
    expect(html).toMatch(/aria-checked="false"[^>]*id="browser-use-claude-enabled"/);
  });
});
