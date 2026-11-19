import { z } from "zod";

const flatFrame = /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/i;
const pageFolder = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const reservedFolders = new Set(["meta", "assets", "components"]);

export function isDesignPageFolder(value: unknown): value is string {
  return (
    typeof value === "string" &&
    pageFolder.test(value) &&
    !value.endsWith(".") &&
    !reservedFolders.has(portableDesignName(value))
  );
}

/** Suggest a valid authored folder without rewriting canvas metadata. */
export function designPageFolderProblem(value: unknown): string | null {
  if (isDesignPageFolder(value)) return null;
  const folder = typeof value === "string" ? value : String(value);
  if (
    typeof value === "string" &&
    pageFolder.test(value) &&
    !value.endsWith(".") &&
    reservedFolders.has(portableDesignName(value))
  ) {
    return `Design page folder "${folder}" is reserved: meta, assets and components hold shared Design files in any letter case. Use another folder, such as "${portableDesignName(value)}-2".`;
  }
  return `Design page folder ${JSON.stringify(folder)} must be one portable segment: 1-64 letters, digits, dots, underscores or hyphens, starting with a letter or digit and not ending in a dot.`;
}

// Legacy flat paths are accepted; never normalize an authored path into an alias.
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
  // Avoid Unicode normalization on the ASCII hot path in large catalogs.
  return (/[\u0080-\uffff]/.test(value) ? value.normalize("NFC") : value).toLowerCase();
}

export const designFrameFileSchema = z
  .string()
  .refine(isDesignFrameFile, "Invalid Design frame file.");

/** A component variant's name, as its <zd-variant name> requires: what a
 * request may name as the variant a main component frame shows. */
export function isDesignComponentVariantName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && value !== "default" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
}
