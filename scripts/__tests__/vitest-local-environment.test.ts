import { expect, it } from "vitest";

it("starts repo tests without inherited Local admission", () => {
  expect(process.env.ZEROS_LOCAL_DEVELOPMENT).toBeUndefined();
});
