import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DESIGN_MAX_FRAMES_PER_PAGE,
  DESIGN_MAX_PAGES,
} from "@zeros/protocol/design-pages";
import { DESIGN_GUIDES } from "../document";
import {
  DESIGN_RULES,
  GENERATED_DESIGN_RULES,
  ROOT_DESIGN_RULES,
  LEGACY_DESIGN_RULES,
  PREVIOUS_NATIVE_DESIGN_RULES,
  PREVIOUS_PAGED_DESIGN_RULES,
  PREVIOUS_PER_PAGE_DESIGN_RULES,
  upgradedDesignRules,
} from "../design-rules";

describe("page authoring guidance", () => {
  it("describes adding native pages with stable identities and portable folders", () => {
    expect(DESIGN_RULES).toContain("meta/canvas.json pages");
    expect(DESIGN_RULES).toContain(
      '{"id":"checkout","title":"Checkout","folder":"checkout","frames":[]}',
    );
    expect(DESIGN_RULES).toContain("create the folder");
    expect(DESIGN_RULES).toContain("one portable segment");
    expect(DESIGN_RULES).toContain("lowercase slug");
    expect(DESIGN_RULES).toContain("meta, assets or components");
    expect(DESIGN_RULES).toContain("../tokens.css");
    expect(DESIGN_RULES).toContain(
      `1-${DESIGN_MAX_PAGES} pages and at most ${DESIGN_MAX_FRAMES_PER_PAGE.toLocaleString("en-US")} frames per page`,
    );
    expect(DESIGN_RULES).not.toContain("256");
  });

  it("keeps shipped generated rules recognizable with their additions intact", () => {
    // ROOT_DESIGN_RULES shipped before Pages; its exact bytes select the
    // generated-rules upgrade/removal path rather than custom-source ownership.
    expect(createHash("sha256").update(ROOT_DESIGN_RULES).digest("hex")).toBe(
      "8b135186b610443e0de8aa7e1efc672fc0260c5e2ff34efc424620211970d150",
    );
    // The paged rules shipped with a directory-wide 256-frame sentence.
    expect(createHash("sha256").update(PREVIOUS_PAGED_DESIGN_RULES).digest("hex")).toBe(
      "f38ac7a9b872d87d8e5deedbf7ae052356ee7d88e7d9b574db6e8c7c4b62d762",
    );
    expect(GENERATED_DESIGN_RULES).toContain(PREVIOUS_PAGED_DESIGN_RULES);
    // The per-page rules shipped before the authoring contract.
    expect(createHash("sha256").update(PREVIOUS_PER_PAGE_DESIGN_RULES).digest("hex")).toBe(
      "69aa279db449eeac1e53b17ce7ee5e9e957096d11c721085851261233067b114",
    );
    expect(GENERATED_DESIGN_RULES).toContain(PREVIOUS_PER_PAGE_DESIGN_RULES);
    for (const previous of [
      ROOT_DESIGN_RULES,
      LEGACY_DESIGN_RULES,
      PREVIOUS_NATIVE_DESIGN_RULES,
      PREVIOUS_PAGED_DESIGN_RULES,
      PREVIOUS_PER_PAGE_DESIGN_RULES,
    ])
      expect(upgradedDesignRules(previous + "\nKeep our brand.\n", 2)).toBe(
        DESIGN_RULES + "\nKeep our brand.\n",
      );
    const custom = "# Project rules\nUse native Pages.\n";
    expect(upgradedDesignRules(custom, 2)).toBe(custom);
  });

  it("carries the authoring contract into upgraded directories and leaves edited rules alone", () => {
    for (const rule of [
      "One class vocabulary per directory",
      "never a second copy",
      "var(--name)",
      "Inline style is for one-off values",
      "data-oid is optional",
      "data-name",
      "data-zd-captured on its root",
      "The contract checks skip marked markup",
      "repeated three or more times becomes a component",
    ])
      expect(DESIGN_RULES).toContain(rule);
    const project = "\n## Project\nKeep the supplied brand.\n";
    expect(upgradedDesignRules(PREVIOUS_PER_PAGE_DESIGN_RULES + project, 2)).toBe(DESIGN_RULES + project);
    // Upgrading twice changes nothing more.
    expect(upgradedDesignRules(DESIGN_RULES + project, 2)).toBe(DESIGN_RULES + project);
    // One changed word makes the whole file the project's own.
    const edited = PREVIOUS_PER_PAGE_DESIGN_RULES.replace("Commit this folder together.", "Commit this folder with the app.") + project;
    expect(upgradedDesignRules(edited, 2)).toBe(edited);
    // An unpaged directory keeps its own generated rules until it moves to pages.
    expect(upgradedDesignRules(ROOT_DESIGN_RULES + project, 1)).toBe(ROOT_DESIGN_RULES + project);
  });

  it("keeps frame and workflow guides aligned with the active directory's pages", () => {
    expect(DESIGN_GUIDES.frame).toContain("page folder");
    expect(DESIGN_GUIDES.frame).toContain("../tokens.css");
    expect(DESIGN_GUIDES.frame).toContain("meta/canvas.json");
    expect(DESIGN_GUIDES.frame).not.toContain("top-level .html");
    expect(DESIGN_GUIDES.workflow).toContain("active Design directory");
    expect(DESIGN_GUIDES.workflow).not.toContain("only under Zeros Design/");
  });
});
