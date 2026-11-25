import { describe, expect, it } from "vitest";

import { ANCHORED_OVERLAY_MOTION } from "../../anchored-overlay-motion";

describe("anchored overlay motion", () => {
  // A duration-* class also sets transition-duration; with no
  // transition-property every popover property eased, so a theme switch
  // faded the card between palettes.
  it("animates its entry without opting every property into a transition", () => {
    const classes = ANCHORED_OVERLAY_MOTION.split(/\s+/);
    expect(classes).toContain("animate-in");
    expect(classes.filter((name) => /(^|:)(duration|transition)(-|$)/.test(name))).toEqual([]);
  });
});
