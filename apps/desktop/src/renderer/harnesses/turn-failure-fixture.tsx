import { useState } from "react";
import type { AgentMessage } from "@zeros/protocol/agent-messages";
import { Button } from "../shared/ui/primitives/button";
import { TurnEventList } from "../features/agent/turn-event-list";
import { TurnFailureCard } from "../features/agent/turn-failure-card";
import { turnFailureForCard } from "../features/agent/turn-failure";
import type { RendererContext } from "../features/agent/renderers/types";

function FailureTranscript({
  provider,
  ctx,
}: {
  provider: string;
  ctx: RendererContext;
}) {
  const turnId = `${provider}-prompt`;
  const [events, setEvents] = useState<AgentMessage[]>(() => [
    {
      id: "tool",
      kind: "tool",
      toolCallId: "tool",
      toolKind: "execute",
      title: "Bash",
      status: "failed",
      rawInput: { command: "pnpm verify" },
      rawOutput: "Verification failed",
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "native-error",
      kind: "error_notice",
      severity: "error",
      recoverable: false,
      message: `${provider}: Selected model is at capacity.`,
      createdAt: 2,
    },
    {
      id: "turn-error",
      kind: "error_notice",
      severity: "error",
      recoverable: false,
      message: `${provider}: Selected model is at capacity.`,
      createdAt: 3,
      turnFailure: { turnId, kind: "protocol-error" },
    },
  ]);
  const [revision, setRevision] = useState(0);
  const [live, setLive] = useState(true);
  const failure = turnFailureForCard({
    events,
    turnId,
    status: "failed",
    live,
  });
  return (
    <section data-failure-provider={provider}>
      <Button onClick={() => setLive(false)}>Settle {provider} turn</Button>
      <Button
        onClick={() => {
          setEvents(JSON.parse(JSON.stringify(events)));
          setRevision((value) => value + 1);
        }}
      >
        Reload {provider} history
      </Button>
      <TurnEventList
        key={revision}
        events={events}
        failureTurnId={turnId}
        isActive={true}
        isStreaming={live}
        showActivity={false}
        ctx={ctx}
        footer={
          failure && (
            <TurnFailureCard
              failure={failure}
              onRetry={() => {}}
              onRetryNewChat={() => {}}
            />
          )
        }
      />
    </section>
  );
}

export function TurnFailureFixture({ ctx }: { ctx: RendererContext }) {
  return (
    <section
      id="turn-failure-fixture"
      className="mx-auto flex w-full max-w-3xl flex-col gap-4"
    >
      {["Claude", "Codex", "Cursor"].map((provider) => (
        <FailureTranscript key={provider} provider={provider} ctx={ctx} />
      ))}
    </section>
  );
}
