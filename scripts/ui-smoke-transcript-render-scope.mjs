import { expect } from "@playwright/test";

/** Streaming into the live turn must not re-render settled turns. Each
 *  TurnContainer's committed hook list keeps its identity until React runs the
 *  component again, so comparing it before and after streamed chunks shows
 *  exactly which turns rendered (development build, function names intact).
 *  Re-rendering every settled turn per chunk made the cost of each chunk grow
 *  with the length of the conversation. */
export async function checkStreamingRenderScope({ page, check }) {
  for (const [placement, index] of [["Cloud", 0], ["Local", 1], ["Organization local", 2]]) {
    await page.getByRole("button", { name: placement, exact: true }).click();
    await page.evaluate(async (index) => {
      const { useSessionsStore, BLANK } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      const store = useSessionsStore.getState(), chatId = `composer-chat-${index}`, slot = store.sessions[chatId];
      const startedAt = Date.now() - 60_000, route = `render-scope-route-${index}`, prefix = `scope-${index}`;
      const messages = [];
      for (let turn = 0; turn < 6; turn++) {
        const at = startedAt + turn * 1_000;
        messages.push(
          { id: `${prefix}-prompt-${turn}`, kind: "text", role: "user", text: `Question ${turn}`, createdAt: at },
          { id: `tool-${prefix}-${turn}`, kind: "tool", toolCallId: `${prefix}-tool-${turn}`, title: "Read src/index.ts",
            toolKind: "read", status: "completed", rawInput: { file_path: "src/index.ts" }, rawOutput: "export {};",
            createdAt: at + 1, updatedAt: at + 2, settledAt: at + 2 },
          { id: `${prefix}-answer-${turn}`, kind: "text", role: "agent", text: `Settled answer ${turn} in ${prefix}`,
            messageId: `${prefix}-answer-${turn}`, createdAt: at + 3 },
        );
      }
      // The live turn has already started working, as it has by its second chunk.
      messages.push(
        { id: `${prefix}-prompt-live`, kind: "text", role: "user", text: "Keep going", createdAt: startedAt + 10_000 },
        { id: `tool-${prefix}-live-read`, kind: "tool", toolCallId: `${prefix}-live-read`, title: "Read src/app.ts",
          toolKind: "read", status: "completed", rawInput: { file_path: "src/app.ts" }, rawOutput: "export {};",
          createdAt: startedAt + 10_001, updatedAt: startedAt + 10_002, settledAt: startedAt + 10_002 },
      );
      store.setPendingLocalTurn(chatId, null);
      store.setSession(chatId, { ...BLANK, cwd: slot.cwd, agentId: "codex", agentName: "Codex", sessionId: route,
        executionId: route, status: "ready", transcriptState: "resident", messages });
      store.applyBridgeUpdate({ chatId, sessionId: route, update: {
        sessionUpdate: "turn_state", turnId: `${prefix}-prompt-live`, state: "running", startedAt: startedAt + 10_000,
      } });
    }, index);
    await expect(page.getByText(`Settled answer 5 in scope-${index}`, { exact: true })).toBeVisible();
    const result = await page.evaluate(async (index) => {
      const prefix = `scope-${index}`;
      const host = document.getElementById("root");
      const rootKey = Object.keys(host).find((key) => key.startsWith("__reactContainer$"));
      const fiberRoot = host[rootKey].stateNode;
      const committedTurns = () => {
        const turns = new Map();
        const stack = [fiberRoot.current];
        while (stack.length > 0) {
          const fiber = stack.pop();
          const promptId = fiber.memoizedProps?.turn?.userPrompt?.id;
          // The development bundler may suffix a memo's inner function name.
          if (/^TurnContainer\d*$/.test(fiber.type?.name ?? "") && typeof promptId === "string" && promptId.startsWith(prefix)) {
            turns.set(promptId, fiber.memoizedState);
          }
          if (fiber.sibling) stack.push(fiber.sibling);
          if (fiber.child) stack.push(fiber.child);
        }
        return turns;
      };
      const before = committedTurns();
      const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      const store = useSessionsStore.getState(), chatId = `composer-chat-${index}`;
      const route = store.sessions[chatId].sessionId;
      const updates = [
        { sessionUpdate: "agent_message_chunk", messageId: `${prefix}-live-answer`, content: { type: "text", text: "Streaming " } },
        { sessionUpdate: "tool_call", toolCallId: `${prefix}-live-tool`, title: "Run tests", kind: "execute", status: "in_progress" },
        { sessionUpdate: "tool_call_update", toolCallId: `${prefix}-live-tool`, status: "in_progress", rawOutput: "1 passed" },
        { sessionUpdate: "agent_message_chunk", messageId: `${prefix}-live-answer`, content: { type: "text", text: "more text" } },
      ];
      for (const update of updates) {
        store.applyBridgeUpdate({ chatId, sessionId: route, update });
        // React commits each external-store update in a microtask.
        await Promise.resolve();
        await Promise.resolve();
      }
      const after = committedTurns();
      return {
        settled: [...before.keys()].filter((id) => !id.endsWith("-live")),
        rerendered: [...before.keys()].filter((id) => !id.endsWith("-live") && after.get(id) !== before.get(id)),
        liveRendered: after.get(`${prefix}-prompt-live`) !== before.get(`${prefix}-prompt-live`),
      };
    }, index);
    expect(result.settled).toHaveLength(6);
    expect(result.rerendered).toEqual([]);
    expect(result.liveRendered).toBe(true);
  }
  check("Streaming chunks re-render only the live turn in Cloud, Local and organization-local chats", true);
}
