import { ipcMain, type IpcMainEvent } from "electron";
import { randomUUID } from "node:crypto";
import { MAX_ATTACHMENT_BYTES } from "@zeros/protocol/attachment-policy";
import { registerAttachmentSource } from "../../src/engine/files/attachment-source";
import { getMainWindow } from "./events";

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
