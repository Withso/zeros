import { describe, expect, it } from "vitest";

import { deferBootSessionAdmission } from "../lazy-boot-resume";

const base = {
  isFocusedChat: false,
  pendingAutoSend: false,
  composerHasText: false,
  preparing: false,
};

describe("deferBootSessionAdmission", () => {
  it("keeps a link navigation adopt-only despite focus, saved text, or a queued draft", () => {
    expect(deferBootSessionAdmission({ ...base, navigationOnly: true, isFocusedChat: true,
      composerHasText: true, pendingAutoSend: true })).toBe(true);
    expect(deferBootSessionAdmission({ ...base, navigationOnly: false, isFocusedChat: true })).toBe(false);
  });
  it("lets the focused chat admit eagerly", () => {
    expect(
      deferBootSessionAdmission({ ...base, isFocusedChat: true }),
    ).toBe(false);
  });

  it("defers a surfaced but unfocused pane", () => {
    expect(deferBootSessionAdmission(base)).toBe(true);
  });

  it("does not defer once there is intent", () => {
    expect(
      deferBootSessionAdmission({ ...base, composerHasText: true }),
    ).toBe(false);
    expect(
      deferBootSessionAdmission({ ...base, pendingAutoSend: true }),
    ).toBe(false);
  });

  it("leaves a hover-prepared surface alone (it never spawns anyway)", () => {
    expect(deferBootSessionAdmission({ ...base, preparing: true })).toBe(false);
  });
});
