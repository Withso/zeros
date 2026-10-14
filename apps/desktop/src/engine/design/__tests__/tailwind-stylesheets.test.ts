import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The generator is a plain .mjs script.
import { renderDesignTailwindStylesheets } from "../../../../../../scripts/codegen-design-tailwind.mjs";
import { DESIGN_TAILWIND_VERSION } from "../generated/tailwind-stylesheets";

describe("embedded Tailwind stylesheets", () => {
  it("match the tailwindcss package the engine bundles", () => {
    const generated = readFileSync(path.join(__dirname, "../generated/tailwind-stylesheets.ts"), "utf8");
    // Stale after a tailwindcss update: run node scripts/codegen-design-tailwind.mjs.
    expect(generated).toBe(renderDesignTailwindStylesheets(process.cwd()));
    expect(DESIGN_TAILWIND_VERSION).toBe(JSON.parse(readFileSync("node_modules/tailwindcss/package.json", "utf8")).version);
  });
});
