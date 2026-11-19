// Debug traces stay out of packaged app.jsonl to bound disk use and feedback exports.

import { describe, it, expect } from "vitest";
import { shouldPersistLevel } from "../renderer-log";

describe("shouldPersistLevel", () => {
  it("drops only debug in packaged builds (dev=false)", () => {
    expect(shouldPersistLevel("debug", false)).toBe(false);
    expect(shouldPersistLevel("log", false)).toBe(true);
    expect(shouldPersistLevel("info", false)).toBe(true);
    expect(shouldPersistLevel("warn", false)).toBe(true);
    expect(shouldPersistLevel("error", false)).toBe(true);
  });

  it("keeps every level in dev (dev=true)", () => {
    expect(shouldPersistLevel("debug", true)).toBe(true);
    expect(shouldPersistLevel("log", true)).toBe(true);
    expect(shouldPersistLevel("info", true)).toBe(true);
    expect(shouldPersistLevel("warn", true)).toBe(true);
    expect(shouldPersistLevel("error", true)).toBe(true);
  });
});
