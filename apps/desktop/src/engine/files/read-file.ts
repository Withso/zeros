// ──────────────────────────────────────────────────────────
// readWorkspaceFile — bounded, path-safe single-file read
// ──────────────────────────────────────────────────────────
//
// Extracted from the Files-tab IPC handler so BOTH the local IPC path and
// the remote-workspace bridge handler call one implementation. `relPath`
// is a repo-relative POSIX path resolved against `cwd` (the worktree
// folder). NEVER throws — every failure returns { kind: "error" } with a
// human reason. Read-only by design.
//
// Safety: lexical containment (no `../` escape) + a realpath symlink-escape
// check; text capped at 2 MB, images at 5 MB (data URL); binary detected.
// ──────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";

const MAX_TEXT_BYTES = 2_000_000; // 2 MB
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // same boundary as composer images

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

export type ReadFileKind = "text" | "image" | "binary" | "too-large" | "error";

export interface ReadFileResult {
  kind: ReadFileKind;
  path: string;
  bytes: number;
  content?: string;
  dataUrl?: string;
  error?: string;
  /** True when this path is Design territory, so the viewer must not offer an
   *  Edit affordance that `file.write` is going to refuse. Advisory only: the
   *  engine guard remains the authority, and a transport that omits this flag
   *  simply shows an editor whose save is refused — the pre-existing
   *  behaviour, never a false read-only. */
  designPath?: boolean;
}

function fail(rel: string, message: string): ReadFileResult {
  return { kind: "error", path: rel, bytes: 0, error: message };
}

// ── Sensitive-file denylist (remote boundary only) ──────────
//
// .gitignore-respect (git ls-files --exclude-standard) hides ignored secrets
// from the TREE, but a remote client can still read a committed or
// path-guessed secret directly. This denylist gates the REMOTE read/tree path
// (the local Files tab keeps full access — it's the user's own machine).
const SENSITIVE_DIR_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".gpg",
  ".kube",
]);
const SENSITIVE_BASENAMES = new Set([
  ".npmrc",
  ".netrc",
  "_netrc",
  ".pgpass",
  ".htpasswd",
  ".dockercfg",
  ".git-credentials",
  ".pypirc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
]);
const SENSITIVE_EXTS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".keystore",
  ".jks",
  ".ppk",
  ".tfstate",
  ".ovpn",
  ".cert",
]);
// Credential-dump JSON/YAML (GCP service accounts, Firebase admin SDK, etc.).
const SENSITIVE_CRED_NAME_RE =
  /(service[-_]?account|credential|secret|gcp[-_]?key|adminsdk)/i;
const STRUCTURED_DATA_EXT_RE = /\.(json|ya?ml)$/i;
// Public templates are intentionally shareable: `.env.example` (suffix) and
// `credentials.example.json` (infix) both carry placeholder values, not secrets.
const ENV_PUBLIC_SUFFIX = /\.(example|sample|template|dist)$/i;
const PUBLIC_TEMPLATE_INFIX = /\.(example|sample|template|dist)\./i;

/** True when a repo-relative path points at a credential/secret that must
 *  never be served to a remote client (regardless of .gitignore state). */
export function isSensitiveRepoPath(relPath: string): boolean {
  // Collapse '.', '..' and redundant separators FIRST. readWorkspaceFile opens
  // path.resolve(cwd, rel) (which collapses these), so without normalizing here
  // a trailing './' or 'x/..' would smuggle a denied basename past the segment
  // check — a universal denylist bypass.
  let norm = (relPath ?? "").replace(/\\/g, "/");
  norm = path.posix.normalize(norm);
  const segments = norm.split("/").filter((s) => s && s !== "." && s !== "..");
  for (const seg of segments) {
    if (SENSITIVE_DIR_SEGMENTS.has(seg.toLowerCase())) return true;
  }
  const base = (segments[segments.length - 1] ?? "").toLowerCase();
  if (!base) return false;
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (
    SENSITIVE_CRED_NAME_RE.test(base) &&
    STRUCTURED_DATA_EXT_RE.test(base) &&
    !PUBLIC_TEMPLATE_INFIX.test(base)
  ) {
    return true;
  }
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot) : "";
  if (SENSITIVE_EXTS.has(ext)) return true;
  // Match `.env` and `.env.local` (prefix form), `prod.env`/`local.env`
  // (suffix form), and framework variants like `.flaskenv`. Public templates
  // (`.env.example`) stay shareable via the ENV_PUBLIC_SUFFIX carve-out.
  if (
    base === ".env" ||
    base.startsWith(".env.") ||
    base.endsWith(".env") ||
    base === ".flaskenv"
  ) {
    return !ENV_PUBLIC_SUFFIX.test(base);
  }
  return false;
}

/** Containment test for two ALREADY-RESOLVED absolute paths. Exported so every
 *  workspace-scoped filesystem reader enforces the boundary identically — the
 *  ignored-entry listing in git/workspace-files.ts reuses it rather than
 *  writing a third copy of `startsWith(root + sep)`. */
export function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

export function readWorkspaceFile(
  cwd: string,
  relPath: string,
  opts?: { remote?: boolean },
): ReadFileResult {
  const remote = opts?.remote === true;
  const rel = relPath;
  if (!cwd) return fail(rel, "no workspace folder is open");
  if (!rel) return fail(rel, "missing path");

  const root = path.resolve(cwd);
  const target = path.resolve(cwd, rel);

  if (!isInside(target, root)) {
    return fail(rel, "refusing to read outside the workspace");
  }

  // (#7) Secret gate for a REMOTE client, on the RESOLVED relative path (so
  // '.env/.' etc. can't slip past) and BEFORE stat (don't even reveal that a
  // secret exists).
  const SECRET_REFUSAL =
    "refusing to read a secret/credential file over a remote connection";
  if (remote && isSensitiveRepoPath(path.relative(root, target))) {
    return fail(rel, SECRET_REFUSAL);
  }

  let size: number;
  try {
    const st = fs.statSync(target);
    if (st.isDirectory()) return fail(rel, "this is a folder, not a file");
    if (!st.isFile()) return fail(rel, "not a regular file");
    size = st.size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return fail(
      rel,
      code === "ENOENT"
        ? "file no longer exists on disk"
        : code === "EACCES"
          ? "permission denied"
          : `cannot stat file (${code ?? "unknown error"})`,
    );
  }

  try {
    const realTarget = fs.realpathSync(target);
    const realRoot = fs.realpathSync(root);
    if (!isInside(realTarget, realRoot)) {
      return fail(rel, "refusing to follow a symlink outside the workspace");
    }
    // (#7) A symlink with an INNOCUOUS name must not resolve to a secret: the
    // name passed the lexical gate, so re-check the realpath target.
    if (remote && isSensitiveRepoPath(path.relative(realRoot, realTarget))) {
      return fail(rel, SECRET_REFUSAL);
    }
  } catch {
    // realpath race/quirk: the lexical gate already passed. For a REMOTE read
    // FAIL CLOSED — we couldn't prove the resolved target isn't a secret or
    // doesn't escape the workspace (e.g. a TOCTOU symlink swap between stat and
    // realpath). A local read proceeds as before.
    if (remote) return fail(rel, SECRET_REFUSAL);
  }

  const ext = path.extname(target).toLowerCase();
  const imageMime = IMAGE_MIME[ext];

  try {
    if (imageMime) {
      if (size > MAX_IMAGE_BYTES)
        return { kind: "too-large", path: rel, bytes: size };
      const buf = fs.readFileSync(target);
      return {
        kind: "image",
        path: rel,
        bytes: size,
        dataUrl: `data:${imageMime};base64,${buf.toString("base64")}`,
      };
    }

    if (size > MAX_TEXT_BYTES)
      return { kind: "too-large", path: rel, bytes: size };

    const buf = fs.readFileSync(target);
    const head = buf.subarray(0, Math.min(buf.length, 8192));
    if (head.includes(0)) return { kind: "binary", path: rel, bytes: size };

    return {
      kind: "text",
      path: rel,
      bytes: size,
      content: buf.toString("utf-8"),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return fail(rel, `cannot read file (${code ?? "unknown error"})`);
  }
}
