import { expect } from "@playwright/test";

export async function runWakeupSmoke({ page, check, capture = async () => {} }) {
  const fixture = page.locator("#wakeup-fixture");
  const transcript = fixture.locator("[data-wakeup-transcript]");
  const waiting = transcript.getByText(/^Waiting for 1 background task/);
  const notice = transcript.locator("[data-wakeup-notice]");
  for (const [source, reset, label] of [
    ["loop", "Reset as loop", "Woke up for “Deployment still provisioning” · due"],
    ["schedule", "Reset as scheduled task", "Scheduled task “Check deployment” · due"],
  ]) {
    await fixture.getByRole("button", { name: reset, exact: true }).click();
    await expect(waiting).toBeVisible();
    await expect(transcript.locator("[data-wakeup-footer]")).toBeVisible();
    await expect(notice).toHaveCount(0);
    await capture(`${source}-waiting`, transcript);
    const settledFooter = await transcript.locator("[data-wakeup-footer]").textContent();
    await fixture.getByRole("button", { name: "Deliver wake-up notice", exact: true }).click();
    await expect(waiting).toBeVisible();
    await expect(notice).toHaveCount(0);
    await expect(transcript.locator("[data-wakeup-footer]")).toHaveText(settledFooter);
    await fixture.getByRole("button", { name: "Start woken work", exact: true }).click();
    await expect(waiting).toHaveCount(0);
    await expect(transcript.locator("[data-wakeup-footer]")).toHaveCount(0);
    await expect(notice).toContainText(label);
    await expect(notice).toHaveAttribute("role", "status");
    await expect(notice.locator("svg")).toHaveAttribute("aria-hidden", "true");
    expect(await notice.evaluate(element => {
      const call = element.closest(".zeros-working-feed")?.querySelector("button");
      return !!call && !!(element.compareDocumentPosition(call) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
    await capture(`${source}-live`, transcript);
    await fixture.getByRole("button", { name: "Finish woken work", exact: true }).click();
    const chip = transcript.getByRole("button", { name: "2 tool calls", exact: true });
    await expect(chip).toBeVisible();
    await expect(notice).toHaveCount(0);
    await expect(transcript.getByText("The deployment is ready. All health checks passed.")).toBeVisible();
    await expect(fixture.locator("[data-wakeup-copy]")).not.toContainText(label);
    await chip.focus();
    await page.keyboard.press("Enter");
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    await expect(notice).toContainText(label);
    await expect(notice.locator("button")).toHaveCount(0);
    await capture(`${source}-settled-expanded`, transcript);
    await page.keyboard.press("Space");
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    await expect(notice).toHaveCount(0);
    check(`${source} wake-up stays out of waiting and copy, starts the live feed, and folds into the unchanged two-call chip`, true);
  }
}
