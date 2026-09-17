import { useMemo, useState } from "react";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import type { SessionUpdate } from "@zeros/protocol/agent-events";
import { Button } from "../shared/ui/primitives/button";
import { ModelPill } from "../features/agent/composer-pills";
import { EventStripe } from "../features/agent/renderers/event-stripe";
import type { RendererContext } from "../features/agent/renderers/types";

export function ModelFallbackFixture({ ctx }: { ctx: RendererContext }) {
  const [agent, setAgent] = useState("claude");
  const [model, setModel] = useState<string | null>("claude-fable-5");
  const [messages, setMessages] = useState<AgentMessage[]>([
    {
      id: "tool-fallback-agent",
      kind: "tool",
      toolCallId: "fallback-agent",
      title: "Agent",
      toolKind: "subagent",
      status: "completed",
      rawInput: { description: "Fallback audit" },
      createdAt: 1,
      updatedAt: 1,
    },
  ]);
  const accept = (update: SessionUpdate) => {
    if (update.sessionUpdate === "current_model_update") setModel(update.model);
    setMessages((old) =>
      applyUpdate(old, { sessionId: "fallback-fixture", update }),
    );
  };
  const local = () =>
    accept({
      sessionUpdate: "model_fallback",
      noticeId: "local",
      provider: "claude",
      reason: "refusal",
      scope: "local",
      fromModel: "claude-sonnet-5",
      toModel: "claude-opus-5",
      parentToolId: "fallback-agent",
    });
  const global = () => {
    accept({
      sessionUpdate: "current_model_update",
      model: "claude-sonnet-5",
      previousModel: model,
      turnStartedAt: 1,
    });
    accept({
      sessionUpdate: "model_fallback",
      noticeId: "global",
      provider: "claude",
      reason: "refusal",
      scope: "session",
      fromModel: "claude-fable-5",
      toModel: "claude-sonnet-5",
    });
  };
  const codex = () => {
    setAgent("codex");
    accept({
      sessionUpdate: "current_model_update",
      model: "gpt-5.6-sol",
      previousModel: "gpt-6-astra",
      turnStartedAt: 1,
    });
    accept({
      sessionUpdate: "model_fallback",
      noticeId: "codex",
      provider: "codex",
      reason: "cybersecurity",
      scope: "session",
      fromModel: "gpt-6-astra",
      toModel: "gpt-5.6-sol",
    });
  };
  const nested = useMemo(
    () => ({
      ...ctx,
      subagentChildren: new Map([
        [
          "fallback-agent",
          messages.filter(
            (m) => "parentToolId" in m && m.parentToolId === "fallback-agent",
          ),
        ],
      ]),
    }),
    [ctx, messages],
  );
  return (
    <section
      id="model-fallback-fixture"
      className="mx-auto w-full max-w-3xl space-y-4"
    >
      <div className="flex flex-wrap gap-2">
        <Button onClick={local}>Local fallback</Button>
        <Button onClick={global}>Session fallback</Button>
        <Button onClick={codex}>Codex safety fallback</Button>
        <ModelPill
          agentId={agent}
          initialize={null}
          value={model}
          effort="high"
          fast={false}
          onChange={setModel}
          onConfigure={() => {}}
        />
      </div>
      <EventStripe
        events={messages.filter(
          (m) => !("parentToolId" in m) || !m.parentToolId,
        )}
        ctx={nested}
        live
        alwaysExpanded
      />
      <div data-legacy-fallback>
        <EventStripe
          events={[
            {
              id: "legacy-fallback",
              kind: "tool",
              toolCallId: "legacy-fallback",
              title: "Model switched",
              toolKind: "model_switch",
              status: "completed",
              rawInput: {
                fromModel: "claude-opus-5",
              toModel: "claude-haiku-4-5",
              reason: "refusal",
            },
            createdAt: 1,
            updatedAt: 1,
            },
          ]}
          ctx={ctx}
          live={false}
        />
      </div>
    </section>
  );
}
