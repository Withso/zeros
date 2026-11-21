// Tool rows in fixed narrow and wide lanes, so the smoke can measure which
// half of a row (name or description) gives way first.
import type { AgentToolMessage } from "@zeros/protocol/agent-messages";
import { EventStripe } from "../features/agent/renderers/event-stripe";
import type { RendererContext } from "../features/agent/renderers/types";

export const TOOL_ROW_WIDTH_LANES = [220, 280, 640] as const;

const tool = (
  lane: number,
  id: string,
  overrides: Partial<AgentToolMessage>,
): AgentToolMessage => ({
  kind: "tool",
  id: `width-${lane}-${id}`,
  toolCallId: `width-${lane}-${id}`,
  title: "Bash",
  toolKind: "execute",
  status: "completed",
  createdAt: 1,
  updatedAt: 2,
  rawOutput: { exitCode: 0, output: "done" },
  ...overrides,
});

const laneTools = (lane: number): AgentToolMessage[] => [
  tool(lane, "bash", { rawInput: { command: "git -C /Users/dev/zeros-alpha/workspaces/okit status --short" } }),
  tool(lane, "short", { rawInput: { command: "ls" } }),
  tool(lane, "mcp", {
    title: "mcp__planetscale__execute_read_query",
    toolKind: "mcp",
    rawInput: {
      appContext: {
        appName: "planetscale: execute_read_query",
        actionName: "select id, name from workspaces where owner_id = ?",
      },
    },
  }),
  tool(lane, "bare", { title: "planetscale: list_schema_recommendations", toolKind: "other", rawInput: {} }),
  tool(lane, "read", {
    title: "Read",
    toolKind: "read",
    rawInput: { path: "apps/desktop/src/renderer/features/agent/renderers/tool-row-width-fixture-name.tsx" },
    rawOutput: [{ type: "text", text: "source" }],
  }),
  tool(lane, "agent", {
    title: "Agent",
    toolKind: "subagent",
    rawInput: { description: "Review the partition edge cases for every provider shape", subagent_type: "Explore" },
    rawOutput: "Report",
  }),
];

export function ToolRowWidthFixture({ ctx }: { ctx: RendererContext }) {
  return (
    <div id="tool-row-width-fixture" className="flex flex-col gap-4">
      {TOOL_ROW_WIDTH_LANES.map((lane) => (
        // Fixed lane widths are the fixture's subject, not a design value.
        <div key={lane} data-lane={lane} className="pl-2" style={{ width: lane }}>
          <EventStripe events={laneTools(lane)} ctx={ctx} live={false} alwaysExpanded />
        </div>
      ))}
    </div>
  );
}
