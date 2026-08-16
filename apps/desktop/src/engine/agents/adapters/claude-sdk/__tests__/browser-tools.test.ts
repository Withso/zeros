import { describe, expect, it } from "vitest";

import { claudeNativeBrowserExtraArgs } from "../adapter";

describe("Claude native browser adapter", () => {
  it("maps Browser use to Claude Code's official --chrome flag", () => {
    expect(claudeNativeBrowserExtraArgs(true)).toEqual({ chrome: null });
  });

  it("explicitly disables Chrome when Browser use is off", () => {
    expect(claudeNativeBrowserExtraArgs(false)).toEqual({ "no-chrome": null });
  });
});
