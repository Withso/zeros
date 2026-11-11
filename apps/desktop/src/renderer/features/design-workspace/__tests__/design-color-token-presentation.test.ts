import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { DesignTokenWire } from "../../../platform/git";
import { TooltipProvider } from "../../../shared/ui/primitives";
import { DesignColorPickerBody, DesignColorTokenList } from "../design-color-picker";
import { designTokenCatalog, designTokenGroups } from "../design-token-catalog";
import { DesignTokenCatalogContext } from "../design-token-context";
import { InspectorEditField } from "../design-inspector";
import {
  DesignTokenPill,
  DesignTokenRows,
  designTokenListGroups,
} from "../design-token-picker";

// Node has no CSS object; the browser decides what paints as a colour.
const COLORS = new Set(["white", "black", "silver", "rebeccapurple"]);
vi.stubGlobal("CSS", { supports: (_property: string, value: string) => COLORS.has(value) });

const manual = (name: string, value: string, description?: string): DesignTokenWire => ({
  name,
  syntax: "*",
  inherits: true,
  initialValue: "",
  value,
  themeValues: {},
  usageCount: 0,
  line: 1,
  ...(description ? { description } : {}),
});

const catalog = designTokenCatalog({
  manual: [
    manual("--bg1", "white", "App canvas"),
    manual("--bg2", "silver", "Raised surfaces and the composer"),
    manual("--fg1", "black"),
    manual("--brand", "var(--accent)"),
    manual("--accent", "rebeccapurple"),
    manual("--radius-md", "6px"),
  ],
  sources: [],
  theme: null,
});
const groups = designTokenListGroups(designTokenGroups(catalog, ["color"]));

// The app mounts one TooltipProvider at its root.
const render = (element: ReactElement) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, element));

const classAttributes = (html: string) => [...html.matchAll(/class="([^"]*)"/g)].map((match) => match[1]!);

describe("color token list", () => {
  it("groups tokens by role with a swatch, the name and its description", () => {
    const html = render(
      createElement(DesignColorTokenList, {
        groups,
        activeToken: "--bg2",
        query: "",
        onQueryChange: () => {},
        onChoose: () => {},
      }),
    );
    expect(html).toContain('aria-label="Search color tokens"');
    expect(html).toContain('role="group" aria-label="Surfaces"');
    expect(html).toContain('role="group" aria-label="Text"');
    expect(html).toContain('role="group" aria-label="Other"');
    expect(html).toMatch(/aria-pressed="true"[^>]*data-design-token-option="--bg2"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-design-token-option="--bg1"/);
    expect(html).toContain(">bg1<");
    expect(html).toContain(">App canvas<");
    // A token without a description shows what it resolves to.
    expect(html).toContain(">black<");
    expect(html).toContain("A color field lists color tokens only.");
    // Chrome is drawn with token classes and never in monospace.
    expect(classAttributes(html).some((value) => /#[0-9a-f]{3,8}\b|rgba?\(|font-mono/i.test(value))).toBe(false);
  });

  it("filters by the query and says when nothing matches or nothing exists", () => {
    const filtered = render(
      createElement(DesignColorTokenList, {
        groups,
        activeToken: null,
        query: "canvas",
        onQueryChange: () => {},
        onChoose: () => {},
      }),
    );
    expect(filtered).toContain('data-design-token-option="--bg1"');
    expect(filtered).not.toContain('data-design-token-option="--fg1"');
    const nothing = (query: string, rows = groups) =>
      render(
        createElement(DesignTokenRows, {
          groups: rows,
          kind: "size",
          activeName: null,
          query,
          onQueryChange: () => {},
          onChoose: () => {},
        }),
      );
    expect(nothing("nothing")).toContain("No size tokens match.");
    expect(nothing("", [])).toContain("No size tokens in this directory.");
    expect(nothing("", [])).toContain("A size field lists size tokens only.");
  });

  it("lets Command-Z reach the design from an empty search", () => {
    const html = render(
      createElement(DesignColorTokenList, { groups, activeToken: null, query: "", onQueryChange: () => {}, onChoose: () => {} }),
    );
    expect(html).toMatch(/aria-label="Search color tokens"[^>]*data-design-draft="clean"|data-design-draft="clean"[^>]*aria-label="Search color tokens"/);
  });
});

describe("token pill", () => {
  it("names the token, and a missing one says so", () => {
    const pill = render(
      createElement(DesignTokenPill, {
        label: "Corner radius",
        token: { name: "--radius-md", description: "radius-md · Manual · 6px", missing: false },
      }),
    );
    expect(pill).toContain('aria-label="Corner radius: token radius-md"');
    expect(pill).toContain(">radius-md<");
    expect(pill).toContain('data-design-style-token="--radius-md"');
    expect(pill).toContain("bg-bg2-highlight");
    const missing = render(
      createElement(DesignTokenPill, {
        label: "Corner radius",
        token: { name: "--radius-card", description: "", missing: true },
      }),
    );
    expect(missing).toContain('aria-label="Corner radius: missing token radius-card"');
    expect(catalog.types.has("color")).toBe(true);
    expect(catalog.types.has("font-weight")).toBe(false);
    expect(missing).toContain(">radius-card is missing<");
    expect(missing).toContain("bg-yellow-bg");
  });
});

describe("token field at rest", () => {
  const token = { name: "--radius-md", description: "radius-md · Manual · 6px", missing: false };
  it("is one pill button that announces its picker, and a closed picker mounts nothing", () => {
    const html = render(
      createElement(
        DesignTokenCatalogContext.Provider,
        { value: catalog },
        createElement(InspectorEditField, {
          label: "Radius",
          value: "6px",
          styleProperty: "border-radius",
          token,
          tokenAccepts: ["length"],
          onChooseToken: () => {},
          onCommit: async () => {},
        }),
      ),
    );
    const pills = [...html.matchAll(/<button[^>]*data-design-style-token="--radius-md"[^>]*>/g)];
    expect(pills).toHaveLength(1);
    expect(pills[0]![0]).toContain('aria-haspopup="dialog"');
    expect(pills[0]![0]).toContain('aria-expanded="false"');
    expect(html).not.toContain("data-design-token-picker");
    expect(html).not.toContain("data-radix-popper-content-wrapper");
    expect(html).not.toContain("zd-popover-edge-anchor");
    // Detach is the field's only other control, hidden by CSS until hover.
    expect(html).toContain('aria-label="Detach token"');
  });
});

describe("color picker body", () => {
  const body = (tokenName: string | undefined, tokenPicker = true) =>
    render(
      createElement(
        DesignTokenCatalogContext.Provider,
        { value: catalog },
        createElement(DesignColorPickerBody, {
          value: "silver",
          label: "Fill",
          tokenName,
          tokenPicker,
          panelRef: { current: null },
          onCommit: vi.fn(),
        }),
      ),
    );

  it("opens a token value on the Theme tab beside Custom", () => {
    const html = body("--bg2");
    expect(html).toContain('role="group" aria-label="Color source"');
    expect(html).toMatch(/aria-label="Theme" aria-pressed="true"/);
    expect(html).toMatch(/aria-label="Custom" aria-pressed="false"/);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-design-token-option="--bg2"/);
    // Only colours: the radius token is not offered.
    expect(html).not.toContain("--radius-md");
  });

  it("keeps a composed color on Custom alone", () => {
    const html = body("--bg2", false);
    expect(html).not.toContain('aria-label="Color source"');
    expect(html).not.toContain("data-design-token-option");
  });
});
