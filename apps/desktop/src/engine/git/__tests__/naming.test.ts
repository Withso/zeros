import { describe, it, expect } from "vitest";
import {
  branchDisplayName,
  colourDictionary,
  DEFAULT_BRANCH_PREFIX,
  generateWorkspaceId,
  isValidBranchName,
  joinBranchPrefix,
  normalizeBranchPrefix,
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

    it("strips an unknown prefix when the tail is an allocated name", () => {
      // The prefix stopped being a constant on 2026-07-29. A capitalized
      // colour tail is the tell that the allocator produced this branch,
      // whichever prefix was configured at the time.
      expect(branchDisplayName("jordan/Cream")).toBe("Cream");
      expect(branchDisplayName("feature/Cream-v2")).toBe("Cream-v2");
      expect(branchDisplayName("team/squad/Cream")).toBe("Cream");
    });

    it("keeps the namespace of a branch Zeros did not name", () => {
      // An adopted worktree or a user's own branch carries its prefix as
      // identity — stripping it would erase which tool owns the branch, and
      // (via managedWorkspacePath) collapse two distinct branches onto one
      // checkout directory.
      expect(branchDisplayName("cursor/foo")).toBe("cursor/foo");
      expect(branchDisplayName("feature/path-name")).toBe("feature/path-name");
    });

    it("strips the legacy prefix regardless of name shape", () => {
      // Pre-2026-07-29 workspaces are on the lowercase flower scheme. They are
      // ours by construction, so the shape test doesn't apply under `zeros/`.
      expect(branchDisplayName("zeros/lupine-1a2b")).toBe("lupine-1a2b");
    });

    it("leaves a non-slash prefix attached", () => {
      // A `myname-` style prefix has no boundary to cut at — the tab shows
      // the whole thing, which is the honest reading of the branch name.
      expect(branchDisplayName("myname-Cream")).toBe("myname-Cream");
    });
  });

  describe("normalizeBranchPrefix", () => {
    it("reduces a prefix to a bare namespace", () => {
      // The separator belongs to joinBranchPrefix, so a prefix normalizes to
      // the namespace ALONE — that is what makes `jordan` and `jordan/` the
      // same setting instead of `jordan/Cream` vs `jordanCream`.
      expect(normalizeBranchPrefix("jordan")).toBe("jordan");
      expect(normalizeBranchPrefix("feature/")).toBe("feature");
      expect(normalizeBranchPrefix("team/squad/")).toBe("team/squad");
      expect(normalizeBranchPrefix("  spaced/  ")).toBe("spaced");
    });

    it("tolerates leading and repeated separators", () => {
      // Someone typing a path is describing a namespace, not a ref — repair it
      // rather than falling back to the default behind their back.
      expect(normalizeBranchPrefix("/leading")).toBe("leading");
      expect(normalizeBranchPrefix("/wrapped/")).toBe("wrapped");
      expect(normalizeBranchPrefix("//doubled//")).toBe("doubled");
    });

    it("leaves a non-slash trailing character alone", () => {
      // Only `/` is ours to normalize. `-` is an ordinary name character, and
      // silently trimming it would edit what the user typed; the settings
      // preview shows the resulting `myname-/Cream` instead.
      expect(normalizeBranchPrefix("myname-")).toBe("myname-");
    });

    it("returns null for an empty prefix so the caller falls back", () => {
      expect(normalizeBranchPrefix("")).toBeNull();
      expect(normalizeBranchPrefix("   ")).toBeNull();
      expect(normalizeBranchPrefix("/")).toBeNull();
      expect(normalizeBranchPrefix("///")).toBeNull();
      expect(normalizeBranchPrefix(undefined)).toBeNull();
    });

    it("rejects anything git would refuse or a shell could misread", () => {
      // This value reaches a `git update-ref` argument.
      expect(normalizeBranchPrefix("--upload-pack=evil/")).toBeNull();
      expect(normalizeBranchPrefix("a..b/")).toBeNull();
      // An INNER double slash is ambiguous (empty namespace or typo?) and
      // survives the leading/trailing strip, so it still falls back.
      expect(normalizeBranchPrefix("a//b")).toBeNull();
      expect(normalizeBranchPrefix("trailing.")).toBeNull();
      expect(normalizeBranchPrefix("weird.lock")).toBeNull();
      expect(normalizeBranchPrefix("has space/")).toBeNull();
      expect(normalizeBranchPrefix("quote'/")).toBeNull();
      expect(normalizeBranchPrefix("semi;colon/")).toBeNull();
      expect(normalizeBranchPrefix("tilde~/")).toBeNull();
      expect(normalizeBranchPrefix("caret^/")).toBeNull();
      expect(normalizeBranchPrefix("star*/")).toBeNull();
    });

    it("rejects an over-long prefix, measured after normalization", () => {
      expect(normalizeBranchPrefix("a".repeat(64))).toBe("a".repeat(64));
      expect(normalizeBranchPrefix("a".repeat(65))).toBeNull();
      // The separators don't count against the budget — they aren't stored.
      expect(normalizeBranchPrefix(`/${"a".repeat(64)}/`)).toBe("a".repeat(64));
    });

    it("applies git's dot/.lock rules to EVERY path component", () => {
      // Checking only the ends of the whole string let these through, and
      // `git check-ref-format` then rejected them at create time — turning a
      // bad setting into an opaque failure on every workspace create. The
      // contract is that a bad prefix falls back, never breaks creation.
      expect(normalizeBranchPrefix("foo.lock/")).toBeNull();
      expect(normalizeBranchPrefix("a/.b/")).toBeNull();
      expect(normalizeBranchPrefix("a/b.lock/c/")).toBeNull();
      expect(normalizeBranchPrefix("a/b./c/")).toBeNull();
      expect(normalizeBranchPrefix(".hidden/")).toBeNull();
      expect(normalizeBranchPrefix("a/b/")).toBe("a/b");
      expect(normalizeBranchPrefix("v1.2/")).toBe("v1.2");
    });
  });

  describe("joinBranchPrefix", () => {
    it("joins with exactly one separator", () => {
      expect(joinBranchPrefix("jordan", "Cream")).toBe("jordan/Cream");
      expect(joinBranchPrefix("team/squad", "Cream")).toBe("team/squad/Cream");
      expect(joinBranchPrefix(DEFAULT_BRANCH_PREFIX, "Cream")).toBe(
        "zeros/Cream",
      );
    });

    it("emits the bare name when there is no prefix", () => {
      // `branch_prefix_type = "none"`. A dangling "/Cream" is not a valid ref.
      expect(joinBranchPrefix(null, "Cream")).toBe("Cream");
      expect(joinBranchPrefix("", "Cream")).toBe("Cream");
      expect(joinBranchPrefix(undefined, "Cream")).toBe("Cream");
    });

    it("round-trips through branchDisplayName", () => {
      // The two halves of the contract: whatever the allocator joins, the
      // labels must be able to take apart again.
      for (const prefix of [null, "zeros", "jordan", "team/squad"]) {
        expect(branchDisplayName(joinBranchPrefix(prefix, "Cream"))).toBe(
          "Cream",
        );
      }
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
