import { expect } from "@playwright/test";

/** Actual native scrolling must jump directly; distant targets never glide. */
export async function checkInstantCheckpointNavigation({ page, check }) {
  for (const [placement, index] of [["Cloud", 0], ["Local", 1], ["Organization local", 2]]) {
    // Each placement starts with a fresh surface: a previous case's hover
    // portal must not become the next case's pointer target under a paused clock.
    await page.mouse.move(8, 8);
    await page.reload();
    await page.getByRole("button", { name: placement, exact: true }).click();
    await page.evaluate(async index => {
      const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      useSessionsStore.getState().patchSession(`composer-chat-${index}`, { status: "ready", transcriptState: "resident",
        transcriptPresentation: null, historyExpanded: false, messages: Array.from({ length: 40 }, (_, row) => ({
          id: `nav-${row}`, kind: "text", role: row % 2 === 0 ? "user" : "agent",
          text: row % 2 === 0 ? `Navigator prompt ${row / 2}` : `Navigator response ${Math.floor(row / 2)}. `.repeat(12), createdAt: row + 1,
        })) });
    }, index);
    const surface = page.locator(".zeros-agent-surface:visible");
    const first = surface.getByRole("button", { name: "Jump to: Navigator prompt 0", exact: true });
    await expect(first).toBeVisible();
    await page.clock.runFor(1000);
    await surface.locator(".zeros-agent-body").evaluate(element => {
      element.scrollTop = element.scrollHeight;
      const original = element.scrollTo.bind(element);
      window.checkpointScrollCalls = [];
      element.scrollTo = options => { window.checkpointScrollCalls.push(options); original(options); };
    });
    await page.clock.runFor(32);
    if (placement === "Local") {
      await first.hover();
      await page.clock.runFor(200);
      await page.getByRole("button", { name: "Navigator prompt 0", exact: true }).click();
    } else {
      await first.click();
    }
    const calls = await page.evaluate(() => window.checkpointScrollCalls);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => call.behavior === "auto")).toBe(true);
    await page.clock.runFor(32);
    await expect(first).toHaveAttribute("aria-current", "true");
    const offset = await surface.locator(".zeros-agent-body").evaluate(element => {
      const target = element.querySelector('[data-checkpoint-id="nav-0"]');
      return target.getBoundingClientRect().top - element.getBoundingClientRect().top;
    });
    expect(Math.abs(offset - 12)).toBeLessThanOrEqual(6);
    check(`${placement}: a distant navigator target jumps directly and stays pinned without smooth scrolling`, true);
  }
}
