import { describe, expect, it } from "vitest";
import { isSubmittedComposerDocument } from "../composer-submission";

describe("composer edits during attachment transfer", () => {
  const submitted = {
    type: "doc",
    content: [
      { type: "text", text: "inspect the video" },
      { type: "attachment", attrs: { attachmentId: "att-1" } },
    ],
  };
  it("clears the submitted draft when only attachment progress has changed", () => {
    expect(
      isSubmittedComposerDocument(submitted, structuredClone(submitted)),
    ).toBe(true);
  });
  it("retains text and file selections edited while the transfer was pending", () => {
    expect(
      isSubmittedComposerDocument(submitted, {
        ...submitted,
        content: [
          ...submitted.content,
          { type: "text", text: "and compare the audio" },
        ],
      }),
    ).toBe(false);
    expect(
      isSubmittedComposerDocument(submitted, {
        ...submitted,
        content: [submitted.content[0]],
      }),
    ).toBe(false);
    expect(isSubmittedComposerDocument(submitted, undefined)).toBe(false);
  });
});
