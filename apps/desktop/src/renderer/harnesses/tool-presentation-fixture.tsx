// Synthetic provider records exercise production rendering without provider IO.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { CodeView } from "@pierre/diffs/react";
import { parsePatchFiles } from "@pierre/diffs";
import {
  applyUpdate,
  type AgentMessage,
  type AgentToolMessage,
} from "@zeros/protocol/agent-messages";
import { Button } from "../shared/ui/primitives/button";
import { useCodeTheme } from "../shared/theme/use-code-theme";
import { changesDiffOptions } from "../shell/workbench/tabs/changes-diff-options";
import { EventStripe } from "../features/agent/renderers/event-stripe";
import {
  EditCard,
  buildUnifiedDiffPatch,
} from "../features/agent/renderers/tool-edit";
import { HighlightedCode } from "../features/agent/renderers/highlighted-code";
import { reconcileHistoryMessages } from "../features/agent/history-message-identity";
import type { RendererContext } from "../features/agent/renderers/types";

const tool = (
  id: string,
  overrides: Partial<AgentToolMessage>,
): AgentToolMessage => ({
  kind: "tool",
  id: `tool-${id}`,
  toolCallId: id,
  title: "Bash",
  toolKind: "execute",
  status: "completed",
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});
const output = Array.from(
  { length: 80 },
  (_, i) => `Recorded output line ${i + 1}`,
).join("\n");
const readProviders = ["Claude", "Codex", "Cursor"] as const;
const readOutput = Array.from({ length: 415 }, (_, index) => `source line ${index + 1}`).join("\n") + "\n";
const initial: AgentMessage[] = [
  ...readProviders.map((provider) => tool(`read-${provider}`, {
    title: "Read",
    toolKind: "read",
    status: "in_progress",
    rawInput: { path: `${provider.toLowerCase()}.txt` },
  })),
  tool("claude-one", {
    status: "in_progress",
    rawInput: { command: "ls -la", description: "Inspect project files" },
  }),
  tool("claude-two", {
    status: "in_progress",
    rawInput: {
      command: "cat README.md",
      description: "Read the project introduction",
    },
  }),
  tool("wrapped", {
    rawInput: { command: "/bin/zsh -lc 'pnpm check'" },
    rawOutput: { exitCode: 0, output, durationMs: 400 },
  }),
  tool("glob", {
    title: "Searching for **/*.tsx",
    toolKind: "search",
    rawInput: { pattern: "**/*.tsx" },
    content: [
      {
        type: "content",
        content: { type: "text", text: "src/a.tsx\nsrc/b.tsx" },
      },
    ],
  }),
  tool("reads", {
    rawInput: {
      command: "/bin/zsh -lc 'cat src/a.ts src/b.ts'",
      commandActions: [
        { type: "read", path: "src/a.ts", command: "cat src/a.ts" },
        { type: "read", path: "src/b.ts", command: "cat src/b.ts" },
      ],
    },
    rawOutput: { exitCode: 0, output: "Contents from both files" },
  }),
  tool("failed", {
    status: "failed",
    rawInput: { command: "cat private.ts" },
    rawOutput: {
      status: "success",
      value: { exitCode: 1, stderr: "Permission denied" },
    },
  }),
];
const before =
  Array.from({ length: 70 }, (_, i) => `export const item${i} = ${i};`).join(
    "\n",
  ) + "\n";
const after = before.replaceAll(" = ", " = 100 + ");
const patch = buildUnifiedDiffPatch("src/card.ts", before, after);
const edit = tool("edit", {
  title: "Edit",
  toolKind: "edit",
  rawInput: {
    changes: [{ path: "src/card.ts", diff: patch, kind: { type: "update" } }],
  },
});
const items = [
  {
    type: "diff" as const,
    id: "card.ts",
    fileDiff: parsePatchFiles(patch)[0].files[0],
  },
];

export function ToolPresentationFixture({ ctx }: { ctx: RendererContext }) {
  const [messages, setMessages] = useState(initial);
  const [version, setVersion] = useState("first");
  const probe = useRef<HTMLDivElement>(null);
  const codeTheme = useCodeTheme();
  const options = useMemo(
    () => changesDiffOptions({ diffStyle: "unified", codeThemeId: codeTheme }),
    [codeTheme],
  );
  const code =
    `const version = "${version}";\n` +
    Array.from({ length: 4000 }, (_, i) => `const value${i} = ${i};`).join(
      "\n",
    );
  useLayoutEffect(() => {
    if (probe.current)
      probe.current.dataset.stale = String(
        !probe.current.textContent?.includes(`const version = "${version}";`),
      );
  }, [version]);
  return (
    <section
      id="tool-presentation-fixture"
      className="mx-auto max-w-3xl space-y-3"
    >
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() =>
            setMessages((previous) =>
              ["claude-one", "claude-two"].reduce(
                (state, toolCallId) =>
                  applyUpdate(state, {
                    sessionId: "fixture",
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status: "completed",
                      rawOutput: "Recorded result",
                    },
                  }),
                previous,
              ),
            )
          }
        >
          Finish tools
        </Button>
        <Button
          onClick={() =>
            setMessages((previous) =>
              reconcileHistoryMessages(
                JSON.parse(JSON.stringify(previous)) as AgentMessage[],
              ),
            )
          }
        >
          Reload transcript
        </Button>
        <Button
          onClick={() =>
            setMessages((previous) =>
              applyUpdate(previous, {
                sessionId: "fixture",
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId: "wrapped",
                  rawOutput: {
                    exitCode: 0,
                    output: `${output}\nLate output remains visible`,
                  },
                },
              }),
            )
          }
        >
          Append output
        </Button>
        <Button
          onClick={() => setMessages((previous) => readProviders.reduce(
            (state, provider) => applyUpdate(state, {
              sessionId: "fixture",
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: `read-${provider}`,
                status: "completed",
                rawOutput: provider === "Claude"
                  ? [{ type: "text", text: readOutput }]
                  : provider === "Codex"
                    ? { exitCode: 0, output: readOutput }
                    : { status: "success", value: { content: readOutput, totalLines: 415, fileSize: readOutput.length } },
              },
            }), previous,
          ))}
        >
          Finish reads
        </Button>
      </div>
      <div id="tool-presentation-rows">
        <EventStripe events={messages} ctx={ctx} live={false} alwaysExpanded />
      </div>
      <div id="tool-presentation-edit">
        <EditCard message={edit} ctx={ctx} />
      </div>
      <div id="tool-presentation-changes" className="relative h-[320px]">
        <CodeView
          items={items}
          options={options}
          className="absolute inset-0 overflow-auto"
        />
      </div>
      <Button onClick={() => setVersion("second")}>Switch source</Button>
      <div
        id="highlight-stream-probe"
        ref={probe}
        className="max-h-[80px] overflow-auto"
      >
        <HighlightedCode code={code} lang="typescript" />
      </div>
    </section>
  );
}
