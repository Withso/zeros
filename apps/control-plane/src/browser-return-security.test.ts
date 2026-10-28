import { expect, it } from "vitest";
import { safeWorkOSReturnPath } from "./workos-browser-sessions.js";

it("keeps repeated return-path normalization on the exact app origin", () => {
  const origin = "https://app.example.test";
  for (let value of [origin + "//outside.example.test/", origin + "//app.example.test//outside.example.test", "/\\outside.example.test", "/\n/outside.example.test"]) {
    for (let index = 0; index < 4; index++) {
      value = safeWorkOSReturnPath(value, origin);
      expect(new URL(value, origin).origin).toBe(origin);
    }
  }
  expect(safeWorkOSReturnPath("/settings?tab=git#account", origin)).toBe("/settings?tab=git#account");
});
