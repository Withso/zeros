import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionToolsInventorySnapshot } from "@zeros/protocol/agent-extensions";
import { ComposerToolGroups } from "../composer-tool-groups";

function render(snapshot: SessionToolsInventorySnapshot): string {
  return renderToStaticMarkup(
    createElement(ComposerToolGroups, {
      snapshot,
      authBusy: null,
      onAuthenticate: () => {},
    }),
  );
}

describe("composer tool group visibility", () => {
  it.each(["ready", "partial", "unsupported"] as const)(
    "omits empty %s groups while keeping reported entries",
    (state) => {
      const html = render({
        state: "ready",
        entries: [{ id: "mcp", name: "MCP", status: "connected" }],
        groups: [
          { kind: "plugins", state, entries: [] },
          { kind: "apps", state, entries: [] },
        ],
      });
      expect(html).not.toContain('data-tool-group="plugins"');
      expect(html).not.toContain('data-tool-group="apps"');
      expect(html).toContain('data-tool-group="mcp"');
      expect(html).not.toContain("No tools reported");
    },
  );

  it("keeps an available app when its MCP group is empty", () => {
    const html = render({
      state: "ready",
      entries: [],
      groups: [
        {
          kind: "apps",
          state: "ready",
          entries: [{ id: "app", name: "App", status: "available" }],
        },
      ],
    });
    expect(html).toContain('data-tool-group="apps"');
    expect(html).not.toContain('data-tool-group="plugins"');
    expect(html).not.toContain('data-tool-group="mcp"');
  });

  it.each(["ready", "partial", "unsupported"] as const)(
    "shows a session empty state without dropdowns for %s inventory",
    (state) => {
      const html = render({ state, entries: [] });
      expect(html).not.toContain("data-tool-group=");
      expect(html).toContain("No tools reported for this session.");
    },
  );

  it("retains loading feedback while discovery is pending", () => {
    const html = render({ state: "pending", entries: [] });
    expect(html).not.toContain("data-tool-group=");
    expect(html).toContain("Loading tools…");
    expect(html).not.toContain("No tools reported");
  });
});
