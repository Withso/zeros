import { describe, expect, it, vi } from "vitest";

// A smaller name limit proves the variant name check reads design-core's
// limit instead of repeating its value.
vi.mock("@zeros/design-core/component-options", async (importOriginal) => {
  const original = await importOriginal<typeof import("@zeros/design-core/component-options")>();
  return { ...original, COMPONENT_OPTION_LIMITS: Object.freeze({ ...original.COMPONENT_OPTION_LIMITS, name: 8 }) };
});

const { appendComponentVariant } = await import("../component-options");

const MAIN = `<!doctype html>
<html lang="en">
  <head>
    <template data-zd-options>
      <zd-option name="width" type="number" label="Width" default="1120" min="640" max="1440" step="8" unit="px"></zd-option>
    </template>
  </head>
  <body><div data-oid="root">Composer</div></body>
</html>
`;

describe("a saved variant's name follows design-core's option-name limit", () => {
  it("refuses a name one character over COMPONENT_OPTION_LIMITS.name", () => {
    expect(appendComponentVariant(MAIN, "a.html", { name: "a".repeat(8), values: { width: 800 } }))
      .toContain(`<zd-variant name="${"a".repeat(8)}" width="800"></zd-variant>`);
    expect(() => appendComponentVariant(MAIN, "a.html", { name: "a".repeat(9), values: { width: 800 } }))
      .toThrow(/use lowercase letters, digits and single hyphens/);
  });
});
