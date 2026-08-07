import { describe, expect, it } from "vitest";

import {
  DesignStyleAmbiguityError,
  mutateDesignTokenDeclaration,
  mutateDesignNodeStyles,
  readDesignStyleProvenance,
} from "../css";
import { createDesignWebDocumentState } from "../revision";
import { FRAME_CSS, FRAME_HTML, webState } from "./fixtures";

describe("CSS provenance and mutation", () => {
  it.each([
    ':root[data-zd-theme="dark"]',
    "[data-zd-theme='dark']",
    ":root[data-zd-theme='dark']",
  ])("updates the existing %s token theme rule in place", (selector) => {
    const source = `${selector} {\n  --accent: navy;\n}\n`;

    expect(
      mutateDesignTokenDeclaration(source, "--accent", "dark", "orchid"),
    ).toBe(`${selector} {\n  --accent: orchid;\n}\n`);
  });

  it("identifies one exact authored rule without calling it computed", () => {
    const provenance = readDesignStyleProvenance(webState(), {
      nodeId: "card",
      property: "color",
      computedValue: "rgb(255, 0, 0)",
    });
    expect(provenance).toMatchObject({
      origin: "stylesheet",
      confidence: "exact",
      winner: {
        file: "styles.css",
        selector: '[data-oid="card"]',
        value: "red",
      },
    });
  });

  it("edits the one authored rule while preserving unrelated bytes", () => {
    const state = webState();
    const mutation = mutateDesignNodeStyles(state, {
      nodeId: "card",
      styles: { color: "rebeccapurple" },
    });
    expect(mutation.files["index.html"]).toBe(FRAME_HTML);
    expect(mutation.files["styles.css"]).toBe(
      FRAME_CSS.replace("color: red", "color: rebeccapurple"),
    );
    expect(mutation.decisions).toEqual([
      expect.objectContaining({
        appliedScope: "rule",
        reason: "single-authored-rule",
        file: "styles.css",
      }),
    ]);
  });

  it("reports ambiguity and uses an honest local override only in auto scope", () => {
    const css = `${FRAME_CSS}\n[data-oid="card"] { color: blue; }\n`;
    const state = createDesignWebDocumentState({
      documentId: "document-1",
      entryFile: "index.html",
      files: { "index.html": FRAME_HTML, "styles.css": css },
    });
    const provenance = readDesignStyleProvenance(state, {
      nodeId: "card",
      property: "color",
      computedValue: "rgb(0, 0, 255)",
    });
    expect(provenance).toMatchObject({
      origin: "ambiguous",
      confidence: "ambiguous",
    });
    const automatic = mutateDesignNodeStyles(state, {
      nodeId: "card",
      styles: { color: "green" },
      scope: "auto",
    });
    expect(automatic.files["styles.css"]).toBe(css);
    expect(automatic.files["index.html"]).toContain('style="color:green;"');
    expect(automatic.decisions[0]?.reason).toBe(
      "inline-fallback-ambiguous-rule",
    );
    expect(() =>
      mutateDesignNodeStyles(state, {
        nodeId: "card",
        styles: { color: "green" },
        scope: "rule",
      }),
    ).toThrow(DesignStyleAmbiguityError);
  });

  it("does not mistake CSSOM enumeration order for the cascade winner", () => {
    const css = `${FRAME_CSS}\n[data-oid="card"] { color: blue; }\n`;
    const state = createDesignWebDocumentState({
      documentId: "document-1",
      entryFile: "index.html",
      files: { "index.html": FRAME_HTML, "styles.css": css },
    });
    const provenance = readDesignStyleProvenance(state, {
      nodeId: "card",
      property: "color",
      computedValue: "rgb(0, 0, 255)",
      matched: [
        {
          property: "color",
          value: "red",
          selector: '[data-oid="card"]',
          sourceFile: "styles.css",
          important: false,
          inherited: false,
          active: true,
        },
        {
          property: "color",
          value: "blue",
          selector: '[data-oid="card"]',
          sourceFile: "styles.css",
          important: false,
          inherited: false,
          active: true,
        },
      ],
    });
    expect(provenance).toMatchObject({
      winner: null,
      origin: "ambiguous",
      confidence: "ambiguous",
    });
  });

  it("does not infer a conditional rule as the base winner or edit it automatically", () => {
    const css =
      '@media (min-width: 900px) { [data-oid="card"] { color: red; } }';
    const state = createDesignWebDocumentState({
      documentId: "document-1",
      entryFile: "index.html",
      files: { "index.html": FRAME_HTML, "styles.css": css },
    });
    expect(
      readDesignStyleProvenance(state, {
        nodeId: "card",
        property: "color",
      }),
    ).toMatchObject({
      winner: null,
      origin: "ambiguous",
      confidence: "ambiguous",
    });

    const automatic = mutateDesignNodeStyles(state, {
      nodeId: "card",
      styles: { color: "blue" },
    });
    expect(automatic.files["styles.css"]).toBe(css);
    expect(automatic.files["index.html"]).toContain('style="color:blue;"');
    expect(automatic.decisions[0]?.reason).toBe(
      "inline-fallback-ambiguous-rule",
    );

    const explicit = mutateDesignNodeStyles(state, {
      nodeId: "card",
      styles: { color: "green" },
      scope: "rule",
    });
    expect(explicit.files["styles.css"]).toContain("color: green");
  });

  it("correlates browser-matched class and component style rules to source", () => {
    const componentHtml =
      '<!doctype html><html><head><style>zd-card { color: purple; }</style></head><body><article data-zid="surface">Card</article></body></html>';
    const state = createDesignWebDocumentState({
      documentId: "document-1",
      entryFile: "index.html",
      files: {
        "index.html": FRAME_HTML.replace(
          '<article data-oid="card" class="card"><span data-oid="label">Hello</span></article>',
          '<zd-card data-oid="card" class="card"></zd-card>',
        ),
        "styles.css": ".card { padding: 8px; }",
        "components/card.html": componentHtml,
      },
      manifest: {
        schemaVersion: 1,
        parameters: [],
        variants: [],
        components: [
          {
            id: "card",
            name: "Card",
            file: "components/card.html",
            props: [],
            slots: [],
          },
        ],
      },
    });

    expect(
      readDesignStyleProvenance(state, {
        nodeId: "card",
        property: "padding",
        computedValue: "8px",
        matched: [
          {
            property: "padding",
            value: "8px",
            selector: ".card",
            sourceFile: "styles.css",
            inherited: false,
            active: true,
          },
        ],
      }),
    ).toMatchObject({
      winner: { file: "styles.css", selector: ".card" },
      origin: "stylesheet",
      confidence: "correlated",
    });
    const component = readDesignStyleProvenance(state, {
      nodeId: "card",
      property: "color",
      computedValue: "rgb(128, 0, 128)",
      matched: [
        {
          property: "color",
          value: "purple",
          selector: "zd-card",
          sourceFile: "card",
          inherited: false,
          active: true,
        },
      ],
    });
    expect(component).toMatchObject({
      winner: {
        origin: "component",
        file: "components/card.html",
        selector: "zd-card",
      },
      origin: "component",
      confidence: "correlated",
    });
    expect(
      componentHtml.slice(
        component.winner!.span.startOffset,
        component.winner!.span.endOffset,
      ),
    ).toContain("color: purple");
  });

  it("fails closed for unimplemented responsive and pseudo-state mutation contexts", () => {
    expect(() =>
      mutateDesignNodeStyles(webState(), {
        nodeId: "card",
        styles: { color: "blue" },
        responsiveContext: "mobile",
      }),
    ).toThrow("Responsive style mutation");
    expect(() =>
      mutateDesignNodeStyles(webState(), {
        nodeId: "card",
        styles: { color: "blue" },
        stateContext: "hover",
      }),
    ).toThrow("State-specific style mutation");
  });

  it("keeps an existing inline declaration in its authored location", () => {
    const html = FRAME_HTML.replace(
      'class="card"',
      "class=\"card\" style=' color : red ; padding: 4px;'",
    );
    const state = createDesignWebDocumentState({
      documentId: "document-1",
      entryFile: "index.html",
      files: { "index.html": html, "styles.css": FRAME_CSS },
    });
    const mutation = mutateDesignNodeStyles(state, {
      nodeId: "card",
      styles: { color: "blue" },
    });
    expect(mutation.files["index.html"]).toBe(
      html.replace("color : red", "color : blue"),
    );
    expect(mutation.files["styles.css"]).toBe(FRAME_CSS);
    expect(mutation.decisions[0]?.reason).toBe("existing-inline");
  });

  it("quotes an unquoted style attribute before adding values that contain whitespace", () => {
    const html = FRAME_HTML.replace(
      'class="card"',
      "class=card style=color:red",
    );
    const state = createDesignWebDocumentState({
      documentId: "document-1",
      entryFile: "index.html",
      files: { "index.html": html, "styles.css": "" },
    });
    const mutation = mutateDesignNodeStyles(state, {
      nodeId: "card",
      styles: { padding: "12px 16px" },
      scope: "inline",
    });

    expect(mutation.files["index.html"]).toContain(
      'class=card style="color:red; padding:12px 16px;"',
    );
    expect(
      createDesignWebDocumentState({
        documentId: "document-1",
        entryFile: "index.html",
        files: {
          "index.html": mutation.files["index.html"]!,
          "styles.css": "",
        },
      }).files["index.html"],
    ).toContain('style="color:red; padding:12px 16px;"');
  });

  it("ignores malformed neighboring inline declarations during provenance", () => {
    const html = FRAME_HTML.replace(
      'class="card"',
      'class="card" style="??? : broken; color: red;"',
    );
    const state = createDesignWebDocumentState({
      documentId: "document-1",
      entryFile: "index.html",
      files: { "index.html": html, "styles.css": "" },
    });
    expect(
      readDesignStyleProvenance(state, {
        nodeId: "card",
        property: "color",
      }),
    ).toMatchObject({
      origin: "inline",
      confidence: "exact",
      winner: { value: "red" },
    });
  });

  it("does not attribute nested child declarations to their parent rule", () => {
    const css = '[data-oid="card"] { & .child { color: blue; } }';
    const state = createDesignWebDocumentState({
      documentId: "document-1",
      entryFile: "index.html",
      files: { "index.html": FRAME_HTML, "styles.css": css },
    });
    expect(
      readDesignStyleProvenance(state, {
        nodeId: "card",
        property: "color",
      }),
    ).toMatchObject({ origin: "computed", confidence: "computed-only" });
    const mutation = mutateDesignNodeStyles(state, {
      nodeId: "card",
      styles: { color: "green" },
    });
    expect(mutation.files["styles.css"]).toBe(css);
    expect(mutation.files["index.html"]).toContain('style="color:green;"');
  });

  it("never confuses legacy head plumbing with a selectable body node", () => {
    const html = FRAME_HTML.replace(
      "<head>",
      '<head><style data-oid="card">.legacy{color:red}</style>',
    );
    const state = createDesignWebDocumentState({
      documentId: "document-1",
      entryFile: "index.html",
      files: { "index.html": html, "styles.css": FRAME_CSS },
    });
    const mutation = mutateDesignNodeStyles(state, {
      nodeId: "card",
      styles: { border: "1px solid red" },
      scope: "inline",
    });
    expect(mutation.files["index.html"]).toContain(
      '<article data-oid="card" class="card" style="border:1px solid red;">',
    );
    expect(mutation.files["index.html"]).toContain(
      '<style data-oid="card">.legacy{color:red}</style>',
    );
  });
});
