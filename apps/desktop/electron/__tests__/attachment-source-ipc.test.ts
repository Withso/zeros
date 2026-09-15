import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  register: vi.fn(async () => "opaque-id"),
  prune: vi.fn(async () => {}),
  pruneTemporary: vi.fn(async () => {}),
  readBuffer: vi.fn(() => Buffer.alloc(0)),
  readHTML: vi.fn(() => ""),
  handle: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  contents: { mainFrame: {}, send: vi.fn(), isDestroyed: () => false },
}));
vi.mock("electron", () => ({
  clipboard: { readBuffer: mocks.readBuffer, readHTML: mocks.readHTML },
  ipcMain: {
    handle: mocks.handle,
    on: mocks.on,
    removeListener: mocks.removeListener,
  },
}));
vi.mock("../ipc/events", () => ({
  getMainWindow: () => ({ webContents: mocks.contents }),
}));
vi.mock("../../src/engine/files/attachment-source", () => ({
  registerAttachmentSource: mocks.register,
  pruneAttachmentSources: mocks.prune,
}));
vi.mock("../../src/engine/files/attachment-temporary-records", () => ({
  pruneAttachmentTemporaryDirectories: mocks.pruneTemporary,
}));
import {
  registerAttachmentSourceIpc,
  prepareAttachmentsForQuit,
} from "../ipc/attachment-source";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readBuffer.mockReturnValue(Buffer.alloc(0));
  mocks.readHTML.mockReturnValue("");
});

it("authorizes cleanup and preserves the current clipboard's recovery sources through HTML fallback", async () => {
  registerAttachmentSourceIpc();
  const handler = mocks.handle.mock.calls.find(
    (call) => call[0] === "zeros:attachment-source-maintenance",
  )![1];
  const event = {
    sender: mocks.contents,
    senderFrame: mocks.contents.mainFrame,
  };
  const draftId = "a".repeat(36);
  const clipboardId = "b".repeat(36);
  const encoded = JSON.stringify({
    attachments: [{ sourceRecoveryId: clipboardId }],
  }).replace(/"/g, "&quot;");
  mocks.readHTML.mockReturnValue(
    `<div data-zeros-composer="${encoded}"></div>`,
  );
  await expect(handler({ sender: {}, senderFrame: {} }, [])).rejects.toThrow(
    /renderer/,
  );
  await expect(handler(event, ["../../source"])).rejects.toThrow(/references/);
  expect(mocks.prune).not.toHaveBeenCalled();
  await expect(handler(event, [draftId])).resolves.toEqual([clipboardId]);
  expect(mocks.prune).toHaveBeenCalledWith(new Set([draftId, clipboardId]));
  expect(mocks.pruneTemporary).toHaveBeenCalledOnce();
});

it("skips cleanup when attachment clipboard metadata cannot be read", async () => {
  registerAttachmentSourceIpc();
  const handler = mocks.handle.mock.calls.find(
    (call) => call[0] === "zeros:attachment-source-maintenance",
  )![1];
  mocks.readBuffer.mockReturnValue(Buffer.from("invalid JSON"));
  await expect(
    handler(
      { sender: mocks.contents, senderFrame: mocks.contents.mainFrame },
      [],
    ),
  ).rejects.toThrow();
  expect(mocks.prune).not.toHaveBeenCalled();
});

it("only registers files selected by the owning main renderer", async () => {
  registerAttachmentSourceIpc();
  const handler = mocks.handle.mock.calls[0][1];
  await expect(
    handler({ sender: {}, senderFrame: {} }, { path: "/selected", size: 1 }),
  ).rejects.toThrow(/renderer/);
  await expect(
    handler(
      { sender: mocks.contents, senderFrame: {} },
      { path: "/selected", size: 1 },
    ),
  ).rejects.toThrow(/renderer/);
  expect(mocks.register).not.toHaveBeenCalled();
  const event = {
    sender: mocks.contents,
    senderFrame: mocks.contents.mainFrame,
  };
  await expect(handler(event, { path: "/selected", size: 1 })).resolves.toBe(
    "opaque-id",
  );
  await expect(handler(event, { path: "/selected", size: -1 })).rejects.toThrow(
    /file/,
  );
});

it("waits for the owning renderer to persist pending sources before quitting", async () => {
  let finished = false;
  const pending = prepareAttachmentsForQuit().then(() => {
    finished = true;
  });
  const token = mocks.contents.send.mock.calls[0][1];
  const acknowledge = mocks.on.mock.calls[0][1];
  acknowledge({ sender: {}, senderFrame: {} }, token);
  await Promise.resolve();
  expect(finished).toBe(false);
  acknowledge(
    { sender: mocks.contents, senderFrame: mocks.contents.mainFrame },
    token,
  );
  await pending;
  expect(finished).toBe(true);
  expect(mocks.removeListener).toHaveBeenCalled();
});
