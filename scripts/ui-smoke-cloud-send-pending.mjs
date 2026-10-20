import { expect } from "@playwright/test";

/** Real AgentChat/store projection; native preparation and Cancel are covered
 * separately at the production provider callback boundary. */
export async function checkCloudSendPending({ page, check, screenshotDir }) {
  const status = page.locator("[data-queued-messages]:visible");
  const working = page.locator('[aria-label="Agent working"]');
  const transcript = page.locator(".zeros-agent-messages:visible");
  await page.evaluate(async () => {
    const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
    const store = useSessionsStore.getState();
    store.setPendingLocalTurn("composer-chat-0", null);
    store.patchSession("composer-chat-0", { status: "warming", activeTurnStartedAt: null, cloudPromptPending: false,
      cloudSendWait: { state: "waiting", phase: "sending", turnId: "pending", startedAt: Date.now() },
      messages: [{ id: "pending", kind: "text", role: "user", text: "Deliver this prompt", createdAt: Date.now(),
        queued: true, queuedPresentation: "active-turn" }] });
  });
  await expect(transcript.getByText("Deliver this prompt", { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-queued-id="pending"]:visible')).toContainText("Deliver this prompt");
  await expect(status).toHaveCount(1);
  await expect(status).toContainText("Waiting for agent");
  await expect(status.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(working).toHaveCount(0);
  await page.clock.runFor(20_000);
  await expect(working).toHaveCount(0);
  await page.evaluate(async () => {
    const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
    const store = useSessionsStore.getState();
    store.patchSession("composer-chat-0", {
      cloudSendWait: { ...store.sessions["composer-chat-0"].cloudSendWait, phase: "starting-workspace" },
    });
  });
  await expect(status).toContainText("Starting workspace… · 20s");
  await page.clock.runFor(60_000);
  await expect(status).toContainText("Starting workspace… · 1m 20s");
  await page.clock.runFor(70_000);
  await expect(status).toContainText("Starting workspace… · 2m 30s");
  await expect(working).toHaveCount(0);
  if (screenshotDir) for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: `${screenshotDir}/cloud-starting-workspace-${theme}.png`, animations: "disabled" });
  }
  for (const placement of ["Local", "Organization local"]) {
    await page.getByRole("button", { name: placement, exact: true }).click();
    await expect(status).toHaveCount(0);
    await page.clock.runFor(5_000);
    await expect(page.locator("[data-queued-messages]").filter({ hasText: "Starting workspace…" })).toContainText("2m 30s");
  }
  await page.getByRole("button", { name: "Cloud", exact: true }).click();
  await expect(status).toContainText("Starting workspace… · 2m 40s");
  await page.getByRole("button", { name: "Remount chat", exact: true }).click();
  await expect(status).toContainText("Starting workspace… · 2m 40s");
  await expect(transcript.getByText("Deliver this prompt", { exact: true })).toHaveCount(0);
  await expect(status).toContainText("Deliver this prompt");
  await page.evaluate(async () => {
    const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
    useSessionsStore.getState().patchSession("composer-chat-0", {
      status: "ready", cloudSendWait: { state: "failed", turnId: "pending", message: "Couldn't load chat history. Retry to send your message." },
    });
  });
  await expect(status).toContainText("Not sent");
  await expect(status).not.toContainText("Starting workspace");
  await expect(status).not.toContainText("2m 40s");
  await expect(status).toContainText("Couldn't load chat history");
  await expect(status.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(status.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
  await expect(page.locator("[data-turn-failure-card]:visible")).toHaveCount(1);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await expect(working).toHaveCount(0);
  if (screenshotDir) for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: `${screenshotDir}/cloud-not-sent-${theme}.png`, animations: "disabled" });
  }
  await page.getByRole("button", { name: "Remount chat", exact: true }).click();
  await expect(status).toContainText("Not sent");
  await expect(page.locator("[data-turn-failure-card]:visible")).toHaveCount(1);
  await page.evaluate(async () => {
    const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
    const store = useSessionsStore.getState(), slot = store.sessions["composer-chat-0"];
    store.patchSession("composer-chat-0", { cloudSendWait: undefined, status: "streaming", cloudPromptPending: true,
      foregroundTurnId: "pending", activeTurnStartedAt: null,
      messages: slot.messages.map(message => ({ ...message, queued: false })) });
    store.setPendingLocalTurn("composer-chat-0", "pending");
  });
  await expect(status).toContainText("Waiting for agent");
  await expect(transcript.getByText("Deliver this prompt", { exact: true })).toHaveCount(0);
  await expect(status.getByRole("button", { name: "Edit", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(status.getByRole("button", { name: "Delete", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(status.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(working).toHaveCount(0);
  for (const connection of ["reconnecting", "warming"]) {
    await page.evaluate(async connection => {
      const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      useSessionsStore.getState().patchSession("composer-chat-0", { status: connection });
    }, connection);
    await expect(status).toContainText("Waiting for agent");
    await expect(transcript.getByText("Deliver this prompt", { exact: true })).toHaveCount(0);
    await expect(working).toHaveCount(0);
  }
  await page.evaluate(async () => {
    const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
    useSessionsStore.getState().applyBridgeUpdate({ chatId: "composer-chat-0", sessionId: "fixture-session", update: {
      sessionUpdate: "turn_state", turnId: "pending", state: "running", startedAt: Date.now(),
    } });
  });
  await expect(status).toHaveCount(0);
  await expect(working).toHaveCount(1);
  await expect(transcript.getByText("Deliver this prompt", { exact: true })).toBeVisible();
  check("Cloud sends stay in Waiting for agent above the composer through preparation, CP queueing, reconnect, remount and A→B→A; only exact acceptance creates the bubble and timer", true);
}
