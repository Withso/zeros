// Attach-time context-graph staging: the composer diffs its document's
// attachment ids on every user edit and stages what appeared. These pin the
// properties that make that safe:
//
//   • APPEND-ONLY — an id disappearing (chip ×, Backspace, select-all
//     delete, undo) plans NO IO, ever: once a file lands in the graph, only
//     the user deleting it on disk removes it (2026-08-03(3) product
//     decision). There is no unstage op to misfire.
//   • LIFECYCLE — only ids the side store owns stage. Reconstructed
//     (`att-edit-`) chips belong to their ORIGINAL send, never to the edit
//     session diffing them, so staging one would duplicate its record.
//   • BYTES — a chip with no body in hand (a reconstructed text chip) has
//     nothing to write; bodies past the validator's hard caps must not ride
//     the IPC at all.
//   • ISOLATION — one failed write (no IPC on web, read-only disk) breaks
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

vi.mock("../agent-history-client", () => ({
  writeContextAttachment: (...args: unknown[]) =>
    writeContextAttachment(...args),
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
  it("stages an id that appeared and plans NOTHING for one that disappeared", () => {
    // The disappeared id ("gone") is still owned by the side store — the
    // strongest version of the append-only pin: even a removal the composer
    // could reverse must not plan any graph IO. The record stays until the
    // user deletes the file on disk.
    const a = att();
    const plan = planGraphSync(new Set(["gone"]), [a.id], storeOf(a, att({ id: "gone" })));
    expect(plan.stage.map((s) => s.id)).toEqual([a.id]);
    expect([...plan.nextIds]).toEqual([a.id]);
  });

  it("is empty when nothing moved", () => {
    const a = att();
    const plan = planGraphSync(new Set([a.id]), [a.id], storeOf(a));
    expect(plan.stage).toEqual([]);
  });

  it("stages nothing for an id the side store no longer owns", () => {
    // Send → clear() empties the store → ⌘Z resurrects the chips. The
    // reappearance has no bytes in hand, so there is nothing to write (the
    // sent message's record already exists).
    const back = planGraphSync(new Set(), ["att-sent"], storeOf());
    expect(back.stage).toEqual([]);
  });

  it("never stages a reconstructed chip", () => {
    // Edit-in-place seeds carry `att-edit-` ids WITH image bytes recovered
    // from the thumbnail — appearing (undo of a chip removal mid-edit) must
    // not create a duplicate graph card for the original send's record.
    const ghost = image({ id: "att-edit-x1" });
    const appear = planGraphSync(new Set(), [ghost.id], storeOf(ghost));
    expect(appear.stage).toEqual([]);
  });

  it("tracks ids it could not act on, so a later lookup can't replay them", () => {
    const plan = planGraphSync(new Set(), ["att-unknown"], storeOf());
    expect(plan.stage).toEqual([]);
    expect(plan.nextIds.has("att-unknown")).toBe(true);
  });
});

describe("planSeedStage", () => {
  it("stages every owned id in the doc", () => {
    // The seed path: a dispatcher-created workspace mounts a draft whose
    // files were never staged (the dispatcher surface opts out). The sweep
    // must cover them all.
    const a = att();
    const b = image({ id: "att-2" });
    const plan = planSeedStage([a.id, b.id], storeOf(a, b));
    expect(plan.stage.map((s) => s.id)).toEqual([a.id, b.id]);
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
    expect(plan.nextIds.has("att-unknown")).toBe(true);
  });
});

describe("executeGraphSync while the worktree is provisioning", () => {
  beforeEach(() => {
    writeContextAttachment.mockReset().mockResolvedValue({});
  });

  it("skips every write for a provisioning cwd and works again once it lands", async () => {
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
        nextIds: new Set(["att-1"]),
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(writeContextAttachment).not.toHaveBeenCalled();
    } finally {
      finishPendingCreate(token);
    }
    executeGraphSync("/repo-worktrees/mauve", {
      stage: [att()],
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
    toastError.mockReset();
    resetStagingFailureNoticesForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("logs every failed write but toasts only the first per workspace", async () => {
    // The 2026-08-03 outage shape: a stale main process rejects EVERY write.
    // Each rejection must be greppable, but the user gets one notice — a
    // paste burst must not stack four identical toasts.
    writeContextAttachment.mockRejectedValue(new Error("disk on fire"));
    executeGraphSync("/w1", {
      stage: [att(), att({ id: "att-2", name: "b.txt" })],
      nextIds: new Set(["att-1", "att-2"]),
    });
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledTimes(2));
    expect(toastError).toHaveBeenCalledTimes(1);
    // A different workspace gets its own notice.
    executeGraphSync("/w2", {
      stage: [att()],
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
      nextIds: new Set(["att-1"]),
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
        '[Zeros] IPC: unknown command "agent_attachment_write". Expected one of 70 registered commands.',
      ),
    ).toBe(true);
    expect(isBuildSkewFailure("EACCES: permission denied")).toBe(false);
    expect(isBuildSkewFailure("path escapes workspace")).toBe(false);
  });
});

describe("executeGraphSync", () => {
  beforeEach(() => {
    writeContextAttachment.mockReset().mockResolvedValue({});
    toastError.mockReset();
    resetStagingFailureNoticesForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("writes stages against the workspace", async () => {
    const a = att();
    executeGraphSync("/repo", {
      stage: [a],
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
    });
  });

  it("drops byte-less stages instead of writing empty files", async () => {
    executeGraphSync("/repo", {
      stage: [att({ text: "" })],
      nextIds: new Set(["att-1"]),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(writeContextAttachment).not.toHaveBeenCalled();
  });

  it("absorbs a synchronously-throwing IPC façade", async () => {
    writeContextAttachment.mockImplementation(() => {
      throw new Error("no IPC");
    });
    expect(() =>
      executeGraphSync("/repo", {
        stage: [att()],
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
