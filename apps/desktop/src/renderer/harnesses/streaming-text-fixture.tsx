import { useMemo, useState } from "react";
import type { AgentTextMessage } from "@zeros/protocol/agent-messages";
import { MessageView } from "../features/agent/renderers/message-view";
import type { RendererContext } from "../features/agent/renderers/types";
import { Button } from "../shared/ui/primitives/button";
import { TurnEventList } from "../features/agent/turn-event-list";

const initialText = "The initial paragraph is already visible.";
const suffix =
  " New assistant text arrives smoothly in a short burst, with a subtle fade at the advancing edge. Emoji stay intact: 👩🏽‍💻. ";
const textMessage = (id: string, text: string): AgentTextMessage => ({
  id,
  kind: "text",
  role: "agent",
  text,
  createdAt: 1,
});

export function StreamingTextFixture({ ctx }: { ctx: RendererContext }) {
  const [text, setText] = useState(initialText);
  const [active, setActive] = useState(true);
  const [streaming, setStreaming] = useState(true);
  const [tail, setTail] = useState(true);
  const message = useMemo(() => textMessage("smooth-message", text), [text]);
  const context = useMemo(
    () => ({
      ...ctx,
      isStreaming: streaming,
      lastMessageId: tail ? message.id : "next-tool",
      attachmentImagesActive: active,
    }),
    [ctx, streaming, tail, message.id, active],
  );
  return (
    <section
      id="streaming-text-fixture"
      className="mx-auto w-full max-w-3xl space-y-4"
    >
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setText((value) => value + suffix)}>
          Append assistant text
        </Button>
        <Button onClick={() => setText("Authoritative correction.")}>
          Correct assistant text
        </Button>
        <Button onClick={() => setStreaming(false)}>Stop assistant text</Button>
        <Button onClick={() => setTail(false)}>
          Advance assistant activity
        </Button>
        <Button onClick={() => setActive((value) => !value)}>
          Toggle text surface
        </Button>
        <Button
          onClick={() => {
            setText(initialText);
            setStreaming(true);
            setTail(true);
          }}
        >
          Reset assistant text
        </Button>
      </div>
      <div id="streaming-text-probe" data-source={text} data-active={active}>
        <MessageView message={message} ctx={context} />
      </div>
      <div id="multiple-report-probe">
        <TurnEventList
          isActive={false}
          isStreaming={false}
          ctx={ctx}
          events={[
            {
              id: "before-report",
              kind: "tool",
              toolCallId: "before-report",
              title: "Read",
              toolKind: "read",
              rawInput: { path: "first.ts" },
              status: "completed",
              createdAt: 1,
              updatedAt: 2,
            },
            {
              ...textMessage(
                "first-report",
                "The first confirmed report stays visible.",
              ),
              phase: "final_answer",
            },
            {
              id: "between-reports",
              kind: "tool",
              toolCallId: "between-reports",
              title: "Read",
              toolKind: "read",
              rawInput: { path: "second.ts" },
              status: "completed",
              createdAt: 3,
              updatedAt: 4,
            },
            {
              ...textMessage(
                "second-report",
                "The second confirmed report stays visible too.",
              ),
              phase: "final_answer",
            },
          ]}
        />
      </div>
    </section>
  );
}
