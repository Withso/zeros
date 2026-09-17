import { expect, it } from "vitest";
import { applyUpdate } from "@zeros/protocol/agent-messages";
import { transcriptParentId } from "../transcript-parent";

it("keeps a late-parented native child error inside its owning Agent group", () => {
  const events = applyUpdate([], {
    sessionId: "s",
    update: {
      sessionUpdate: "error_notice",
      noticeId: "child-error",
      severity: "error",
      message: "Child transport disconnected",
      recoverable: false,
    },
  });
  const adopted = applyUpdate(events, {
    sessionId: "s",
    update: {
      sessionUpdate: "message_parent_update",
      messageIds: [events[0].id],
      parentToolId: "agent-group",
    },
  });
  expect(transcriptParentId(adopted[0])).toBe("agent-group");
  expect(transcriptParentId(events[0])).toBeUndefined();
});
