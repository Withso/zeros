import { describe, it, expect } from "vitest";
import { shikiLangForPath } from "../shiki-lang";

describe("shikiLangForPath", () => {
  it("maps common extensions to shiki language ids", () => {
    expect(shikiLangForPath("a.ts")).toBe("typescript");
    expect(shikiLangForPath("a.tsx")).toBe("tsx");
    expect(shikiLangForPath("a.js")).toBe("javascript");
    expect(shikiLangForPath("a.py")).toBe("python");
    expect(shikiLangForPath("a.md")).toBe("markdown");
    expect(shikiLangForPath("deep/dir/x.rs")).toBe("rust");
  });

  it("covers the long tail incl. Swift", () => {
    expect(shikiLangForPath("ContentView.swift")).toBe("swift");
    expect(shikiLangForPath("Main.kt")).toBe("kotlin");
    expect(shikiLangForPath("app.dart")).toBe("dart");
  });

  it("handles extension-less well-known filenames", () => {
    expect(shikiLangForPath("Dockerfile")).toBe("docker");
    expect(shikiLangForPath("Makefile")).toBe("make");
  });

  it("returns null for unknown or pathless inputs", () => {
    expect(shikiLangForPath(undefined)).toBeNull();
    expect(shikiLangForPath("README")).toBeNull();
    expect(shikiLangForPath("a.unknownext")).toBeNull();
  });
});
