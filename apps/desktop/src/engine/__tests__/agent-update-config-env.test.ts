import { describe, expect, it } from "vitest";

import { ZerosEngine } from "../index";

type RelayScrubber = {
  scrubRelayUpdateConfigEnv(
    this: { pty: { isWithinAllowed(path: string): boolean } },
    env: Record<string, string>,
  ): Record<string, string>;
};

describe("remote agent config env allowlist", () => {
  it("preserves every provider model choice and safe composer knob", () => {
    const scrub = (ZerosEngine.prototype as unknown as RelayScrubber)
      .scrubRelayUpdateConfigEnv;
    const result = scrub.call(
      { pty: { isWithinAllowed: (path) => path === "/managed/repo" } },
      {
        ANTHROPIC_MODEL: "claude-opus-4-8",
        OPENAI_MODEL: "gpt-5.6-sol",
        CURSOR_MODEL: "composer-2.5",
        ZEROS_THINKING_EFFORT: "max",
        ZEROS_FAST_MODE: "1",
        ZEROS_ADDITIONAL_DIRS: '["/managed/repo","/private"]',
        NODE_OPTIONS: "--require=/private/inject.js",
        PATH: "/private/bin",
      },
    );

    expect(result).toEqual({
      ANTHROPIC_MODEL: "claude-opus-4-8",
      OPENAI_MODEL: "gpt-5.6-sol",
      CURSOR_MODEL: "composer-2.5",
      ZEROS_THINKING_EFFORT: "max",
      ZEROS_FAST_MODE: "1",
      ZEROS_ADDITIONAL_DIRS: '["/managed/repo"]',
    });
  });
});
