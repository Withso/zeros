import { expect, it } from "vitest";
import { contextAttachmentLocations, MAX_ATTACHMENT_BYTES, parseContextAttachmentPath } from "../../packages/protocol/src/attachment-policy";
import { CLOUD_V2_ATTACHMENT_DIRS, CLOUD_V2_ATTACHMENT_MAX_BYTES, CLOUD_V2_ATTACHMENT_PATH } from "../../apps/control-plane/src/cloud/checkpoint";

it("keeps standalone checkpoint attachment paths and caps aligned with the upload contract", () => {
  expect(CLOUD_V2_ATTACHMENT_MAX_BYTES).toBe(MAX_ATTACHMENT_BYTES);
  const paths = contextAttachmentLocations("a-b_c123", "recording.mp4");
  expect(paths.map(path => path.split("/").slice(0, -2).join("/"))).toEqual(CLOUD_V2_ATTACHMENT_DIRS);
  const pattern = new RegExp(CLOUD_V2_ATTACHMENT_PATH);
  for (const path of [...paths, ".context/attachments/id/a b.mp4", ".context/attachments/../clip.mp4", ".context-graph/attachments/id/clip.mp4", ".context/attachments/id/nested/clip.mp4"])
    expect(pattern.test(path), path).toBe(parseContextAttachmentPath(path) !== null);
});
