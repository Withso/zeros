import { expect } from "@playwright/test";

export async function runToolWaitSmoke({ page, check }) {
  const fixture = page.locator("#tool-wait-fixture");
  const feed = fixture.locator("#tool-wait-feed");
  const pending = feed.getByRole("button", { name: "Bash gh pr checks 42", exact: true });
  await pending.click();
  await expect(pending).toHaveAttribute("aria-expanded", "true");
  const timer = feed.locator('[aria-live="off"]');
  await expect(feed.getByRole("status", { name: "Agent working", exact: true })).toHaveCount(1);
  await timer.evaluate((element) => { element.dataset.waitTimer = "retained"; });
  await expect(timer).toContainText(/^\d{1,2}m, /);
  const firstTime = await timer.textContent();

  await fixture.getByRole("button", { name: "Show pending checks", exact: true }).click();
  await expect(pending).toHaveAttribute("aria-expanded", "true");
  await expect(pending).toHaveAttribute("aria-description", "Checks are still running.");
  await expect(pending).toHaveText("Bash");
  const detail = page.locator(`[id="${await pending.getAttribute("aria-controls")}"] [data-tool-detail]`);
  await expect(detail).toContainText("Checks are still running.");
  await expect(detail).toContainText("smoke");
  await expect(detail).not.toHaveClass(/text-red-primary/);
  await expect(feed).not.toContainText("Sleep");
  await expect(feed).not.toContainText("durationMs");
  await expect(feed.locator('[data-live-narration="true"]')).toContainText("I will check again shortly.");
  await expect(timer).toHaveAttribute("data-wait-timer", "retained");
  await expect(timer).not.toHaveText(firstTime);
  await expect(fixture.locator("#tool-wait-export")).toContainText("checks pending");
  await expect(fixture.locator("#tool-wait-export")).not.toContainText("Sleep");
  await expect(fixture.locator("#tool-wait-native")).toContainText('"exitCode":8');
  await expect(fixture.locator("#tool-wait-native")).toContainText('"status":"failed"');
  await expect(fixture.locator("#tool-wait-native")).toContainText('"type":"sleep"');

  await fixture.getByRole("button", { name: "Reload waits", exact: true }).click();
  await expect(pending).toHaveAttribute("aria-expanded", "true");
  await expect(timer).toHaveAttribute("data-wait-timer", "retained");
  await expect(feed).not.toContainText("Sleep");
  await fixture.getByRole("button", { name: "Finish Sleep", exact: true }).click();
  await expect(feed.getByRole("button", { name: "Bash gh pr checks 42 --required", exact: true })).toBeVisible();
  await expect(pending).toHaveAttribute("aria-expanded", "true");
  await expect(timer).toHaveAttribute("data-wait-timer", "retained");
  await expect(feed.getByRole("status", { name: "Agent working", exact: true })).toHaveCount(1);
  await expect(feed).not.toContainText("Sleep");
  check("Pending CI keeps its disclosure and neutral details; native Sleep keeps one ticking activity timer through replay", true);

  const failure = fixture.locator("#tool-wait-real-failure").getByRole("button", { name: "Bash pnpm test", exact: true });
  await expect(failure).toContainText("Error");
  await expect(failure).toHaveAttribute("aria-description", "Tool failed");
  await failure.click();
  await expect(fixture.locator("#tool-wait-real-failure [data-tool-detail]")).toHaveClass(/text-red-primary/);
  await expect(fixture.locator("#tool-wait-real-failure")).toContainText("One test failed.");

  await fixture.getByRole("button", { name: "Finish checks", exact: true }).click();
  await expect(feed.getByRole("status", { name: "Agent working", exact: true })).toHaveCount(0);
  await expect(feed.getByRole("button", { name: "2 tool calls, 1 message", exact: true })).toBeVisible();
  await expect(feed).toContainText("All checks passed.");
  await expect(fixture.locator("#tool-wait-export")).not.toContainText("Sleep");
  await expect(fixture.locator("#tool-wait-native")).toContainText('"type":"sleep"');
  check("Settled history and copy omit routine Sleep while genuine command errors retain red diagnostics", true);

  await fixture.getByRole("button", { name: "Reset wait", exact: true }).click();
  await fixture.getByRole("button", { name: "Show pending checks", exact: true }).click();
  await fixture.getByRole("button", { name: "Stop wait", exact: true }).click();
  await feed.getByRole("button", { name: "2 tool calls, 1 message", exact: true }).click();
  await feed.getByRole("button", { name: "Sleep", exact: true }).click();
  await expect(feed).toContainText("Completion not reported.");
  await expect(feed.getByRole("status", { name: "Agent working", exact: true })).toHaveCount(0);
  await expect(fixture.locator("#tool-wait-export")).toContainText("Sleep");
  check("A stopped wait remains inspectable instead of silently disappearing", true);
}
