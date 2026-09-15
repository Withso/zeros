import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  register: vi.fn(async () => "opaque-id"),
  handle: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  contents: { mainFrame: {}, send: vi.fn(), isDestroyed: () => false },
}));
vi.mock("electron", () => ({
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
}));
import {
  registerAttachmentSourceIpc,
  prepareAttachmentsForQuit,
} from "../ipc/attachment-source";

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
