import fs from "node:fs";
import path from "node:path";
import { discoverDesignDirectories } from "../design/directory";
import {
  activeDesignDirectoryNameFor,
  DESIGN_CANVAS_FILE,
} from "../design/directory-registry";
import {
  DESIGN_METADATA_PROTECTED_PATHS,
  isDesignMetadataRepoPath,
  readDesignDirectoryRegistry,
} from "../design/metadata";
import { stickyRecognizedDesignDirectories } from "../design/recognition-store";
import { repoPathOverlapsDesignRoot } from "../design/path-authority";
import { assertGuardedWorkspaceFilePath } from "../files/file-content-guard";
import { readBoundedUtf8FileSync } from "../files/bounded-read-sync";
import { parseDesignManifest } from "../design/manifest";
import { GitError } from "./errors";

/** Defense in depth for direct callers as well as dispatch. Reuse the same
 * current/index/HEAD/sticky evidence as generic editor/Git mutation guards. */
export async function assertReviewSourceWriteAllowed(
  cwd: string,
  relative: string,
  prospectiveContent?: string | null,
): Promise<void> {
  assertGuardedWorkspaceFilePath(cwd, relative);
  const [discovered, sticky] = await Promise.all([
    discoverDesignDirectories(cwd),
    stickyRecognizedDesignDirectories(cwd),
  ]);
  const roots = [
    ...discovered,
    ...sticky,
    ...DESIGN_METADATA_PROTECTED_PATHS,
    ...Object.values(readDesignDirectoryRegistry(cwd)?.directories ?? {}).map(
      (entry) => entry.path,
    ),
  ];
  const active = activeDesignDirectoryNameFor(cwd);
  if (active) roots.push(active);
  const segments = relative.split("/");
  for (let i = 1; i < segments.length; i += 1) {
    const directory = segments.slice(0, i).join("/");
    if (fs.existsSync(path.join(cwd, directory, DESIGN_CANVAS_FILE)))
      roots.push(directory);
  }
  if (
    isDesignMetadataRepoPath(relative) ||
    roots.some((root) => repoPathOverlapsDesignRoot(relative, root))
  ) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message:
        "Resolve or reject Design source in Design view; Code review cannot write Design files.",
    });
  }
  // A filename alone never registers Design. Protect recognized envelopes in
  // either the current or proposed bytes, including a damaged Zeros manifest.
  if (path.basename(relative) === "design.toml") {
    const sources =
      typeof prospectiveContent === "string" ? [prospectiveContent] : [];
    try {
      sources.push(
        readBoundedUtf8FileSync(path.join(cwd, relative), 2_000_000),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: "Could not verify this Design manifest before writing.",
        });
    }
    let claimsDesign = false;
    for (const source of sources) {
      try {
        if (parseDesignManifest(source) !== null) claimsDesign = true;
      } catch {
        claimsDesign = true;
      }
    }
    if (claimsDesign)
      throw new GitError({
        code: "VALIDATION_FAILED",
        message:
          "Update Design manifests through Zeros Settings or Design view.",
      });
  }
}
