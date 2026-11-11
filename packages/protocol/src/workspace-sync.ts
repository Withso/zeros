import { z } from "zod";

/** Order 3 (CONTRACT.md section 12): a one-way mirror of a cloud checkout into
 * a folder on a Mac. Worker ops on the app's cloud bridge; cloud always wins. */
export const SYNC_FEATURE = "sync-v1";
export const SYNC_CAPABILITY = "workspace-sync-v1";
/** On the worker's ENGINE_READY to a sync socket: `sync.readBatch` is served. An older worker never says it, and the Mac reads files one by one. */
export const SYNC_BATCH_CAPABILITY = "sync-batch-v1";
export const SYNC_LIMITS = {
  fileBytes: 100 * 1024 * 1024,
  totalBytes: 5 * 1024 * 1024 * 1024,
  totalFiles: 200_000,
  /** `.context/`'s own budget, in walk order, so a huge one cannot stop the rest of the sync. */
  contextFiles: 20_000,
  contextBytes: 1024 * 1024 * 1024,
  chunkBytes: 4 * 1024 * 1024,
  pageEntries: 2_000,
  retainedDeltas: 2_000,
  pathChars: 4_096,
  /** A sync socket is re-authorized at least this often, or the worker closes it. */
  renewMs: 10 * 60_000,
  bundleLifetimeMs: 10 * 60_000,
  /** sync.readBatch: files up to this size go in batches; a reply carries at most this many raw bytes (base64 stays well under a 16 MiB frame). */
  batchFileBytes: 1024 * 1024,
  batchBytes: 4 * 1024 * 1024,
  batchFiles: 512,
  /** Requests a Mac keeps in flight on its sync socket. */
  inFlight: 6,
  /** A transfer keeps the VM awake this long after its last read, for at most this long in one continuous run. */
  transferActivityMs: 60_000,
  transferActivityCapMs: 30 * 60_000,
} as const;

/** The Mac's direct socket through Boat's protected route (not the control-plane relay). */
export const SYNC_BRIDGE_PATH = "/v2/worker/sync";
export const SYNC_BRIDGE_PROTOCOL = "zeros.worker.sync.v1";
/** The worker answers a passive sync client only these. */
export const SYNC_PASSIVE_OPS = ["sync.snapshot", "sync.read", "sync.readBatch", "sync.bootstrap", "sync.bundleRead"] as const;
/** The passive ops that move bytes: a recent one keeps the VM awake (CONTRACT.md 12, 2026-11-11 amendment). */
export const SYNC_TRANSFER_OPS: ReadonlySet<string> = new Set(["sync.read", "sync.readBatch", "sync.bundleRead"]);

/** `POST /v1/cloud-v2/workspaces/:id/sync/grant` (D+H) reply: the route base, its port-auth value and a
 * single-use Ed25519 grant (claims iss, aud, boot, iat, exp <= 60 s, jti, scope "sync", sub, dev). */
export const SyncGrantReplySchema = z.object({
  url: z.string().url().refine(value => { try { const url = new URL(value); return url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password; } catch { return false; } }, "Invalid route"),
  portAuth: z.string().regex(/^[A-Za-z0-9._~+/=-]{16,8192}$/),
  grant: z.string().regex(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/).max(4096),
  expiresAt: z.string().datetime(),
}).strict();
export type SyncGrantReply = z.infer<typeof SyncGrantReplySchema>;
/** The only frame on the sync socket that is not a bridge message: a fresh grant for the same user and device. */
export const SyncRenewFrameSchema = z.object({ t: z.literal("renew"), grant: SyncGrantReplySchema.shape.grant }).strict();

/** Code points HFS+ ignores in names, which Git itself strips before comparing with `.git` (is_hfs_dotgit). */
const HFS_IGNORABLE = /[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/g;
/** A name as a case-insensitive, normalizing volume (APFS, HFS+, NTFS) sees it: NFC, ignorables stripped,
 * lowercased, NTFS's trailing dots and spaces dropped. */
const volumeName = (part: string) => part.normalize("NFC").replace(HFS_IGNORABLE, "").toLowerCase().replace(/[. ]+$/, "");
/** `.git` in any spelling such a volume or Git treats as the same, including NTFS's short name `git~1`. */
const isGitName = (part: string) => { const name = volumeName(part); return name === ".git" || name === "git~1"; };
const isSyncMetaName = (part: string) => volumeName(part) === ".zeros-sync";

/** A checkout-relative POSIX path: never absolute, `..`, empty segments, NUL,
 * any spelling of `.git` in any component, or the Mac's own `.zeros-sync` as
 * the first. Both sides enforce it (an APFS Mac would open `.GIT` as `.git`). */
export function isSyncPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > SYNC_LIMITS.pathChars || value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/")) return false;
  const parts = value.split("/");
  return parts.every(part => part !== "" && part !== "." && part !== ".." && !isGitName(part)) && !isSyncMetaName(parts[0]!);
}
/** A symlink is mirrored only when its target is relative and, judged
 * lexically from the link's own directory, stays inside the root (never the
 * root itself, never `.git`). The worker and the Mac apply the same rule. */
export function isSyncLinkTarget(linkPath: string, target: string): boolean {
  if (!target || target.length > SYNC_LIMITS.pathChars || target.startsWith("/") || target.includes("\0") || target.includes("\\")) return false;
  const stack: string[] = linkPath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (!stack.length) return false; stack.pop(); continue; }
    stack.push(part);
  }
  return stack.length > 0 && !stack.some(isGitName) && !isSyncMetaName(stack[0]!);
}
const path = z.string().refine(isSyncPath, "Invalid sync path");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const gitSha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
/** A branch name Git would accept, bounded; never a path outside refs/heads. */
const branch = z.string().min(1).max(255).regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[^\s~^:?*[\\\x00-\x1f\x7f]+$/).refine(value => !value.endsWith(".lock") && !value.endsWith("/") && !value.endsWith(".") && !value.startsWith("/"));

export const SyncEntrySchema = z.object({
  path,
  size: z.number().int().min(0).max(SYNC_LIMITS.fileBytes),
  /** Permission bits only (0o777). */
  mode: z.number().int().min(0).max(0o777),
  mtimeMs: z.number().nonnegative(),
  /** Of the bytes, or of the link target for a symlink. */
  sha256,
  /** A relative link target that resolves inside the checkout. */
  symlink: z.string().min(1).max(SYNC_LIMITS.pathChars).optional(),
}).strict();
export type SyncEntry = z.infer<typeof SyncEntrySchema>;

export const SYNC_RESYNC_REASONS = ["unknown_epoch", "retention_gap", "page_expired"] as const;
/** context_limit: reported once, as path `.context`, when its budget was spent. */
export const SYNC_SKIP_REASONS = ["too_large", "symlink_outside", "unsupported", "context_limit"] as const;
export const SYNC_STOP_REASONS = ["too_many_files", "too_many_bytes"] as const;

export const SyncSnapshotRequestSchema = z.object({
  epoch: z.string().uuid().optional(),
  seq: z.number().int().nonnegative().optional(),
  /** The next page of a frozen full inventory. */
  page: z.string().min(1).max(256).optional(),
}).strict();
export type SyncSnapshotRequest = z.infer<typeof SyncSnapshotRequestSchema>;

export const SyncSnapshotReplySchema = z.object({
  epoch: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  /** A full inventory page (replaces the Mac's view once its last page lands). */
  full: z.array(SyncEntrySchema).max(SYNC_LIMITS.pageEntries).optional(),
  changes: z.array(SyncEntrySchema).max(SYNC_LIMITS.pageEntries).optional(),
  deletes: z.array(path).max(SYNC_LIMITS.pageEntries).optional(),
  resyncReason: z.enum(SYNC_RESYNC_REASONS).optional(),
  nextPage: z.string().min(1).max(256).optional(),
  skipped: z.array(z.object({ path, reason: z.enum(SYNC_SKIP_REASONS) }).strict()).max(SYNC_LIMITS.pageEntries).optional(),
  stopped: z.enum(SYNC_STOP_REASONS).optional(),
  /** The checkout's branch and HEAD; a change makes the Mac fetch a new bundle. Absent when detached. */
  head: z.object({ branch, sha: gitSha }).strict().optional(),
}).strict().refine(value => !(value.full && (value.changes || value.deletes)), "A reply is either a full page or changes")
  .refine(value => !value.nextPage || value.full, "Only a full inventory pages");
export type SyncSnapshotReply = z.infer<typeof SyncSnapshotReplySchema>;

/** File bytes for sync, bound to the content the inventory named. */
export const SyncReadRequestSchema = z.object({
  path, sha256,
  offset: z.number().int().min(0).max(SYNC_LIMITS.fileBytes),
  length: z.number().int().min(1).max(SYNC_LIMITS.chunkBytes),
}).strict();
export type SyncReadRequest = z.infer<typeof SyncReadRequestSchema>;
export const SyncReadReplySchema = z.object({ bytes: z.number().int().min(0).max(SYNC_LIMITS.chunkBytes), base64: z.string() }).strict();

/** Several whole small files in one round trip (sync-batch-v1), each bound to the inventory's sha256. */
export const SyncReadBatchRequestSchema = z.object({
  files: z.array(z.object({ path, sha256 }).strict()).min(1).max(SYNC_LIMITS.batchFiles),
}).strict();
export type SyncReadBatchRequest = z.infer<typeof SyncReadBatchRequestSchema>;
/** Answers a prefix of the request, in order, within batchBytes; the Mac asks again for the rest.
 * A file that no longer matches its sha256 (or is not a small regular file) says `changed`. */
export const SyncReadBatchReplySchema = z.object({
  entries: z.array(z.union([
    z.object({ path, bytes: z.number().int().min(0).max(SYNC_LIMITS.batchFileBytes), base64: z.string() }).strict(),
    z.object({ path, changed: z.literal(true) }).strict(),
  ])).max(SYNC_LIMITS.batchFiles),
}).strict();
export type SyncReadBatchReply = z.infer<typeof SyncReadBatchReplySchema>;

const HOST = "[A-Za-z0-9][A-Za-z0-9.-]*", PORT = "(?::[0-9]{1,5})?", REPO_PATH = "[A-Za-z0-9._~][A-Za-z0-9._~/-]*";
const SAFE_REMOTE = [
  new RegExp(`^https://${HOST}${PORT}/${REPO_PATH}$`),
  new RegExp(`^ssh://(?:git@)?${HOST}${PORT}/${REPO_PATH}$`),
  new RegExp(`^git@${HOST}:${REPO_PATH}$`),
];
/** A remote the Mac may write as origin: credential-free https, ssh (optionally as git@), or scp-like git@host:path.
 * Never another transport (ext::, file:, fd::, http), userinfo, query, whitespace or a leading dash. */
export function isSafeRemoteUrl(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2048 && SAFE_REMOTE.some(pattern => pattern.test(value));
}

/** Git history for the Mac's real clone: a bundle of the branch (full, or from `have` when that is an ancestor). */
export const SyncBootstrapRequestSchema = z.object({ have: gitSha.optional() }).strict();
export const SyncBootstrapReplySchema = z.object({
  branch, head: gitSha,
  /** The origin URL without credentials; anything unsafe reads as null (origin left unset). */
  remoteUrl: z.string().max(2048).nullable().transform(value => isSafeRemoteUrl(value) ? value : null).catch(null),
  /** Absent when `have` is already HEAD. */
  bundle: z.object({ id: z.string().uuid(), size: z.number().int().positive().max(SYNC_LIMITS.totalBytes), sha256, full: z.boolean() }).strict().optional(),
  stopped: z.enum(SYNC_STOP_REASONS).optional(),
}).strict();
export type SyncBootstrapReply = z.infer<typeof SyncBootstrapReplySchema>;
export const SyncBundleReadRequestSchema = z.object({
  id: z.string().uuid(), offset: z.number().int().min(0).max(SYNC_LIMITS.totalBytes), length: z.number().int().min(1).max(SYNC_LIMITS.chunkBytes),
}).strict();

/** 12.z: GET /v1/cloud-v2/devices/:deviceId/connections (D+H for this device, X-Zeros-Sync-Wanted: 1): this
 * registration's live connections with the person's wanted state, 200 per keyset page. Read leniently. */
export const DeviceSyncConnectionSchema = z.object({
  workspaceId: z.string().uuid(),
  repository: z.string().min(3).max(201).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  number: z.number().int().positive().nullable(),
  name: z.string().min(1).max(120),
  syncWanted: z.boolean(),
  syncing: z.boolean().optional(),
}).passthrough();
export const DeviceSyncConnectionsReplySchema = z.object({
  connections: z.array(DeviceSyncConnectionSchema).max(200),
  nextCursor: z.string().uuid().nullable(),
}).passthrough();

/** The worker's live hint to passive clients after a debounced batch. */
export const SYNC_HINT_KIND = "workspaceSync";
