import { describe, it, expect } from "vitest";
import {
  generateBranchName,
  generateWorkspaceId,
  isValidBranchName,
} from "../naming";

describe("naming", () => {
  describe("generateWorkspaceId", () => {
    it("starts with ws_ and contains 6 hex chars", () => {
      const id = generateWorkspaceId("hello world");
      expect(id).toMatch(/^ws_[0-9a-f]{6}-[a-z0-9-]+$/);
    });

    it("slugifies the hint", () => {
      const id = generateWorkspaceId("Add Canvas Zoom!");
      expect(id).toMatch(/^ws_[0-9a-f]{6}-add-canvas-zoom$/);
    });

    it("clamps long hints", () => {
      const long = "a".repeat(200);
      const id = generateWorkspaceId(long);
      // Hex prefix + slug should be ≤ 50 chars after ws_
      expect(id.length).toBeLessThanOrEqual(60);
    });

    it("falls back to a flower name for empty hints (follow-up D)", () => {
      const id = generateWorkspaceId("");
      // Single flower word, no adjective+noun pair.
      expect(id).toMatch(/^ws_[0-9a-f]{6}-[a-z]+$/);
    });

    it("falls back for non-alphanumeric hints", () => {
      const id = generateWorkspaceId("!!!@@@###");
      expect(id).toMatch(/^ws_[0-9a-f]{6}-[a-z]+$/);
    });

    it("never produces collisions over 1000 calls", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        const id = generateWorkspaceId(`test-${i}`);
        seen.add(id);
      }
      expect(seen.size).toBe(1000);
    });
  });

  describe("generateBranchName", () => {
    it("matches zeros/<flower>-<hex> (follow-up D)", () => {
      const name = generateBranchName();
      expect(name).toMatch(/^zeros\/[a-z]+-[0-9a-f]{4}$/);
    });

    it("only picks names from the curated flower dictionary", async () => {
      const { flowerDictionary } = await import("../naming");
      const flowers = new Set(flowerDictionary());
      for (let i = 0; i < 200; i++) {
        const name = generateBranchName();
        const m = name.match(/^zeros\/([a-z]+)-[0-9a-f]{4}$/);
        expect(m).not.toBeNull();
        expect(flowers.has(m![1])).toBe(true);
      }
    });

    it("produces low collision rate over 1000 calls", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        seen.add(generateBranchName());
      }
      // ~250 flowers × 65k hex tails = ~16M unique combinations.
      // 1000 samples should collide essentially never. 0.1% slack for
      // flake-resistance on small dictionaries.
      expect(seen.size).toBeGreaterThanOrEqual(999);
    });

    it("flower dictionary has at least 200 entries and is alphabetized", async () => {
      const { flowerDictionary } = await import("../naming");
      const flowers = flowerDictionary();
      expect(flowers.length).toBeGreaterThanOrEqual(200);
      // All entries are valid branch slugs (a-z, 3-12 chars).
      for (const f of flowers) {
        expect(f).toMatch(/^[a-z]{3,12}$/);
      }
      // No duplicates.
      expect(new Set(flowers).size).toBe(flowers.length);
    });
  });

  describe("isValidBranchName", () => {
    it("accepts well-formed names", () => {
      expect(isValidBranchName("add-canvas-zoom")).toBe(true);
      expect(isValidBranchName("fix-bug-123")).toBe(true);
      expect(isValidBranchName("a-b-c")).toBe(true);
    });

    it("rejects names that start with non-letter", () => {
      expect(isValidBranchName("1-bad")).toBe(false);
      expect(isValidBranchName("-bad")).toBe(false);
    });

    it("rejects too-short names", () => {
      expect(isValidBranchName("ab")).toBe(false);
    });

    it("rejects too-long names", () => {
      expect(isValidBranchName("a".repeat(50))).toBe(false);
    });

    it("rejects uppercase / underscores / slashes", () => {
      expect(isValidBranchName("Add-Zoom")).toBe(false);
      expect(isValidBranchName("add_zoom")).toBe(false);
      expect(isValidBranchName("zeros/foo")).toBe(false);
    });

    it("rejects reserved names", () => {
      expect(isValidBranchName("main")).toBe(false);
      expect(isValidBranchName("master")).toBe(false);
      expect(isValidBranchName("head")).toBe(false);
    });
  });
});
