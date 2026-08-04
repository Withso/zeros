import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeAgentAttachment } from "../agent-attachment";

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-attachment-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("writeAgentAttachment", () => {
  it("uses the MIME extension so later reads classify the bytes correctly", async () => {
    const root = tempRoot();
    const result = await writeAgentAttachment(root, {
      chatId: "chat-1",
      attachmentId: "att-1",
      base64: Buffer.from("png bytes").toString("base64"),
      mimeType: "image/png",
      filename: "capture.jpg",
    });

    expect(result.relativePath).toBe(
      ".context/attachments/chat-1/att-1-capture.png",
    );
    expect(fs.readFileSync(result.absolutePath, "utf8")).toBe("png bytes");
  });

  it("rejects non-image MIME types and oversized payloads before writing", async () => {
    const root = tempRoot();
    const base = {
      chatId: "chat-1",
      attachmentId: "att-1",
      filename: "capture.png",
    };
    await expect(
      writeAgentAttachment(root, {
        ...base,
        base64: "aGVsbG8=",
        mimeType: "text/plain",
      }),
    ).rejects.toThrow(/image MIME/i);
    await expect(
      writeAgentAttachment(root, {
        ...base,
        base64: "A".repeat(7_000_000),
        mimeType: "image/png",
      }),
    ).rejects.toThrow(/too large/i);
    expect(fs.existsSync(path.join(root, ".context"))).toBe(false);
  });

  it("does not follow a symlinked .context directory outside the workspace", async () => {
    const root = tempRoot();
    const outside = tempRoot();
    fs.symlinkSync(outside, path.join(root, ".context"), "dir");

    await expect(
      writeAgentAttachment(root, {
        chatId: "chat-1",
        attachmentId: "att-1",
        base64: "aGVsbG8=",
        mimeType: "image/png",
        filename: "capture.png",
      }),
    ).rejects.toThrow(/symlink/i);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("adds the attachment rule without replacing an existing context ignore", async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, ".context"));
    fs.writeFileSync(path.join(root, ".context/.gitignore"), "notes/\n");

    await writeAgentAttachment(root, {
      chatId: "chat-1",
      attachmentId: "att-1",
      base64: "aGVsbG8=",
      mimeType: "image/png",
      filename: "capture.png",
    });

    expect(
      fs.readFileSync(path.join(root, ".context/.gitignore"), "utf8"),
    ).toBe("notes/\n/attachments/\n");
  });
});
