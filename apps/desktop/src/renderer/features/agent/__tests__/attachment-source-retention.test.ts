import { expect, it } from "vitest";
import { collectAttachmentSourceIds } from "@zeros/protocol/attachment-policy";
import {
  registerAttachmentSourceOwner,
  retainedAttachmentSourceIds,
} from "../attachment-source-retention";

const id = "a".repeat(36);
it("retains sources independently for editor history, parked drafts and concurrent transfers", () => {
  const disposeEditor = registerAttachmentSourceOwner(() => [
    { sourceRecoveryId: id },
  ]);
  const disposeUpload = registerAttachmentSourceOwner(() => [
    { sourceRecoveryId: id },
  ]);
  try {
    disposeEditor();
    expect(retainedAttachmentSourceIds()).toContain(id);
    disposeUpload();
    expect(retainedAttachmentSourceIds()).not.toContain(id);
    expect(
      retainedAttachmentSourceIds({
        edits: { edit: { newAttachments: [{ sourceRecoveryId: id }] } },
      }),
    ).toContain(id);
  } finally {
    disposeEditor();
    disposeUpload();
  }
});

it("reads owner references at cleanup time and refuses cleanup when an owner cannot be inspected", () => {
  let ids: unknown = [{ sourceRecoveryId: id }];
  const dispose = registerAttachmentSourceOwner(() => ids);
  try {
    expect(retainedAttachmentSourceIds()).toContain(id);
    ids = [];
    expect(retainedAttachmentSourceIds()).not.toContain(id);
    ids = Array.from({ length: 100_001 }, () => ({}));
    expect(retainedAttachmentSourceIds()).toBeNull();
  } finally {
    dispose();
  }
});

it("collects metadata without visiting Blob payloads or cyclic editor documents", () => {
  const value: Record<string, unknown> = {
    sourceRecoveryId: id,
    sourceFile: new Blob(["data"]),
  };
  value.json = value;
  value.other = value;
  expect(collectAttachmentSourceIds(value)).toEqual([id]);
  expect(
    collectAttachmentSourceIds({ sourceRecoveryId: "../../file" }),
  ).toEqual([]);
});
