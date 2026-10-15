import { expect } from "@playwright/test";

/** The real AgentChat must remain visibly live across tool boundaries,
 * reconnect, retained-view switches and an older terminal receipt. */
export async function checkRunningTurnPresentation({ page, check, screenshotDir }) {
  for (const agentId of ["codex", "claude", "cursor"]) {
    for (const [placement, index] of [["Cloud", 0], ["Local", 1], ["Organization local", 2]]) {
      await page.getByRole("button", { name: placement, exact: true }).click();
      await page.evaluate(async ({ index, agentId }) => {
        const { useSessionsStore, BLANK } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
        const store = useSessionsStore.getState(), chatId = `composer-chat-${index}`, slot = store.sessions[chatId];
        const startedAt = Date.now() - 20_000, route = `running-route-${index}`;
        store.setPendingLocalTurn(chatId, null);
        store.setSession(chatId, { ...BLANK, cwd: slot.cwd, agentId, agentName: agentId,
          sessionId: route, executionId: route, status: "ready", transcriptState: "resident", messages: [
            { id: "current", kind: "text", role: "user", text: "Inspect the project", createdAt: startedAt },
            { id: "working-tool", kind: "tool", toolCallId: "working-tool", title: "Read project files", toolKind: "read",
              status: "in_progress", createdAt: startedAt + 1, updatedAt: startedAt + 1 },
          ] });
        store.applyBridgeUpdate({ chatId, sessionId: route, update: {
          sessionUpdate: "turn_state", turnId: "current", state: "running", startedAt,
        } });
      }, { index, agentId });
      const working = page.locator('[aria-label="Agent working"]');
      await expect(working).toHaveCount(1);
      await expect(working).toBeVisible();
      await page.evaluate(async index => {
        const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
        const store = useSessionsStore.getState(), chatId = `composer-chat-${index}`, slot = store.sessions[chatId];
        store.patchSession(chatId, { messages: [...slot.messages.map(message => message.id === "working-tool"
          ? { ...message, status: "completed", settledAt: Date.now() } : message),
          { id: "commentary", kind: "text", role: "agent", phase: "commentary", text: "Checking the next part", createdAt: Date.now() }] });
      }, index);
      await expect(working).toHaveCount(1);
      for (const status of ["reconnecting", "warming"]) {
        await page.evaluate(async ({ index, status }) => {
          const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
          useSessionsStore.getState().patchSession(`composer-chat-${index}`, { status });
        }, { index, status });
        await expect(working).toHaveCount(1);
        await expect(working).toBeVisible();
      }
      await page.evaluate(async index => {
        const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
        const store = useSessionsStore.getState(), chatId = `composer-chat-${index}`, slot = store.sessions[chatId];
        store.applyBridgeUpdate({ chatId, sessionId: slot.sessionId, update: {
          sessionUpdate: "turn_state", turnId: "older", state: "completed", startedAt: slot.activeTurnStartedAt - 10_000,
        } });
      }, index);
      await expect(working).toHaveCount(1);
      const other = index === 0 ? "Local" : "Cloud";
      await page.getByRole("button", { name: other, exact: true }).click();
      await expect(working).toHaveCount(0); // Retained hidden turns have no live timer/loader.
      await page.getByRole("button", { name: placement, exact: true }).click();
      await expect(working).toHaveCount(1);
      await expect(working).toBeVisible();
      if (screenshotDir && index === 0 && agentId === "claude") {
        for (const theme of ["dark", "light"]) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          await page.screenshot({ path: `${screenshotDir}/running-cloud-turn-${theme}.png`, animations: "disabled" });
        }
      }
      await page.evaluate(async index => {
        const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
        const store = useSessionsStore.getState(), chatId = `composer-chat-${index}`, slot = store.sessions[chatId];
        store.applyBridgeUpdate({ chatId, sessionId: slot.sessionId, update: {
          sessionUpdate: "turn_state", turnId: "current", state: "cancelled", startedAt: slot.activeTurnStartedAt,
        } });
      }, index);
      await expect(working).toHaveCount(0);
      await page.evaluate(async index => {
        const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
        useSessionsStore.getState().patchSession(`composer-chat-${index}`, { status: "warming" });
      }, index);
      await expect(working).toHaveCount(0);
      check(`${placement} / ${agentId}: one working indicator survives tools, reconnect and stale completion; hidden and stopped turns stay inert`, true);
    }
  }
}
