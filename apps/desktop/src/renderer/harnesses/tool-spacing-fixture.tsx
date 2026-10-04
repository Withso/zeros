import { useState } from "react";
import type { AgentToolMessage } from "@zeros/protocol/agent-messages";
import { Button } from "../shared/ui/primitives/button";
import { EventStripe } from "../features/agent/renderers/event-stripe";
import { SubagentCard } from "../features/agent/renderers/tool-subagent";
import { EditCard } from "../features/agent/renderers/tool-edit";
import type { RendererContext } from "../features/agent/renderers/types";

const tool = (
  id: string,
  overrides: Partial<AgentToolMessage>,
): AgentToolMessage => ({
  kind: "tool",
  id,
  toolCallId: id,
  title: "Bash",
  toolKind: "execute",
  status: "completed",
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});
const changes = [
  {
    path: "src/update.ts",
    kind: { type: "update" },
    diff: "@@ -1 +1 @@\n-old\n+new\n",
  },
  {
    path: "src/added.ts",
    kind: { type: "add" },
    diff: "export const added = true;\n",
  },
  { path: "src/deleted.ts", kind: { type: "delete" }, diff: "old\n" },
];
const agent = tool("spacing-agent", {
  title: "Agent",
  toolKind: "subagent",
  rawInput: { description: "Spacing audit" },
});

export function ToolSpacingFixture({ ctx }: { ctx: RendererContext }) {
  const [live, setLive] = useState(true);
  const [reloaded, setReloaded] = useState(false);
  const [largeBatch, setLargeBatch] = useState(false);
  const events = [
    tool("spacing-before", { rawInput: { command: "pnpm check" } }),
    tool("spacing-batch", {
      title: "Edit",
      toolKind: "edit",
      status: live ? "in_progress" : "completed",
      rawInput: { changes },
    }),
    tool("spacing-single", {
      title: "Edit",
      toolKind: "edit",
      rawInput: {
        file_path: "src/single.ts",
        old_string: "old",
        new_string: "new",
      },
    }),
    tool("spacing-reads", {
      rawInput: {
        command: "cat src/first.ts src/second.ts",
        commandActions: [
          { type: "read", path: "src/first.ts", command: "cat src/first.ts" },
          { type: "read", path: "src/second.ts", command: "cat src/second.ts" },
        ],
      },
      rawOutput: { output: "Shared read result" },
    }),
    tool("spacing-failed", {
      title: "Edit",
      toolKind: "edit",
      status: "failed",
      rawInput: {
        changes: changes
          .slice(0, 2)
          .map((change) => ({
            ...change,
            path: change.path.replace("src/", "src/failed-"),
          })),
      },
      rawOutput: "Patch did not apply",
    }),
    tool("spacing-fallback", {
      title: "Edit",
      toolKind: "edit",
      rawInput: { path: "src/no-diff.ts" },
    }),
    tool("spacing-after", { rawInput: { command: "pnpm verify" } }),
  ];
  const childCtx = {
    ...ctx,
    subagentChildren: new Map([[agent.toolCallId, events]]),
  };
  return (
    <section id="tool-spacing-fixture" className="mx-auto max-w-3xl space-y-3">
      <div className="flex gap-2">
        <Button onClick={() => setLive(false)}>Finish spacing tools</Button>
        <Button onClick={() => setReloaded(true)}>
          Remount spacing history
        </Button>
        <Button onClick={() => setLargeBatch(true)}>Load large batch</Button>
      </div>
      <div id="tool-spacing-root" key={String(reloaded)}>
        <EventStripe events={events} ctx={ctx} live={live} />
      </div>
      <div id="tool-spacing-nested">
        <SubagentCard
          message={{ ...agent, status: live ? "in_progress" : "completed" }}
          ctx={childCtx}
        />
      </div>
      {largeBatch && (
        <div id="tool-spacing-large">
          <EditCard
            message={tool("spacing-large", {
              title: "Edit",
              toolKind: "edit",
              rawInput: {
                changes: Array.from({ length: 51 }, (_, index) => ({
                  ...changes[0],
                  path: `src/file-${index}.ts`,
                })),
              },
            })}
            ctx={ctx}
          />
        </div>
      )}
    </section>
  );
}
