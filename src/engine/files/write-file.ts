// ──────────────────────────────────────────────────────────
// writeWorkspaceFile — bounded, path-safe single-file write
// ──────────────────────────────────────────────────────────
//
// The WRITE counterpart to readWorkspaceFile (read-file.ts). Used by BOTH the
// local IPC path (electron `write_file`) and the remote bridge handler
// (workspace/service.ts "file.write") so ONE implementation owns the safety
// contract. `relPath` is a repo-relative POSIX path resolved against `cwd` (the
// worktree folder). NEVER throws — every failure returns { kind: "error" } with
// a human reason.
//
// Safety mirrors the read path: lexical containment (no `../` escape) + a
// realpath symlink-escape check on the nearest EXISTING ancestor + the secret
// denylist (REMOTE clients only) + a 2 MB size cap. The write itself is atomic
// (tmp file in the same dir + rename), so a crash mid-write can't truncate the
// file, and an existing symlink AT the target name is replaced (rename swaps the
// name) rather than written THROUGH to a path outside the workspace.
// ──────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isSensitiveRepoPath } from "./read-file";

// Keep in sync with read-file.ts MAX_TEXT_BYTES (the editor is a text surface).
const MAX_TEXT_BYTES = 2_000_000; // 2 MB

export type WriteFileKind = "success" | "too-large" | "error";

export interface WriteFileResult {
  kind: WriteFileKind;
  /** Echo of the requested repo-relative path. */
  path: string;
  /** Bytes written (0 on error). */
  bytes: number;
  /** Present when kind === "error" — a human-readable reason. */
  error?: string;
}

function fail(rel: string, message: string): WriteFileResult {
  return { kind: "error", path: rel, bytes: 0, error: message };
}

// Mirror of read-file.ts isInside (kept local so read-file.ts stays untouched).
function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/** The deepest already-existing ancestor of `p` (walking up its parents). For a
 *  brand-new file this is the nearest existing directory — realpathing it catches
 *  a symlinked intermediate dir that would escape the workspace before we create
 *  anything. Stops at the filesystem root. */
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
  opts?: { remote?: boolean },
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

  // Size cap on the content we're about to persist (mirrors the read text cap).
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_TEXT_BYTES) return { kind: "too-large", path: rel, bytes };

  // Secret gate for a REMOTE client, on the RESOLVED relative path (so '.env/.'
  // can't slip past) and BEFORE touching disk.
  const SECRET_REFUSAL =
    "refusing to write a secret/credential file over a remote connection";
  if (remote && isSensitiveRepoPath(path.relative(root, target))) {
    return fail(rel, SECRET_REFUSAL);
  }

  // realpath the nearest existing ancestor: a symlinked intermediate dir is the
  // only way the lexically-contained target could escape the workspace.
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    realRoot = root;
  }
  try {
    const existing = deepestExisting(target);
    const realExisting = fs.realpathSync(existing);
    if (!isInside(realExisting, realRoot)) {
      return fail(rel, "refusing to follow a symlink outside the workspace");
    }
    // An innocuously-named path whose REAL location is a secret must be refused.
    const realTarget = path.join(realExisting, path.relative(existing, target));
    if (remote && isSensitiveRepoPath(path.relative(realRoot, realTarget))) {
      return fail(rel, SECRET_REFUSAL);
    }
  } catch {
    // realpath race/quirk. For a REMOTE write FAIL CLOSED (we couldn't prove the
    // resolved target is safe); a LOCAL write proceeds (the owner's own machine).
    if (remote) return fail(rel, SECRET_REFUSAL);
  }

  // Don't clobber a directory (statSync follows symlinks, so a symlink→dir is
  // caught here; a symlink→file is allowed and replaced by the rename below).
  try {
    const st = fs.statSync(target);
    if (st.isDirectory()) return fail(rel, "this is a folder, not a file");
    if (!st.isFile()) return fail(rel, "not a regular file");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return fail(rel, `cannot stat file (${code ?? "unknown error"})`);
    }
    // ENOENT → a new file; allowed (we mkdir its parent below).
  }

  // Atomic tmp + rename (same dir, same filesystem) — mirrors settings/files.ts.
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      fs.writeFileSync(tmp, content, "utf-8");
      // Preserve the existing file's mode (e.g. an executable script's +x) — the
      // fresh tmp would otherwise reset it to the umask default on rename, a
      // silent perms change that also surfaces as a spurious mode diff.
      try {
        fs.chmodSync(tmp, fs.statSync(target).mode);
      } catch {
        /* new file — no prior mode to preserve */
      }
      fs.renameSync(tmp, target);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best-effort tmp cleanup */
      }
      throw err;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return fail(rel, `cannot write file (${code ?? "unknown error"})`);
  }

  return { kind: "success", path: rel, bytes };
}
