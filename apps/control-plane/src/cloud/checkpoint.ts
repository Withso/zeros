// Workspace checkpoints. Boat deletes a stopped VM's disk after 14 days, so
// every stop saves what the workspace needs to come back on a new VM, as one
// encrypted object in our own storage, kept until the workspace is deleted:
// - the workspace repository's Git state: branches, local commits, stashes,
//   the index and every tracked or untracked file that is not ignored, plus
//   small ignored files outside ignored directories (such as `.env.local`);
// - the worker's state and the agents' session files.
// Ignored directories (dependencies, build outputs) come back from the Cloud
// Computer and the setup script instead. The VM builds and uploads the object
// itself through a short-lived presigned URL; the data key exists only in the
// command and sealed in the database.
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { hkdfSync } from "node:crypto";
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
const IGNORED_FILE_BYTES = 1024 * 1024, IGNORED_TOTAL_BYTES = 32 * 1024 * 1024;

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
    "export GIT_TERMINAL_PROMPT=0 GIT_AUTHOR_NAME=Zeros GIT_AUTHOR_EMAIL=checkpoint@zeros.invalid GIT_COMMITTER_NAME=Zeros GIT_COMMITTER_EMAIL=checkpoint@zeros.invalid",
    "command -v node || { step=node; fail checkpoint_failed; }",
    "mkdir -p \"$home/.cache\"",
    `work=$(mktemp -d "$home/.cache/zeros-${kind}.XXXXXX")`,
    `printf %s ${quote(b64(STREAM))} | base64 -d > "$work/stream.mjs"`,
  ];
}

/** Builds `$work/checkpoint.zck` and sets `bytes` and `sha`. The worker must
 * not be running: its sessions and the repository must be quiet. */
export function checkpointArchiveSteps(input: CheckpointPaths & { baseBranch: string; key: Buffer; maxBytes?: number }): string[] {
  // Quoted for the shell and always prefixed for Git; only option-like or
  // multi-line names are refused.
  if (!/^[^\0\r\n]{1,255}$/.test(input.baseBranch) || input.baseBranch.startsWith("-")) throw new Error("Invalid checkpoint base branch");
  const maxBytes = input.maxBytes ?? CLOUD_V2_CHECKPOINT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > CLOUD_V2_CHECKPOINT_MAX_BYTES) throw new Error("Invalid checkpoint limit");
  return [
    ...prologue("checkpoint", [...paths(input), `base=${quote(input.baseBranch)}`]),
    `printf %s ${quote(dataKey(input.key))} > "$work/key"`,
    "c=\"$work/c\"; mkdir \"$c\"; m=\"$c/manifest\"; printf 'zeros-checkpoint 1\\n' > \"$m\"",
    "step=repository",
    "if [ -d \"$repo\" ] && top=$(git -C \"$repo\" rev-parse --show-toplevel) && [ \"$(cd \"$repo\" && pwd -P)\" = \"$(cd \"$top\" && pwd -P)\" ]; then",
    "  cd \"$repo\"; cleanup_refs=1",
    "  head=$(git rev-parse -q --verify 'HEAD^{commit}' || true)",
    "  if ref=$(git symbolic-ref -q HEAD); then printf 'head ref %s\\n' \"$ref\" >> \"$m\"",
    "  elif [ -n \"$head\" ]; then printf 'head detached %s\\n' \"$head\" >> \"$m\"; fi",
    "  if [ -n \"$head\" ]; then printf 'commit %s\\n' \"$head\" >> \"$m\"; git update-ref refs/zeros-checkpoint/head \"$head\"; fi",
    // The working tree as Git sees it, from a copy of the index so only
    // changed files are hashed again: tracked and untracked, never ignored.
    "  step=worktree",
    "  scratch() { GIT_INDEX_FILE=\"$work/index\" git \"$@\"; }",
    "  index=$(git rev-parse --git-path index)",
    "  if ! { [ -f \"$index\" ] && cp \"$index\" \"$work/index\" && scratch add -A -- .; }; then",
    "    rm -f \"$work/index\"",
    "    if [ -n \"$head\" ]; then scratch read-tree \"$head\"; else scratch read-tree --empty; fi",
    "    scratch add -A -- .",
    "  fi",
    "  tree=$(scratch write-tree)",
    "  parent=(); if [ -n \"$head\" ]; then parent=(-p \"$head\"); fi",
    // A conflicted index has no tree; the restore then shows every change as unstaged.
    "  if staged=$(git write-tree); then",
    "    staged=$(git commit-tree --no-gpg-sign ${parent[@]+\"${parent[@]}\"} -m zeros-checkpoint-index \"$staged\")",
    "    git update-ref refs/zeros-checkpoint/index \"$staged\"; printf 'index %s\\n' \"$staged\" >> \"$m\"; parent=(-p \"$staged\")",
    "  fi",
    "  files=$(git commit-tree --no-gpg-sign ${parent[@]+\"${parent[@]}\"} -m zeros-checkpoint-worktree \"$tree\")",
    "  git update-ref refs/zeros-checkpoint/worktree \"$files\"; printf 'worktree %s\\n' \"$files\" >> \"$m\"",
    "  step=refs",
    "  git for-each-ref --format='branch %(objectname) %(refname)' refs/heads >> \"$m\"",
    "  while read -r name remote merge; do",
    "    if [ -n \"$remote\" ] && [ -n \"$merge\" ]; then printf 'upstream %s %s %s\\n' \"$name\" \"$remote\" \"$merge\" >> \"$m\"; fi",
    "  done < <(git for-each-ref --format='%(refname) %(upstream:remotename) %(upstream:remoteref)' refs/heads)",
    "  step=stash; n=0",
    "  while read -r sha subject; do",
    "    git update-ref \"refs/zeros-checkpoint/stash-$n\" \"$sha\"; n=$((n + 1))",
    "    printf 'stash %s %s\\n' \"$sha\" \"$(printf %s \"${subject:-stash}\" | base64 -w0)\" >> \"$m\"",
    "  done < <(git log -g --format='%H %gs' refs/stash 2>/dev/null || true)",
    // Objects the base branch already has stay out; a new Cloud Computer has them.
    "  step=bundle",
    "  negative=(); if git rev-parse -q --verify \"refs/remotes/origin/$base^{commit}\"; then negative=(--not \"refs/remotes/origin/$base\"); fi",
    "  git bundle create \"$c/repo.bundle\" --branches --glob=refs/zeros-checkpoint ${negative[@]+\"${negative[@]}\"}",
    "  step=ignored; total=0",
    "  while IFS= read -r -d '' path; do",
    "    case \"$path\" in */) continue ;; esac",
    "    if [ -f \"$path\" ] && [ ! -L \"$path\" ]; then",
    "      size=$(stat -c %s -- \"$path\")",
    `      if [ "$size" -le ${IGNORED_FILE_BYTES} ] && [ $((total + size)) -le ${IGNORED_TOTAL_BYTES} ]; then total=$((total + size)); printf '%s\\0' "$path" >> "$work/ignored"; fi`,
    "    fi",
    "  done < <(git ls-files -z --others --ignored --exclude-standard --directory)",
    "  if [ -s \"$work/ignored\" ]; then tar --null --verbatim-files-from --no-recursion -T \"$work/ignored\" -cf \"$c/ignored.tar\"; fi",
    "fi",
    "step=sessions",
    "cd \"$home\"; set --",
    `for p in ${SESSION_PATHS.map(quote).join(" ")}; do if [ -e "$p" ] && [ ! -L "$p" ]; then set -- "$@" "$p"; fi; done`,
    "if [ $# -gt 0 ]; then",
    "  tar -cf \"$c/home.tar\" --exclude=\"$state/workspace-setup\" --exclude=\"$state/github.sock\" --exclude=\"$state/restored-from-checkpoint\" \\",
    "    --exclude='.credentials.json' --exclude='auth.json' --warning=no-file-changed --warning=no-file-removed --ignore-failed-read \"$@\" || [ $? -eq 1 ]",
    "fi",
    "step=pack",
    "(cd \"$c\" && tar -cf - .) | gzip -1 > \"$work/plain\"; rm -rf \"$c\"",
    `if [ "$(stat -c %s "$work/plain")" -gt ${maxBytes} ]; then fail checkpoint_too_large; fi`,
    "step=encrypt",
    "node \"$work/stream.mjs\" encrypt \"$work/key\" \"$work/plain\" \"$work/checkpoint.zck\"; rm -f \"$work/plain\" \"$work/key\"",
    "bytes=$(stat -c %s \"$work/checkpoint.zck\"); sha=$(sha256sum \"$work/checkpoint.zck\" | cut -c1-64)",
  ];
}

/** Stops the worker, builds the checkpoint and uploads it. */
export function checkpointCommand(input: CheckpointPaths & { baseBranch: string; key: Buffer; uploadUrl: string; maxBytes?: number }): string {
  const url = https(input.uploadUrl);
  const script = [
    ...checkpointArchiveSteps(input),
    "step=upload",
    `curl -fsS --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 420 -T "$work/checkpoint.zck" ${quote(url)} || fail checkpoint_upload_failed`,
    "report \"zeros-checkpoint-saved bytes=$bytes sha256=$sha\"",
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
    "branch() { [[ \"$1\" == refs/heads/* ]] && git check-ref-format \"$1\" || fail checkpoint_corrupt; }",
    // Network only when the Cloud Computer lacks a commit the checkpoint needs.
    ...(token ? [
      `printf %s ${quote(b64(token))} | base64 -d > "$work/token"`,
      "printf '#!/bin/sh\\ncase \"$1\" in Username*) echo x-access-token ;; *) cat \"%s\" ;; esac\\n' \"$work/token\" > \"$work/askpass\"; chmod 700 \"$work/askpass\"",
      "remote_git() { GIT_ASKPASS=\"$work/askpass\" git -c credential.helper= \"$@\"; }",
    ] : ["remote_git() { git -c credential.helper= \"$@\"; }"]),
    "fetched=''",
    "need() {",
    "  hex \"$1\"; if git cat-file -e \"$1^{commit}\"; then return 0; fi",
    "  if [ -z \"$fetched\" ]; then fetched=1; remote_git fetch -q origin || true; fi",
    "  git cat-file -e \"$1^{commit}\" || remote_git fetch -q origin \"$1\" || true",
    "  git cat-file -e \"$1^{commit}\" || fail checkpoint_prerequisites_missing",
    "}",
    "step=sessions",
    "if [ -f \"$c/home.tar\" ]; then tar -xf \"$c/home.tar\" -C \"$home\" --no-same-owner; fi",
    "if grep -q '^worktree ' \"$m\"; then",
    "  step=repository",
    "  if ! [ -d \"$repo/.git\" ]; then",
    ...(remote ? [`    remote_git clone -q --no-checkout ${quote(remote)} "$repo" || fail checkpoint_repository_missing`] : ["    fail checkpoint_repository_missing"]),
    "  fi",
    "  cd \"$repo\"",
    "  step=objects",
    "  if [ -f \"$c/repo.bundle\" ]; then",
    "    while read -r sha; do need \"$sha\"; done < <(sed '/^$/q' \"$c/repo.bundle\" | grep -a '^-' | cut -c2- | cut -d' ' -f1)",
    "    git bundle unbundle \"$c/repo.bundle\" || fail checkpoint_corrupt",
    "  fi",
    "  step=refs",
    "  while read -r _ sha name; do hex \"$sha\"; branch \"$name\"; need \"$sha\"; git update-ref \"$name\" \"$sha\"; done < <(grep '^branch ' \"$m\" || true)",
    "  line=$(grep '^head ' \"$m\" || true)",
    "  case \"$line\" in",
    "    'head ref '*) ref=${line#head ref }; branch \"$ref\"; git symbolic-ref HEAD \"$ref\" ;;",
    "    'head detached '*) sha=${line#head detached }; need \"$sha\"; git update-ref --no-deref HEAD \"$sha\" ;;",
    "  esac",
    "  step=files",
    "  worktree=$(awk '$1 == \"worktree\" { print $2 }' \"$m\"); need \"$worktree\"",
    "  git read-tree -u --reset \"$worktree^{tree}\"",
    "  staged=$(awk '$1 == \"index\" { print $2 }' \"$m\")",
    "  if [ -n \"$staged\" ]; then need \"$staged\"; git read-tree \"$staged^{tree}\"",
    "  elif git rev-parse -q --verify 'HEAD^{commit}'; then git read-tree HEAD",
    "  else git read-tree --empty; fi",
    "  git update-index -q --refresh || true",
    "  if [ -f \"$c/ignored.tar\" ]; then tar -xf \"$c/ignored.tar\" -C \"$repo\" --no-same-owner; fi",
    "  step=stash",
    "  while read -r _ sha message; do",
    "    need \"$sha\"; git stash store -q -m \"$(printf %s \"$message\" | base64 -d)\" \"$sha\"",
    "  done < <(grep '^stash ' \"$m\" | tac || true)",
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

export type CheckpointResult = { ok: true; bytes: number; sha256: string } | { ok: false; code: CloudV2CheckpointError };

/** The one result line a checkpoint command prints; anything else is a failure. */
export function parseCheckpointResult(stdout: string): CheckpointResult {
  for (const line of stdout.split(/\r?\n/)) {
    const saved = /^zeros-checkpoint-saved bytes=([1-9][0-9]{0,15}) sha256=([0-9a-f]{64})$/.exec(line);
    if (saved) {
      const bytes = Number(saved[1]);
      if (Number.isSafeInteger(bytes) && bytes <= CLOUD_V2_CHECKPOINT_MAX_BYTES + 64 * 1024 * 1024) return { ok: true, bytes, sha256: saved[2]! };
    }
    const failed = /^zeros-checkpoint-error ([a-z_]+)\b/.exec(line);
    if (failed) return { ok: false, code: errorCode(failed[1]!, "checkpoint_failed") };
  }
  return { ok: false, code: "checkpoint_failed" };
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
  /** Deletes every checkpoint object of the workspace except `keep`. */
  prune(workspaceId: string, keep?: string): Promise<void>;
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
    async prune(workspaceId, keep) {
      const Prefix = checkpointPrefix(workspaceId);
      if (keep !== undefined) objectOf(workspaceId, keep);
      let ContinuationToken: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken, MaxKeys: 1000 }));
        for (const object of page.Contents ?? [])
          if (object.Key && object.Key.startsWith(Prefix) && object.Key !== keep) await client.send(new DeleteObjectCommand({ Bucket, Key: object.Key }));
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
