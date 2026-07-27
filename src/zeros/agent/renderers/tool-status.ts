// Map the Zeros tool status enum to the AI Elements ToolStatus vocabulary.
// Extracted from the (now-removed) ToolCard so the live EditCard can use it
// without the dead generic card.

import type { AgentToolMessage } from "../use-agent-session";
import type { ToolStatus } from "@/zeros/ui/primitives/elements";

export function mapToolStatus(
  status: AgentToolMessage["status"],
): ToolStatus {
  if (status === "completed") return "complete";
  if (status === "failed") return "error";
  // pending + in_progress both map to "running" — the user mostly wants to
  // know "is this still working?", and pending cards live for milliseconds
  // before flipping to in_progress.
  return "running";
}
