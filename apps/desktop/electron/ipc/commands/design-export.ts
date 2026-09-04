import { rename, unlink, writeFile } from "node:fs/promises";

import { BrowserWindow, dialog, type SaveDialogOptions } from "electron";

import type { CommandHandler } from "../router";
import { electronAtomicTemporaryPath } from "./atomic-file-write";

const MAX_PNG_BYTES = 12 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

export function decodeDesignPng(data: string): Buffer {
  if (
    !data ||
    data.length > Math.ceil((MAX_PNG_BYTES * 4) / 3) + 8 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  ) {
    throw new Error("Design PNG data must be bounded base64.");
  }
  const decoded = Buffer.from(data, "base64");
  if (decoded.length > MAX_PNG_BYTES) {
    throw new Error("Design PNG is too large to export.");
  }
  if (
    decoded.length < PNG_SIGNATURE.length ||
    !decoded.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error("Design export data is not a PNG image.");
  }
  return decoded;
}

export function designPngSuggestedName(value: string): string {
  const stem = value
    .trim()
    .replace(/\.(?:html|png)$/i, "")
    .replace(/[\\/:*?"<>|]+/g, " - ")
    .replace(/\s+/g, " ")
    .replace(/(?:\s+-\s+){2,}/g, " - ")
    .replace(/^[. -]+|[. -]+$/g, "")
    .slice(0, 80);
  return `${stem || "Design"}.png`;
}

export function designPngSaveDialogOptions(
  suggestedName: string,
): SaveDialogOptions {
  return {
    title: "Export design as PNG",
    defaultPath: suggestedName,
    filters: [{ name: "PNG image", extensions: ["png"] }],
  };
}

/** Keep an export selected inside Design territory out of the engine-owned
 * transaction recovery namespace while retaining an atomic same-dir rename. */
export function designPngTemporaryPath(target: string): string {
  return electronAtomicTemporaryPath(target);
}

export const designExportPng: CommandHandler = async (args, event) => {
  const data = typeof args.data === "string" ? args.data : "";
  const suggestedName = designPngSuggestedName(
    typeof args.suggestedName === "string" ? args.suggestedName : "Design",
  );
  const png = decodeDesignPng(data);
  const options = designPngSaveDialogOptions(suggestedName);
  const owner = BrowserWindow.fromWebContents(event.sender);
  const result = owner
    ? await dialog.showSaveDialog(owner, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { saved: false };
  const target = result.filePath.toLowerCase().endsWith(".png")
    ? result.filePath
    : `${result.filePath}.png`;
  const temporary = designPngTemporaryPath(target);
  try {
    await writeFile(temporary, png, { flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { saved: true, path: target };
};
