import { describe, expect, it } from "vitest";
import { designRelocationRootStyles, assertDesignRelocationSource } from "../relocation-source";

describe("source-preserving relocation admission", () => {
  it("refuses context-dependent selectors and viewport layout before extracting source", () => {
    for (const css of [".parent > .child { color:red }", ".child:nth-child(2) { width:30px }", "@media(min-width:700px){.child{color:red}}", ".child{width:30vw}", ".child{perspective:500px}", ".child{animation:move 1s}"]) {
      expect(() => assertDesignRelocationSource(`<html><head><style>${css}</style></head><body><div data-oid="child"></div></body></html>`)).toThrow(/safely/);
    }
  });

  it("admits simple rules, stable custom properties and the seeded reset", () => {
    expect(() => assertDesignRelocationSource('<html><head><style>@layer reset { *, *::before, *::after { box-sizing:border-box } html,body{margin:0} } :root{--accent:red} .child{color:var(--accent);border:2px solid}</style></head><body><div data-oid="child" style="width:100px;height:80px"></div></body></html>')).not.toThrow();
  });

  it("rejects a transformed document coordinate system and inline viewport dependencies", () => {
    for (const source of ['<html><body style="position:relative;padding:20px"><div data-oid="child"></div></body></html>', '<style>body{transform:scale(2)}</style><div data-oid="child"></div>', '<div data-oid="child"><div style="width:30vw"></div></div>']) {
      expect(() => assertDesignRelocationSource(source, "child")).toThrow(/safely/);
    }
  });

  it("preserves the measured local size and full affine pose without carrying root margins", () => {
    expect(designRelocationRootStyles({ width: 100, height: 80, matrix: [0, 2, -3, 0, 240, 0], inheritedStyles: { color: "navy", "font-size": "30px", "--accent": "red" } })).toMatchObject({ width: "100px", height: "80px", margin: "0", left: "0px", top: "0px", transform: "matrix(0,2,-3,0,240,0)", "transform-origin": "0 0", color: "navy", "font-size": "30px", "--accent": "red" });
  });

  it("rejects nonfinite, singular and non-inherited payloads", () => {
    const base = { width: 100, height: 80, matrix: [1, 0, 0, 1, 0, 0], inheritedStyles: {} };
    expect(() => designRelocationRootStyles({ ...base, matrix: [0, 0, 0, 0, 0, 0] })).toThrow();
    expect(() => designRelocationRootStyles({ ...base, width: Infinity })).toThrow();
    expect(() => designRelocationRootStyles({ ...base, inheritedStyles: { position: "fixed" } })).toThrow();
  });
});
