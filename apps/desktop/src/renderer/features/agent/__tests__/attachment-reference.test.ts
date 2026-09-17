import { expect, it } from "vitest";
import {
  attachmentReferenceBlock,
  countPromptAttachments,
} from "../attachment-reference";

it("quotes filenames and paths without changing the path the agent must read", () => {
  const name = 'screen "one".png';
  const path = "/repo with spaces/.context/local/attachments/id/screen.png";
  const prompt = attachmentReferenceBlock({
    name,
    absolutePath: path,
    mimeType: "image/png",
  });
  const lines = prompt.split("\n");
  expect(JSON.parse(lines[1].slice("Path: ".length))).toBe(path);
  expect(lines[0]).toContain(JSON.stringify(name));
  expect(prompt).toContain("image-reading tool");
});

it("counts image references as images rather than text attachments", () => {
  expect(
    countPromptAttachments(
      [
        { type: "text", text: "reference to screenshot" },
        { type: "text", text: "reference to notes" },
      ],
      [
        { kind: "image", name: "screen.png", mimeType: "image/png" },
        { kind: "text", name: "notes.md", mimeType: "text/markdown" },
      ],
    ),
  ).toEqual({ image: 1, text: 1 });
});

it("retains the native-content fallback for older sends with no attachment metadata", () => {
  expect(
    countPromptAttachments([
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "text", text: "text file" },
    ]),
  ).toEqual({ image: 1, text: 1 });
});
