import { describe, expect, it } from "vitest";

import { startBackgroundSignIn } from "../background-signin";

describe("background sign-in runtime gate", () => {
  it("refuses to create a hidden auth PTY outside the Mac app", async () => {
    await expect(startBackgroundSignIn("claude")).resolves.toEqual({
      ok: false,
      error: "Background sign-in is available only in the Zeros Mac app.",
    });
  });
});
