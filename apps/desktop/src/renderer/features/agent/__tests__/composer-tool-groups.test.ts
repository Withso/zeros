import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SessionToolInventoryEntry } from "@zeros/protocol/agent-extensions";
import { ComposerToolGroups } from "../composer-tool-groups";

// Keep the disclosure open for static status assertions; the browser smoke
// covers its actual controls, focus, and retry behavior.
vi.mock("../../../shared/ui/primitives/elements/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => children,
  CollapsibleTrigger: ({ children }: { children: React.ReactNode }) => children,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => children,
}));

const render = (status: SessionToolInventoryEntry["status"], canAuthenticate = true, authBusy: string | null = null) =>
  renderToStaticMarkup(createElement(ComposerToolGroups, {
    snapshot: { state: "ready", entries: [], groups: [{ kind: "mcp", state: "ready", entries: [{ id: "linear", name: "linear", status, canAuthenticate }] }] },
    authBusy, onAuthenticate: () => {},
  }));

describe("MCP sign-in rows", () => {
  it("shows Opening until the latest native attempt completes", () => {
    const html = render("connecting");
    expect(html).toContain("Opening…");
    expect(html).toContain("disabled");
    expect(html).not.toContain("lucide-loader-circle");
  });

  it("keeps failure visible as an accessible retry action", () => {
    const html = render("error");
    expect(html).toContain('aria-label="Authenticate linear"');
    expect(html).toContain('aria-label="Sign-in failed"');
    expect(html).toContain("lucide-x");
    expect(html).not.toContain(">Authenticate<");
  });

  it("preserves initial Authenticate, the request Opening state, and ordinary connection icons", () => {
    expect(render("needs-auth")).toContain(">Authenticate<");
    expect(render("needs-auth", true, "linear")).toContain("Opening…");
    expect(render("connected", false)).toContain('aria-label="Connected"');
    expect(render("connecting", false)).toContain("lucide-loader-circle");
    expect(render("error", false)).toContain('aria-label="Error"');
  });
  it("does not apply an MCP attempt to a plugin or app with the same id", () => {
    const html = renderToStaticMarkup(createElement(ComposerToolGroups, {
      snapshot: { state: "ready", entries: [], groups: [
        { kind: "plugins", state: "ready", entries: [{ id: "linear", name: "Linear plugin", status: "enabled" }] },
        { kind: "apps", state: "ready", entries: [{ id: "linear", name: "Linear app", status: "available" }] },
        { kind: "mcp", state: "ready", entries: [{ id: "linear", name: "linear", status: "needs-auth", canAuthenticate: true }] },
      ] }, authBusy: "linear", authFailed: "linear", onAuthenticate: () => {},
    }));
    expect(html.match(/Opening…/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Enabled"');
    expect(html).toContain('aria-label="Available"');
  });
});
