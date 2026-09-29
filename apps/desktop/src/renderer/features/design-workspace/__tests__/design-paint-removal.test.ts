import {
  createDesignWebDocumentState,
  mutateDesignNodeStyles,
} from "@zeros/design-web";
import { describe, expect, it } from "vitest";
import { designPaintRemovalStyles } from "../design-style-values";

describe("removing authored paint", () => {
  it.each(["inline", "rule"] as const)(
    "removes border and outline shorthands from %s source",
    (scope) => {
      for (const kind of ["border", "outline"] as const) {
        const declarations = `${kind}:2px solid red !important; border-radius:8px; padding:12px;`;
        const source =
          scope === "inline"
            ? `<html><body><div data-oid="box" style="${declarations}"></div></body></html>`
            : `<html><head><style>[data-oid="box"] { ${declarations} }</style></head><body><div data-oid="box"></div></body></html>`;
        const state = createDesignWebDocumentState({
          documentId: "paint",
          entryFile: "home.html",
          files: { "home.html": source },
        });
        const styles = designPaintRemovalStyles(kind, [
          kind,
          "border-radius",
          "padding",
        ]);
        const after = mutateDesignNodeStyles(state, { nodeId: "box", styles })
          .files["home.html"]!;
        expect(after).not.toContain(`${kind}:2px solid red`);
        expect(after).not.toContain("solid red");
        expect(after).toContain("border-radius:8px");
        expect(after).toContain("padding:12px");
      }
    },
  );

  it("clears physical and logical border sides while preserving corner geometry", () => {
    const styles = designPaintRemovalStyles("border", [
      "border-top",
      "border-inline-start-width",
      "border-bottom-style",
      "border-radius",
      "border-start-start-radius",
    ]);
    expect(styles).toMatchObject({
      "border-top": null,
      "border-inline-start-width": null,
      "border-bottom-style": null,
    });
    expect(styles).not.toHaveProperty("border-radius");
    expect(styles).not.toHaveProperty("border-start-start-radius");
  });

  it("removes a background shorthand without removing other appearance properties", () => {
    const source =
      '<html><body><div data-oid="box" style="background:red; background-position:center; opacity:0.5"></div></body></html>';
    const state = createDesignWebDocumentState({
      documentId: "paint",
      entryFile: "home.html",
      files: { "home.html": source },
    });
    const styles = designPaintRemovalStyles("fill", [
      "background",
      "background-position",
      "opacity",
    ]);
    const after = mutateDesignNodeStyles(state, { nodeId: "box", styles })
      .files["home.html"]!;
    expect(after).not.toContain("background:red");
    expect(after).not.toContain("background-color:");
    expect(after).not.toContain("background-image:");
    expect(after).toContain("background-position:center");
    expect(after).toContain("opacity:0.5");
  });

  it("suppresses computed paint when an older runtime omits authored declarations", () => {
    expect(designPaintRemovalStyles("border")).toEqual({
      "border-style": "none",
    });
    expect(designPaintRemovalStyles("fill")).toEqual({
      "background-color": "transparent",
      "background-image": "none",
    });
  });
});
