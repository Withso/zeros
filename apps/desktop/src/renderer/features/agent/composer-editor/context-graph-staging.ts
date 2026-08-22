// ──────────────────────────────────────────────────────────
// context-graph-staging — attachments hit the graph the moment they're staged
// ──────────────────────────────────────────────────────────
//
// The Context tab canvas renders the workspace's `.context-graph/`, and until
// 2026-08-02(2) the graph only learned about an attachment when a SEND
// encoded it. Attach a screenshot, look at the Context tab, see nothing — the
// canvas lagged the composer by one whole prompt. This module closes that
// gap: the composer diffs the set of attachment ids in its document on every
// user edit, and an id that APPEARED is written into the graph immediately
// (bytes come from the composer's side store), so the card shows while the
// user is still typing the prompt.
//
// The graph is APPEND-ONLY from the app (2026-08-03(3), explicit product
// decision): once a file lands in `.context-graph`, NO composer gesture
// deletes it — not removing the chip (×, Backspace, select-all delete), not
// untoggling a transcript pill, not deleting a queued message, not send's
// clear(). The graph is the workspace's context RECORD, and the point of a
// record is that it outlives the composer lifecycle that created it; the only
// way a file leaves the graph is the user deleting it on disk (Finder, an
// editor, `rm`). Between 2026-08-02(2) and 2026-08-03(3) chip removal DID
// unstage (`agent_attachment_remove` IPC, since deleted) — that made "I'm not
// sending this after all" also mean "erase it from the workspace's context",
// which destroyed records the user meant to keep. So the diff acts on ADDS
// only; ids that disappear merely leave the tracking set, and re-attaching
// the same file later mints a fresh id and a fresh record.
//
// The diff (pure, tested) is separate from the IO (fire-and-forget): staging
// must never block or break typing, and a failed write is only a cosmetic gap
// the send-path safety net (encode-attachments.ts) re-covers. Fire-and-forget
// is NOT silent, though — every failed op logs, and the first failure per
// workspace raises a toast (reportStagingFailure). A day of writes rejected
// by a stale main process produced zero user-visible signal on 2026-08-03;
// "the canvas lags" and "the feature is broken" must not look identical.
// Undo/redo work for free — ⌘Z after a removal makes the id reappear, the
// diff sees an ADD, and the side store still holds the bytes (removal
// deliberately keeps them, see removeBySourceKey); the re-write is a same-id
// same-bytes no-op the engine skips without touching mtime.
//
// What deliberately does NOT stage:
//   • programmatic doc swaps — clear() on send, setContent() for drafts and
//     edit seeds, setText(). The hook suppresses the diff around them and
//     resyncs the id set, because those transitions say nothing about user
//     intent toward the FILES (an edit-in-place seed reconstructs sent chips
//     that were staged by their own send).
//   • attachments with no bytes in hand (a reconstructed text chip carries a
//     name but never a body) — nothing to write.
//   • bytes past the validator's hard caps (5 MB images / 4 MB text): such an
//     attachment can never ride a prompt under any model, and pushing tens of
//     MB of base64 through the IPC on a paste would jank the renderer.
// ──────────────────────────────────────────────────────────

import { writeContextAttachment } from "../agent-history-client";
import { utf8ToBase64 } from "../encode-attachments";
import { HARD_TEXT_CAP_BYTES, MAX_IMAGE_BYTES } from "../agent-attachments";
import {
  isWorkspaceProvisioning,
  usePendingWorkspacesStore,
} from "../../../state/pending-workspaces";
import { isNativeRuntime } from "../../../platform/runtime";
import { toast } from "../../../shared/ui/primitives/elements";
import { RECONSTRUCTED_ATTACHMENT_ID_PREFIX } from "./reconstruct";
import type { ComposerAttachment } from "../composer-attachments";

/** What one doc change means for the graph. `nextIds` is the state to carry
 *  into the next diff whether or not any IO happens. Stage-only by design —
 *  the graph is append-only, so a disappearing id plans no IO at all. */
export interface GraphSyncPlan {
  /** Attachments to stage — present in the doc now, absent before, bytes in
   *  the side store. */
  stage: ComposerAttachment[];
  nextIds: ReadonlySet<string>;
}

/** Base64 payload for an attachment, or null when it has nothing stageable:
 *  no bytes in hand, a failed validation verdict, or a body past the hard
 *  caps. */
export function stageablePayload(a: ComposerAttachment): string | null {
  // The send path excludes invalid attachments entirely, so staging one
  // would put a card on the canvas for a file no agent ever received. If a
  // model switch later makes it valid, the send-path safety net stages it
  // with the prompt that actually carries it.
  if (!a.validation.ok) return null;
  if (a.kind === "image") {
    if (!a.data) return null;
    // base64 length ≈ bytes × 4⁄3 — compare in decoded bytes.
    if (Math.floor((a.data.length * 3) / 4) > MAX_IMAGE_BYTES) return null;
    return a.data;
  }
  if (!a.text) return null;
  // Byte length, not string length — transcripts are full of multi-byte
  // punctuation (same reasoning as insertTextAttachment's validation).
  if (new TextEncoder().encode(a.text).length > HARD_TEXT_CAP_BYTES)
    return null;
  return utf8ToBase64(a.text);
}

/** Diff the doc's attachment ids against the previous set. Pure — the caller
 *  owns when to run it (user edits only) and what to do with the plan. */
export function planGraphSync(
  prevIds: ReadonlySet<string>,
  presentIds: readonly string[],
  lookup: (id: string) => ComposerAttachment | undefined,
): GraphSyncPlan {
  const next = new Set(presentIds);
  const stage: ComposerAttachment[] = [];
  for (const id of next) {
    if (prevIds.has(id)) continue;
    // A reconstructed chip is an already-SENT file under a fresh id — its
    // graph record exists under the original id, and belongs to the send,
    // not to this edit session. Staging it would duplicate that record.
    if (id.startsWith(RECONSTRUCTED_ATTACHMENT_ID_PREFIX)) continue;
    const a = lookup(id);
    if (a) stage.push(a);
  }
  return { stage, nextIds: next };
}

/** Stage-only sweep of everything currently in the doc — the SEED sync, i.e.
 *  the diff run against an empty previous set.
 *
 *  Runs where a document arrives whole instead of by user edits: the mount of
 *  a restored draft, setContent() for a draft/edit seed, and the moment a
 *  provisioning worktree lands on disk. Those documents can hold attachments
 *  whose graph record doesn't exist yet — above all the new-workspace
 *  dispatcher's seed, whose surface deliberately never stages (its cwd is the
 *  trunk) and whose send may be minutes away behind setup + agent spawn. The
 *  graph write is idempotent (the engine skips byte-identical re-writes
 *  without touching mtime), so re-sweeping an
 *  already-staged draft is a cheap no-op, and it doubles as self-heal for a
 *  record lost to a crashed write or an externally pruned folder. */
export function planSeedStage(
  presentIds: readonly string[],
  lookup: (id: string) => ComposerAttachment | undefined,
): GraphSyncPlan {
  return planGraphSync(new Set<string>(), presentIds, lookup);
}

/** True when a staging-IPC failure reads like renderer/main BUILD SKEW: a
 *  long-lived dev instance keeps yesterday's main process while Vite
 *  hot-reloads today's renderer, so the renderer speaks a command set the
 *  main doesn't have. The two signatures are the exact errors an old main
 *  returns for this feature — an unknown `agent_attachment_*` command, or
 *  the pre-context-graph write handler demanding its required `chatId`.
 *  Every op fails identically until the app restarts, so the toast should
 *  say the one thing that fixes it. */
export function isBuildSkewFailure(message: string): boolean {
  return (
    /unknown command "agent_attachment_/i.test(message) ||
    /missing required string 'chatId'/i.test(message)
  );
}

/** Workspaces whose staging failure has already been announced this session —
 *  a paste burst or a doomed retry loop must cost one toast, not a stack. */
const notifiedFailureCwds = new Set<string>();

/** Attachments accepted before `git worktree add` owns the prepared path.
 * Keyed by cwd + attachment id so concurrent workspace creates stay isolated
 * and repeated attach-time sweeps collapse onto the same durable record. */
interface QueuedContextGraphWrite {
  attachmentId: string;
  base64: string;
  mimeType: string;
  filename: string;
}

const queuedProvisioningWrites = new Map<
  string,
  Map<string, QueuedContextGraphWrite>
>();

/** Test-only: clear the once-per-workspace toast latch. */
export function resetStagingFailureNoticesForTests(): void {
  notifiedFailureCwds.clear();
}

/** Test-only: prevent queued fixtures from crossing test boundaries. */
export function resetQueuedContextGraphWritesForTests(): void {
  queuedProvisioningWrites.clear();
}

/** A failed prepared create must never flush into its now-unowned reserved
 * path. The create rollback calls this before dropping the provisioning key. */
export function discardQueuedContextGraphWrites(cwd: string): void {
  queuedProvisioningWrites.delete(cwd);
}

/** A staging op failed. Always logged (the renderer console rides the app's
 *  structured log, so this is greppable in app.jsonl); toasted once per
 *  workspace per session when native notifications exist. Browser development
 *  and optional relay clients stay silent; inline blocks still carry delivery. */
function reportStagingFailure(
  cwd: string,
  filename: string,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    `[Zeros] context-graph staging failed in ${cwd} for "${filename}": ${message}`,
  );
  if (!isNativeRuntime()) return;
  if (notifiedFailureCwds.has(cwd)) return;
  notifiedFailureCwds.add(cwd);
  toast.error(`"${filename}" couldn't be added to the context graph`, {
    id: `context-graph-staging:${cwd}`,
    description: isBuildSkewFailure(message)
      ? "Zeros' background process is running an older build — quit and relaunch the app, then attach the file again."
      : message,
  });
}

function writeStagedAttachment(
  cwd: string,
  write: QueuedContextGraphWrite,
): void {
  // Promise.resolve() so a SYNCHRONOUS throw from the IPC façade reaches the
  // same reporter as an async rejection — silent-catch was how a full day of
  // skew-rejected writes went unnoticed.
  void Promise.resolve()
    .then(() =>
      writeContextAttachment({
        cwd,
        ...write,
      }),
    )
    .catch((err) => reportStagingFailure(cwd, write.filename, err));
}

function flushQueuedContextGraphWrites(cwd: string): void {
  if (isWorkspaceProvisioning(cwd)) return;
  const queued = queuedProvisioningWrites.get(cwd);
  if (!queued) return;
  // Detach the batch before dispatch so another attachment arriving while an
  // async write is in flight forms the next exact batch instead of mutating
  // the collection being iterated.
  queuedProvisioningWrites.delete(cwd);
  for (const attachment of queued.values()) {
    writeStagedAttachment(cwd, attachment);
  }
}

// A prepared path can accept composer input before it exists. Zustand
// publishes finishPendingCreate synchronously; flush only the exact paths that
// left provisioning, leaving every concurrently-created workspace isolated.
usePendingWorkspacesStore.subscribe((state, previous) => {
  if (state.creates === previous.creates) return;
  const stillProvisioning = new Set(
    state.creates.flatMap((create) => (create.path ? [create.path] : [])),
  );
  for (const create of previous.creates) {
    if (create.path && !stillProvisioning.has(create.path)) {
      flushQueuedContextGraphWrites(create.path);
    }
  }
});

/** Execute a plan against the workspace graph. Fire-and-forget on every axis:
 *  each write is independently caught and never awaited — unavailable IPC or
 *  a read-only disk must not break typing, and the send-path safety net
 *  re-covers a failed write. Each write that lands notifies the graph-change
 *  signal itself (agent-history-client), which the Context tab and the git
 *  refresh bus both subscribe to — so visibility needs nothing further here.
 *  Concurrent writes for the same id need no ordering: writes are the ONLY
 *  op (the graph is append-only) and a given id always carries the same
 *  bytes, so every interleaving settles on the same file.
 *
 *  A PROVISIONING cwd is queued: the dispatcher reserves the worktree path
 *  before `git worktree add` creates it, and a stage write in that window
 *  would mkdir `.context-graph/` into the reserved path — worktree add refuses
 *  a non-empty directory, so the write wouldn't just be early, it would fail
 *  creation itself. Holding the attachment object here (rather than relying
 *  only on a later document sweep) also survives chip removal, chat parking,
 *  and composer unmount before the checkout lands. */
export function executeGraphSync(cwd: string, plan: GraphSyncPlan): void {
  for (const a of plan.stage) {
    const base64 = stageablePayload(a);
    if (!base64) continue;
    let queued = queuedProvisioningWrites.get(cwd);
    if (!queued) {
      queued = new Map();
      queuedProvisioningWrites.set(cwd, queued);
    }
    // Attachment ids are immutable graph identities. Preserve the exact first
    // accepted payload: a later model-validation sweep must not overwrite it
    // with an invalid view while the checkout is still landing.
    if (!queued.has(a.id)) {
      queued.set(a.id, {
        attachmentId: a.id,
        base64,
        mimeType: a.mimeType,
        filename: a.name,
      });
    }
  }
  flushQueuedContextGraphWrites(cwd);
}
