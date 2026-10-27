import { BrowserWindow, dialog, protocol, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, dirname, join } from "node:path";
import { FILE_MEDIA_SCHEME } from "@zeros/protocol/file-media";
import { FileMediaStreams } from "./file-media-stream";

const streams = new FileMediaStreams();
const observed = new WeakSet<Electron.WebContents>();
let downloads = 0;
function owner(event: IpcMainInvokeEvent): Electron.WebContents {
  if (event.senderFrame !== event.sender.mainFrame || !BrowserWindow.fromWebContents(event.sender)) throw new Error("Media previews require the app window");
  if (!observed.has(event.sender)) {
    observed.add(event.sender);
    event.sender.once("destroyed", () => streams.close(event.sender.id));
    event.sender.on("render-process-gone", () => streams.close(event.sender.id));
    event.sender.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) streams.close(event.sender.id);
    });
  }
  return event.sender;
}
export function registerFileMediaProtocolPrivileges(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: FILE_MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
}
export function installFileMediaProtocol(): void {
  protocol.handle(FILE_MEDIA_SCHEME, request => streams.response(request));
}
export function openFileMediaSource(args: Record<string, unknown>, event: IpcMainInvokeEvent): string {
  const sender = owner(event);
  return streams.register(sender.id, args, payload => sender.send("zeros:event", { name: "file-media-range", payload }));
}
export function closeFileMediaSource(args: Record<string, unknown>, event: IpcMainInvokeEvent): void {
  const sender = owner(event);
  if (typeof args.sourceId !== "string") throw new Error("Invalid media source");
  streams.close(sender.id, args.sourceId);
}
export function replyFileMediaRange(args: Record<string, unknown>, event: IpcMainInvokeEvent): void {
  streams.reply(owner(event).id, args);
}
export async function downloadFileMediaSource(args: Record<string, unknown>, event: IpcMainInvokeEvent): Promise<boolean> {
  const sender = owner(event);
  if (typeof args.url !== "string" || !streams.owns(sender.id, args.url) || typeof args.filename !== "string" || downloads >= 2) throw new Error("Media download unavailable");
  downloads++;
  let temporary: string | undefined;
  try {
    const chosen = await dialog.showSaveDialog(BrowserWindow.fromWebContents(sender)!, { defaultPath: basename(args.filename) });
    if (chosen.canceled || !chosen.filePath) return false;
    temporary = join(dirname(chosen.filePath), `.zeros-download-${randomUUID()}`);
    const response = streams.response(new Request(args.url));
    if (!response.ok) throw new Error("Media download unavailable");
    const target = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    const source = response.body ? Readable.fromWeb(response.body as import("node:stream/web").ReadableStream) : Readable.from([]);
    await pipeline(source, target);
    await rename(temporary, chosen.filePath);
    return true;
  } finally {
    downloads--;
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
  }
}
