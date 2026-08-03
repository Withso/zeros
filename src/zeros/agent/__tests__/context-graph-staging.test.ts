// Attach-time context-graph staging: the composer diffs its document's
// attachment ids on every user edit, stages what appeared and unstages what
// disappeared. These pin the three properties that make that safe:
//
//   • LIFECYCLE — only ids the side store owns move the graph. After a send,
//     clear() empties the store, so chips resurrected by ⌘Z and deleted again
//     must not delete the sent message's graph record. Reconstructed
//     (`att-edit-`) chips belong to their ORIGINAL send, never to the edit
//     session diffing them.
//   • BYTES — a chip with no body in hand (a reconstructed text chip) has
//     nothing to write; bodies past the validator's hard caps must not ride
//     the IPC at all.
//   • ISOLATION — one failed op (no IPC on web, read-only disk) breaks
//     neither its siblings nor the caller, which is the composer's keystroke
//     path.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// console.warn spies are installed per-describe; restore between tests so a
// silenced warn can't leak into blocks that don't expect the reporter to run.
afterEach(() => {
  vi.restoreAllMocks();
});
import { getSchema } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";

const writeContextAttachment = vi.fn();
const removeContextAttachment = vi.fn();

vi.mock("../agent-history-client", () => ({
  writeContextAttachment: (...args: unknown[]) =>
    writeContextAttachment(...args),
  removeContextAttachment: (...args: unknown[]) =>
    removeContextAttachment(...args),
}));

// The failure reporter's two collaborators: mocked so these node tests stay
// off the UI module graph AND can assert the once-per-workspace toast.
const toastError = vi.fn();
vi.mock("../../ui/primitives/elements", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));
vi.mock("../../../native/runtime", () => ({
  isNativeRuntime: () => true,
}));

import { AttachmentNode } from "../composer-editor/nodes";
import { collectAttachmentIds } from "../composer-editor/attachment-keys";
import {
  executeGraphSync,
  isBuildSkewFailure,
  planGraphSync,
  planSeedStage,
  resetStagingFailureNoticesForTests,
  stageablePayload,
} from "../composer-editor/context-graph-staging";
import {
  beginPendingCreate,
  finishPendingCreate,
} from "../../store/pending-workspaces";
import {
  HARD_TEXT_CAP_BYTES,
  MAX_IMAGE_BYTES,
} from "../agent-attachments";
import type { ComposerAttachment } from "../composer-attachments";

function att(over: Partial<ComposerAttachment> = {}): ComposerAttachment {
  return {
    id: "att-1",
    name: "notes.txt",
    mimeType: "text/plain",
    size: 5,
    kind: "text",
    data: "",
    text: "hello",
    validation: { ok: true },
    ...over,
  };
}

function image(over: Partial<ComposerAttachment> = {}): ComposerAttachment {
  return att({
    id: "att-img",
    name: "shot.png",
    mimeType: "image/png",
    kind: "image",
    data: "aGVsbG8=",
    text: undefined,
    ...over,
  });
}

function storeOf(...items: ComposerAttachment[]) {
  const map = new Map(items.map((a) => [a.id, a]));
  return (id: string) => map.get(id);
}

describe("stageablePayload", () => {
  it("returns image base64 as-is and encodes text bodies", () => {
    expect(stageablePayload(image())).toBe("aGVsbG8=");
    expect(stageablePayload(att())).toBe("aGVsbG8="); // "hello" round-trips
  });

  it("refuses an attachment whose validation failed", () => {
    // The send path excludes invalid attachments entirely — staging one
    // would put a card on the canvas for a file no agent ever received. A
    // later model switch that makes it valid re-covers it at send time.
    expect(
      stageablePayload(att({ validation: { ok: false, reason: "too big" } })),
    ).toBeNull();
    expect(
      stageablePayload(image({ validation: { ok: false, reason: "too big" } })),
    ).toBeNull();
  });

  it("returns null when there are no bytes in hand", () => {
    // The reconstructed-chip shape: a name without a body (reconstruct.ts
    // sets text: "" / data: "").
    expect(stageablePayload(att({ text: "" }))).toBeNull();
    expect(stageablePayload(att({ text: undefined }))).toBeNull();
    expect(stageablePayload(image({ data: "" }))).toBeNull();
  });

  it("refuses bodies past the hard caps instead of shipping them over IPC", () => {
    const bigText = att({ text: "x".repeat(HARD_TEXT_CAP_BYTES + 1) });
    expect(stageablePayload(bigText)).toBeNull();
    // ~base64 of (cap + a margin) decoded bytes.
    const bigImage = image({
      data: "A".repeat(Math.ceil(((MAX_IMAGE_BYTES + 1024) * 4) / 3)),
    });
    expect(stageablePayload(bigImage)).toBeNull();
  });
});

describe("planGraphSync", () => {
  it("stages an id that appeared and unstages one that disappeared", () => {
    const a = att();
    const plan = planGraphSync(new Set(["gone"]), [a.id], storeOf(a, att({ id: "gone" })));
    expect(plan.stage.map((s) => s.id)).toEqual([a.id]);
    expect(plan.unstage).toEqual(["gone"]);
    expect([...plan.nextIds]).toEqual([a.id]);
  });

  it("is empty when nothing moved", () => {
    const a = att();
    const plan = planGraphSync(new Set([a.id]), [a.id], storeOf(a));
    expect(plan.stage).toEqual([]);
    expect(plan.unstage).toEqual([]);
  });

  it("never unstages an id the side store no longer owns", () => {
    // Send → clear() empties the store → ⌘Z resurrects the chips → user
    // deletes them again. The disappearance must NOT delete the sent
    // message's graph record.
    const plan = planGraphSync(new Set(["att-sent"]), [], storeOf());
    expect(plan.unstage).toEqual([]);
    // …and the reappearance (the ⌘Z itself) had nothing to stage either.
    const back = planGraphSync(new Set(), ["att-sent"], storeOf());
    expect(back.stage).toEqual([]);
  });

  it("ignores reconstructed chips in both directions", () => {
    // Edit-in-place seeds carry `att-edit-` ids WITH image bytes recovered
    // from the thumbnail — appearing (undo of a chip removal mid-edit) must
    // not create a duplicate graph card, and disappearing must not touch the
    // original send's record.
    const ghost = image({ id: "att-edit-x1" });
    const appear = planGraphSync(new Set(), [ghost.id], storeOf(ghost));
    expect(appear.stage).toEqual([]);
    const vanish = planGraphSync(new Set([ghost.id]), [], storeOf(ghost));
    expect(vanish.unstage).toEqual([]);
  });

  it("tracks ids it could not act on, so a later lookup can't replay them", () => {
    const plan = planGraphSync(new Set(), ["att-unknown"], storeOf());
    expect(plan.stage).toEqual([]);
    expect(plan.nextIds.has("att-unknown")).toBe(true);
  });
});

describe("planSeedStage", () => {
  it("stages every owned id in the doc and never unstages", () => {
    // The seed path: a dispatcher-created workspace mounts a draft whose
    // files were never staged (the dispatcher surface opts out). The sweep
    // must cover them all — and must not read the seed as a removal of
    // anything (prevIds from an earlier lifecycle are not its business).
    const a = att();
    const b = image({ id: "att-2" });
    const plan = planSeedStage([a.id, b.id], storeOf(a, b));
    expect(plan.stage.map((s) => s.id)).toEqual([a.id, b.id]);
    expect(plan.unstage).toEqual([]);
    expect([...plan.nextIds]).toEqual([a.id, b.id]);
  });

  it("skips reconstructed chips and ids the side store no longer owns", () => {
    // An edit-in-place seed rebuilds SENT chips under `att-edit-` ids with
    // bytes recovered from thumbnails — staging those would duplicate the
    // original send's record on every edit. And an id with no store entry
    // has no bytes to write, only a record to corrupt.
    const ghost = image({ id: "att-edit-x1" });
    const plan = planSeedStage([ghost.id, "att-unknown"], storeOf(ghost));
    expect(plan.stage).toEqual([]);
    expect(plan.unstage).toEqual([]);
    expect(plan.nextIds.has("att-unknown")).toBe(true);
  });
});

describe("executeGraphSync while the worktree is provisioning", () => {
  beforeEach(() => {
    writeContextAttachment.mockReset().mockResolvedValue({});
    removeContextAttachment.mockReset().mockResolvedValue({ removed: true });
  });

  it("skips every op for a provisioning cwd and works again once it lands", async () => {
    // The dispatcher reserves the worktree path before `git worktree add`
    // creates it. A stage write in that window would mkdir into the reserved
    // path and fail the creation itself — so the whole plan is dropped (the
    // provisioning-end sweep re-covers it) rather than queued.
    const token = beginPendingCreate({
      repoRoot: "/repo",
      repoSlug: "o/r",
      path: "/repo-worktrees/mauve",
    });
    try {
      executeGraphSync("/repo-worktrees/mauve", {
        stage: [att()],
        unstage: ["att-old"],
        nextIds: new Set(["att-1"]),
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(writeContextAttachment).not.toHaveBeenCalled();
      expect(removeContextAttachment).not.toHaveBeenCalled();
    } finally {
      finishPendingCreate(token);
    }
    executeGraphSync("/repo-worktrees/mauve", {
      stage: [att()],
      unstage: [],
      nextIds: new Set(["att-1"]),
    });
    await vi.waitFor(() => expect(writeContextAttachment).toHaveBeenCalled());
  });

  it("leaves other workspaces' staging untouched", async () => {
    const token = beginPendingCreate({
      repoRoot: "/repo",
      repoSlug: "o/r",
      path: "/repo-worktrees/other",
    });
    try {
      executeGraphSync("/repo", {
        stage: [att()],
        unstage: [],
        nextIds: new Set(["att-1"]),
      });
      await vi.waitFor(() => expect(writeContextAttachment).toHaveBeenCalled());
    } finally {
      finishPendingCreate(token);
    }
  });
});

describe("staging failures are reported, once per workspace", () => {
  beforeEach(() => {
    writeContextAttachment.mockReset();
    removeContextAttachment.mockReset().mockResolvedValue({ removed: true });
    toastError.mockReset();
    resetStagingFailureNoticesForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("logs every failed op but toasts only the first per workspace", async () => {
    // The 2026-08-03 outage shape: a stale main process rejects EVERY write.
    // Each rejection must be greppable, but the user gets one notice — a
    // paste burst must not stack four identical toasts.
    writeContextAttachment.mockRejectedValue(new Error("disk on fire"));
    executeGraphSync("/w1", {
      stage: [att(), att({ id: "att-2", name: "b.txt" })],
      unstage: [],
      nextIds: new Set(["att-1", "att-2"]),
    });
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledTimes(2));
    expect(toastError).toHaveBeenCalledTimes(1);
    // A different workspace gets its own notice.
    executeGraphSync("/w2", {
      stage: [att()],
      unstage: [],
      nextIds: new Set(["att-1"]),
    });
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(2));
  });

  it("names build skew and prescribes a relaunch", async () => {
    // The exact rejection an old main returns after the context-graph
    // migration: its legacy write handler still requires chatId. The toast
    // must say the one thing that fixes it — restart — not echo internals.
    writeContextAttachment.mockRejectedValue(
      new Error("agent_attachment: missing required string 'chatId'"),
    );
    executeGraphSync("/w", {
      stage: [att()],
      unstage: [],
      nextIds: new Set(["att-1"]),
    });
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    const [, opts] = toastError.mock.calls[0] as [
      unknown,
      { description?: string },
    ];
    expect(opts.description).toMatch(/relaunch/i);
  });

  it("reports failed unstages through the same channel", async () => {
    removeContextAttachment.mockRejectedValue(
      new Error(
        '[Zeros] IPC: unknown command "agent_attachment_remove". Expected one of 70 registered commands.',
      ),
    );
    executeGraphSync("/w", {
      stage: [],
      unstage: ["att-1"],
      nextIds: new Set(),
    });
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    const [, opts] = toastError.mock.calls[0] as [
      unknown,
      { description?: string },
    ];
    expect(opts.description).toMatch(/relaunch/i);
  });
});

describe("isBuildSkewFailure", () => {
  it("matches the two stale-main signatures and nothing else", () => {
    expect(
      isBuildSkewFailure("agent_attachment: missing required string 'chatId'"),
    ).toBe(true);
    expect(
      isBuildSkewFailure(
        '[Zeros] IPC: unknown command "agent_attachment_remove". Expected one of 70 registered commands.',
      ),
    ).toBe(true);
    expect(isBuildSkewFailure("EACCES: permission denied")).toBe(false);
    expect(isBuildSkewFailure("path escapes workspace")).toBe(false);
  });
});

describe("executeGraphSync", () => {
  beforeEach(() => {
    writeContextAttachment.mockReset().mockResolvedValue({});
    removeContextAttachment.mockReset().mockResolvedValue({ removed: true });
    toastError.mockReset();
    resetStagingFailureNoticesForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("writes stages and removes unstages against the workspace", async () => {
    const a = att();
    executeGraphSync("/repo", {
      stage: [a],
      unstage: ["att-old"],
      nextIds: new Set([a.id]),
    });
    await vi.waitFor(() => {
      expect(writeContextAttachment).toHaveBeenCalledWith({
        cwd: "/repo",
        attachmentId: "att-1",
        base64: "aGVsbG8=",
        mimeType: "text/plain",
        filename: "notes.txt",
      });
      expect(removeContextAttachment).toHaveBeenCalledWith({
        cwd: "/repo",
        attachmentId: "att-old",
      });
    });
  });

  it("drops byte-less stages instead of writing empty files", async () => {
    executeGraphSync("/repo", {
      stage: [att({ text: "" })],
      unstage: [],
      nextIds: new Set(["att-1"]),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(writeContextAttachment).not.toHaveBeenCalled();
  });

  it("applies same-id ops strictly in gesture order", async () => {
    // attach → ⌘Z-flurry: a write still in flight when the remove is issued
    // must finish FIRST, or the disk settles on the wrong state (file present
    // for a removed chip, or missing for a present one).
    const order: string[] = [];
    let releaseWrite!: () => void;
    writeContextAttachment.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = () => {
            order.push("write");
            resolve();
          };
        }),
    );
    removeContextAttachment.mockImplementation(() => {
      order.push("remove");
      return Promise.resolve({ removed: true });
    });
    const a = att();
    executeGraphSync("/repo", {
      stage: [a],
      unstage: [],
      nextIds: new Set([a.id]),
    });
    executeGraphSync("/repo", {
      stage: [],
      unstage: [a.id],
      nextIds: new Set(),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]); // remove is queued behind the pending write
    releaseWrite();
    await vi.waitFor(() => expect(order).toEqual(["write", "remove"]));
  });

  it("absorbs a synchronously-throwing IPC façade", async () => {
    writeContextAttachment.mockImplementation(() => {
      throw new Error("no IPC");
    });
    removeContextAttachment.mockImplementation(() => {
      throw new Error("no IPC");
    });
    expect(() =>
      executeGraphSync("/repo", {
        stage: [att()],
        unstage: ["att-old"],
        nextIds: new Set(["att-1"]),
      }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("collectAttachmentIds", () => {
  it("reads every attachment node's id in document order", () => {
    const schema = getSchema([Document, Paragraph, Text, AttachmentNode]);
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text("see "),
        schema.nodes.attachment.create({
          attachmentId: "att-a",
          name: "a.txt",
          mimeType: "text/plain",
          kind: "text",
        }),
        schema.text(" and "),
        schema.nodes.attachment.create({
          attachmentId: "att-b",
          name: "b.png",
          mimeType: "image/png",
          kind: "image",
        }),
      ]),
    ]);
    expect(collectAttachmentIds(doc)).toEqual(["att-a", "att-b"]);
  });
});
