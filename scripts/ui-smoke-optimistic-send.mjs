import { expect } from "@playwright/test";

/** Native/FIFO races are exercised by the production callback tests. Here the
 * real AgentChat proves the same provisional rows are visible before an ACK. */
export async function checkOptimisticSendPresentation({ page, check, screenshotDir }) {
  for (const [placement, index] of [["Cloud", 0], ["Local", 1], ["Organization local", 2]]) {
    await page.getByRole("button", { name: placement, exact: true }).click();
    const transcript = page.locator(".zeros-agent-messages:visible");
    await page.evaluate(async index => {
      const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      const store = useSessionsStore.getState(), chatId = `composer-chat-${index}`, now = Date.now();
      store.patchSession(chatId, { status: "warming", activeTurnStartedAt: now,
        messages: [{ id: "opening", kind: "text", role: "user", text: "Start this task now", createdAt: now,
          queued: true, queuedPresentation: "active-turn" }],
        ...(index === 0 ? { cloudSendWait: { state: "waiting" } } : {}) });
      store.setPendingLocalTurn(chatId, "opening");
    }, index);
    if (index === 0) {
      await expect(transcript.getByText("Start this task now", { exact: true })).toHaveCount(0);
      await expect(page.locator('[data-queued-id="opening"]:visible')).toContainText("Start this task now");
    } else {
      await expect(transcript.getByText("Start this task now", { exact: true })).toBeVisible();
      await expect(page.locator("[data-queued-id]:visible")).toHaveCount(0);
    }

    await page.evaluate(async index => {
      const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      const store = useSessionsStore.getState(), chatId = `composer-chat-${index}`, now = Date.now();
      store.patchSession(chatId, { status: "streaming", cloudSendWait: undefined, messages: [
        { id: "opening", kind: "text", role: "user", text: "Start this task now", createdAt: now },
        { id: "steering", kind: "text", role: "user", text: "Use the smaller change", createdAt: now + 1,
          queued: true, queuedDelivery: "sending", steeredTurnId: "opening" },
        { id: "queued", kind: "text", role: "user", text: "Deliberately saved for later", createdAt: now + 2, queued: true },
      ] });
    }, index);
    if (index === 0) {
      await expect(transcript.getByText("Use the smaller change", { exact: true })).toHaveCount(0);
      await expect(page.locator('[data-queued-id="steering"]:visible')).toContainText("Use the smaller change");
    } else await expect(transcript.getByText("Use the smaller change", { exact: true })).toBeVisible();
    await expect(page.locator("[data-queued-id]:visible")).toHaveCount(index === 0 ? 2 : 1);
    await expect(page.locator('[data-queued-id="queued"]:visible')).toContainText("Deliberately saved for later");
    await page.evaluate(() => { window.optimisticBubbleNode = document.querySelector('[data-checkpoint-id="steering"] .zeros-agent-turn-prompt'); });
    await page.evaluate(async index => {
      const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      const store = useSessionsStore.getState(), chatId = `composer-chat-${index}`;
      store.patchSession(chatId, { messages: store.sessions[chatId].messages.map(message => message.id === "steering"
        ? { ...message, queued: false, queuedDelivery: undefined } : message) });
    }, index);
    await expect(transcript.getByText("Use the smaller change", { exact: true })).toBeVisible();
    if (index !== 0) expect(await page.evaluate(() => window.optimisticBubbleNode != null &&
      window.optimisticBubbleNode === document.querySelector('[data-checkpoint-id="steering"] .zeros-agent-turn-prompt'))).toBe(true);
    if (screenshotDir && index === 0) await page.screenshot({ path: `${screenshotDir}/optimistic-cloud-steering.png`, animations: "disabled" });
    check(index === 0 ? "Cloud: opening and steering messages stay queued until acceptance; confirmed messages then enter the transcript" :
      `${placement}: opening and steering bubbles paint before consumption; ACK retains the bubble and explicit Queue stays separate`, true);
  }
}
