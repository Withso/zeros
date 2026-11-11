import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { DesignTokenWire } from "../../../platform/git";
import { TooltipProvider } from "../../../shared/ui/primitives";
import { DesignColorPickerBody, DesignColorTokenList } from "../design-color-picker";
import { designTokenCatalog, designTokenGroups } from "../design-token-catalog";
import { DesignTokenCatalogContext } from "../design-token-context";
import { InspectorEditField } from "../design-inspector";
import { DesignFieldOriginsContext, designFieldOrigins } from "../design-field-origins";
import { DesignFieldOverlays } from "../design-style-card";
import { DesignFillEditor } from "../design-fill-editor";
import type { DesignStyleOriginsContext } from "../design-style-origins";
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

const originsContext: DesignStyleOriginsContext = { label: () => "Frame styles", utilitySources: new Set() };

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
        token: { name: "--radius-md", missing: false },
      }),
    );
    expect(pill).toContain('aria-label="Corner radius: token radius-md"');
    expect(pill).toContain(">radius-md<");
    expect(pill).toContain('data-design-style-token="--radius-md"');
    expect(pill).toContain("bg-bg2-highlight");
    const missing = render(
      createElement(DesignTokenPill, {
        label: "Corner radius",
        token: { name: "--radius-card", missing: true },
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
  const token = { name: "--radius-md", missing: false };
  const field = (origins = designFieldOrigins([], originsContext, null)) =>
    render(
      createElement(
        DesignTokenCatalogContext.Provider,
        { value: catalog },
        createElement(
          DesignFieldOriginsContext.Provider,
          { value: origins },
          createElement(
            DesignFieldOverlays,
            {
              rootRef: { current: null },
              active: true,
              ownerKey: "selection",
              origins,
              onChooseToken: () => {},
              onReset: () => {},
              children: createElement(InspectorEditField, {
                label: "Radius",
                value: "6px",
                styleProperty: "border-radius",
                linkedProperties: ["border-top-left-radius"],
                token,
                tokenAccepts: ["length"],
                onCommit: async () => {},
              }),
            },
          ),
        ),
      ),
    );

  it("is one pill button that announces its picker; the panel's card and picker mount nothing", () => {
    const html = field();
    const pills = [...html.matchAll(/<button[^>]*data-design-style-token="--radius-md"[^>]*>/g)];
    expect(pills).toHaveLength(1);
    expect(pills[0]![0]).toContain('aria-haspopup="dialog"');
    expect(pills[0]![0]).toContain('aria-expanded="false"');
    expect(html).not.toContain("data-design-token-picker");
    expect(html).not.toContain("data-design-style-card");
    expect(html).not.toContain("data-radix-popper-content-wrapper");
    expect(html).not.toContain("zd-popover-edge-anchor");
    // No per-field tooltip: Detach keeps its name, and nothing else wraps it.
    expect(html).toContain('aria-label="Detach token"');
    expect(html).not.toContain('data-state="closed"');
    // What the card and Reset read from the field.
    expect(html).toContain('data-design-field-label="Radius"');
    expect(html).toContain('data-design-linked-properties="border-top-left-radius"');
  });

  it("carries the selection's mark, and steps aside while a filter hides it", () => {
    const changed = {
      sourceVersion: "a".repeat(24), oid: "send", tag: "button", name: "Send", text: null,
      selector: '[data-oid="send"]', visible: true, breadcrumb: [], rect: { x: 0, y: 0, width: 1, height: 1 },
      styles: {}, classes: "btn",
      authoredStyleProperties: ["border-radius", "color"],
      authoredStyles: {
        "border-radius": {
          origin: "inline" as const, scope: "inline" as const, value: "8px", declared: "border-radius",
          replaced: { origin: "frame" as const, selector: ".btn", scope: "element" as const, subjectClasses: ["btn"], value: "6px" },
        },
        color: { origin: "frame" as const, selector: ".btn", scope: "element" as const, subjectClasses: ["btn"], value: "navy" },
      },
    };
    expect(field(designFieldOrigins([changed], originsContext, null))).toContain('data-design-origin="changed"');
    const classGroup = designFieldOrigins([changed], originsContext, null).styledBy!.groups[0]!.key;
    expect(field(designFieldOrigins([changed], originsContext, classGroup))).toContain("data-design-filter-out");
  });
});

describe("a linked field under the Styled-by filter", () => {
  it("stays when its source sets only the linked side it edits", () => {
    const node = {
      sourceVersion: "a".repeat(24), oid: "card", tag: "div", name: "Card", text: null,
      selector: '[data-oid="card"]', visible: true, breadcrumb: [], rect: { x: 0, y: 0, width: 1, height: 1 },
      styles: {}, classes: "inset",
      authoredStyleProperties: ["padding-right"],
      authoredStyles: { "padding-right": { origin: "frame" as const, selector: ".inset", scope: "element" as const, subjectClasses: ["inset"], value: "8px" } },
    };
    const key = designFieldOrigins([node], originsContext, null).styledBy!.groups[0]!.key;
    const html = (linkedProperties: string[]) => render(
      createElement(DesignFieldOriginsContext.Provider, { value: designFieldOrigins([node], originsContext, key) },
        createElement(InspectorEditField, { label: "Horizontal padding", value: "8", styleProperty: "padding-left", linkedProperties, onCommit: async () => {} })),
    );
    expect(html(["padding-right"])).not.toContain("data-design-filter-out");
    expect(html([])).toContain("data-design-filter-out");
  });
});

describe("Fill under the Styled-by filter", () => {
  const layer = (authoredStyles: NonNullable<Parameters<typeof designFieldOrigins>[0][number]["authoredStyles"]>) => ({
    sourceVersion: "a".repeat(24), oid: "card", tag: "div", name: "Card", text: null,
    selector: '[data-oid="card"]', visible: true, breadcrumb: [], rect: { x: 0, y: 0, width: 1, height: 1 },
    styles: {}, classes: "hero",
    authoredStyleProperties: Object.keys(authoredStyles),
    authoredStyles,
  });
  const fromHero = { origin: "frame" as const, selector: ".hero", scope: "element" as const, subjectClasses: ["hero"] };
  const fill = (node: ReturnType<typeof layer>, image: string) => {
    const unfiltered = designFieldOrigins([node], originsContext, null);
    const origins = designFieldOrigins([node], originsContext, unfiltered.styledBy!.groups[0]!.key);
    return render(
      createElement(
        DesignFieldOriginsContext.Provider,
        { value: origins },
        createElement(DesignFillEditor, { color: "white", image, position: "0% 0%", size: "auto", repeat: "repeat", onCommit: () => {} }),
      ),
    );
  };

  it("stays when the source sets only the gradient or image the field edits", () => {
    const gradient = "linear-gradient(white, black)";
    expect(fill(layer({ "background-image": { ...fromHero, value: gradient }, color: { ...fromHero, value: "navy" } }), gradient))
      .not.toContain("data-design-filter-out");
    expect(fill(layer({ "background-size": { ...fromHero, value: "cover" }, color: { ...fromHero, value: "navy" } }), "none"))
      .not.toContain("data-design-filter-out");
    expect(fill(layer({ color: { ...fromHero, value: "navy" } }), "none")).toContain("data-design-filter-out");
  });

  it("names the declaration that paints it to the card and Reset, and the colour to a token", () => {
    const node = layer({ "background-image": { ...fromHero, value: "linear-gradient(white, black)" } });
    const gradient = fill(node, "linear-gradient(white, black)");
    expect(gradient).toContain('data-design-style-property="background-image"');
    expect(gradient).toContain('data-design-token-property="background-color"');
    const solid = fill(layer({ "background-color": { ...fromHero, value: "white" } }), "none");
    expect(solid).toContain('data-design-style-property="background-color"');
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
