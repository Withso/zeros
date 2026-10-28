// Workspace checkpoints. Boat deletes a stopped VM's disk after 14 days, so
// every stop saves what the workspace needs to come back on a new VM, as one
// encrypted object in our own storage, kept until the workspace is deleted:
// - the workspace repository's Git state: branches, local commits, stashes,
//   the index and every tracked or untracked file that is not ignored, plus
//   small ignored files outside ignored directories (such as `.env.local`);
// - completed composer attachments, including inside ignored context roots;
// - the worker's state and the agents' session files.
// Ignored directories (dependencies, build outputs) come back from the Cloud
// Computer and the setup script instead. The VM builds and uploads the object
// itself through a short-lived presigned URL; the data key exists only in the
// command and sealed in the database. A stop that finds everything above
// exactly as the last checkpoint holds it keeps that checkpoint instead of
// uploading an identical one; the comparison covers contents, never times.
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash, hkdfSync } from "node:crypto";
import { z } from "zod";
import { openCredentialBytes, sealCredentialBytes, type CloudAgentCredentialKeys } from "../agent-credentials/agent-credential-envelope.js";
import type { CloudV2RuntimeStore } from "./runtime.js";
import { runtimeObjectMissing } from "./runtime-source.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBJECT = /^cloud-v2\/checkpoints\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.zck$/;
const URL_TTL_SECONDS = 15 * 60;
/** R2 accepts a single upload of up to 5 GiB. */
export const CLOUD_V2_CHECKPOINT_MAX_BYTES = 4 * 1024 ** 3;
/** The whole command, within Boat's ten-minute command limit. */
export const CLOUD_V2_CHECKPOINT_SECONDS = 540;
/** Paths under the VM user's home; the worker keeps its state in the first. */
export const CLOUD_V2_WORKER_STATE = ".local/share/zeros/cloud-worker";
const SESSION_PATHS = [CLOUD_V2_WORKER_STATE, ".claude/projects", ".codex/sessions", ".codex/archived_sessions", ".cursor/chats", ".cursor/projects"];
/** Written after a restore; the worker then runs the setup once more. */
export const CLOUD_V2_RESTORED_MARKER = `${CLOUD_V2_WORKER_STATE}/restored-from-checkpoint`;
/** Never saved from the session paths: setup status, partial uploads, the
 * broker socket, the restore marker and credential files. The archive and its
 * fingerprint both leave out exactly these. */
const SESSION_EXCLUDED_PATHS = ["workspace-setup", "attachment-uploads", "github.sock", "restored-from-checkpoint"].map(name => `${CLOUD_V2_WORKER_STATE}/${name}`);
const SESSION_EXCLUDED_NAMES = [".credentials.json", "auth.json"];
const IGNORED_FILE_BYTES = 1024 * 1024, IGNORED_TOTAL_BYTES = 32 * 1024 * 1024;

// Mirrored from protocol/attachment-policy: this deploys independently of the
// desktop/worker package graph. checkpoint-attachment-contract.test.ts checks parity.
export const CLOUD_V2_ATTACHMENT_MAX_BYTES = 500_000_000;
export const CLOUD_V2_ATTACHMENT_DIRS = [".context/attachments", ".context/local/attachments", ".context/shared/attachments",
  ".context-graph/local/attachments", ".context-graph/shared/attachments"] as const;
export const CLOUD_V2_ATTACHMENT_PATH = String.raw`^(\.context/attachments|\.context(-graph)?/(local|shared)/attachments)/[a-zA-Z0-9_-]{1,128}/[a-zA-Z0-9._-]+$`;
const ATTACHMENT_HELPERS = [
  `attachment_path() { [[ "$1" =~ ${CLOUD_V2_ATTACHMENT_PATH} ]] && [ "\${1##*/}" != . ] && [ "\${1##*/}" != .. ]; }`,
  "attachment_parents() {",
  "  local parent=$1",
  "  while [[ \"$parent\" == */* ]]; do",
  "    parent=${parent%/*}",
  "    [ ! -L \"$parent\" ] && { [ ! -e \"$parent\" ] || [ -d \"$parent\" ]; } || return 1",
  "  done",
  "}",
];

export const CLOUD_V2_CHECKPOINT_ERRORS = ["checkpoint_failed", "checkpoint_too_large", "checkpoint_upload_failed", "checkpoint_download_failed",
  "checkpoint_corrupt", "checkpoint_repository_missing", "checkpoint_prerequisites_missing", "checkpoint_restore_failed"] as const;
export type CloudV2CheckpointError = typeof CLOUD_V2_CHECKPOINT_ERRORS[number];

export function cloudV2CheckpointObject(workspaceId: string, checkpointId: string): string {
  const workspace = workspaceId.toLowerCase(), checkpoint = checkpointId.toLowerCase();
  if (!UUID.test(workspace) || !UUID.test(checkpoint)) throw new Error("Invalid checkpoint identity");
  return `cloud-v2/checkpoints/${workspace}/${checkpoint}.zck`;
}
const checkpointPrefix = (workspaceId: string) => {
  const workspace = workspaceId.toLowerCase();
  if (!UUID.test(workspace)) throw new Error("Invalid checkpoint identity");
  return `cloud-v2/checkpoints/${workspace}/`;
};
function objectOf(workspaceId: string, object: string): string {
  const match = OBJECT.exec(object);
  if (!match || match[1] !== workspaceId.toLowerCase()) throw new Error("Invalid checkpoint object");
  return object;
}

// The encrypted stream: "ZCK1", an 8-byte random nonce prefix, then chunks of
// at most 1 MiB, each a 4-byte length, AES-256-GCM ciphertext and tag. A chunk
// nonce is the prefix and its index; its additional data marks the final
// chunk, so truncation or appended data fails authentication. Runs with the
// VM's own Node, the one the worker uses.
const STREAM = String.raw`
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
const [mode, keyFile, input, output] = process.argv.slice(2);
const key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
if (key.length !== 32) process.exit(2);
const MAGIC = Buffer.from("ZCK1"), CHUNK = 1 << 20, TAG = 16;
const source = openSync(input, "r"), target = openSync(output, "wx", 0o600), total = fstatSync(source).size;
let position = 0;
const read = size => {
  const buffer = Buffer.alloc(size); let filled = 0;
  while (filled < size) { const count = readSync(source, buffer, filled, size - filled, null); if (count === 0) break; filled += count; }
  position += filled; return buffer.subarray(0, filled);
};
const write = buffer => { for (let done = 0; done < buffer.length;) done += writeSync(target, buffer, done); };
const nonce = (prefix, index) => { const value = Buffer.alloc(12); prefix.copy(value); value.writeUInt32BE(index, 8); return value; };
const aad = (index, last) => { const value = Buffer.alloc(9); MAGIC.copy(value); value.writeUInt32BE(index, 4); value[8] = last ? 1 : 0; return value; };
if (mode === "encrypt") {
  const prefix = randomBytes(8); write(MAGIC); write(prefix);
  let chunk = read(CHUNK);
  for (let index = 0; ; index++) {
    if (index > 0xfffffffe) process.exit(2);
    const next = chunk.length === CHUNK ? read(CHUNK) : Buffer.alloc(0), last = next.length === 0;
    const cipher = createCipheriv("aes-256-gcm", key, nonce(prefix, index)); cipher.setAAD(aad(index, last));
    const body = Buffer.concat([cipher.update(chunk), cipher.final()]), length = Buffer.alloc(4);
    length.writeUInt32BE(body.length); write(length); write(body); write(cipher.getAuthTag());
    if (last) break;
    chunk = next;
  }
} else if (mode === "decrypt") {
  const header = read(12);
  if (header.length !== 12 || !header.subarray(0, 4).equals(MAGIC)) process.exit(3);
  const prefix = header.subarray(4);
  for (let index = 0; ; index++) {
    const length = read(4); if (length.length !== 4 || index > 0xfffffffe) process.exit(3);
    const size = length.readUInt32BE(); if (size > CHUNK) process.exit(3);
    const body = read(size), tag = read(TAG); if (body.length !== size || tag.length !== TAG) process.exit(3);
    const last = position === total;
    const decipher = createDecipheriv("aes-256-gcm", key, nonce(prefix, index)); decipher.setAAD(aad(index, last)); decipher.setAuthTag(tag);
    try { write(Buffer.concat([decipher.update(body), decipher.final()])); } catch { process.exit(3); }
    if (last) break;
  }
} else process.exit(2);
closeSync(source); closeSync(target);
`;

// One digest over what a part of the checkpoint holds. Each field is length-
// prefixed, so no name or content can imitate another entry. Names, kinds,
// permission bits, link targets and file contents count; owners and times do
// not, because the worker rewrites unchanged files. "files" reads a NUL-
// separated list of paths under root; "tree" walks the session paths as tar
// saves them, without following links, minus the same exclusions.
const DIGEST = String.raw`
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync } from "node:fs";
const [mode, root, ...rest] = process.argv.slice(2);
const digest = createHash("sha256"), chunk = Buffer.alloc(1 << 20);
const field = value => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value)), size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(bytes.length)); digest.update(size); digest.update(bytes);
};
const under = name => Buffer.concat([Buffer.from(root + "/"), name]);
const entry = name => {
  const path = under(name), stat = lstatSync(path);
  field(name); field((stat.mode & 0o170000).toString(8)); field((stat.mode & 0o7777).toString(8));
  if (stat.isSymbolicLink()) field(readlinkSync(path, { encoding: "buffer" }));
  else if (stat.isFile()) {
    const hash = createHash("sha256"), fd = openSync(path, "r");
    try { for (let read; (read = readSync(fd, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, read)); } finally { closeSync(fd); }
    field(hash.digest());
  }
  return stat;
};
if (mode === "files") {
  const list = readFileSync(rest[0]);
  for (let start = 0; start < list.length;) {
    let end = list.indexOf(0, start); if (end < 0) end = list.length;
    if (end > start) entry(list.subarray(start, end));
    start = end + 1;
  }
} else if (mode === "tree") {
  const split = rest.indexOf("--");
  if (split < 0) process.exit(2);
  const paths = new Set(rest.slice(0, split).filter(value => value.startsWith("path:")).map(value => value.slice(5)));
  const names = new Set(rest.slice(0, split).filter(value => value.startsWith("name:")).map(value => value.slice(5)));
  const walk = name => {
    const text = name.toString("latin1");
    if (paths.has(text) || names.has(text.slice(text.lastIndexOf("/") + 1))) return;
    if (!entry(name).isDirectory()) return;
    for (const child of readdirSync(under(name), { encoding: "buffer" }).sort(Buffer.compare)) walk(Buffer.concat([name, Buffer.from("/"), child]));
  };
  for (const top of rest.slice(split + 1)) walk(Buffer.from(top));
} else process.exit(2);
process.stdout.write(digest.digest("hex") + "\n");
`;

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64");

export type CheckpointPaths = {
  /** The workspace repository, /home/user/<owner>/<name>. */
  checkoutPath: string;
  /** The VM user's home, /home/user. */
  home: string;
};

function paths(input: CheckpointPaths) {
  for (const value of [input.checkoutPath, input.home])
    if (!value.startsWith("/") || value.includes("\n") || value.includes("\0") || value.split("/").some(part => part === "..")) throw new Error("Invalid checkpoint path");
  return [`repo=${quote(input.checkoutPath)}`, `home=${quote(input.home)}`, `state=${quote(CLOUD_V2_WORKER_STATE)}`];
}
function dataKey(key: Buffer): string {
  if (key.length !== 32) throw new Error("Invalid checkpoint key");
  return b64(key);
}
function https(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Invalid checkpoint URL");
  return url.href;
}

/** Finds what Git needs inside the checkout, relative to it (any name is
 * possible, newlines included). `mine` gets the resolved Git and common
 * directories when they live inside it, plus every link inside it on the way
 * there. `route` gets every name inside it that is looked up on the way. Git
 * gets there through the `.git` file and the Git directory's `commondir`
 * file, each followed as the kernel would. Runs in the checkout; fails
 * rather than leave out anything it could not resolve. */
const OWN_GIT_DIRS = [
  // $(...) drops trailing newlines, which a name can end with; the x keeps them.
  "own_git_dirs() {",
  "  local here gitdir common cand target",
  "  mine=() route=()",
  "  here=$(pwd -P && printf x) && gitdir=$(git rev-parse --absolute-git-dir && printf x) && common=$(git rev-parse --git-common-dir && printf x) || return 1",
  "  here=${here%$'\\nx'} gitdir=${gitdir%$'\\nx'} common=${common%$'\\nx'}",
  "  gitdir=$(cd \"$gitdir\" && pwd -P && printf x) && common=$(cd \"$common\" && pwd -P && printf x) || return 1",
  "  gitdir=${gitdir%$'\\nx'} common=${common%$'\\nx'}",
  "  if [ -f .git ]; then pointer .git 'gitdir: ' && walk \"$here\" \"$target\" || return 1; fi",
  "  if [ -f \"$gitdir/commondir\" ]; then pointer \"$gitdir/commondir\" '' && walk \"$gitdir\" \"$target\" || return 1; fi",
  "  for cand in \"$gitdir\" \"$common\"; do",
  "    [ \"$cand\" != \"$here\" ] || return 1",
  "    case \"$cand\" in \"$here\"/*) mine+=(\"${cand#\"$here\"/}\") ;; esac",
  "  done",
  "}",
  // Reads a pointer file as Git does: everything after the prefix, less trailing line ends.
  "pointer() {",
  "  target=$(cat -- \"$1\" && printf x) || return 1; target=${target%x}",
  "  case \"$target\" in \"$2\"*) target=${target#\"$2\"} ;; *) return 1 ;; esac",
  "  while case \"$target\" in *$'\\n' | *$'\\r') true ;; *) false ;; esac; do target=${target%?}; done",
  "}",
  // Follows a path from a physical directory, one name at a time, as the kernel does.
  "walk() {",
  "  local cur=$1 rest=$2 comp next link hops=0",
  "  case \"$rest\" in /*) cur=/ ;; esac",
  "  while [ -n \"$rest\" ]; do",
  "    comp=${rest%%/*}; rest=${rest#\"$comp\"}; rest=${rest#/}",
  "    case \"$comp\" in",
  "      '' | .) continue ;;",
  "      ..) cur=$(cd \"${cur%/}/..\" && pwd -P && printf x) || return 1; cur=${cur%$'\\nx'}; continue ;;",
  "    esac",
  "    next=${cur%/}/$comp",
  "    case \"$next\" in \"$here\"/*) route+=(\"${next#\"$here\"/}\") ;; esac",
  "    if [ -L \"$next\" ]; then",
  "      hops=$((hops + 1)); [ \"$hops\" -le 40 ] || return 1",
  "      case \"$next\" in \"$here\"/*) mine+=(\"${next#\"$here\"/}\") ;; esac",
  "      link=$(readlink -- \"$next\" && printf x) || return 1; link=${link%$'\\nx'}",
  "      case \"$link\" in /*) cur=/ ;; esac",
  "      rest=$link/$rest",
  "    else",
  "      cur=$next",
  "    fi",
  "  done",
  "}",
];

/** Shared prologue: results go to the original stdout as one line; every
 * other output is discarded, so file names and contents never reach the
 * control plane. A failure names only its step. */
function prologue(kind: "checkpoint" | "restore", lines: string[]): string[] {
  return [
    "set -euo pipefail", "umask 077", ...lines, "step=start work=''",
    "report() { printf '%s\\n' \"$1\" >&3; reported=1; }",
    "fail() { report \"zeros-checkpoint-error $1 $step\"; exit 3; }",
    "finish() {",
    "  code=$?",
    "  if [ -n \"${cleanup_refs:-}\" ]; then",
    "    git -C \"$repo\" for-each-ref --format='%(refname)' refs/zeros-checkpoint/ 2>/dev/null | while read -r ref; do git -C \"$repo\" update-ref -d \"$ref\" || true; done",
    "  fi",
    "  if [ -n \"$work\" ]; then rm -rf \"$work\"; fi",
    `  if [ "$code" -ne 0 ] && [ -z "\${reported:-}" ]; then printf 'zeros-checkpoint-error ${kind === "checkpoint" ? "checkpoint_failed" : "checkpoint_restore_failed"} %s\\n' "$step" >&3; fi`,
    "}",
    "exec 3>&1 >/dev/null 2>&1",
    "trap finish EXIT",
    // A killed command still cleans up: bash runs no EXIT trap on an untrapped signal.
    "trap 'exit 143' TERM INT HUP",
    "export GIT_TERMINAL_PROMPT=0 GIT_AUTHOR_NAME=Zeros GIT_AUTHOR_EMAIL=checkpoint@zeros.invalid GIT_COMMITTER_NAME=Zeros GIT_COMMITTER_EMAIL=checkpoint@zeros.invalid",
    "command -v node || { step=node; fail checkpoint_failed; }",
    "mkdir -p \"$home/.cache\"",
    `work=$(mktemp -d "$home/.cache/zeros-${kind}.XXXXXX")`,
    `printf %s ${quote(b64(STREAM))} | base64 -d > "$work/stream.mjs"`,
  ];
}

/** What an existing checkpoint is compared by: the fingerprint of what it
 * holds, and the base commit whose objects it left out (null if none). */
export type CheckpointReuse = { fingerprint: string; base: string | null };
type ArchiveInput = CheckpointPaths & { baseBranch: string; key: Buffer; maxBytes?: number; reuse?: CheckpointReuse | null };
const FINGERPRINT = /^[0-9a-f]{64}$/, COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Builds `$work/checkpoint.zck` and sets `bytes`, `sha`, `fingerprint` and
 * `base_commit`. Given `reuse`, it instead reports unchanged and exits when
 * the workspace still holds exactly what that checkpoint does. The worker
 * must not be running: its sessions and the repository must be quiet. */
export function checkpointArchiveSteps(input: ArchiveInput): string[] {
  // Quoted for the shell and always prefixed for Git; only option-like or
  // multi-line names are refused.
  if (!/^[^\0\r\n]{1,255}$/.test(input.baseBranch) || input.baseBranch.startsWith("-")) throw new Error("Invalid checkpoint base branch");
  const maxBytes = input.maxBytes ?? CLOUD_V2_CHECKPOINT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > CLOUD_V2_CHECKPOINT_MAX_BYTES) throw new Error("Invalid checkpoint limit");
  if (input.reuse && (!FINGERPRINT.test(input.reuse.fingerprint) || (input.reuse.base !== null && !COMMIT.test(input.reuse.base))))
    throw new Error("Invalid checkpoint fingerprint");
  // A fingerprint is only comparable with one made by the same capture: any
  // change to what or how this saves starts a new comparison.
  const template = archiveSteps({ ...input, key: Buffer.alloc(32), reuse: null }, "0".repeat(64));
  return archiveSteps(input, createHash("sha256").update(template.join("\n")).digest("hex"));
}

function archiveSteps(input: ArchiveInput, revision: string): string[] {
  const reuse = input.reuse ?? null, maxBytes = input.maxBytes ?? CLOUD_V2_CHECKPOINT_MAX_BYTES;
  return [
    ...prologue("checkpoint", [...paths(input), `base=${quote(input.baseBranch)}`]),
    `printf %s ${quote(dataKey(input.key))} > "$work/key"`,
    `printf %s ${quote(b64(DIGEST))} | base64 -d > "$work/digest.mjs"`,
    "c=\"$work/c\"; mkdir \"$c\"; m=\"$c/manifest\"; printf 'zeros-checkpoint 1\\n' > \"$m\"",
    // Digests of the parts outside Git; a part that cannot be read disables reuse.
    "have_repo='' tree='' staged_tree='' base_commit='' digests=1; : > \"$work/parts\"",
    "step=repository",
    "if [ -d \"$repo\" ] && top=$(git -C \"$repo\" rev-parse --show-toplevel) && [ \"$(cd \"$repo\" && pwd -P)\" = \"$(cd \"$top\" && pwd -P)\" ]; then",
    "  cd \"$repo\"; cleanup_refs=1; have_repo=1",
    "  head=$(git rev-parse -q --verify 'HEAD^{commit}' || true)",
    "  if ref=$(git symbolic-ref -q HEAD); then printf 'head ref %s\\n' \"$ref\" >> \"$m\"",
    "  elif [ -n \"$head\" ]; then printf 'head detached %s\\n' \"$head\" >> \"$m\"; fi",
    "  if [ -n \"$head\" ]; then printf 'commit %s\\n' \"$head\" >> \"$m\"; git update-ref refs/zeros-checkpoint/head \"$head\"; fi",
    // The working tree as Git sees it, from a copy of the index so only
    // changed files are hashed again: tracked and untracked, never ignored.
    "  step=worktree",
    "  scratch() { GIT_INDEX_FILE=\"$work/index\" git \"$@\"; }",
    // Edits Git was told to ignore are still the user's work. A skip-worktree
    // file missing from disk is sparse, not deleted, so it keeps its mark.
    "  unhide() {",
    "    { scratch ls-files -z -v | grep -z '^[a-z] ' || true; } | cut -z -c3- | scratch update-index -z --no-assume-unchanged --stdin",
    "    while IFS= read -r -d '' path; do if [ -e \"$path\" ] || [ -L \"$path\" ]; then printf '%s\\0' \"$path\"; fi; done \\",
    "      < <(scratch ls-files -z -t | grep -z '^S ' | cut -z -c3- || true) | scratch update-index -z --no-skip-worktree --stdin",
    "  }",
    // Git lists its own directory as untracked files when it lives inside the
    // checkout under another name; it is never part of the checkpoint, even if
    // something already staged it. --sparse: edits outside a sparse cone count.
    ...OWN_GIT_DIRS,
    "  own_git_dirs || fail checkpoint_failed",
    "  own=(); keep=(); for rel in ${mine[@]+\"${mine[@]}\"}; do own+=(\":(top,literal)$rel\"); keep+=(\":(exclude,top,literal)$rel\"); done",
    "  addall() { scratch add -A --sparse -- . ${keep[@]+\"${keep[@]}\"}; }",
    "  forget() { if [ ${#own[@]} -gt 0 ]; then GIT_INDEX_FILE=\"$1\" git rm -r -q -f --cached --sparse --ignore-unmatch -- \"${own[@]}\"; fi; }",
    // A conflicted index has no tree; the restore then shows every change as unstaged.
    "  staged=$(git write-tree) || staged=''",
    "  if [ -n \"$staged\" ] && [ ${#own[@]} -gt 0 ]; then",
    "    GIT_INDEX_FILE=\"$work/staged\" git read-tree \"$staged\"; forget \"$work/staged\"; staged=$(GIT_INDEX_FILE=\"$work/staged\" git write-tree)",
    "  fi",
    "  index=$(git rev-parse --git-path index)",
    "  if ! { [ -f \"$index\" ] && cp \"$index\" \"$work/index\" && unhide && addall; }; then",
    // A fresh index, seeded from the staged tree as Conductor's checkpointer
    // does, and made as complete as a copy: sparse files absent from disk keep
    // their mark, and every path the real index lists (unmerged and
    // intent-to-add entries included) is added even if it matches .gitignore.
    "    rm -f \"$work/index\"",
    "    if [ -n \"$staged\" ]; then scratch read-tree \"$staged\"; elif [ -n \"$head\" ]; then scratch read-tree \"$head\"; else scratch read-tree --empty; fi",
    "    while IFS= read -r -d '' path; do if ! [ -e \"$path\" ] && ! [ -L \"$path\" ]; then printf '%s\\0' \"$path\"; fi; done \\",
    "      < <(git ls-files -z -t | grep -z '^[Ss] ' | cut -z -c3- || true) | scratch update-index -z --skip-worktree --stdin",
    "    addall",
    "    while IFS= read -r -d '' path; do if [ -e \"$path\" ] || [ -L \"$path\" ]; then printf '%s\\0' \"$path\"; fi; done < <(git ls-files -z) \\",
    "      | scratch --literal-pathspecs add -f --sparse --pathspec-from-file=- --pathspec-file-nul",
    "  fi",
    "  forget \"$work/index\"",
    "  tree=$(scratch write-tree) staged_tree=$staged",
    "  parent=(); if [ -n \"$head\" ]; then parent=(-p \"$head\"); fi",
    "  if [ -n \"$staged\" ]; then",
    "    staged=$(git commit-tree --no-gpg-sign ${parent[@]+\"${parent[@]}\"} -m zeros-checkpoint-index \"$staged\")",
    "    git update-ref refs/zeros-checkpoint/index \"$staged\"; printf 'index %s\\n' \"$staged\" >> \"$m\"; parent=(-p \"$staged\")",
    "  fi",
    "  files=$(git commit-tree --no-gpg-sign ${parent[@]+\"${parent[@]}\"} -m zeros-checkpoint-worktree \"$tree\")",
    "  git update-ref refs/zeros-checkpoint/worktree \"$files\"; printf 'worktree %s\\n' \"$files\" >> \"$m\"",
    "  step=refs",
    "  git for-each-ref --format='branch %(objectname) %(refname)' refs/heads >> \"$m\"",
    "  git for-each-ref --format='tag %(objectname) %(refname)' refs/tags >> \"$m\"",
    // Remotes other than origin (which the Cloud Computer has): every URL, push
    // URL and fetch setting, without credentials.
    "  strip() { printf %s \"$1\" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/@]*@#\\1#' | base64 -w0; }",
    "  while read -r name; do",
    "    if [ \"$name\" = origin ] || ! [[ \"$name\" =~ ^[A-Za-z0-9._-]{1,100}$ ]]; then continue; fi",
    "    printf 'remote %s\\n' \"$name\" >> \"$m\"",
    // Effective URLs, with this checkout's insteadOf rewriting already applied.
    "    while read -r value; do printf 'remoteurl %s %s\\n' \"$name\" \"$(strip \"$value\")\" >> \"$m\"; done < <(git remote get-url --all \"$name\" || true)",
    // Push URLs too whenever pushing goes elsewhere, through an explicit pushurl
    // or a pushInsteadOf rule that the new checkout does not have.
    "    fetches=$(git remote get-url --all \"$name\" || true); pushes=$(git remote get-url --push --all \"$name\" || true)",
    "    if [ \"$pushes\" != \"$fetches\" ]; then",
    "      while read -r value; do printf 'remotepush %s %s\\n' \"$name\" \"$(strip \"$value\")\" >> \"$m\"; done <<< \"$pushes\"",
    "    fi",
    "    while read -r spec; do printf 'remotefetch %s %s\\n' \"$name\" \"$(printf %s \"$spec\" | base64 -w0)\" >> \"$m\"; done < <(git config --get-all \"remote.$name.fetch\" || true)",
    "  done < <(git remote)",
    "  while read -r name remote merge; do",
    "    if [ -n \"$remote\" ] && [ -n \"$merge\" ]; then printf 'upstream %s %s %s\\n' \"$name\" \"$remote\" \"$merge\" >> \"$m\"; fi",
    "  done < <(git for-each-ref --format='%(refname) %(upstream:remotename) %(upstream:remoteref)' refs/heads)",
    "  step=stash; n=0",
    "  while read -r sha subject; do",
    "    git update-ref \"refs/zeros-checkpoint/stash-$n\" \"$sha\"; n=$((n + 1))",
    "    printf 'stash %s %s\\n' \"$sha\" \"$(printf %s \"${subject:-stash}\" | base64 -w0)\" >> \"$m\"",
    "  done < <(git log -g --format='%H %gs' refs/stash 2>/dev/null || true)",
    // Objects the base branch already has stay out; a new Cloud Computer has them.
    "  base_commit=$(git rev-parse -q --verify \"refs/remotes/origin/$base^{commit}\" || true)",
    // Ignore rules often hide the whole .context directory. Enumerate only
    // registered layouts, at their fixed depth, without following any links.
    // Tracked/nonignored attachments are already in the Git snapshot; ignored
    // ones use tar to avoid hashing large media into Git's object store.
    ...ATTACHMENT_HELPERS,
    "  step=attachments; : > \"$work/attachment-candidates\"",
    `  for dir in ${CLOUD_V2_ATTACHMENT_DIRS.map(quote).join(" ")}; do`,
    "    if [ -d \"$dir\" ] && attachment_parents \"$dir/file\"; then find -P \"$dir\" -mindepth 2 -maxdepth 2 -type f -print0 >> \"$work/attachment-candidates\"; fi",
    "  done",
    "  git check-ignore -z --stdin < \"$work/attachment-candidates\" > \"$work/attachment-ignored\" || [ $? -eq 1 ]",
    "  while IFS= read -r -d '' path; do",
    "    attachment_path \"$path\" || continue",
    "    skip=''; for rel in ${mine[@]+\"${mine[@]}\"}; do case \"$path\" in \"$rel\" | \"$rel\"/*) skip=1 ;; esac; done; [ -z \"$skip\" ] || continue",
    "    attachment_parents \"$path\" && [ -f \"$path\" ] && [ ! -L \"$path\" ] || fail checkpoint_failed",
    `    [ "$(stat -c %s -- "$path")" -le ${CLOUD_V2_ATTACHMENT_MAX_BYTES} ] || fail checkpoint_too_large`,
    "    printf '%s\\0' \"$path\" >> \"$work/attachments\"",
    "  done < \"$work/attachment-ignored\"",
    "  step=ignored; total=0",
    "  while IFS= read -r -d '' path; do",
    "    case \"$path\" in */) continue ;; esac",
    "    if attachment_path \"$path\"; then continue; fi",
    "    if [ -f \"$path\" ] && [ ! -L \"$path\" ]; then",
    "      size=$(stat -c %s -- \"$path\")",
    `      if [ "$size" -le ${IGNORED_FILE_BYTES} ] && [ $((total + size)) -le ${IGNORED_TOTAL_BYTES} ]; then total=$((total + size)); printf '%s\\0' "$path" >> "$work/ignored"; fi`,
    "    fi",
    "  done < <(git ls-files -z --others --ignored --exclude-standard --directory)",
    "  step=fingerprint",
    "  for part in attachments ignored; do",
    "    if [ -s \"$work/$part\" ]; then printf '%s ' \"$part\" >> \"$work/parts\"; node \"$work/digest.mjs\" files \"$repo\" \"$work/$part\" >> \"$work/parts\" || digests=''; fi",
    "  done",
    "fi",
    "step=sessions",
    "cd \"$home\"; set --",
    `for p in ${SESSION_PATHS.map(quote).join(" ")}; do if [ -e "$p" ] && [ ! -L "$p" ]; then set -- "$@" "$p"; fi; done`,
    "step=fingerprint",
    `if [ $# -gt 0 ]; then printf 'home ' >> "$work/parts"; node "$work/digest.mjs" tree "$home" ${[...SESSION_EXCLUDED_PATHS.map(path => `path:${path}`), ...SESSION_EXCLUDED_NAMES.map(name => `name:${name}`)].map(quote).join(" ")} -- "$@" >> "$work/parts" || digests=''; fi`,
    // The Git part is the manifest with the index and worktree commits, whose
    // times change on every run, replaced by their trees.
    "fingerprint=''",
    "if [ -n \"$digests\" ]; then",
    `  { printf 'zeros-checkpoint-fingerprint 1\\nrevision %s\\n' ${revision}; grep -v -E '^(index|worktree) ' "$m" || true; printf 'index-tree %s\\nworktree-tree %s\\n' "\${staged_tree:--}" "\${tree:--}"; cat "$work/parts"; } > "$work/fingerprint"`,
    "  fingerprint=$(sha256sum \"$work/fingerprint\" | cut -c1-64)",
    "fi",
    // Same contents, and everything the old checkpoint left out is still
    // reachable from this base: restoring it gives back exactly this workspace.
    ...(reuse ? [
      `if [ "$fingerprint" = ${reuse.fingerprint} ] && { ${reuse.base === null ? "true" : `[ -n "$base_commit" ] && git -C "$repo" merge-base --is-ancestor ${reuse.base} "$base_commit"`}; }; then`,
      "  report \"zeros-checkpoint-unchanged fingerprint=$fingerprint\"; exit 0",
      "fi",
    ] : []),
    "step=bundle",
    "if [ -n \"$have_repo\" ]; then",
    "  cd \"$repo\"",
    "  negative=(); if [ -n \"$base_commit\" ]; then negative=(--not \"$base_commit\"); fi",
    "  git bundle create \"$c/repo.bundle\" --branches --tags --glob=refs/zeros-checkpoint ${negative[@]+\"${negative[@]}\"}",
    "  step=attachments",
    "  if [ -s \"$work/attachments\" ]; then tar --sparse --null --verbatim-files-from --no-recursion --hard-dereference -T \"$work/attachments\" -cf \"$c/attachments.tar\"; fi",
    "  step=ignored",
    "  if [ -s \"$work/ignored\" ]; then tar --null --verbatim-files-from --no-recursion -T \"$work/ignored\" -cf \"$c/ignored.tar\"; fi",
    "fi",
    "step=sessions",
    "cd \"$home\"",
    "if [ $# -gt 0 ]; then",
    `  tar -cf "$c/home.tar" ${[...SESSION_EXCLUDED_PATHS, ...SESSION_EXCLUDED_NAMES].map(path => `--exclude=${quote(path)}`).join(" ")} \\`,
    "    --warning=no-file-changed --warning=no-file-removed --ignore-failed-read \"$@\" || [ $? -eq 1 ]",
    "fi",
    "step=pack",
    "(cd \"$c\" && tar -cf - .) | gzip -1 > \"$work/plain\"; rm -rf \"$c\"",
    `if [ "$(stat -c %s "$work/plain")" -gt ${maxBytes} ]; then fail checkpoint_too_large; fi`,
    "step=encrypt",
    "node \"$work/stream.mjs\" encrypt \"$work/key\" \"$work/plain\" \"$work/checkpoint.zck\"; rm -f \"$work/plain\" \"$work/key\"",
    "bytes=$(stat -c %s \"$work/checkpoint.zck\"); sha=$(sha256sum \"$work/checkpoint.zck\" | cut -c1-64)",
  ];
}

/** A saved checkpoint's result line: its size and digest, and what a later
 * stop compares it by whenever the VM could read every part. */
export const CHECKPOINT_SAVED_REPORT = "report \"zeros-checkpoint-saved bytes=$bytes sha256=$sha${fingerprint:+ fingerprint=$fingerprint} base=${base_commit:--}\"";

/** Stops the worker, then builds the checkpoint and uploads it, or reports
 * that the one `reuse` describes still holds everything. */
export function checkpointCommand(input: ArchiveInput & { uploadUrl: string }): string {
  const url = https(input.uploadUrl);
  const script = [
    ...checkpointArchiveSteps(input),
    "step=upload",
    `curl -fsS --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 420 -T "$work/checkpoint.zck" ${quote(url)} || fail checkpoint_upload_failed`,
    CHECKPOINT_SAVED_REPORT,
  ];
  // The worker is told to stop first; systemd's stop also ends its agents,
  // terminals and anything they started before the files are read.
  return `bash -c ${quote(["sudo -n systemctl stop zeros-worker.service >/dev/null 2>&1 || true", ...script].join("\n"))}`;
}

export type RestoreInput = CheckpointPaths & { key: Buffer; sha256: string; githubToken?: string; repositoryUrl?: string };

/** Verifies and applies the checkpoint that `fetch` places at
 * `$work/checkpoint.zck`, before the worker starts. */
export function checkpointRestoreSteps(input: RestoreInput, fetch: readonly string[]): string[] {
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error("Invalid checkpoint digest");
  const token = input.githubToken;
  if (token !== undefined && !/^[\x21-\x7e]{16,4096}$/.test(token)) throw new Error("Invalid GitHub token");
  const remote = input.repositoryUrl === undefined ? "" : https(input.repositoryUrl);
  return [
    ...prologue("restore", paths(input)),
    "step=download",
    ...fetch,
    `printf '%s  %s\\n' ${input.sha256} "$work/checkpoint.zck" | sha256sum -c --status || fail checkpoint_corrupt`,
    `printf %s ${quote(dataKey(input.key))} > "$work/key"`,
    "step=decrypt",
    "node \"$work/stream.mjs\" decrypt \"$work/key\" \"$work/checkpoint.zck\" \"$work/plain\" || fail checkpoint_corrupt",
    "rm -f \"$work/checkpoint.zck\" \"$work/key\"; c=\"$work/c\"; mkdir \"$c\"",
    "tar -xzf \"$work/plain\" -C \"$c\" --no-same-owner || fail checkpoint_corrupt",
    "rm -f \"$work/plain\"; m=\"$c/manifest\"",
    "[ \"$(head -n 1 \"$m\")\" = 'zeros-checkpoint 1' ] || fail checkpoint_corrupt",
    "hex() { [[ \"$1\" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || fail checkpoint_corrupt; }",
    ...OWN_GIT_DIRS,
    "branch() { [[ \"$1\" == refs/heads/* ]] && git check-ref-format \"$1\" || fail checkpoint_corrupt; }",
    // Network only when the Cloud Computer lacks a commit the checkpoint needs.
    ...(token ? [
      `printf %s ${quote(b64(token))} | base64 -d > "$work/token"`,
      "printf '#!/bin/sh\\ncase \"$1\" in Username*) echo x-access-token ;; *) cat \"%s\" ;; esac\\n' \"$work/token\" > \"$work/askpass\"; chmod 700 \"$work/askpass\"",
      "remote_git() { GIT_ASKPASS=\"$work/askpass\" git -c credential.helper= \"$@\"; }",
    ] : ["remote_git() { git -c credential.helper= \"$@\"; }"]),
    "fetched=''",
    "need() {",
    "  hex \"$1\"; local object=\"$1^{${2:-commit}}\"; if git cat-file -e \"$object\"; then return 0; fi",
    "  if [ -z \"$fetched\" ]; then fetched=1; remote_git fetch -q --tags origin || true; fi",
    "  git cat-file -e \"$object\" || remote_git fetch -q origin \"$1\" || true",
    "  git cat-file -e \"$object\" || fail checkpoint_prerequisites_missing",
    "}",
    "step=sessions",
    "if [ -f \"$c/home.tar\" ]; then tar -xf \"$c/home.tar\" -C \"$home\" --no-same-owner; fi",
    "if grep -q '^worktree ' \"$m\"; then",
    "  step=repository",
    "  if ! { [ -d \"$repo\" ] && top=$(git -C \"$repo\" rev-parse --show-toplevel) && [ \"$(cd \"$repo\" && pwd -P)\" = \"$(cd \"$top\" && pwd -P)\" ]; }; then",
    ...(remote ? [`    remote_git clone -q --no-checkout ${quote(remote)} "$repo" || fail checkpoint_repository_missing`] : ["    fail checkpoint_repository_missing"]),
    "  fi",
    "  cd \"$repo\"",
    // A checkout that keeps its own Git directory inside itself under any
    // name but .git, or reaches it through anything inside itself, could
    // lose it to saved files or history. Cloud Computer checkouts never do;
    // refuse before changing anything.
    "  step=gitdir; own_git_dirs || fail checkpoint_restore_failed",
    "  for rel in ${mine[@]+\"${mine[@]}\"} ${route[@]+\"${route[@]}\"}; do [ \"$rel\" = .git ] || fail checkpoint_restore_failed; done",
    "  step=objects",
    "  if [ -f \"$c/repo.bundle\" ]; then",
    "    while read -r sha; do need \"$sha\"; done < <(sed '/^$/q' \"$c/repo.bundle\" | grep -a '^-' | cut -c2- | cut -d' ' -f1)",
    "    git bundle unbundle \"$c/repo.bundle\" || fail checkpoint_corrupt",
    "  fi",
    "  step=refs",
    "  while read -r _ sha name; do hex \"$sha\"; branch \"$name\"; need \"$sha\"; git update-ref \"$name\" \"$sha\"; done < <(grep '^branch ' \"$m\" || true)",
    "  while read -r _ sha name; do",
    "    hex \"$sha\"; [[ \"$name\" == refs/tags/* ]] && git check-ref-format \"$name\" || fail checkpoint_corrupt",
    "    need \"$sha\" object; git update-ref \"$name\" \"$sha\"",
    "  done < <(grep '^tag ' \"$m\" || true)",
    "  line=$(grep '^head ' \"$m\" || true)",
    "  case \"$line\" in",
    // An unborn branch stays unborn even where the Cloud Computer has it.
    "    'head ref '*) ref=${line#head ref }; branch \"$ref\"",
    "      if ! grep -q '^commit ' \"$m\"; then git update-ref -d \"$ref\" || true; fi",
    "      git symbolic-ref HEAD \"$ref\" ;;",
    "    'head detached '*) sha=${line#head detached }; need \"$sha\"; git update-ref --no-deref HEAD \"$sha\" ;;",
    "  esac",
    "  step=files",
    // The restored files must all reach disk, whatever this checkout's sparse rules.
    "  if [ \"$(git config --bool core.sparseCheckout || true)\" = true ]; then git sparse-checkout disable; fi",
    "  { git ls-files -z -t | grep -z '^S ' || true; } | cut -z -c3- | git update-index -z --no-skip-worktree --stdin",
    "  worktree=$(awk '$1 == \"worktree\" { print $2 }' \"$m\"); need \"$worktree\"",
    "  git read-tree -u --reset \"$worktree^{tree}\"",
    "  staged=$(awk '$1 == \"index\" { print $2 }' \"$m\")",
    "  if [ -n \"$staged\" ]; then need \"$staged\"; git read-tree \"$staged^{tree}\"",
    "  elif git rev-parse -q --verify 'HEAD^{commit}'; then git read-tree HEAD",
    "  else git read-tree --empty; fi",
    "  git update-index -q --refresh || true",
    "  if [ -f \"$c/ignored.tar\" ]; then tar -xf \"$c/ignored.tar\" -C \"$repo\" --no-same-owner; fi",
    ...ATTACHMENT_HELPERS,
    "  step=attachments",
    "  if [ -f \"$c/attachments.tar\" ]; then",
    // Names contain no whitespace. Validate every entry and every existing
    // parent before extracting, including links supplied by the new recipe.
    // Only regular files are accepted; capture dereferences hardlinks only.
    "    tar -tf \"$c/attachments.tar\" > \"$work/attachment-paths\" || fail checkpoint_corrupt",
    "    tar -tvf \"$c/attachments.tar\" | awk 'substr($0, 1, 1) != \"-\" { exit 1 }' || fail checkpoint_corrupt",
    "    while IFS= read -r path; do",
    "      attachment_path \"$path\" || fail checkpoint_corrupt",
    "      attachment_parents \"$path\" && [ ! -L \"$path\" ] && { [ ! -e \"$path\" ] || [ -f \"$path\" ]; } || fail checkpoint_restore_failed",
    "    done < \"$work/attachment-paths\"",
    "    tar -xf \"$c/attachments.tar\" -C \"$repo\" --no-same-owner --no-overwrite-dir",
    "  fi",
    // A retried restore stores the same stashes again, never twice.
    "  step=stash; git update-ref -d refs/stash || true",
    "  while read -r _ sha message; do",
    "    need \"$sha\"; git stash store -q -m \"$(printf %s \"$message\" | base64 -d)\" \"$sha\"",
    "  done < <(grep '^stash ' \"$m\" | tac || true)",
    "  step=remotes",
    "  saved() { [[ \"$1\" =~ ^[A-Za-z0-9._-]{1,100}$ ]] && [ \"$1\" != origin ] || fail checkpoint_corrupt; }",
    // Every URL, push URL and fetch setting comes from the checkpoint, never from this checkout.
    "  while read -r _ name; do saved \"$name\"; for key in url pushurl fetch; do git config --unset-all \"remote.$name.$key\" || true; done; done < <(grep '^remote ' \"$m\" || true)",
    "  while read -r kind name value; do",
    "    saved \"$name\"; grep -qxF \"remote $name\" \"$m\" || fail checkpoint_corrupt",
    "    case \"$kind\" in remoteurl) key=url ;; remotepush) key=pushurl ;; remotefetch) key=fetch ;; esac",
    "    git config --add \"remote.$name.$key\" \"$(printf %s \"$value\" | base64 -d)\"",
    "  done < <(grep -E '^(remoteurl|remotepush|remotefetch) ' \"$m\" || true)",
    "  step=upstream",
    "  while read -r _ name remote merge; do",
    "    branch \"$name\"; branch \"$merge\"; [[ \"$remote\" =~ ^[A-Za-z0-9._-]{1,100}$ ]] || fail checkpoint_corrupt",
    "    git config \"branch.${name#refs/heads/}.remote\" \"$remote\"; git config \"branch.${name#refs/heads/}.merge\" \"$merge\"",
    "  done < <(grep '^upstream ' \"$m\" || true)",
    "fi",
    "step=marker",
    "mkdir -p \"$home/$state\"; : > \"$home/$state/restored-from-checkpoint\"",
  ];
}

/** Downloads, verifies and applies a checkpoint before the worker starts. */
export function restoreCommand(input: RestoreInput & { downloadUrl: string }): string {
  const url = https(input.downloadUrl);
  return `bash -c ${quote([
    ...checkpointRestoreSteps(input, [
      `curl -fsS --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 420 -o "$work/checkpoint.zck" ${quote(url)} || fail checkpoint_download_failed`,
    ]),
    "report zeros-checkpoint-restored",
  ].join("\n"))}`;
}

export type CheckpointResult =
  /** A new object, with what a later stop can compare it by when the VM could tell. */
  | { ok: true; unchanged?: never; bytes: number; sha256: string; reuse?: CheckpointReuse }
  /** The existing checkpoint still holds everything; nothing was uploaded. */
  | { ok: true; unchanged: true; fingerprint: string }
  | { ok: false; code: CloudV2CheckpointError; step: string };

/** The one result line a checkpoint command prints; anything else is a failure. */
export function parseCheckpointResult(stdout: string): CheckpointResult {
  for (const line of stdout.split(/\r?\n/)) {
    const saved = /^zeros-checkpoint-saved bytes=([1-9][0-9]{0,15}) sha256=([0-9a-f]{64})(?: fingerprint=([0-9a-f]{64}))?(?: base=([0-9a-f]{40}(?:[0-9a-f]{24})?|-))?$/.exec(line);
    if (saved) {
      const bytes = Number(saved[1]);
      if (Number.isSafeInteger(bytes) && bytes <= CLOUD_V2_CHECKPOINT_MAX_BYTES + 64 * 1024 * 1024)
        return { ok: true, bytes, sha256: saved[2]!,
          ...(saved[3] && saved[4] ? { reuse: { fingerprint: saved[3], base: saved[4] === "-" ? null : saved[4] } } : {}) };
    }
    const unchanged = /^zeros-checkpoint-unchanged fingerprint=([0-9a-f]{64})$/.exec(line);
    if (unchanged) return { ok: true, unchanged: true, fingerprint: unchanged[1]! };
    const failed = /^zeros-checkpoint-error ([a-z_]+)(?: ([a-z]+))?$/.exec(line);
    if (failed) return { ok: false, code: errorCode(failed[1]!, "checkpoint_failed"), step: failed[2] ?? "unknown" };
  }
  return { ok: false, code: "checkpoint_failed", step: "unknown" };
}

export function parseRestoreResult(stdout: string): { ok: true } | { ok: false; code: CloudV2CheckpointError } {
  for (const line of stdout.split(/\r?\n/)) {
    if (line === "zeros-checkpoint-restored") return { ok: true };
    const failed = /^zeros-checkpoint-error ([a-z_]+)\b/.exec(line);
    if (failed) return { ok: false, code: errorCode(failed[1]!, "checkpoint_restore_failed") };
  }
  return { ok: false, code: "checkpoint_restore_failed" };
}

const errorCode = (value: string, fallback: CloudV2CheckpointError): CloudV2CheckpointError =>
  (CLOUD_V2_CHECKPOINT_ERRORS as readonly string[]).includes(value) ? value as CloudV2CheckpointError : fallback;

/** Where checkpoints live: the runtime's bucket, under cloud-v2/checkpoints/. */
export interface CloudV2CheckpointStorage {
  uploadUrl(workspaceId: string, object: string): Promise<string>;
  downloadUrl(workspaceId: string, object: string): Promise<string>;
  /** The stored size, or null when the object does not exist. */
  size(workspaceId: string, object: string): Promise<number | null>;
  delete(workspaceId: string, object: string): Promise<void>;
  /** Deletes every checkpoint object of the workspace, for its deletion. */
  prune(workspaceId: string): Promise<void>;
}

export function cloudV2CheckpointStorage(client: S3Client, store: Pick<CloudV2RuntimeStore, "bucket">): CloudV2CheckpointStorage {
  const Bucket = store.bucket;
  return {
    uploadUrl: (workspaceId, object) => getSignedUrl(client, new PutObjectCommand({ Bucket, Key: objectOf(workspaceId, object) }), { expiresIn: URL_TTL_SECONDS }),
    downloadUrl: (workspaceId, object) => getSignedUrl(client, new GetObjectCommand({ Bucket, Key: objectOf(workspaceId, object) }), { expiresIn: URL_TTL_SECONDS }),
    async size(workspaceId, object) {
      try { return (await client.send(new HeadObjectCommand({ Bucket, Key: objectOf(workspaceId, object) }))).ContentLength ?? null; }
      catch (error) { if (runtimeObjectMissing(error)) return null; throw error; }
    },
    async delete(workspaceId, object) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: objectOf(workspaceId, object) }));
    },
    async prune(workspaceId) {
      const Prefix = checkpointPrefix(workspaceId);
      let ContinuationToken: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken, MaxKeys: 1000 }));
        for (const object of page.Contents ?? [])
          if (object.Key?.startsWith(Prefix)) await client.send(new DeleteObjectCommand({ Bucket, Key: object.Key }));
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken);
    },
  };
}

const purpose = "zeros-cloud-v2-checkpoint-key-v1";
const Envelope = z.object({ version: z.literal(1), keyVersion: z.number().int().positive(),
  nonce: z.string().max(32), ciphertext: z.string().max(128), authTag: z.string().max(32) }).strict();
export type CheckpointKeyEnvelope = z.infer<typeof Envelope>;
function sealingKey(keys: CloudAgentCredentialKeys, version: number): Buffer {
  const encoded = keys.keys[version];
  if (!encoded) throw new Error("Checkpoint key unavailable");
  const root = Buffer.from(encoded, "base64url");
  try {
    if (root.length !== 32 || root.toString("base64url") !== encoded) throw new Error("Invalid checkpoint sealing key");
    return Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), purpose, 32));
  } finally { root.fill(0); }
}
const aad = (workspaceId: string, object: string, version: number) =>
  Buffer.from(JSON.stringify([purpose, workspaceId.toLowerCase(), objectOf(workspaceId, object), version]));

/** The data key, bound to its workspace and object. */
export function sealCheckpointKey(key: Buffer, workspaceId: string, object: string, keys: CloudAgentCredentialKeys): CheckpointKeyEnvelope {
  if (key.length !== 32) throw new Error("Invalid checkpoint key");
  const version = keys.currentKeyVersion, cipherKey = sealingKey(keys, version);
  try {
    const envelope = sealCredentialBytes(key, aad(workspaceId, object, version), cipherKey);
    return { version: 1, keyVersion: version, nonce: envelope.nonce.toString("base64url"),
      ciphertext: envelope.ciphertext.toString("base64url"), authTag: envelope.authTag.toString("base64url") };
  } finally { cipherKey.fill(0); }
}

export function openCheckpointKey(value: unknown, workspaceId: string, object: string, keys: CloudAgentCredentialKeys): Buffer {
  const envelope = Envelope.parse(value), cipherKey = sealingKey(keys, envelope.keyVersion);
  try {
    const key = openCredentialBytes({ nonce: Buffer.from(envelope.nonce, "base64url"), ciphertext: Buffer.from(envelope.ciphertext, "base64url"),
      authTag: Buffer.from(envelope.authTag, "base64url") }, aad(workspaceId, object, envelope.keyVersion), cipherKey);
    if (key.length !== 32) { key.fill(0); throw new Error("Invalid checkpoint key"); }
    return key;
  } finally { cipherKey.fill(0); }
}
