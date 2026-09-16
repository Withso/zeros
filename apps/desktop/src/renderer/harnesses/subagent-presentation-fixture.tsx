// Native-shaped, synthetic records exercise production group rendering.
import { useMemo, useState } from "react";
import {
  applyUpdate,
  type AgentMessage,
  type AgentToolMessage,
} from "@zeros/protocol/agent-messages";
import { Button } from "../shared/ui/primitives/button";
import { EventStripe } from "../features/agent/renderers/event-stripe";
import type { RendererContext } from "../features/agent/renderers/types";

const providers = ["Claude", "Codex", "Cursor"] as const;
const thinkingText = "\n\nChecking the entry points before following the imports.\n\n \t\nKeep the review focused on the source and its tests.\n\n";
const tool = (
  id: string,
  changes: Partial<AgentToolMessage>,
): AgentToolMessage => ({
  id: `tool-${id}`,
  toolCallId: id,
  kind: "tool",
  title: "Bash",
  status: "in_progress",
  toolKind: "execute",
  createdAt: 1,
  updatedAt: 1,
  ...changes,
});
const rootNarration: AgentMessage = {
  kind: "text",
  role: "agent",
  id: "root-text",
  text: "Live parent narration",
  createdAt: 1,
};
const initial: AgentMessage[] = providers.flatMap((provider) => [
  tool(provider, {
    title: "Agent",
    toolKind: provider === "Cursor" ? "task" : "subagent",
    rawInput: {
      description: `${provider} source audit`,
      prompt: "Inspect the project and report your findings.",
      model: provider === "Claude" ? "claude-opus-4-6" : undefined,
    },
    rawOutput: provider === "Claude" ? { status: "async_launched" } : undefined,
  }),
  {
    id: `${provider}-thought`,
    kind: "text",
    role: "thought",
    text: provider === "Cursor" ? thinkingText.replace(/\n/g, "\r\n") : thinkingText,
    durationMs: 5000,
    parentToolId: provider,
    createdAt: 2,
  },
  {
    id: `${provider}-text`,
    kind: "text",
    role: "agent",
    text: `${provider} is inspecting the source.`,
    parentToolId: provider,
    createdAt: 3,
  },
]);

export function SubagentPresentationFixture({ ctx }: { ctx: RendererContext }) {
  const [messages, setMessages] = useState(initial);
  const [ready, setReady] = useState(false);
  const [finished, setFinished] = useState(false);
  const nested = useMemo(() => {
    const children = new Map<string, AgentMessage[]>();
    for (const message of messages) {
      if (!("parentToolId" in message) || !message.parentToolId) continue;
      children.set(message.parentToolId, [
        ...(children.get(message.parentToolId) ?? []),
        message,
      ]);
    }
    return { ...ctx, subagentChildren: children };
  }, [ctx, messages]);
  const append = () => {
    setReady(true);
    setMessages((previous) => [
      ...previous,
      ...providers.map((provider) =>
        tool(`${provider}-shell`, {
          parentToolId: provider,
          rawInput: { command: "pnpm test" },
          rawOutput: {
            output: Array.from(
              { length: 70 },
              (_, i) => `Test result line ${i + 1}`,
            ).join("\n"),
          },
        }),
      ),
    ]);
  };
  const finish = () => {
    setFinished(true);
    setMessages((previous) =>
      providers.reduce((state, provider) => {
        let next = applyUpdate(state, {
          sessionId: "fixture",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: provider,
            status: "completed",
            rawOutput: { status: "completed" },
          },
        });
        next = applyUpdate(next, {
          sessionId: "fixture",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: `${provider}-shell`,
            status: "completed",
          },
        });
        return [
          ...next,
          {
            id: `${provider}-answer`,
            kind: "text",
            role: "agent",
            phase: "final_answer",
            parentToolId: provider,
            text: `${provider} audit complete. The project is a desktop coding workspace.`,
            createdAt: 5,
          },
        ];
      }, previous),
    );
  };
  return (
    <section
      id="subagent-presentation-fixture"
      className="mx-auto w-full max-w-3xl space-y-4"
    >
      <div className="flex gap-2">
        <Button onClick={append} disabled={ready}>
          Stream child tools
        </Button>
        <Button onClick={finish} disabled={!ready || finished}>
          Finish child agents
        </Button>
      </div>
      <div id="thinking-spacing-probe">
        <EventStripe
          events={[{
            id: "root-thinking-spacing",
            kind: "text",
            role: "thought",
            text: thinkingText,
            createdAt: 1,
          }]}
          ctx={ctx}
          live
        />
      </div>
      <div id="narration-readiness-probe">
        <EventStripe
          events={[
            rootNarration,
            tool("provisional", {
              title: "Running shell command",
              rawInput: ready ? { command: "pwd" } : {},
            }),
          ]}
          ctx={ctx}
          live
          alwaysExpanded
        />
      </div>
      <div id="nested-agent-groups">
        <EventStripe
          events={messages.filter(
            (message) => !("parentToolId" in message) || !message.parentToolId,
          )}
          ctx={nested}
          live
          alwaysExpanded
        />
      </div>
      <div id="error-and-list-probe">
        <EventStripe
          events={[
            tool("list", {
              title: "List",
              toolKind: "list",
              status: "completed",
              rawInput: { path: "src" },
              rawOutput: "main.ts",
            }),
            tool("failed-read", {
              title: "Read",
              toolKind: "read",
              status: "failed",
              rawInput: { path: "private.ts" },
              rawOutput: "Permission denied by the workspace",
            }),
            tool("failed-shell", {
              status: "failed",
              rawInput: {
                command: "echo 'denied' && exit 1",
                description: "Check command access",
              },
              rawOutput: "Command access was denied.",
            }),
            tool("failed-agent", {
              title: "Agent",
              toolKind: "subagent",
              status: "failed",
              rawInput: { description: "Interrupted review" },
              rawOutput: { message: "The child was interrupted." },
            }),
            tool("unreported-read", {
              title: "Read",
              toolKind: "read",
              status: "pending",
              rawInput: { path: "unreported.ts" },
              rawOutput: { _zerosToolCompletion: "unreported" },
            }),
          ]}
          ctx={ctx}
          live
          alwaysExpanded
        />
      </div>
    </section>
  );
}
