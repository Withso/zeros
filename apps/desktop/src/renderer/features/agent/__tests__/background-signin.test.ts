import { describe, expect, it } from "vitest";

import {
  startBackgroundSignIn,
  supportsBackgroundSignIn,
} from "../background-signin";

describe("background sign-in runtime gate", () => {
  it("supports the same browser entry point for Claude, Codex and Cursor", () => {
    expect(["claude", "codex", "cursor"].map(supportsBackgroundSignIn)).toEqual(
      [true, true, true],
    );
    expect(supportsBackgroundSignIn("__proto__")).toBe(false);
  });
  it("refuses to create a hidden auth PTY outside the Mac app", async () => {
    await expect(startBackgroundSignIn("claude")).resolves.toEqual({
      ok: false,
      error: "Background sign-in is available only in the Zeros Mac app.",
    });
  });
});
