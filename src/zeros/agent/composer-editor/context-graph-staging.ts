// ──────────────────────────────────────────────────────────
// context-graph-staging — attachments hit the graph the moment they're staged
// ──────────────────────────────────────────────────────────
//
// The Context tab canvas renders the workspace's `.context-graph/`, and until
// 2026-08-02(2) the graph only learned about an attachment when a SEND
// encoded it. Attach a screenshot, look at the Context tab, see nothing — the
// canvas lagged the composer by one whole prompt. This module closes that
// gap: the composer diffs the set of attachment ids in its document on every
// user edit, and
//
//   • an id that APPEARED is written into the graph immediately (bytes come
//     from the composer's side store), so the card shows while the user is
//     still typing the prompt;
//   • an id that DISAPPEARED is deleted from the graph's private scope — the
//     canvas has no delete affordance, so without this a mis-attached file
//     would squat on it forever. `shared/` is never touched, and the engine
//     refuses ids outside `local/attachments/<id>/`.
//
// The diff (pure, tested) is separate from the IO (fire-and-forget): staging
// must never block or break typing, and a failed write is only a cosmetic gap
// the send-path safety net (encode-attachments.ts) re-covers. Undo/redo work
// for free — ⌘Z after a removal makes the id reappear, the diff sees an ADD,
// and the side store still holds the bytes (removal deliberately keeps them,
// see removeBySourceKey) so the file is re-staged.
//
// What deliberately does NOT stage or unstage:
//   • programmatic doc swaps — clear() on send, setContent() for drafts and
//     edit seeds, setText(). The hook suppresses the diff around them and
//     resyncs the id set, because those transitions say nothing about user
//     intent toward the FILES (a send must keep its record; an edit-in-place
//     seed reconstructs sent chips whose record must survive a cancel).
//   • attachments with no bytes in hand (a reconstructed text chip carries a
//     name but never a body) — nothing to write, and unstaging them could
//     only delete some other lifecycle's record, so both sides skip them.
//   • bytes past the validator's hard caps (5 MB images / 4 MB text): such an
//     attachment can never ride a prompt under any model, and pushing tens of
//     MB of base64 through the IPC on a paste would jank the renderer.
// ──────────────────────────────────────────────────────────

import {
  removeContextAttachment,
  writeContextAttachment,
} from "../agent-history-client";
import { utf8ToBase64 } from "../encode-attachments";
import {
  HARD_TEXT_CAP_BYTES,
  MAX_IMAGE_BYTES,
} from "../agent-attachments";
import { isWorkspaceProvisioning } from "../../store/pending-workspaces";
import { RECONSTRUCTED_ATTACHMENT_ID_PREFIX } from "./reconstruct";
import type { ComposerAttachment } from "../composer-attachments";

/** What one doc change means for the graph. `nextIds` is the state to carry
 *  into the next diff whether or not any IO happens. */
export interface GraphSyncPlan {
  /** Attachments to stage — present in the doc now, absent before, bytes in
   *  the side store. */
  stage: ComposerAttachment[];
  /** Ids to unstage — gone from the doc, previously present, and still owned
   *  by this composer's lifecycle (bytes in the side store). */
  unstage: string[];
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
    // not to this edit session. Neither staged nor (below) unstaged.
    if (id.startsWith(RECONSTRUCTED_ATTACHMENT_ID_PREFIX)) continue;
    const a = lookup(id);
    if (a) stage.push(a);
  }
  const unstage: string[] = [];
  for (const id of prevIds) {
    if (next.has(id)) continue;
    if (id.startsWith(RECONSTRUCTED_ATTACHMENT_ID_PREFIX)) continue;
    // Only ids the side store still owns. After a send, clear() empties the
    // store — so chips resurrected by ⌘Z and deleted again can't unstage the
    // sent message's graph record.
    if (lookup(id)) unstage.push(id);
  }
  return { stage, unstage, nextIds: next };
}

/** Stage-only plan for everything currently in the doc — the SEED sync.
 *
 *  Runs where a document arrives whole instead of by user edits: the mount of
 *  a restored draft, setContent() for a draft/edit seed, and the moment a
 *  provisioning worktree lands on disk. Those documents can hold attachments
 *  whose graph record doesn't exist yet — above all the new-workspace
 *  dispatcher's seed, whose surface deliberately never stages (its cwd is the
 *  trunk) and whose send may be minutes away behind setup + agent spawn. The
 *  graph write is idempotent (same id ⇒ same bytes; the engine skips
 *  same-size re-writes without touching mtime), so re-sweeping an
 *  already-staged draft is a cheap no-op, and it doubles as self-heal for a
 *  record lost to a crashed write or an externally pruned folder.
 *
 *  Never unstages: a seed says nothing about the user REMOVING a file, and
 *  the ids it carries may belong to another lifecycle's record (reconstructed
 *  chips are skipped by the shared diff for the same reason). */
export function planSeedStage(
  presentIds: readonly string[],
  lookup: (id: string) => ComposerAttachment | undefined,
): GraphSyncPlan {
  const plan = planGraphSync(new Set<string>(), presentIds, lookup);
  return { stage: plan.stage, unstage: [], nextIds: plan.nextIds };
}

// One in-flight chain per `cwd|id`, so a remove→undo→redo flurry can't
// interleave its write and remove IPCs and settle on the wrong disk state —
// ops for one attachment apply strictly in gesture order. Entries are pruned
// as soon as their tail settles, so the map stays bounded by what's in
// flight right now.
const opChains = new Map<string, Promise<void>>();
function enqueuePerId(key: string, op: () => Promise<unknown>): void {
  const run = () => op().then(() => undefined);
  const tail: Promise<void> = (opChains.get(key) ?? Promise.resolve())
    .then(run, run)
    .catch(() => {});
  opChains.set(key, tail);
  void tail.then(() => {
    if (opChains.get(key) === tail) opChains.delete(key);
  });
}

/** Execute a plan against the workspace graph. Fire-and-forget on every axis:
 *  each op is independently caught and never awaited — web clients have no
 *  IPC, a read-only disk must not break typing, and the send-path safety net
 *  re-covers a failed write. Each op that lands notifies the graph-change
 *  signal itself (agent-history-client), which the Context tab and the git
 *  refresh bus both subscribe to — so visibility needs nothing further here.
 *  The deferred `op()` call inside the chain also absorbs a SYNCHRONOUS
 *  throw from the IPC façade.
 *
 *  A PROVISIONING cwd is skipped whole: the dispatcher reserves the worktree
 *  path before `git worktree add` creates it, and a stage write in that
 *  window would mkdir `.context-graph/` into the reserved path — worktree
 *  add refuses a non-empty directory, so the write wouldn't just be early,
 *  it would fail the workspace creation itself. Nothing is lost: the
 *  composer's provisioning-end sweep (use-composer-editor) re-stages the
 *  doc the moment the worktree lands, and unstages skipped here had nothing
 *  on disk to remove anyway. */
export function executeGraphSync(cwd: string, plan: GraphSyncPlan): void {
  if (isWorkspaceProvisioning(cwd)) return;
  for (const a of plan.stage) {
    const base64 = stageablePayload(a);
    if (!base64) continue;
    enqueuePerId(`${cwd}|${a.id}`, () =>
      writeContextAttachment({
        cwd,
        attachmentId: a.id,
        base64,
        mimeType: a.mimeType,
        filename: a.name,
      }),
    );
  }
  for (const id of plan.unstage) {
    enqueuePerId(`${cwd}|${id}`, () =>
      removeContextAttachment({ cwd, attachmentId: id }),
    );
  }
}
