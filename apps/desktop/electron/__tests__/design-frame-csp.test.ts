import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("design frame CSP", () => {
  it("allows the app-owned zeros-design scheme in every packaged renderer policy", () => {
    const root = path.resolve(__dirname, "../../../..");
    const vite = readFileSync(path.join(root, "vite.config.ts"), "utf8");
    const electron = readFileSync(
      path.join(root, "apps/desktop/electron/main.ts"),
      "utf8",
    );
    expect(vite).toMatch(/frame-src[^"\n]*\bzeros-design:/);
    expect(electron).toMatch(/frame-src[^"\n]*\bzeros-design:/);
  });
});
