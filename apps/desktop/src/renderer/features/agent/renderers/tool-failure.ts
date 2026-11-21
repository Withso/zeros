import type { AgentMessage, AgentToolMessage } from "../use-agent-session";
import { browserActivityGroupStatus, groupBrowserToolActivity } from "../../browser/browser-tool-activity";
import { metaForEvent, statusTone, type EventMeta } from "./event-meta";
import { hasPlanBody } from "./plan-body";
import { pendingChecksMessage } from "./tool-pending-checks";

type ToolTone = ReturnType<typeof statusTone>;

/** Records whose renderer always passes `toneOverride="ok"`: a "failed"
 * status is how the outcome is delivered (Claude answers a question or
 * rejects a plan through a deny tool_result), or the row tells the reason in
 * words (compaction, budget stop). Keep in step with those renderers. */
function quietRecord(tool: AgentToolMessage): boolean {
  return tool.toolKind === "question" || tool.toolKind === "compaction" ||
    tool.toolKind === "budget_stop" ||
    (tool.toolKind === "switch_mode" && hasPlanBody(tool.rawInput));
}

/** The status tone a tool row shows when its renderer supplies no override. */
export function toolRowTone(tool: AgentToolMessage, meta: Pick<EventMeta, "tone">): ToolTone {
  if (pendingChecksMessage(tool)) return "ok";
  return meta.tone ?? statusTone(tool.status);
}

/** Whether the event's row presents it as a failed tool call. The working
 * group header uses this so it never flags a row that reads as ok. */
export function eventShowsFailure(event: AgentMessage): boolean {
  if (event.kind !== "tool" || event.status !== "failed" || quietRecord(event)) return false;
  return toolRowTone(event, metaForEvent(event)) === "fail";
}

/** Whether a working group's rows show a failed tool call. Browser, computer
 * and simulator batches render as one card that reads failed only when every
 * action in it failed, so a batch counts the same way here. */
export function groupShowsFailure(events: AgentMessage[], closeTail: boolean): boolean {
  return groupBrowserToolActivity(events, { closeTail }).some((item) =>
    item.kind === "browser-activity"
      ? browserActivityGroupStatus(item.events, item.closed) === "failed"
      : eventShowsFailure(item.event));
}
