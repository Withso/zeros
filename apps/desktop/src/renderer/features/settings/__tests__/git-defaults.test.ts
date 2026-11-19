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
    const engine = await import("../../../../engine/git/branch-naming");
    const renderer = await import("../../../shared/lib/branch-name");
    expect(renderer.normalizeBranchPrefix).toBe(engine.normalizeBranchPrefix);
    expect(renderer.joinBranchPrefix).toBe(engine.joinBranchPrefix);
    expect(renderer.branchDisplayName).toBe(engine.branchDisplayName);
  });

  it("keeps that module free of imports", async () => {
    // Both bundles import this module; Node-only dependencies would break the renderer.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("apps/desktop/src/engine/git/branch-naming.ts", "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
  });

  it("normalizes every shape the settings pane can be handed", () => {
    for (const input of PREFIX_CASES) {
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
    expect(previewFor("none", "", null)).toBe(
      "New branches will have no prefix.",
    );
    expect(previewFor("none", "", null)).not.toContain("named like");
    expect(previewFor("none", "", null)).not.toContain("Cream");
    expect(previewFor("none", "hello", "jordan")).toBe(
      "New branches will have no prefix.",
    );
  });

  it("shows ONE separator however the user typed it", () => {
    for (const typed of ["hello", "hello/", "/hello", "/hello/", "//hello//"]) {
      expect(previewFor("custom", typed, null), `for ${typed}`).toContain(
        "hello/Cream",
      );
    }
  });

  it("keeps a non-slash trailing character and joins after it", () => {
    expect(previewFor("custom", "myname-", null)).toContain("myname-/Cream");
  });

  it("supports a multi-segment namespace", () => {
    expect(previewFor("custom", "team/squad", null)).toContain(
      "team/squad/Cream",
    );
  });

  it("admits when the engine will reject the custom prefix", () => {
    const p = previewFor("custom", "my name/", null);
    expect(p).not.toContain("my name");
    expect(p).toContain("zeros/");
  });

  it("says what to do when GitHub is picked but no account is connected", () => {
    const p = previewFor("github", "", null);
    expect(p).toMatch(/connect github/i);
    // A fresh install has no account, so its default GitHub mode still needs a fallback preview.
    expect(p).toContain("zeros/Cream");
  });

  it("prompts for a value when custom is picked but empty", () => {
    expect(previewFor("custom", "", null)).toBe("Enter a prefix.");
    expect(previewFor("custom", "   ", null)).toBe("Enter a prefix.");
    expect(previewFor("custom", "", null)).not.toContain("separated by");
  });
});

// Assert the effective size: Tailwind rule order, not class order, decides when conflicting size classes survive.
describe("the neutral badge chip", () => {
  const sizes = (cls: string) =>
    cls.split(/\s+/).filter((c) => /^text-(3xxs|2xxs|xxs|xs|sm|base|lg)$/.test(c));
  const weights = (cls: string) =>
    cls
      .split(/\s+/)
      .filter((c) => /^font-(normal|medium|semibold|bold)$/.test(c));

  it("is the one badge size: 13px medium, merged or raw", () => {
    // The raw variant must have one size before caller-side class merging.
    for (const cls of [cn(badgeVariants({ variant: "neutral" })), badgeVariants({ variant: "neutral" })]) {
      expect(sizes(cls)).toEqual(["text-xs"]);
      expect(weights(cls)).toEqual(["font-medium"]);
    }
  });
});

describe("BranchPrefixType", () => {
  it("mirrors the engine's BRANCH_PREFIX_TYPES exactly", () => {
    // The renderer mirrors these values without importing the engine's schema bundle.
    expect([...BRANCH_PREFIX_TYPES].sort()).toEqual(
      ["custom", "github", "none", "zeros"].sort(),
    );
  });
});

describe("readType", () => {
  it("selects GitHub username by default", () => {
    // An untouched effective tree may omit the branch-prefix mode.
    expect(readType(undefined)).toBe("github");
    expect(readType(null)).toBe("github");
    expect(readType(undefined)).toBe(DEFAULT_BRANCH_PREFIX_TYPE);
  });

  it("shows the user's explicit choice", () => {
    expect(readType("github")).toBe("github");
    expect(readType("custom")).toBe("custom");
    expect(readType("none")).toBe("none");
  });

  it("does not let the fold reach the preview line", () => {
    // The schema's zeros mode has no radio row but must still preview its real prefix.
    expect(readType("zeros")).toBe("github");
    expect(readPreviewType("zeros")).toBe("zeros");
    expect(previewFor(readPreviewType("zeros"), "", "jordan")).toContain(
      "zeros/Cream",
    );
    for (const value of [undefined, null, "github", "custom", "none", "wat"]) {
      expect(
        readPreviewType(value),
        `for ${JSON.stringify(value) ?? "undefined"}`,
      ).toBe(readType(value));
    }
  });

  it("never leaves the group unselected, whatever the tree holds", () => {
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
