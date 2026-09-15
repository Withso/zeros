// End-to-end byte and reference coverage lives in reference-only-attachments.test.ts.
import { describe, expect, it, vi } from "vitest";
import {
  textAttachmentBlock,
  reportSkippedAttachments,
} from "../encode-attachments";

describe("textAttachmentBlock", () => {
  it("wraps the body in <file name>", () => {
    expect(textAttachmentBlock("a.txt", "body")).toBe(
      '<file name="a.txt">\nbody\n</file>',
    );
  });

  it("folds quotes in the name so the attribute can't be broken out of", () => {
    expect(textAttachmentBlock('we"ird.txt', "x")).toBe(
      `<file name="we'ird.txt">\nx\n</file>`,
    );
  });
});

describe("reportSkippedAttachments", () => {
  it("names every invalid selection and its reason", () => {
    const warn = vi.fn();
    reportSkippedAttachments(
      [
        { name: "large.txt", reason: "too big" },
        { name: "archive.zip", reason: "unsupported" },
      ],
      warn,
    );
    expect(warn.mock.calls).toEqual([
      ['"large.txt" wasn\'t sent — too big.'],
      ['"archive.zip" wasn\'t sent — unsupported.'],
    ]);
  });
  it("says nothing when every file was encoded", () => {
    const warn = vi.fn();
    reportSkippedAttachments([], warn);
    expect(warn).not.toHaveBeenCalled();
  });
  it("is called by every encoder call site in agent-chat", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      "apps/desktop/src/renderer/features/agent/agent-chat.tsx",
      "utf8",
    );

    // encodeAttachments directly, plus the encodeComposerAttachments wrapper
    // — but not the wrapper's own definition.
    const callSites = [
      ...src.matchAll(/await encode(?:Composer)?Attachments\(/g),
    ];
    expect(callSites.length).toBeGreaterThanOrEqual(3);

    const reports = [...src.matchAll(/reportSkippedAttachments\(/g)];
    expect(reports.length).toBe(callSites.length);
  });
});
