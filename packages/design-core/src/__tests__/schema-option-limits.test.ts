import { describe, expect, it, vi } from "vitest";

// Smaller limits prove the schema reads design-core's limits instead of
// repeating their values.
vi.mock("../component-options", async (importOriginal) => {
  const original = await importOriginal<typeof import("../component-options")>();
  return { ...original, COMPONENT_OPTION_LIMITS: Object.freeze({ ...original.COMPONENT_OPTION_LIMITS, name: 8, options: 2 }) };
});

const { designOperationSchema } = await import("../schema");

const base = { operationId: "op-1", file: "chat/composer.html" };
const accepts = (operation: object) => designOperationSchema.safeParse(operation).success;

describe("component operations follow design-core's option limits", () => {
  it("bounds option, variant and saved-variant names by COMPONENT_OPTION_LIMITS.name", () => {
    expect(accepts({ ...base, type: "component.set-option", option: "a".repeat(8), value: 1 })).toBe(true);
    expect(accepts({ ...base, type: "component.set-option", option: "a".repeat(9), value: 1 })).toBe(false);
    expect(accepts({ ...base, type: "component.set-option", option: "width", variant: "a".repeat(9), value: 1 })).toBe(false);
    expect(accepts({ ...base, type: "component.save-variant", name: "a".repeat(8), values: { width: 1 } })).toBe(true);
    expect(accepts({ ...base, type: "component.save-variant", name: "a".repeat(9), values: { width: 1 } })).toBe(false);
    expect(accepts({ ...base, type: "component.save-variant", name: "compact", values: { [`${"a".repeat(9)}`]: 1 } })).toBe(false);
  });

  it("bounds how many options a saved variant sets by COMPONENT_OPTION_LIMITS.options", () => {
    expect(accepts({ ...base, type: "component.save-variant", name: "compact", values: { width: 1, gap: 2 } })).toBe(true);
    const tooMany = designOperationSchema.safeParse({ ...base, type: "component.save-variant", name: "compact", values: { width: 1, gap: 2, mode: "plan" } });
    expect(tooMany.success).toBe(false);
    expect(tooMany.error?.issues.map((issue) => issue.message)).toContain("A variant may set at most 2 options");
  });
});
