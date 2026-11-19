
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openBoundedDirectorySync } from "./bounded-read-sync";
import { isSensitiveRepoPath } from "./read-file";
import { inspectExpectedWorkspaceContent, WorkspaceFileGuardError } from "./file-content-guard";

// The editor's save limit must match the read text cap.
const MAX_TEXT_BYTES = 2_000_000;

export type WriteFileKind = "success" | "too-large" | "error";

export interface WriteFileResult {
  kind: WriteFileKind;
  path: string;
  bytes: number;
  error?: string;
}

function fail(rel: string, message: string): WriteFileResult {
  return { kind: "error", path: rel, bytes: 0, error: message };
}

function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/** Resolve the nearest existing parent so containment is enforced even for a new file. */
function deepestExisting(p: string): string {
  let cur = path.dirname(p);
  while (cur !== path.dirname(cur)) {
    if (fs.existsSync(cur)) return cur;
    cur = path.dirname(cur);
  }
  return cur;
}

export function writeWorkspaceFile(
  cwd: string,
  relPath: string,
  content: string,
  opts?: {
    remote?: boolean;
    canonicalRoot?: string;
    expectedContent?: string | null;
    /** Apply a Git-validated mode only when the guarded destination is still absent. */
    creationMode?: 0o644 | 0o755;
  },
): WriteFileResult {
  const remote = opts?.remote === true;
  const rel = relPath;
  if (!cwd) return fail(rel, "no workspace folder is open");
  if (!rel) return fail(rel, "missing path");
  if (typeof content !== "string") return fail(rel, "missing content");

  const root = path.resolve(cwd);
  const target = path.resolve(cwd, rel);

  if (!isInside(target, root)) {
    return fail(rel, "refusing to write outside the workspace");
  }

  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_TEXT_BYTES) return { kind: "too-large", path: rel, bytes };
  const guarded = opts?.expectedContent !== undefined;
  const creationMode =
    opts?.expectedContent === null ? opts.creationMode : undefined;
  const inspect = () => inspectExpectedWorkspaceContent(root, rel, opts!.expectedContent!);
  let expectedGeneration: string | undefined;
  if (guarded) {
    try {
      if (remote && isSensitiveRepoPath(path.relative(root, target))) {
        return fail(rel, "refusing to write a secret/credential file over a remote connection");
      }
      expectedGeneration = inspect();
    }
    catch (error) { return fail(rel, error instanceof WorkspaceFileGuardError ? error.message : "The file cannot be safely compared. Refresh before saving."); }
  }
  const assertStillExpected = () => {
    if (guarded && inspect() !== expectedGeneration) {
      throw new WorkspaceFileGuardError("The file changed. Refresh it before saving; your draft is still available.");
    }
  };
  // Deny normalized remote secret names before filesystem probes.
  const SECRET_REFUSAL =
    "refusing to write a secret/credential file over a remote connection";
  if (remote && isSensitiveRepoPath(path.relative(root, target))) {
    return fail(rel, SECRET_REFUSAL);
  }

  let realRoot: string;
  try {
    realRoot = opts?.canonicalRoot ?? fs.realpathSync(root);
  } catch {
    return fail(rel, "cannot safely resolve workspace");
  }
  let safeTarget: string;
  try {
    const existing = deepestExisting(target);
    const realExisting = fs.realpathSync(existing);
    if (!isInside(realExisting, realRoot)) {
      return fail(rel, "refusing to follow a symlink outside the workspace");
    }
    // Recheck remote secret policy after resolving directory aliases.
    const realTarget = path.join(realExisting, path.relative(existing, target));
    safeTarget = realTarget;
    if (remote && isSensitiveRepoPath(path.relative(realRoot, realTarget))) {
      return fail(rel, SECRET_REFUSAL);
    }
  } catch {
    return fail(rel, "cannot safely resolve file parent");
  }

  // Refuse directory targets, including symlinks to directories. Unguarded writes replace a file symlink rather than writing through it.
  try {
    const st = fs.statSync(target);
    if (st.isDirectory()) return fail(rel, "this is a folder, not a file");
    if (!st.isFile()) return fail(rel, "not a regular file");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return fail(rel, `cannot stat file (${code ?? "unknown error"})`);
    }
  }

  // Stage in the held destination directory so rename is atomic and a partial write never truncates the target.
  try {
    const directory = openBoundedDirectorySync(path.dirname(safeTarget), true);
    const pinnedTarget = path.join(directory.path, path.basename(safeTarget));
    const tmp = `${pinnedTarget}.tmp-${process.pid}-${randomUUID()}`;
    try {
      assertStillExpected();
      fs.writeFileSync(tmp, content, { encoding: "utf-8", flag: "wx" });
      // Copy the existing mode; otherwise rename would reset permissions to the temp file's defaults.
      try {
        const previous = fs.lstatSync(pinnedTarget);
        if (previous.isFile()) fs.chmodSync(tmp, previous.mode);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT" &&
          creationMode !== undefined
        )
          fs.chmodSync(tmp, creationMode);
      }
      assertStillExpected();
      fs.renameSync(tmp, pinnedTarget);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best-effort tmp cleanup */
      }
      throw err;
    } finally { directory.close(); }
  } catch (err) {
    if (err instanceof WorkspaceFileGuardError) return fail(rel, err.message);
    const code = (err as NodeJS.ErrnoException).code;
    return fail(rel, `cannot write file (${code ?? "unknown error"})`);
  }

  return { kind: "success", path: rel, bytes };
}
