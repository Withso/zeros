import { describe, expect, it } from "vitest";
import {
  organizationContextNeedsClear,
  organizationContextStillSelected,
} from "../organization-context-isolation";

describe("organization engine-context isolation", () => {
  it("clears an unknown or differently owned engine context before revalidation", () => {
    expect(organizationContextNeedsClear(undefined, "org_a")).toBe(true);
    expect(organizationContextNeedsClear("org_a", "org_b")).toBe(true);
    expect(organizationContextNeedsClear("org_a", "org_a")).toBe(false);
  });

  it("rejects a settings response after the user switches organizations", () => {
    expect(organizationContextStillSelected("org_a", "org_a")).toBe(true);
    expect(organizationContextStillSelected("org_a", "org_b")).toBe(false);
  });
});
