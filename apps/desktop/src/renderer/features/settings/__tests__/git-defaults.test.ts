import { describe, it, expect } from "vitest";

import {
  OPTIONS,
  previewFor,
  readPreviewType,
  readType,
} from "../git-defaults-section";
import {
  BRANCH_PREFIX_TYPES,
  DEFAULT_BRANCH_PREFIX_TYPE,
} from "../../../../engine/settings/schema";
import { normalizeBranchPrefix } from "../../../shared/lib/branch-name";
import { cn } from "../../../shared/ui/cn";
import { badgeVariants } from "../../../shared/ui/primitives/badge";

// The Git pane's preview line is the only place the UI states what a setting
// will DO. If it disagrees with the engine, it is worse than no preview — the
// user reads a promise and gets something else on disk.

/** Every shape worth pinning: the ordinary ones, the separator variants the
 *  join rule has to absorb, and the hostile ones that must fall back. */
const EXPECTED: Record<string, string | null> = {
  jordan: "jordan",
  "feature/": "feature",
  "myname-": "myname-",
  "team/squad/": "team/squad",
  "/leading": "leading",
  "/wrapped/": "wrapped",
  "//doubled//": "doubled",
  "v1.2/": "v1.2",
  ["a".repeat(64)]: "a".repeat(64),
};

const PREFIX_CASES = [
  "jordan",
  "feature/",
  "myname-",
  "team/squad/",
  "/leading",
  "/wrapped/",
  "//doubled//",
  "/",
  "///",
  "v1.2/",
  "",
  "   ",
  "--upload-pack=evil/",
  "a..b/",
  "a//b",
  "trailing.",
  "weird.lock",
  "foo.lock/",
  "a/.b/",
  "has space/",
  "quote'/",
  "a".repeat(64),
  "a".repeat(65),
];

describe("prefix rules", () => {
  it("is the ENGINE's module, not a copy of it", async () => {
    // The renderer used to hand-copy these rules (naming.ts pulls node:crypto,
    // which cannot enter the browser bundle), and a drift was silent and
    // user-visible: the pane previews `hello/Cream`, the engine writes
    // `zeros/Cream`. The pure rules now live in an import-free module both
    // sides read, so identity — not agreement — is the thing to assert.
    const engine = await import("../../../../engine/git/branch-naming");
    const renderer = await import("../../../shared/lib/branch-name");
    expect(renderer.normalizeBranchPrefix).toBe(engine.normalizeBranchPrefix);
    expect(renderer.joinBranchPrefix).toBe(engine.joinBranchPrefix);
    expect(renderer.branchDisplayName).toBe(engine.branchDisplayName);
  });

  it("keeps that module free of imports", async () => {
    // The whole split rests on this file importing nothing: one `node:` import
    // here and the renderer bundle breaks (or the copy comes back).
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("apps/desktop/src/engine/git/branch-naming.ts", "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
  });

  it("normalizes every shape the settings pane can be handed", () => {
    for (const input of PREFIX_CASES) {
      // Snapshot-free: each case states its own answer, so a rule change has
      // to be acknowledged case by case rather than blessed in bulk.
      expect(normalizeBranchPrefix(input), `for ${JSON.stringify(input)}`).toBe(
        EXPECTED[input] ?? null,
      );
    }
  });
});

describe("previewFor", () => {
  it("names the resulting branch for each usable setting", () => {
    expect(previewFor("zeros", "", null)).toContain("zeros/Cream");
    expect(previewFor("github", "", "jordan")).toContain("jordan/Cream");
    expect(previewFor("custom", "hello", null)).toContain("hello/Cream");
  });

  it("states the ABSENCE for none, rather than previewing a bare name", () => {
    // 2026-07-29 founder direction. It used to render "New branches will be
    // named like Cream." — which reads as a naming scheme and gives no hint
    // that the other three rows put a namespace in FRONT of that name.
    expect(previewFor("none", "", null)).toBe(
      "New branches will have no prefix.",
    );
    // The example sentence is what it must NOT be: no branch is previewed here.
    expect(previewFor("none", "", null)).not.toContain("named like");
    expect(previewFor("none", "", null)).not.toContain("Cream");
    // A stale prefix/login in settings must not leak into the opt-out row.
    expect(previewFor("none", "hello", "jordan")).toBe(
      "New branches will have no prefix.",
    );
  });

  it("shows ONE separator however the user typed it", () => {
    // The whole point of the 2026-07-29 join rule: a prefix is a namespace, so
    // these are the same setting and must preview the same branch. Before it,
    // `hello` previewed (and created) the flat `helloCream`.
    for (const typed of ["hello", "hello/", "/hello", "/hello/", "//hello//"]) {
      expect(previewFor("custom", typed, null), `for ${typed}`).toContain(
        "hello/Cream",
      );
    }
  });

  it("keeps a non-slash trailing character and joins after it", () => {
    // Not silently trimmed — shown, so the user can see the shape and fix it.
    expect(previewFor("custom", "myname-", null)).toContain("myname-/Cream");
  });

  it("supports a multi-segment namespace", () => {
    expect(previewFor("custom", "team/squad", null)).toContain(
      "team/squad/Cream",
    );
  });

  it("admits when the engine will reject the custom prefix", () => {
    // Previously this previewed "my name/Cream" while the engine normalized
    // the value away and created zeros/Cream.
    const p = previewFor("custom", "my name/", null);
    expect(p).not.toContain("my name");
    expect(p).toContain("zeros/");
  });

  it("says what to do when GitHub is picked but no account is connected", () => {
    const p = previewFor("github", "", null);
    expect(p).toMatch(/connect github/i);
    // …and what happens UNTIL then. This row is the default (2026-08-03), so
    // "no account connected" is the fresh-install state rather than a deliberate
    // pick, and the ask alone left a new user with no idea what their branches
    // would be called meanwhile. The engine substitutes the `zeros` fallback.
    expect(p).toContain("zeros/Cream");
  });

  it("prompts for a value when custom is picked but empty", () => {
    // Just the ask (2026-07-29 founder direction). The old line explained the
    // slash-join too — but the field is empty, so there is nothing to explain
    // yet, and the moment the user types the preview shows the real branch.
    expect(previewFor("custom", "", null)).toBe("Enter a prefix.");
    expect(previewFor("custom", "   ", null)).toBe("Enter a prefix.");
    expect(previewFor("custom", "", null)).not.toContain("separated by");
  });
});

// The "GitHub username <login>" row renders the login as a `neutral` badge.
// That variant overrides the cva base's type scale, and cva CONCATENATES — so
// the override only lands if the result goes through tailwind-merge. Without
// it both classes reach the DOM, and at equal specificity the later RULE wins:
// Tailwind emits `.text-xs` after `.text-sm`, so the chip silently paints at
// the base 13px semibold the variant exists to avoid. None of that shows up in
// the class attribute's ORDER, which is why this asserts on the resolved set.
describe("the neutral badge chip", () => {
  const sizes = (cls: string) =>
    cls.split(/\s+/).filter((c) => /^text-(xs|sm|base|lg)$/.test(c));
  const weights = (cls: string) =>
    cls
      .split(/\s+/)
      .filter((c) => /^font-(normal|medium|semibold|bold)$/.test(c));

  it("resolves to exactly one type size and weight once merged", () => {
    const merged = cn(badgeVariants({ variant: "neutral" }));
    expect(sizes(merged)).toEqual(["text-sm"]);
    expect(weights(merged)).toEqual(["font-normal"]);
  });

  it("is why the raw cva call cannot be used at a call site", () => {
    // Pins the hazard itself. If a future base/variant change ever made the
    // raw call unambiguous, this failing is the signal to revisit the note at
    // the call site — not a bug.
    const raw = badgeVariants({ variant: "neutral" });
    expect(sizes(raw).length).toBeGreaterThan(1);
    expect(weights(raw).length).toBeGreaterThan(1);
  });
});

describe("BranchPrefixType", () => {
  it("mirrors the engine's BRANCH_PREFIX_TYPES exactly", () => {
    // The renderer duplicates the union rather than importing the zod schema
    // into the browser bundle; this is what keeps the copy honest.
    expect([...BRANCH_PREFIX_TYPES].sort()).toEqual(
      ["custom", "github", "none", "zeros"].sort(),
    );
  });
});

// The radio must never render with nothing selected (2026-08-03 founder
// direction). Before this, the default was the unlisted "zeros", so a fresh
// install showed three empty circles: the pane had a state for "the user hasn't
// chosen" even though the app had already chosen for them. The fix is a real
// default in the engine (repo-git.test.ts) plus this fold, which is what
// guarantees `selected` always names a row that exists.
describe("readType", () => {
  it("selects GitHub username by default", () => {
    // Unset is the fresh-install case — the pane reads the EFFECTIVE tree, and
    // an untouched one has no `git.branch_prefix_type` at all.
    expect(readType(undefined)).toBe("github");
    expect(readType(null)).toBe("github");
    // Whatever the engine defaults to is what the pane must preselect, or the
    // dot describes a branch the engine won't create.
    expect(readType(undefined)).toBe(DEFAULT_BRANCH_PREFIX_TYPE);
  });

  it("shows the user's explicit choice", () => {
    expect(readType("github")).toBe("github");
    expect(readType("custom")).toBe("custom");
    expect(readType("none")).toBe("none");
  });

  it("does not let the fold reach the preview line", () => {
    // The fold is for the RADIO — it must have a row for the dot. Applying it to
    // the preview too made the pane contradict the engine for the one value that
    // has no row: a repo/team layer pinning "zeros" showed the GitHub row (the
    // radio can't do better) AND promised `<login>/Cream`, while the engine kept
    // creating `zeros/`. The row still folds; the sentence tells the truth.
    expect(readType("zeros")).toBe("github");
    expect(readPreviewType("zeros")).toBe("zeros");
    expect(previewFor(readPreviewType("zeros"), "", "jordan")).toContain(
      "zeros/Cream",
    );
    // Everything else must resolve exactly as the radio does, or the line and
    // the dot would disagree for values the pane itself writes.
    for (const value of [undefined, null, "github", "custom", "none", "wat"]) {
      expect(
        readPreviewType(value),
        `for ${JSON.stringify(value) ?? "undefined"}`,
      ).toBe(readType(value));
    }
  });

  it("never leaves the group unselected, whatever the tree holds", () => {
    // "zeros" is a real schema value with no row of its own, and the rest are
    // the shapes a hand-edited settings.toml can produce. Every one of them has
    // to land on something the RadioGroup renders.
    for (const value of [
      undefined,
      null,
      "zeros",
      "wat",
      "",
      42,
      true,
      {},
      [],
      "GitHub",
    ]) {
      expect(
        OPTIONS as readonly string[],
        `for ${JSON.stringify(value) ?? "undefined"}`,
      ).toContain(readType(value));
    }
  });
});
