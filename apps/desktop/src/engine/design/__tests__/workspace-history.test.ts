import { describe, expect, it } from "vitest";
import type { DesignLocalHistoryCheckpoint } from "@zeros/design-web";
import type { DesignFrameRestorePoint } from "../document";
import {
  documentDesignHistoryEntry,
  frameDesignHistoryEntry,
  pruneWorkspaceDesignFrameHistory,
  type WorkspaceDesignHistoryEntry,
} from "../workspace-history";

const removed = "page-b/home.html";
const kept = "page-a/home.html";
function point(file: string): DesignFrameRestorePoint {
  return {
    file,
    source: "<main></main>",
    geometry: { x: 0, y: 0, w: 100, h: 100, z: 0 },
  };
}
function transfer(): Extract<
  WorkspaceDesignHistoryEntry,
  { kind: "transfer" }
> {
  return {
    kind: "transfer",
    frame: kept,
    changes: [],
    beforeHistory: [],
    afterHistory: [],
    bytes: 128,
  };
}

describe("deleted Design frame history", () => {
  it("prunes earlier deleted-frame entries by the exact removed page folder", () => {
    const deleted = frameDesignHistoryEntry(point(removed), null);
    const survivor = documentDesignHistoryEntry("page-beta/home.html");
    const state = {
      undo: [survivor, deleted],
      redo: [deleted],
      bytes: survivor.bytes + 2 * deleted.bytes,
    };
    pruneWorkspaceDesignFrameHistory(state, new Set(), "page-b");
    expect(state).toEqual({
      undo: [survivor],
      redo: [],
      bytes: survivor.bytes,
    });
  });
  it.each([
    "document",
    "frame",
    "transfer-frame",
    "transfer-before",
    "transfer-after",
    "checkpoint-before",
    "checkpoint-after",
  ])(
    "prunes %s references from both stacks with exact byte accounting",
    (kind) => {
      let deleted: WorkspaceDesignHistoryEntry;
      if (kind === "document") deleted = documentDesignHistoryEntry(removed);
      else if (kind === "frame")
        deleted = frameDesignHistoryEntry(point(removed), null);
      else {
        deleted = transfer();
        if (kind === "transfer-frame") deleted.frame = removed;
        else if (kind === "transfer-before")
          deleted.changes = [{ before: point(removed), after: null }];
        else if (kind === "transfer-after")
          deleted.changes = [{ before: null, after: point(removed) }];
        else {
          const checkpoint = {
            documentId: `frame:${removed}`,
          } as DesignLocalHistoryCheckpoint;
          deleted[
            kind === "checkpoint-before" ? "beforeHistory" : "afterHistory"
          ] = [checkpoint];
        }
      }
      const survivor = documentDesignHistoryEntry(kept);
      const state = {
        undo: [survivor, deleted],
        redo: [deleted, survivor],
        bytes: 2 * (survivor.bytes + deleted.bytes),
      };
      pruneWorkspaceDesignFrameHistory(state, new Set([removed]));
      expect(state).toEqual({
        undo: [survivor],
        redo: [survivor],
        bytes: 2 * survivor.bytes,
      });
    },
  );
});
