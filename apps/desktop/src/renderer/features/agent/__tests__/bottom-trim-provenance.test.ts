import { describe, expect, it } from "vitest";
import { bottomTrimPatch } from "../transcript-paging";
import { BLANK, MAX_MESSAGES_PER_CHAT, useSessionsStore } from "../sessions-store";

const chatId = "cloud:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:chat";
const text = (id: string) => ({ id, kind: "text" as const, role: "agent" as const, text: id, createdAt: 1 });

// Review (outside diff): returning to the bottom trimmed the window with a messages patch, which defaults a slot to
// resident and clears its presentation and dirty flag. A cached (non-resident) transcript then claimed to be
// confirmed live history.
describe("the bottom trim keeps a cached transcript's provenance", () => {
  it("a non-resident cached slot stays non-resident, presented and dirty after the trim", () => {
    const presentation = { source: "cache" as const };
    useSessionsStore.getState().setSession(chatId, { ...BLANK, messages: [text("a"), text("b")], historyExpanded: true,
      transcriptState: "loading", transcriptPresentation: presentation, transcriptDirty: true });
    const slot = useSessionsStore.getState().sessions[chatId];
    useSessionsStore.getState().patchSession(chatId, bottomTrimPatch(slot));
    expect(useSessionsStore.getState().sessions[chatId]).toMatchObject({ historyExpanded: false, transcriptState: "loading",
      transcriptPresentation: presentation, transcriptDirty: true });
    useSessionsStore.getState().removeSession(chatId);
  });

  it("a resident slot keeps today's trim", () => {
    const messages = Array.from({ length: MAX_MESSAGES_PER_CHAT + 2 }, (_, i) => text(`m${i}`));
    const patch = bottomTrimPatch({ ...BLANK, messages, historyExpanded: true, transcriptState: "resident" });
    expect(patch).toEqual({ historyExpanded: false, messages: messages.slice(-MAX_MESSAGES_PER_CHAT) });
  });
});
