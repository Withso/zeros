import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DESIGN_GUIDES } from "../document";
import {
  DESIGN_RULES,
  ROOT_DESIGN_RULES,
  LEGACY_DESIGN_RULES,
  PREVIOUS_NATIVE_DESIGN_RULES,
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
  });

  it("keeps shipped generated rules recognizable with their additions intact", () => {
    // ROOT_DESIGN_RULES shipped before Pages; its exact bytes select the
    // generated-rules upgrade/removal path rather than custom-source ownership.
    expect(createHash("sha256").update(ROOT_DESIGN_RULES).digest("hex")).toBe(
      "8b135186b610443e0de8aa7e1efc672fc0260c5e2ff34efc424620211970d150",
    );
    for (const previous of [
      ROOT_DESIGN_RULES,
      LEGACY_DESIGN_RULES,
      PREVIOUS_NATIVE_DESIGN_RULES,
    ])
      expect(upgradedDesignRules(previous + "\nKeep our brand.\n", 2)).toBe(
        DESIGN_RULES + "\nKeep our brand.\n",
      );
    const custom = "# Project rules\nUse native Pages.\n";
    expect(upgradedDesignRules(custom, 2)).toBe(custom);
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
