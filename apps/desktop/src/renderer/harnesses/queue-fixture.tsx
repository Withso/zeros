import { useEffect, useState } from "react";
import {
  useAgentSessions,
  useChatSession,
} from "../features/agent/sessions-hooks";
import { BLANK, useSessionsStore } from "../features/agent/sessions-store";
import { loadAgents } from "../features/agent/agents-cache";
import { QueuedMessagesCard } from "../features/agent/queued-messages-card";
import type { AgentTextMessage } from "../features/agent/use-agent-session";
import { Button } from "../shared/ui";

/** Real provider callbacks and queue controls with deterministic native replies. */
export function QueueFixture({
  provider,
  prompts,
  finish,
  acknowledge,
}: {
  provider: string;
  prompts: string[];
  finish: (sessionId: string) => void;
  acknowledge: (sessionId: string, outcome: string) => void;
}) {
  const chatId = `chat-${provider}`;
  const actions = useAgentSessions();
  const session = useChatSession(chatId);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [, render] = useState(0);
  const queued = session.messages.filter(
    (m): m is AgentTextMessage => m.kind === "text" && m.queued === true,
  );
  useEffect(() => {
    useSessionsStore
      .getState()
      .setSession(chatId, {
        ...BLANK,
        transcriptState: "resident",
        agentId: provider,
        agentName: provider,
        cwd: "/fixture/repository",
      });
    actions.setRetainedChatIds([chatId]);
    void loadAgents(actions.listAgents);
    const update = () => render((value) => value + 1);
    window.addEventListener("queue-fixture-change", update);
    return () => window.removeEventListener("queue-fixture-change", update);
  }, [actions, chatId, provider]);
  const save = () => {
    if (!editing) return;
    actions.editQueued(chatId, editing, { text: draft });
    setEditing(null);
    setDraft("");
    actions.releaseQueue(chatId);
  };
  return (
    <main className="bg-bg1 text-fg1 flex min-h-screen flex-col gap-4 p-6">
      <p>{provider} queue fixture</p>
      <output id="queue-status">{session.status}</output>
      <output id="queue-prompts">{JSON.stringify(prompts)}</output>
      <div className="flex gap-2">
        <Button onClick={() => void actions.cancel(chatId)}>Stop</Button>
        <Button onClick={() => finish(session.sessionId!)}>Finish turn</Button>
        <Button onClick={() => acknowledge(session.sessionId!, "delivered")}>
          Confirm delivery
        </Button>
        <Button onClick={() => acknowledge(session.sessionId!, "queued")}>
          Return to queue
        </Button>
      </div>
      <div className="max-w-xl">
        <QueuedMessagesCard
          messages={queued}
          selectedId={selected}
          editingId={editing}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((value) => !value)}
          onSelect={setSelected}
          onEdit={(id) => {
            actions.holdQueue(chatId);
            setEditing(id);
            setDraft(queued.find((m) => m.id === id)?.text ?? "");
          }}
          onSaveEdit={save}
          saveDisabled={!draft.trim()}
          onDelete={(id) => actions.removeQueued(chatId, id)}
          onSendNow={(id) => void actions.steerQueued(chatId, id)}
          steeringSupported={
            session.initialize?.agentCapabilities?.steering === true
          }
          streaming={session.status === "streaming"}
          paused={session.queuePaused}
          agentName={provider}
        />
        <input
          className="bg-bg2 text-fg1 w-full p-3"
          aria-label="Message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          disabled={!draft.trim()}
          onClick={() => {
            if (editing) save();
            else {
              void actions.sendPrompt(chatId, draft);
              setDraft("");
            }
          }}
        >
          {editing ? "Save message" : "Send message"}
        </Button>
      </div>
    </main>
  );
}
