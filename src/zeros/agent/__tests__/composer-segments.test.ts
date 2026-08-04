// Pure-function tests for the composer's segment serialization helpers.
// (The full editor walk needs a DOM, which this node-env runner excludes —
// these cover the logic that maps composer segments to the persisted bubble
// segments + seeds plain-text drafts.)

import { describe, it, expect } from "vitest";

import { toMessageSegments, textToDoc } from "../composer-editor/serialize";
import type { ComposerSegment } from "../composer-editor/segments";
import type { ComposerAttachment } from "../composer-attachments";

describe("toMessageSegments", () => {
  it("passes text + mention through, dropping transient fields (token)", () => {
    const segs: ComposerSegment[] = [
      { type: "text", text: "look at " },
      {
        type: "mention",
        token: "`src/foo.ts`",
        label: "foo.ts",
        path: "src/foo.ts",
        kind: "file",
      },
      { type: "text", text: " please" },
    ];
    expect(toMessageSegments(segs, [])).toEqual([
      { type: "text", text: "look at " },
      { type: "mention", label: "foo.ts", path: "src/foo.ts", kind: "file" },
      { type: "text", text: " please" },
    ]);
  });

  it("persists an image disk reference without copying its base64", () => {
    const segs: ComposerSegment[] = [
      {
        type: "attachment",
        attachmentId: "a1",
        name: "shot.png",
        mimeType: "image/png",
        kind: "image",
      },
    ];
    const atts: ComposerAttachment[] = [
      {
        id: "a1",
        name: "shot.png",
        mimeType: "image/png",
        kind: "image",
        data: "BASE64",
        size: 10,
        validation: { ok: true },
      },
    ];
    const bubbleById = new Map([
      [
        "a1",
        {
          name: "shot.png",
          mimeType: "image/png",
          kind: "image" as const,
          diskPath: ".context-graph/local/attachments/a1/shot.png",
          attachmentId: "a1",
        },
      ],
    ]);
    expect(toMessageSegments(segs, atts, bubbleById)).toEqual([
      {
        type: "attachment",
        name: "shot.png",
        mimeType: "image/png",
        kind: "image",
        diskPath: ".context-graph/local/attachments/a1/shot.png",
        attachmentId: "a1",
      },
    ]);
    expect(
      JSON.stringify(toMessageSegments(segs, atts, bubbleById)),
    ).not.toContain("BASE64");
  });

  it("never falls back to an inline thumbnail when storage metadata is absent", () => {
    const segs: ComposerSegment[] = [
      {
        type: "attachment",
        attachmentId: "big",
        name: "huge.png",
        mimeType: "image/png",
        kind: "image",
      },
    ];
    const atts: ComposerAttachment[] = [
      {
        id: "big",
        name: "huge.png",
        mimeType: "image/png",
        kind: "image",
        data: "A".repeat(128),
        size: 96,
        validation: { ok: true },
      },
    ];
    const [seg] = toMessageSegments(segs, atts);
    // The attachment pill still renders (name + kind), but transcript JSON
    // never gets image bytes regardless of image size.
    expect(seg).toMatchObject({
      type: "attachment",
      name: "huge.png",
      kind: "image",
    });
    expect(seg).not.toHaveProperty("thumbnailUri");
    expect(JSON.stringify(seg)).not.toContain("AAAA");
  });

  it("omits the thumbnail for text attachments and missing bytes", () => {
    const segs: ComposerSegment[] = [
      {
        type: "attachment",
        attachmentId: "t1",
        name: "notes.md",
        mimeType: "text/markdown",
        kind: "text",
      },
      {
        type: "attachment",
        attachmentId: "missing",
        name: "x.png",
        mimeType: "image/png",
        kind: "image",
      },
    ];
    const result = toMessageSegments(segs, []);
    expect(result[0]).toEqual({
      type: "attachment",
      name: "notes.md",
      mimeType: "text/markdown",
      kind: "text",
    });
    expect(result[1]).not.toHaveProperty("thumbnailUri");
  });
});

describe("textToDoc", () => {
  it("wraps text in a single paragraph", () => {
    expect(textToDoc("hello")).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello" }] },
      ],
    });
  });

  it("emits an empty paragraph for empty text", () => {
    expect(textToDoc("")).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
  });
});
