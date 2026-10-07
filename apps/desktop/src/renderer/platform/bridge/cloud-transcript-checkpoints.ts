import type { WorkspaceRuntimeClient } from "./workspace-runtime-client";

type Selection = { activeChatId: string | null; activePage: string };
type SelectionSource = { subscribe: (listener: (state: Selection, previous: Selection) => void) => () => void };

/** One root subscription owns passive checkpoints for retained chat surfaces. */
export function wireCloudTranscriptCheckpoints(client: WorkspaceRuntimeClient, selection: SelectionSource): () => void {
  const stops = [
    selection.subscribe((state, previous) => {
      if (previous.activeChatId && (state.activeChatId !== previous.activeChatId ||
          previous.activePage === "workspace" && state.activePage !== "workspace"))
        client.checkpointCloudTranscript(previous.activeChatId);
    }),
    ...["AGENT_PROMPT_COMPLETE", "AGENT_PROMPT_FAILED"].map(type => client.on(type, message => {
      const chatId = (message as unknown as { chatId?: unknown }).chatId;
      if (typeof chatId === "string") client.checkpointCloudTranscript(chatId);
    })),
  ];
  return () => { for (const stop of stops) stop(); };
}
