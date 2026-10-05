import path from "node:path";
import { sanitizeDesignDirectoryName } from "./directory-path";
import { DESIGN_MANIFEST_FILE, type ParsedDesignManifest } from "./manifest";

export interface DesignDirectoryLayout {
  directory: string;
  kind: "inline-v1" | "root-v2" | "meta-v3";
  manifestFile: string;
  documentFile: string;
  rulesFile: string;
  canvasVersion: 1 | 2;
}

/** Pure interpretation of captured manifest bytes, shared by worktree and Git
 * readers. A v3 manifest never claims the meta folder as a Design directory. */
export function resolveDesignManifestLayout(
  manifestFile: string,
  manifest: ParsedDesignManifest,
): DesignDirectoryLayout {
  const parent = path.posix.dirname(manifestFile);
  if (path.posix.basename(manifestFile) !== DESIGN_MANIFEST_FILE ||
      sanitizeDesignDirectoryName(parent) !== parent)
    throw new Error("Invalid Design manifest path.");
  const directory = manifest.version === 3 ? path.posix.dirname(parent) : parent;
  if (manifest.version === 3 && (path.posix.basename(parent) !== "meta" ||
      sanitizeDesignDirectoryName(directory) !== directory))
    throw new Error("Design manifest v3 must be at <Design directory>/meta/design.toml.");
  return {
    directory,
    kind: manifest.version === 3 ? "meta-v3" : manifest.version === 2 ? "root-v2" : "inline-v1",
    manifestFile,
    documentFile: manifest.canvas ? `${parent}/${manifest.canvas}` : manifestFile,
    rulesFile: `${directory}/rules.md`,
    canvasVersion: manifest.version === 3 ? 2 : 1,
  };
}
