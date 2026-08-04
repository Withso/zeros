import { describe, expect, it } from "vitest";

import { messageToEditorContent } from "../composer-editor/reconstruct";

describe("messageToEditorContent — disk-backed images", () => {
  it("carries the disk reference into edit mode without transcript base64", () => {
    const content = messageToEditorContent({
      text: "look",
      segments: [
        { type: "text", text: "look " },
        {
          type: "attachment",
          name: "shot.png",
          mimeType: "image/png",
          kind: "image",
          diskPath: ".context-graph/local/attachments/a1/shot.png",
          attachmentId: "a1",
        },
      ],
    });

    expect(content.attachments).toHaveLength(1);
    expect(content.attachments[0]).toMatchObject({
      name: "shot.png",
      kind: "image",
      data: "",
      diskPath: ".context-graph/local/attachments/a1/shot.png",
      contextAttachmentId: "a1",
    });
  });

  it("still reconstructs legacy data-URL transcripts", () => {
    const content = messageToEditorContent({
      text: "legacy",
      attachments: [
        {
          name: "old.png",
          mimeType: "image/png",
          kind: "image",
          thumbnailUri: "data:image/png;base64,T0xE",
        },
      ],
    });

    expect(content.attachments[0]).toMatchObject({ data: "T0xE", size: 3 });
  });
});
