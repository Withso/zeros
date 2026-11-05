import { describe, expect, it } from "vitest";

import { initialsOf } from "../initials";

describe("initialsOf", () => {
  it("takes the first letters of the first two words", () => {
    expect(initialsOf("Alex Rivera")).toBe("AR");
    expect(initialsOf("Mary-Jane Watson Smith")).toBe("MW");
    expect(initialsOf("alex")).toBe("A");
  });

  it("reads a handle or an email by its parts", () => {
    expect(initialsOf("alex.rivera@acme.com")).toBe("AR");
    expect(initialsOf("alex@acme.com")).toBe("A");
    expect(initialsOf("octo-cat")).toBe("OC");
  });

  it("keeps whole characters and falls back when there is nothing", () => {
    expect(initialsOf("😀 Bot")).toBe("😀B");
    expect(initialsOf("   ")).toBe("·");
    expect(initialsOf(null)).toBe("·");
    expect(initialsOf("@acme.com")).toBe("·");
  });
});
