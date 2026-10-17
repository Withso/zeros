import { expect } from "@playwright/test";

/** Drive startup failures in new chats and chats with retained history. */
export async function checkAgentPreparationFailures({ page, check }) {
  const toasts = page.locator("[data-sonner-toast]");
  for (const [index, label] of [[1, "Local"], [2, "Organization local"], [0, "Cloud"]]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    for (const provider of ["claude", "codex", "cursor"]) {
      const patch = async (value) => page.evaluate(async ({ index, value }) => {
        const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
        useSessionsStore.getState().patchSession(`composer-chat-${index}`, value);
      }, { index, value });
      await patch({ agentId: provider, agentName: provider, status: "idle", failure: null, error: null });
      await page.clock.runFor(50);
      await patch({ status: "failed", failure: { kind: "protocol-error", stage: "initialize", message: "The provider could not initialize." } });
      await page.clock.runFor(50);
      await expect(toasts).toHaveCount(0);
      const notice = page.locator("[data-agent-preparation-notice]:visible");
      await expect(notice).toContainText("The provider could not initialize.");
      await page.getByRole("button", { name: "Remount chat", exact: true }).click();
      await expect(toasts).toHaveCount(0);
      await patch({ status: "failed", failure: { kind: "transport-closed", stage: "initialize", message: "Engine reconnecting" } });
      await expect(notice).toHaveCount(0);
      await expect(toasts).toHaveCount(0);
      await patch({ status: "ready", failure: null, error: null });
      for (const status of ["completed", "cancelled", "failed"]) {
        await page.evaluate(async ({ index, provider, status }) => {
          const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
          const { turnRowCache, turnRowKey } = await import("/apps/desktop/src/renderer/state/read-caches.ts");
          const chatId = `composer-chat-${index}`, turnId = `preparation-history-${index}`;
          const store = useSessionsStore.getState();
          const stopReason = status === "completed" ? "end_turn" : status === "cancelled" ? "cancelled" : null;
          turnRowCache.setData(turnRowKey(chatId, turnId), {
            chatId, turnId, workspaceId: null, folder: store.sessions[chatId].cwd,
            agentId: provider, ord: 1, summary: null, startedAt: 1, endedAt: 2,
            status, stopReason, preSnapshot: null, postSnapshot: null, files: [],
          });
          store.patchSession(chatId, {
            messages: [
              { id: turnId, kind: "text", role: "user", text: "Earlier request", createdAt: 1 },
              { id: `preparation-answer-${index}`, kind: "text", role: "agent", text: "Earlier answer", createdAt: 2 },
            ],
            hasTranscript: true, transcriptState: "resident", lastStopReason: stopReason,
          });
        }, { index, provider, status });
        const message = "The provider could not restore this chat.";
        await patch({ status: "failed", failure: { kind: "protocol-error", stage: "loadSession", message }, error: message });
        await page.clock.runFor(50);
        await expect(page.getByText(message, { exact: true }).filter({ visible: true })).toHaveCount(1);
        await expect(notice).toHaveCount(status === "failed" ? 0 : 1);
        await expect(page.locator("[data-turn-failure-card]:visible")).toHaveCount(status === "failed" ? 1 : 0);
        await expect(toasts).toHaveCount(0);
        await page.getByRole("button", { name: "Remount chat", exact: true }).click();
        await expect(page.getByText(message, { exact: true }).filter({ visible: true })).toHaveCount(1);
        await patch({ status: "failed", failure: { kind: "transport-closed", stage: "loadSession", message: "Engine reconnecting" } });
        await expect(notice).toHaveCount(0);
        await patch({ status: "ready", failure: null, error: null });
      }
      await patch({ messages: [], hasTranscript: false, lastStopReason: null });
    }
    await page.evaluate(async ({ index }) => {
      const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      useSessionsStore.getState().patchSession(`composer-chat-${index}`, { agentId: "codex", agentName: "Codex" });
    }, { index });
    check(`${label}: startup failures have one explanation with empty, completed, cancelled and unfinished history for all providers`, true);
  }
}
