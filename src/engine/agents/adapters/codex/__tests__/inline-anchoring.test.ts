// §3.2 Task 5 (audit) — Codex approvals anchor INLINE under the matching tool
// card. This shipped via a different mechanism than the doc planned: instead of
// making the approval's toolCallId equal the card's minted UUID, BOTH ends key
// on the raw codex item id — the tool card carries it as `nativeToolCallId`, the
// approval carries it as `toolCall.toolCallId`, and the renderer matches either
// (event-stripe.tsx:81: `t.toolCallId === pendingPermId || t.nativeToolCallId
// === pendingPermId`). If either end drifts off the codex item id, the approval
// detaches into the global bar. These lock both ends onto the SAME id.

import { describe, it, expect } from "vitest";

import { CodexAppServerTranslator } from "../app-server-translator";
import { mapApprovalToCanonical } from "../app-server-adapter";
import type { SessionNotification } from "../../../types";

/** Minimal CodexSession — mapApprovalToCanonical reads only these two fields. */
const fakeSession = () =>
  ({ zerosSessionId: "zsid", fileEditPathsByItemId: new Map() }) as never;

/** Stream an item/started for a tool item and return the card's nativeToolCallId. */
function cardNativeId(
  type: string,
  id: string,
  extra: Record<string, unknown> = {},
): string {
  const emitted: SessionNotification[] = [];
  const t = new CodexAppServerTranslator({
    sessionId: "s",
    emit: (n) => emitted.push(n),
    onUnknown: () => {},
  });
  t.handle("item/started", {
    item: { type, id, ...extra },
    threadId: "thr",
    turnId: "turn",
    startedAtMs: 0,
  });
  const call = emitted.find((n) => n.update.sessionUpdate === "tool_call");
  return (call?.update as { nativeToolCallId?: string }).nativeToolCallId ?? "";
}

/** The canonical approval's toolCall.toolCallId for an approval on `itemId`. */
function approvalToolCallId(
  method: string,
  params: Record<string, unknown>,
): string {
  const canonical = mapApprovalToCanonical(fakeSession(), {
    method,
    params,
  } as never) as { toolCall: { toolCallId: string } };
  return canonical.toolCall.toolCallId;
}

describe("Codex inline anchoring — approval id lines up with the tool card", () => {
  it("command approval keys on the SAME codex item id as its commandExecution card", () => {
    const native = cardNativeId("commandExecution", "cmd-1", { command: "ls -la" });
    expect(native).toBe("cmd-1");

    const approvalId = approvalToolCallId("item/commandExecution/requestApproval", {
      itemId: "cmd-1",
      command: "ls -la",
    });
    expect(approvalId).toBe("cmd-1");
    // The invariant event-stripe.tsx relies on → the approval anchors inline.
    expect(approvalId).toBe(native);
  });

  it("file-change approval keys on the SAME codex item id as its fileChange card", () => {
    const native = cardNativeId("fileChange", "fc-9", { changes: [{ path: "a.ts" }] });
    expect(native).toBe("fc-9");

    const approvalId = approvalToolCallId("item/fileChange/requestApproval", {
      itemId: "fc-9",
    });
    expect(approvalId).toBe("fc-9");
    expect(approvalId).toBe(native);
  });

  it("an approval with NO itemId falls back to a random id (documents the detach failure mode)", () => {
    const approvalId = approvalToolCallId("item/commandExecution/requestApproval", {
      command: "ls", // no itemId → nothing for a card to match → detaches
    });
    expect(approvalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(approvalId).not.toBe("cmd-1");
  });
});
