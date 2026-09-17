import { clipboard, ipcMain, type IpcMainEvent } from "electron";
import { randomUUID } from "node:crypto";
import { decodeHTML } from "entities";
import {
  MAX_ATTACHMENT_BYTES,
  ATTACHMENT_CLIPBOARD_MIME,
  collectAttachmentSourceIds,
  isAttachmentSourceId,
} from "@zeros/protocol/attachment-policy";
import {
  registerAttachmentSource,
  pruneAttachmentSources,
} from "../../src/engine/files/attachment-source";
import { pruneAttachmentTemporaryDirectories } from "../../src/engine/files/attachment-temporary-records";
import { getMainWindow } from "./events";

function clipboardSourceIds(): string[] {
  let encoded = clipboard
    .readBuffer(ATTACHMENT_CLIPBOARD_MIME)
    .toString("utf8");
  if (!encoded) {
    const html = clipboard.readHTML();
    if (!html.includes("data-zeros-composer")) return [];
    if (html.length > 2_000_000)
      throw new Error("Attachment clipboard metadata is too large");
    const match = html.match(/data-zeros-composer\s*=\s*(["'])(.*?)\1/s);
    if (!match) throw new Error("Attachment clipboard metadata is unavailable");
    encoded = decodeHTML(match[2]);
  }
  if (encoded.length > 2_000_000)
    throw new Error("Attachment clipboard metadata is too large");
  const ids = collectAttachmentSourceIds(JSON.parse(encoded));
  if (!ids) throw new Error("Attachment clipboard metadata is too large");
  return ids;
}

export function registerAttachmentSourceIpc(): void {
  ipcMain.handle("zeros:attachment-source", async (event, input: unknown) => {
    const contents = getMainWindow()?.webContents;
    if (
      !contents ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame
    ) {
      throw new Error("Attachment selection requires the main renderer");
    }
    const args = input as {
      path?: unknown;
      size?: unknown;
      id?: unknown;
    } | null;
    if (
      !args ||
      typeof args.path !== "string" ||
      !Number.isSafeInteger(args.size) ||
      (args.size as number) < 0 ||
      (args.size as number) > MAX_ATTACHMENT_BYTES
    ) {
      throw new Error("Invalid attachment file");
    }
    return registerAttachmentSource(args.path, args.size as number, args.id);
  });
  ipcMain.handle(
    "zeros:attachment-source-maintenance",
    async (event, input: unknown) => {
      const contents = getMainWindow()?.webContents;
      if (
        !contents ||
        event.sender !== contents ||
        event.senderFrame !== contents.mainFrame
      )
        throw new Error("Attachment cleanup requires the main renderer");
      if (
        !Array.isArray(input) ||
        input.length > 100_000 ||
        !input.every(isAttachmentSourceId)
      )
        throw new Error("Invalid attachment recovery references");
      const clipboardIds = clipboardSourceIds();
      await pruneAttachmentSources(new Set([...input, ...clipboardIds]));
      await pruneAttachmentTemporaryDirectories();
      return clipboardIds;
    },
  );
}

/** Drain source preparation, not the full remote upload: the persisted source
 * and draft are sufficient to resume next launch. Bound a crashed renderer. */
export async function prepareAttachmentsForQuit(): Promise<void> {
  const contents = getMainWindow()?.webContents;
  if (!contents || contents.isDestroyed()) return;
  const token = randomUUID();
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      ipcMain.removeListener("zeros:attachment-quit-ready", acknowledge);
      resolve();
    };
    const acknowledge = (event: IpcMainEvent, value: unknown) => {
      if (
        event.sender === contents &&
        event.senderFrame === contents.mainFrame &&
        value === token
      )
        finish();
    };
    const timer = setTimeout(finish, 30_000);
    ipcMain.on("zeros:attachment-quit-ready", acknowledge);
    contents.send("zeros:prepare-attachment-quit", token);
  });
}
