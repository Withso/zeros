import { useState } from "react";
import type {
  AgentTextMessage,
  AgentToolMessage,
} from "@zeros/protocol/agent-messages";
import { TextMessage } from "../features/agent/renderers/text-message";
import { EventStripe } from "../features/agent/renderers/event-stripe";
import type { RendererContext } from "../features/agent/renderers/types";
import { isLoopbackUrl } from "../shell/workbench/tabs/localhost-url";

const path = ".context/local/artifacts/demo/Generated image.png";
const text: AgentTextMessage = {
  kind: "text",
  id: "artifact-prose",
  role: "agent",
  createdAt: 1,
  updatedAt: 2,
  text: `[Generated image](<${path}>) and [Report](.context/local/artifacts/demo/report.html).\n\n[Documentation](https://example.com/docs) · [Local preview](http://localhost:5173) · [\`external.ts\`](https://example.com/external)\n\nKeep \`@scope/package\` and \`const value = true\` as code.\n\n[${"LongPath".repeat(35)}.png](.context/local/artifacts/demo/long.png)\n\n\`\`\`ts\nconst message = "unchanged code";\n\`\`\``,
};
const tools: AgentToolMessage[] = [
  {
    kind: "tool",
    id: "artifact-generate",
    toolCallId: "artifact-generate",
    title: "Generating image",
    toolKind: "other",
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
    rawOutput: { savedPath: path },
  },
  {
    kind: "tool",
    id: "artifact-report",
    toolCallId: "artifact-report",
    title: "Create report",
    toolKind: "mcp",
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
    rawInput: { server: "reports", tool: "create" },
    rawOutput: { structuredContent: { matches: ["src/a.ts", "src/b.ts"] } },
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: "Report ready\n" + "Report details\n".repeat(40),
        },
      },
      {
        type: "content",
        content: {
          type: "resource_link",
          uri: ".context/local/artifacts/demo/report.html",
          name: "Report",
          description: "Generated report",
        },
      },
      {
        type: "content",
        content: {
          type: "resource_link",
          uri: "https://example.com/reference",
          name: "Reference",
        },
      },
    ],
  },
];

export function ArtifactLinksFixture({ ctx }: { ctx: RendererContext }) {
  const [opened, setOpened] = useState("");
  const localCtx = {
    ...ctx,
    isStreaming: false,
    openFile: (file: string) => setOpened(`file:${file}`),
    openPreviewUrl: (url: string) => {
      if (!isLoopbackUrl(url)) return false;
      setOpened(`browser:${url}`);
      return true;
    },
  };
  return (
    <section
      id="artifact-links-fixture"
      className="mx-auto max-w-3xl space-y-3"
    >
      <output data-opened-artifact="">{opened}</output>
      <div data-artifact-prose="">
        <TextMessage message={text} ctx={localCtx} />
      </div>
      <EventStripe events={tools} ctx={localCtx} live={false} alwaysExpanded />
    </section>
  );
}
