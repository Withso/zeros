import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { assertRootControlledPath } from "./cloud-worker-config";

const MARKER = "/etc/zeros/cloud-workspace-paths.json";
const WORKSPACE = "/srv/zeros/workspace";
export type CloudWorkspacePaths = Readonly<{ workspaceRoot: string; repositoryAlias: string }>;
const invalid = () => new Error("Cloud workspace path admission is invalid");

/** Published by the host launcher from fresh admission into its read-only
 * /etc/zeros projection. Neither environment variables nor repository files
 * can select an alias. Base images and local workspaces have no marker. */
export function loadCloudWorkspacePaths(): CloudWorkspacePaths | null {
  let descriptor: number;
  try { descriptor = openSync(MARKER, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw invalid();
  }
  try {
    assertRootControlledPath(MARKER);
    const stat = fstatSync(descriptor), current = lstatSync(MARKER);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== current.dev || stat.ino !== current.ino || stat.size < 2 || stat.size > 4096)
      throw invalid();
    const value = JSON.parse(readFileSync(descriptor, "utf8"));
    if (!value || Object.keys(value).sort().join("\0") !== "repositoryAlias\0schema\0workspaceRoot" ||
      value.schema !== "zeros.cloud-workspace-paths/v1" || value.workspaceRoot !== WORKSPACE ||
      typeof value.repositoryAlias !== "string" || !/^\/srv\/zeros\/repos\/[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/.test(value.repositoryAlias) ||
      value.repositoryAlias.split("/").some((part: string) => part === "." || part === "..")) throw invalid();
    const primary = lstatSync(WORKSPACE), alias = lstatSync(value.repositoryAlias);
    if (!primary.isDirectory() || !alias.isDirectory() || realpathSync(WORKSPACE) !== WORKSPACE ||
      realpathSync(value.repositoryAlias) !== value.repositoryAlias || primary.dev !== alias.dev || primary.ino !== alias.ino)
      throw invalid();
    return { workspaceRoot: WORKSPACE, repositoryAlias: value.repositoryAlias };
  } finally { closeSync(descriptor); }
}

function translated(candidate: string, from: string, to: string): string | null {
  if (candidate === from) return to;
  return candidate.startsWith(from + path.sep) ? to + candidate.slice(from.length) : null;
}

/** Attachment checks still authorize and report the registered logical path.
 * Only staging/mount selection and atomic publication use the shared mount. */
export function cloudWorkspacePublicationPath(candidate: string): string {
  const mapping = loadCloudWorkspacePaths();
  return mapping ? translated(candidate, mapping.workspaceRoot, mapping.repositoryAlias) ?? candidate : candidate;
}

/** Mirror every read/write grant and restriction, including nested exceptions,
 * in both directions. Only the admitted primary has an alias; other clones
 * retain their existing actor policy. Call after canonicalizing policy paths. */
export function expandCloudWorkspacePaths(paths: readonly string[], mapping: CloudWorkspacePaths | null): string[] {
  if (!mapping) return [...paths];
  return [...new Set(paths.flatMap(candidate => {
    const alias = translated(candidate, mapping.workspaceRoot, mapping.repositoryAlias) ??
      translated(candidate, mapping.repositoryAlias, mapping.workspaceRoot);
    return alias ? [candidate, alias] : [candidate];
  }))].sort();
}
