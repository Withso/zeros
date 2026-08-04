import { describe, expect, it } from "vitest";

import {
  beginInlineTextCommit,
  cancelInlineTextCommit,
  createInlineTextCommitGuard,
  finishInlineTextCommit,
} from "../design-inline-text-commit";

describe("design inline-text commit guard", () => {
  it("treats the blur after Escape as cancellation without poisoning a reopened edit", () => {
    const guard = createInlineTextCommitGuard<object>();
    const cancelledEdit = {};

    cancelInlineTextCommit(guard, cancelledEdit);
    expect(beginInlineTextCommit(guard, cancelledEdit, "frame\0node\0v1")).toBe(
      false,
    );

    const reopenedEdit = {};
    expect(beginInlineTextCommit(guard, reopenedEdit, "frame\0node\0v1")).toBe(
      true,
    );
    expect(beginInlineTextCommit(guard, reopenedEdit, "frame\0node\0v1")).toBe(
      false,
    );
    finishInlineTextCommit(guard, "frame\0node\0v1");
    expect(beginInlineTextCommit(guard, reopenedEdit, "frame\0node\0v1")).toBe(
      true,
    );
  });
});
