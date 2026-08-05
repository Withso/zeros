import { describe, it, expect } from "vitest";
import { resolveLanguage } from "../language";

describe("resolveLanguage", () => {
  it("returns null for missing or unrecognized paths", async () => {
    expect(await resolveLanguage(undefined)).toBeNull();
    expect(await resolveLanguage("README")).toBeNull();
    expect(await resolveLanguage("file.zzzunknown")).toBeNull();
  });

  it("resolves a Lezer language for the common extensions", async () => {
    for (const f of [
      "a.ts",
      "a.tsx",
      "a.js",
      "a.jsx",
      "a.py",
      "a.json",
      "a.html",
      "a.css",
      "a.go",
      "a.rs",
      "a.md",
      "a.yaml",
    ]) {
      expect(await resolveLanguage(f), f).not.toBeNull();
    }
  });

  it("resolves Swift via a legacy stream mode (long-tail coverage)", async () => {
    // SwiftUI is just Swift — a .swift file resolves to the Swift legacy mode
    // (highlight + brackets; no Lezer tree, so no tree folding/indent).
    expect(await resolveLanguage("ContentView.swift")).not.toBeNull();
  });

  it("matches by basename, ignoring directories", async () => {
    expect(await resolveLanguage("src/app/core/auth/auth.guard.ts")).not.toBeNull();
  });
});
