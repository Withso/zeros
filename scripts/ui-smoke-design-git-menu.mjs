import { expect } from "@playwright/test";

export async function runDesignGitMenuSmoke({ page, check }) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`, { waitUntil: "networkidle" });
  const trigger = page.getByRole("button", { name: "Review Design changes", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Review Design changes", exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate(element => {
    const style = getComputedStyle(element);
    return { width: style.width, height: style.height };
  })).toEqual({ width: "640px", height: "480px" });
  await expect.poll(() => page.evaluate(() => {
    const surface = document.elementFromPoint(10, 10);
    if (!surface) return null;
    const style = getComputedStyle(surface);
    return { background: style.backgroundColor, backdropFilter: style.backdropFilter };
  })).toEqual({ background: "rgba(0, 0, 0, 0)", backdropFilter: "none" });
  check("Design review is a compact dialog with an undimmed canvas", true);
  await dialog.getByRole("button", { name: "Current canvas", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+Z");
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => page.evaluate(() => window.__zerosHarnessDesignShortcutOperations)).toEqual([]);
  check("Review owns keyboard focus without invoking canvas undo or save", true);
  await expect(dialog.getByRole("button", { name: "Commit staged Design changes" })).toBeDisabled();
  await dialog.getByRole("button", { name: /home.html/ }).click();
  await expect(dialog.getByLabel("Design source diff")).toContainText("Refined");
  await dialog.getByLabel("Back to changes").click();
  await dialog.getByLabel("Stage Design changes", { exact: true }).click();
  await expect(dialog.getByLabel("Commit staged Design changes")).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.__zerosHarnessDesignShortcutOperations)).toEqual(["stage:start", "stage:end"]);
  check("Design review shows source changes and stages without committing", true);

  await dialog.getByLabel("Unstage Design changes").click();
  await expect(dialog.getByLabel("Commit staged Design changes")).toBeDisabled();
  await dialog.getByLabel("Stage Design changes", { exact: true }).click();
  await expect(dialog.getByLabel("Commit staged Design changes")).toBeEnabled();
  await dialog.getByLabel("Design commit message").fill("Review Design checkpoint");
  await page.evaluate(() => { window.__zerosHarnessDesignCommitFailure = true; });
  await dialog.getByLabel("Commit staged Design changes").click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Staging changed" })).toBeVisible();
  await expect(dialog.getByLabel("Design commit message")).toHaveValue("Review Design checkpoint");
  await page.evaluate(() => { window.__zerosHarnessDesignCommitFailure = false; });
  await expect(dialog.getByLabel("Commit staged Design changes")).toBeEnabled();
  await dialog.getByLabel("Commit staged Design changes").click();
  await expect(dialog.getByLabel("Commit staged Design changes")).toBeDisabled();
  await expect(dialog.getByRole("status")).toContainText("committed");
  check("Design review keeps unstage and commit as separate explicit actions", true);

  await dialog.getByLabel("Design change scope").click();
  await page.getByRole("option", { name: /Agent proposals/ }).click();
  await dialog.getByRole("button", { name: /Refine the heading spacing/ }).click();
  await expect(dialog.getByText("Validated against the current source.", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Capture preview", exact: true }).click();
  await expect(dialog.getByRole("img", { name: "Design before proposal" })).toBeVisible();
  await expect(dialog.getByRole("img", { name: "Design with proposal" })).toBeVisible();
  check("Review displays source-bound before and proposed captures without executing HTML", true);
  await dialog.getByRole("button", { name: "Accept proposal", exact: true }).click();
  await expect(dialog.getByText("Accepted in Design mode", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Accept proposal", exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Commit staged Design changes")).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.__zerosHarnessDesignShortcutOperations?.filter(value => value === "proposal:accept").length)).toBe(1);
  check("Human proposal acceptance updates source separately from Git staging", true);

  await page.setViewportSize({ width: 360, height: 480 });
  await expect(dialog.getByRole("navigation", { name: "Design pages" })).toBeHidden();
  await expect.poll(() => dialog.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const footer = element.querySelector(".design-review-footer")?.getBoundingClientRect();
    const body = element.querySelector(".design-review-body");
    return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 &&
      rect.bottom <= innerHeight && !!footer && footer.bottom <= rect.bottom &&
      !!body && body.clientHeight > 0 && element.scrollWidth === element.clientWidth;
  })).toBe(true);
  await expect(dialog.getByLabel("Design commit message")).toBeInViewport();
  await expect(dialog.getByLabel("Commit staged Design changes")).toBeInViewport();
  await dialog.getByLabel("Back to changes").click();
  await dialog.getByLabel("Design change scope").click();
  await page.getByRole("option", { name: /Unstaged/ }).click();
  await expect(dialog.getByLabel("Design change scope")).toContainText("Unstaged");
  check("Compact review keeps its controls and comparison menu usable in a narrow window", true);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(10, 10);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  check("Design review preserves keyboard focus and protects against accidental backdrop dismissal", true);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+Z");
  await expect.poll(() => page.evaluate(() => window.__zerosHarnessDesignShortcutOperations?.slice(-2))).toEqual(["undo:start", "undo:end"]);
  check("Closing review restores normal canvas keyboard commands", true);

  // Snapshot failures keep their ordinary retry feedback after the private
  // draft/recovery workflow is retired.
  await page.evaluate(async () => {
    const { refreshDesignWorkspaceSnapshot } = await import(
      "/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts"
    );
    // Fail the transport, including an already-queued refresh from Undo.
    // Injecting only a cache error lets that successful refresh erase the
    // simulated failure before the user can exercise Retry.
    window.__zerosHarnessDesignSnapshotFailure = true;
    await refreshDesignWorkspaceSnapshot("ws_design_harness").catch(() => {});
  });
  const failure = page.getByText("Design needs attention", { exact: true });
  await expect(failure).toBeVisible();
  await page.evaluate(() => { window.__zerosHarnessDesignSnapshotFailure = false; });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(failure).toHaveCount(0);
  await expect(trigger).toBeVisible();
  check("Design snapshot failures retain retry feedback without private-store recovery choices", true);
}
