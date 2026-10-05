import { z } from "zod";

const flatFrame = /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/i;
const pageFolder = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const reservedFolders = new Set(["meta", "assets", "components"]);

/** Authored spelling is identity. Never normalize traversal or encoded aliases
 * into a different registered frame. Legacy flat basenames remain accepted. */
export function isDesignPageFolder(value: unknown): value is string {
  return (
    typeof value === "string" &&
    pageFolder.test(value) &&
    !value.endsWith(".") &&
    !reservedFolders.has(portableDesignName(value))
  );
}

export function isDesignFrameFile(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  return parts.length === 1
    ? flatFrame.test(value)
    : parts.length === 2 &&
        isDesignPageFolder(parts[0]) &&
        flatFrame.test(parts[1]);
}

/** Encode a validated frame path without escaping its page separator. */
export function encodeDesignFramePath(file: string): string {
  return file.split("/").map(encodeURIComponent).join("/");
}

/** Comparison key only; authored path spelling remains the source identity. */
export function portableDesignName(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

export const designFrameFileSchema = z
  .string()
  .refine(isDesignFrameFile, "Invalid Design frame file.");
