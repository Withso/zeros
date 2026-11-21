import { describe, expect, it } from "vitest";
import { isSubmittedComposerDocument, sendClearsChatDraft } from "../composer-submission";

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

describe("the saved draft after a send", () => {
  // Local and cloud sends both decide through this one rule.
  it("survives a reply sent beside the composer", () => {
    expect(sendClearsChatDraft({ override: true, keepDraft: true, submittedUnchanged: false })).toBe(false);
  });
  it("is retired by the composer's own unchanged send and by another surface's send", () => {
    expect(sendClearsChatDraft({ override: false, keepDraft: false, submittedUnchanged: true })).toBe(true);
    expect(sendClearsChatDraft({ override: true, keepDraft: false, submittedUnchanged: false })).toBe(true);
    expect(sendClearsChatDraft({ override: false, keepDraft: false, submittedUnchanged: false })).toBe(false);
  });
});
