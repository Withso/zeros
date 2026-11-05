import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { McpServerRow, McpToolCount, McpToolList } from "../mcp-server-row";
import { SettingsAddRow } from "../../settings/settings-ui";

function row(props: Partial<Parameters<typeof McpServerRow>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(McpServerRow, {
      transport: "http",
      name: "acme-issues",
      hint: "https://mcp.acme.dev/issues",
      hintMono: true,
      toggle: { checked: true, onCheckedChange: vi.fn() },
      menu: { items: [{ label: "Edit", onSelect: vi.fn() }, { label: "Remove", onSelect: vi.fn(), destructive: true }] },
      ...props,
    }),
  );
}

describe("McpServerRow", () => {
  it("puts the transport in a 48px mono column so names share one edge", () => {
    const markup = row();
    expect(markup).toMatch(/<span class="flex w-12 shrink-0"><div class="[^"]*font-mono[^"]*text-2xxs[^"]*">http<\/div><\/span>/);
    expect(markup).toContain("acme-issues");
    expect(markup).toMatch(/class="[^"]*text-fg3[^"]*font-mono[^"]*">https:\/\/mcp\.acme\.dev\/issues/);
  });

  it("shows no status for a server that needs nothing", () => {
    const markup = row();
    for (const label of ["Connected", "Starts with agent", "Disabled"]) expect(markup).not.toContain(label);
  });

  it("names the switch and the one ⋯ menu after the server", () => {
    const markup = row();
    expect(markup).toContain('aria-label="Use acme-issues"');
    expect(markup).toContain('aria-label="More actions for acme-issues"');
    expect(markup).not.toContain('aria-label="Edit server"');
  });

  it("opens the server from its name when asked", () => {
    const markup = row({ onOpen: { label: "Edit acme-issues", onClick: vi.fn() } });
    expect(markup).toMatch(/<button[^>]*aria-label="Edit acme-issues"/);
  });

  it("dims an inherited name and keeps Override here trailing", () => {
    const markup = row({ dimmed: true, toggle: undefined, menu: undefined, trailing: createElement("button", null, "Override here") });
    expect(markup).toMatch(/class="[^"]*text-fg2[^"]*">acme-issues</);
    expect(markup).toContain("Override here");
    expect(markup).not.toContain("More actions");
  });
});

describe("MCP tools", () => {
  it("counts tools on a 24px Ghost that reports whether the list is open", () => {
    const markup = renderToStaticMarkup(createElement(McpToolCount, { count: 7, open: true, onToggle: vi.fn() }));
    expect(markup).toContain("7 tools");
    expect(markup).toContain('aria-expanded="true"');
    expect(renderToStaticMarkup(createElement(McpToolCount, { count: 1, open: false, onToggle: vi.fn() }))).toContain("1 tool");
  });

  it("lists tools in sans with off tools in fg3 and their own switches", () => {
    const markup = renderToStaticMarkup(createElement(McpToolList, {
      server: "acme-issues", tools: ["list_issues", "delete_issue"], isOn: (tool: string) => tool !== "delete_issue", onToggle: vi.fn(),
    }));
    expect(markup).toContain('aria-label="acme-issues tools"');
    expect(markup).toMatch(/text-fg2">list_issues</);
    expect(markup).toMatch(/text-fg3">delete_issue</);
    expect(markup).toContain('aria-label="Use delete_issue"');
    expect(markup).not.toContain("font-mono");
  });
});

describe("SettingsAddRow", () => {
  it("is the card's last row: a full-width Ghost with a plus", () => {
    const markup = renderToStaticMarkup(createElement(SettingsAddRow, { label: "Add server", onClick: vi.fn() }));
    expect(markup).toMatch(/<button[^>]*class="[^"]*w-full[^"]*justify-start/);
    expect(markup).toContain("Add server");
    expect(markup).toContain("lucide-plus");
  });
});
