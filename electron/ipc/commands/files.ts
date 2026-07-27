// ──────────────────────────────────────────────────────────
// IPC command: generic workspace file read (Files tab)
// ──────────────────────────────────────────────────────────
//
// read_file({ cwd, path }) — reads a single file for the Files-tab viewer.
// The real logic lives in src/engine/files/read-file.ts so the remote
// workspace bridge (engine process) and this local IPC path share ONE
// implementation. See that file for the safety/bounds contract.
//
// H3 — the renderer supplies `cwd`. Left unchecked it was an arbitrary-file
// read primitive (`read_file({cwd:"~/.ssh", path:"id_rsa"})`). The fix is
// `cwdIsTrusted()` below: `cwd` MUST be the open project root OR live under the
// Zeros worktrees tree — every legitimate Files-tab cwd — and readWorkspaceFile
// then lexically + realpath-confines the read inside that root. Together those
// fully close the arbitrary-read hole.
//
// This is a LOCAL read on the owner's OWN machine, so it runs with `remote:false`
// (full access). The secret/credential denylist is the REMOTE boundary ONLY
// (remote/cloud clients hit it via the engine `file.read` op). An earlier H3
// hardening also forced `remote:true` here, which hid secret-named files
// (.npmrc, .env, …) that legitimately live INSIDE the project — even though
// (a) the read-only "Local main" trunk shows them anyway (it reads over the
// loopback bridge as a `local` client → remote:false) and (b) the Files TREE
// (git_list_files) already lists them. The only effect was a confusing
// "refusing … over a remote connection" error on a purely local worktree read,
// inconsistent with both Local main and the tree. See read-file.ts: the denylist
// is the remote boundary; the local Files tab keeps full access.
// ──────────────────────────────────────────────────────────

import path from "node:path";
import {
  readWorkspaceFile,
  type ReadFileKind,
  type ReadFileResult,
} from "../../../src/engine/files/read-file";
import {
  writeWorkspaceFile,
  type WriteFileResult,
} from "../../../src/engine/files/write-file";
import { zerosWorkspacesRoot } from "../../../src/engine/db/paths";
import { currentRoot } from "../../sidecar";
import type { CommandHandler } from "../router";

export type { ReadFileKind, ReadFileResult, WriteFileResult };

/** The renderer-supplied cwd must be the open project root or live under the
 *  Zeros worktrees tree — never an arbitrary host path. */
function cwdIsTrusted(cwd: string): boolean {
  const resolved = path.resolve(cwd);
  const roots = [currentRoot(), zerosWorkspacesRoot()].filter(
    (r): r is string => typeof r === "string" && r.length > 0,
  );
  return roots.some((root) => {
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

export const readFile: CommandHandler = (args) => {
  const cwd = String(args.cwd ?? "");
  const rel = String(args.path ?? "");
  if (!cwd || !cwdIsTrusted(cwd)) {
    return {
      kind: "error",
      path: rel,
      bytes: 0,
      error: "refusing to read outside the workspace",
    } satisfies ReadFileResult;
  }
  // Local read on the owner's machine → remote:false (full access). The
  // arbitrary-read threat is closed by cwdIsTrusted() + readWorkspaceFile's
  // containment checks; the secret denylist stays a REMOTE-only boundary so
  // this stays consistent with Local main and the Files tree (which both show
  // these files). Do NOT pass remote:true here — see the header note.
  return readWorkspaceFile(cwd, rel, { remote: false });
};

/** write_file({ cwd, path, content }) — writes a single file for the Files-tab
 *  editor (Edit mode). Same trust boundary as readFile: `cwd` MUST be the open
 *  project root or under the Zeros worktrees tree, then writeWorkspaceFile
 *  lexically + realpath-confines the write inside that root. Local write on the
 *  owner's machine → remote:false. */
export const writeFile: CommandHandler = (args) => {
  const cwd = String(args.cwd ?? "");
  const rel = String(args.path ?? "");
  const content = typeof args.content === "string" ? args.content : null;
  if (!cwd || !cwdIsTrusted(cwd)) {
    return {
      kind: "error",
      path: rel,
      bytes: 0,
      error: "refusing to write outside the workspace",
    } satisfies WriteFileResult;
  }
  if (content === null) {
    return {
      kind: "error",
      path: rel,
      bytes: 0,
      error: "missing content",
    } satisfies WriteFileResult;
  }
  return writeWorkspaceFile(cwd, rel, content, { remote: false });
};
