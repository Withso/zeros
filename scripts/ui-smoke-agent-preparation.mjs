import { expect } from "@playwright/test";

/** Drive the production chat after creation, before a user prompt exists. */
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
    }
    await page.evaluate(async ({ index }) => {
      const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      useSessionsStore.getState().patchSession(`composer-chat-${index}`, { agentId: "codex", agentName: "Codex" });
    }, { index });
    check(`${label}: startup failures stay in the chat and transient reconnects stay quiet for all providers`, true);
  }
}
