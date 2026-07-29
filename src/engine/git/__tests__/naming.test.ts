import { describe, it, expect } from "vitest";
import {
  branchDisplayName,
  colourDictionary,
  generateWorkspaceId,
  isValidBranchName,
  pickFreeColourName,
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

    it("falls back to a colour name for empty hints", () => {
      const id = generateWorkspaceId("");
      // Lowercased: the workspace id is a path component, not a display name.
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

  describe("pickFreeColourName", () => {
    it("returns a bare capitalized colour when nothing is used", () => {
      const name = pickFreeColourName([]);
      expect(name).toMatch(/^[A-Z][a-z]{2,15}$/);
      expect(new Set(colourDictionary()).has(name!)).toBe(true);
    });

    it("never returns a name already in use", () => {
      const all = colourDictionary();
      const used = all.slice(0, 349);
      // Exactly one name left: it must pick that one, every time.
      for (let i = 0; i < 50; i++) {
        expect(pickFreeColourName(used)).toBe(all[349]);
      }
    });

    it("treats used names case-insensitively", () => {
      // macOS folds case and git loose refs are files, so "cream" claims
      // "Cream". Feed the whole dictionary lowercased: nothing is free, so it
      // must fall through to the -v1 round rather than re-hand out a base name.
      const lowered = colourDictionary().map((c) => c.toLowerCase());
      const name = pickFreeColourName(lowered);
      expect(name).toMatch(/^[A-Z][a-z]{2,15}-v1$/);
    });

    it("only falls back to -vN once every base colour is taken", () => {
      const all = colourDictionary();
      // One base name free → no suffix, even though 349 are gone.
      expect(pickFreeColourName(all.slice(0, 349))).toBe(all[349]);
      // All gone → -v1.
      expect(pickFreeColourName(all)).toMatch(/-v1$/);
      // -v1 round also gone → -v2.
      const withV1 = [...all, ...all.map((c) => `${c}-v1`)];
      expect(pickFreeColourName(withV1)).toMatch(/-v2$/);
    });

    it("returns null only when the suffix rounds are exhausted", () => {
      const all = colourDictionary();
      const used = [...all];
      for (let round = 1; round <= 100; round++) {
        for (const c of all) used.push(`${c}-v${round}`);
      }
      expect(pickFreeColourName(used)).toBeNull();
    });

    it("does not hand out names in alphabetical order", () => {
      // Successive workspaces marching "Absinthe, Alabaster, Alizarin" would
      // read as a counter and make two workspaces easy to confuse.
      const picks = Array.from({ length: 40 }, () => pickFreeColourName([]));
      const sorted = [...picks].sort();
      expect(picks).not.toEqual(sorted);
    });

    it("every allocated name is a valid branch name", () => {
      for (const c of colourDictionary()) {
        expect(isValidBranchName(c)).toBe(true);
        expect(isValidBranchName(`${c}-v3`)).toBe(true);
      }
    });
  });

  describe("colour dictionary", () => {
    it("has exactly 350 entries", () => {
      expect(colourDictionary().length).toBe(350);
    });

    it("is single capitalized words, alphabetized, no duplicates", () => {
      const colours = colourDictionary();
      for (const c of colours) {
        // No spaces or hyphens: the name becomes a branch AND a directory.
        expect(c).toMatch(/^[A-Z][a-z]{2,15}$/);
      }
      expect(new Set(colours).size).toBe(colours.length);
      expect([...colours].sort()).toEqual([...colours]);
    });

    it("is unique under case folding", () => {
      // Two names differing only in case would be ONE file on macOS, both as
      // a worktree directory and as a git loose ref.
      const folded = colourDictionary().map((c) => c.toLowerCase());
      expect(new Set(folded).size).toBe(folded.length);
    });

    it("collides with no reserved branch name", () => {
      for (const c of colourDictionary()) {
        expect(isValidBranchName(c)).toBe(true);
      }
      expect(isValidBranchName("Main")).toBe(false);
    });
  });

  describe("branchDisplayName", () => {
    it("strips the ownership prefix", () => {
      expect(branchDisplayName("zeros/Cream")).toBe("Cream");
      expect(branchDisplayName("zeros/Cream-v2")).toBe("Cream-v2");
    });

    it("passes through a branch that is not workspace-owned", () => {
      expect(branchDisplayName("main")).toBe("main");
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

    it("accepts uppercase (colour names, since 2026-07-29)", () => {
      // Was rejected until workspace names became capitalized colours.
      expect(isValidBranchName("Add-Zoom")).toBe(true);
      expect(isValidBranchName("Cream")).toBe(true);
      expect(isValidBranchName("Cream-v2")).toBe(true);
    });

    it("still rejects underscores / slashes", () => {
      expect(isValidBranchName("add_zoom")).toBe(false);
      expect(isValidBranchName("zeros/foo")).toBe(false);
      expect(isValidBranchName("zeros/Cream")).toBe(false);
    });

    it("rejects reserved names in any casing", () => {
      expect(isValidBranchName("main")).toBe(false);
      expect(isValidBranchName("master")).toBe(false);
      expect(isValidBranchName("head")).toBe(false);
      // Case folding matters: git would resolve "Main" to "main" on a
      // case-insensitive filesystem.
      expect(isValidBranchName("Main")).toBe(false);
      expect(isValidBranchName("MASTER")).toBe(false);
    });
  });
});
