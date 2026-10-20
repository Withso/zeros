import { expect } from "@playwright/test";

/** Real composer/store presentation. The native retirement and original Stop
 * operation are verified by the bridge and provider callback regressions. */
export async function checkCloudStopPending({ page, check, screenshotDir }) {
  const submit = page.locator('[data-slot="prompt-input"]:visible button[type="submit"]');
  const stopIcon = submit.locator("svg.lucide-square");
  const notice = page.locator("[data-cloud-stop-notice]:visible");
  const expectStop = async () => {
    await expect(submit).toBeVisible(); await expect(submit).toBeEnabled(); await expect(stopIcon).toBeVisible();
    await submit.hover(); await page.clock.runFor(200);
    await expect(page.getByRole("tooltip")).toContainText("Stop agent");
    await page.mouse.move(0, 0); await page.clock.runFor(200);
  };
  await page.evaluate(async () => {
    const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
    const store = useSessionsStore.getState(), startedAt = Date.now() - 20_000;
    store.patchSession("composer-chat-0", { status: "streaming", foregroundTurnId: "stop-turn",
      activeTurnStartedAt: startedAt, cloudStop: { operationId: "11111111-1111-4111-8111-111111111111", turnId: "stop-turn", state: "pending" },
      messages: [{ id: "stop-turn", kind: "text", role: "user", text: "Keep this accepted turn visible", createdAt: startedAt }] });
  });
  await expectStop(); await expect(notice).toHaveCount(0);
  for (const source of ["snapshot", "revocation", "exit", "unconfirmed"]) {
    await page.evaluate(async source => {
      const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      const store = useSessionsStore.getState();
      if (source === "snapshot") store.installCloudSnapshot("composer-chat-0", {
        version: 1, conversationId: "composer-chat-0", agentId: "codex", executionId: "fixture-session", session: null,
        initialize: null, activeTurn: null, messages: [], permissions: [], questions: [],
      });
      if (source === "revocation") store.applyBridgeBoundaryStatus("codex", "fixture-session", {
        version: 1, actor: "agent-code", state: "revoked", backend: "cloud-worker", checkedAt: Date.now(),
        designProtection: { required: false, enforced: false, protectedDirectoryCount: 0 }, parity: { level: "full", restrictions: [] },
      });
      if (source === "exit") store.applyBridgeAgentExit("codex", "fixture-session");
      if (source === "unconfirmed") store.patchSession("composer-chat-0", {
        cloudStop: { ...store.sessions["composer-chat-0"].cloudStop, state: "unconfirmed" },
        error: "Stop could not be confirmed. Reconnect to check this turn.",
        failure: { kind: "transport-closed", stage: "cancel", agentId: "codex", message: "Stop could not be confirmed. Reconnect to check this turn." },
      });
    }, source);
    await expectStop();
    expect(await page.evaluate(async () => {
      const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      const slot = useSessionsStore.getState().sessions["composer-chat-0"];
      return { turnId: slot.foregroundTurnId, operationId: slot.cloudStop?.operationId, hasClock: slot.activeTurnStartedAt !== null };
    })).toEqual({ turnId: "stop-turn", operationId: "11111111-1111-4111-8111-111111111111", hasClock: true });
  }
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("Stop could not be confirmed. Reconnect to check this turn.");
  await expect(notice.getByRole("button", { name: "Retry Stop", exact: true })).toBeEnabled();
  for (const placement of ["Local", "Organization local"]) {
    await page.getByRole("button", { name: placement, exact: true }).click();
    await expect(stopIcon).toHaveCount(0); await expect(notice).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Cloud", exact: true }).click();
  await expectStop(); await expect(notice).toHaveCount(1);
  await page.getByRole("button", { name: "Remount chat", exact: true }).click();
  await expectStop(); await expect(notice).toHaveCount(1);
  if (screenshotDir) await page.screenshot({ path: screenshotDir + "/cloud-stop-unconfirmed.png", animations: "disabled" });
  await page.evaluate(async () => {
    const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
    useSessionsStore.getState().patchSession("composer-chat-0", { cloudStop: undefined, status: "ready",
      activeTurnStartedAt: null, error: null, failure: null, lastStopReason: "cancelled" });
  });
  await expect(stopIcon).toHaveCount(0); await expect(notice).toHaveCount(0);
  check("Cloud Stop retains its control, clock and visible recovery through reattachment, native exit, revocation and Local/cloud switching until exact retirement", true);
}
