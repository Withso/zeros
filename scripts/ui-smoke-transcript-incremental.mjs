import { expect } from "@playwright/test";

export async function checkIncrementalTranscriptPresentation({ page, check }) {
  for (const [placement, index] of [["Cloud", 0], ["Local", 1], ["Organization local", 2]]) {
    await page.getByRole("button", { name: placement, exact: true }).click();
    await page.evaluate(async ({ placement, index }) => {
      const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      useSessionsStore.getState().patchSession(`composer-chat-${index}`, { status: "ready", transcriptState: "resident",
        transcriptPresentation: null, messages: [
          { id: "first-prompt", kind: "text", role: "user", text: `Earlier prompt in ${placement}`, createdAt: 1 },
          { id: "first-answer", kind: "text", role: "agent", text: `Earlier answer in ${placement}`, createdAt: 2 },
          { id: "next-prompt", kind: "text", role: "user", text: "Continue the task", createdAt: 3 },
          { id: "next-answer", kind: "text", role: "agent", text: "Part of the next answer", createdAt: 4 },
        ] });
    }, { placement, index });
    const transcript = page.locator(".zeros-agent-messages:visible");
    await expect(transcript.getByText(`Earlier answer in ${placement}`, { exact: true })).toBeVisible();
    await page.evaluate(async index => {
      const { useSessionsStore, mergeWindowedTail } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      const store = useSessionsStore.getState(), chatId = `composer-chat-${index}`, before = store.sessions[chatId].messages;
      // Restrict node identity to the visible owner's transcript, including
      // when previous owner surfaces remain mounted in this harness.
      window.transcriptRefreshNode = [...document.querySelectorAll('[data-checkpoint-id="first-prompt"] .zeros-agent-turn-prompt')]
        .find(element => element.getBoundingClientRect().height > 0);
      const incoming = JSON.parse(JSON.stringify(before));
      incoming[3].text = "The next answer is complete";
      const messages = mergeWindowedTail(before, incoming);
      window.transcriptRefreshSharesRows = messages[0] === before[0] && messages[1] === before[1] && messages[2] === before[2];
      store.patchSession(chatId, { messages });
    }, index);
    await expect(transcript.getByText("The next answer is complete", { exact: true })).toBeVisible();
    const retained = await page.evaluate(async index => {
      const { useSessionsStore, mergeWindowedTail } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      const store = useSessionsStore.getState(), chatId = `composer-chat-${index}`, current = store.sessions[chatId].messages;
      const node = [...document.querySelectorAll('[data-checkpoint-id="first-prompt"] .zeros-agent-turn-prompt')]
        .find(element => element.getBoundingClientRect().height > 0);
      const unchanged = mergeWindowedTail(current, JSON.parse(JSON.stringify(current)));
      store.patchSession(chatId, { messages: unchanged });
      return { mounted: !!node && node === window.transcriptRefreshNode, rows: window.transcriptRefreshSharesRows, array: unchanged === current };
    }, index);
    expect(retained).toEqual({ mounted: true, rows: true, array: true });
    check(`${placement}: a changed history row preserves earlier rows, mounted turns and unchanged refresh arrays`, true);
  }
}
