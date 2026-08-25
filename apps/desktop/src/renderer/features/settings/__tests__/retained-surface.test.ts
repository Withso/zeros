import { describe, expect, it } from "vitest";

import { retainedDialogOpen } from "../retained-surface";

describe("retainedDialogOpen", () => {
  it("makes an open dialog inert as soon as its retained surface deactivates", () => {
    expect(retainedDialogOpen(true, true)).toBe(true);
    expect(retainedDialogOpen(false, true)).toBe(false);
  });
});
