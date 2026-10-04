import { expect } from "@playwright/test";

export async function runStickyBottomSmoke({ page, check }) {
  const base = new URL(page.url()).origin;
  await page.goto(`${base}/apps/desktop/src/renderer/harnesses/harness-sticky-bottom.html`);
  const scroller = page.getByTestId("scroller");
  const atBottom = page.getByTestId("at-bottom");
  const gap = () => scroller.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  const grow = () => page.getByTestId("body").evaluate(el => {
    el.style.height = `${Number.parseFloat(el.style.height) + 900}px`;
  });

  // Layout-only growth (text pacing, image decoding, offscreen materialization)
  // does not change the hook's React dependencies.
  await page.getByRole("button", { name: "Jump instantly", exact: true }).click();
  await expect.poll(gap).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Restore latest position", exact: true }).click();
  await grow();
  await expect.poll(gap).toBeLessThanOrEqual(1);
  await expect(atBottom).toHaveText("true");
  check("Following latest survives asynchronous transcript layout growth", true);

  const readingTop = await scroller.evaluate(el => el.scrollTop);
  await page.getByRole("button", { name: "Toggle detail", exact: true }).hover();
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await expect(atBottom).toHaveText("false");
  expect(await scroller.evaluate(el => el.scrollTop)).toBe(readingTop);
  await page.getByRole("button", { name: "Toggle detail", exact: true }).click();
  await expect(atBottom).toHaveText("true");
  check("Opening a detail preserves the reader position and collapse refreshes the jump state", true);

  await page.getByRole("button", { name: "Toggle detail", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(atBottom).toHaveText("false");
  expect(await scroller.evaluate(el => el.scrollTop)).toBe(readingTop);
  await page.keyboard.press("Enter");
  await expect(atBottom).toHaveText("true");
  check("Keyboard disclosure activation preserves the reader position", true);

  await scroller.hover();
  await page.mouse.wheel(0, 150);
  await scroller.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await grow();
  await expect.poll(gap).toBeLessThanOrEqual(1);
  check("A wheel gesture that cannot move past the tail does not disable following", true);

  await scroller.evaluate(el => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })); el.scrollTop = 0; });
  await expect(atBottom).toHaveText("false");
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await expect(atBottom).toHaveText("false");
  await grow();
  await expect.poll(gap).toBeLessThanOrEqual(1);
  await expect(atBottom).toHaveText("true");
  check("Smooth latest navigation follows the current bottom through resizing", true);

  // A reader can cancel a jump immediately; subsequent content must not
  // steal the viewport back. Use an actual browser wheel gesture.
  await scroller.evaluate(el => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })); el.scrollTop = 0; });
  await expect(atBottom).toHaveText("false");
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  await scroller.hover();
  await page.mouse.wheel(0, -250);
  await expect(atBottom).toHaveText("false");
  await expect.poll(gap).toBeGreaterThan(100);
  await grow();
  await page.getByRole("button", { name: "Append event", exact: true }).click();
  await expect(atBottom).toHaveText("false");
  await expect.poll(gap).toBeGreaterThan(100);
  check("Reader scrolling cancels latest navigation and retains reading intent", true);

  await page.getByRole("button", { name: "Toggle surface", exact: true }).click();
  await grow();
  await page.getByRole("button", { name: "Append event", exact: true }).click();
  await expect(atBottom).toHaveText("false");
  await page.getByRole("button", { name: "Toggle surface", exact: true }).click();
  await expect(atBottom).toHaveText("false");
  check("Hidden transcript layout cannot change the saved follow state", true);

  await page.getByRole("button", { name: "Toggle spacer", exact: true }).click();
  await page.getByRole("button", { name: "Jump instantly", exact: true }).click();
  await expect.poll(gap).toBe(500);
  await expect(atBottom).toHaveText("true");
  check("Latest navigation excludes checkpoint spacer geometry", true);

  await page.getByRole("button", { name: "Toggle spacer", exact: true }).click();
  await scroller.evaluate(el => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 })); el.scrollTop = 0; });
  await expect(atBottom).toHaveText("false");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  expect(await gap()).toBeLessThanOrEqual(1);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  check("Reduced motion jumps directly to the current tail", true);

  // Actual skipped-layout boundaries use estimates until Chromium paints
  // them. A single target captured at click time is not the final bottom.
  await page.goto(`${base}/apps/desktop/src/renderer/harnesses/harness-sticky-bottom.html?contained`);
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await expect.poll(gap).toBeLessThanOrEqual(1);
  await expect(atBottom).toHaveText("true");
  await expect(page.getByTestId("tail")).toBeInViewport();
  check("Latest navigation settles through content-visibility estimates", true);

  await page.goto(`${base}/apps/desktop/src/renderer/harnesses/harness-sticky-bottom.html?rail`);
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Jump to: Middle prompt", exact: true }).click();
  const middleOffset = () => scroller.evaluate(el => el.querySelector('[data-checkpoint-id="middle"]').getBoundingClientRect().top - el.getBoundingClientRect().top);
  await expect.poll(middleOffset).toBeGreaterThanOrEqual(0);
  await expect.poll(middleOffset).toBeLessThanOrEqual(16);
  await expect(atBottom).toHaveText("false");
  check("Checkpoint navigation supersedes an unfinished latest jump", true);

  await page.getByRole("button", { name: "Jump to: Start prompt", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await expect.poll(gap).toBeLessThanOrEqual(1);
  // Wait past the rail's fallback correction to prove the old navigation
  // cannot pull the completed latest jump back into history.
  await page.waitForTimeout(800);
  expect(await gap()).toBeLessThanOrEqual(1);
  check("Latest navigation supersedes pending checkpoint corrections", true);

  await page.getByRole("button", { name: "Jump to start", exact: true }).click();
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Jump to start", exact: true }).click();
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBe(0);
  await expect(atBottom).toHaveText("false");
  check("An external navigation cancels the prior latest completion handler", true);

  await page.getByRole("button", { name: "Jump instantly", exact: true }).click();
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find(button => button.textContent === "Jump to start").click();
    requestAnimationFrame(() => {
      const body = document.querySelector('[data-testid="body"]');
      body.style.height = `${Number.parseFloat(body.style.height) + 900}px`;
    });
  });
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBe(0);
  await expect(atBottom).toHaveText("false");
  check("Upward navigation keeps reading intent when layout grows in its first frame", true);

  await page.getByRole("button", { name: "Jump to: Latest prompt", exact: true }).press("Enter");
  const tailOffset = () => scroller.evaluate(el => el.querySelector('[data-checkpoint-id="tail"]').getBoundingClientRect().top - el.getBoundingClientRect().top);
  await expect.poll(tailOffset).toBeGreaterThanOrEqual(0);
  await expect.poll(tailOffset).toBeLessThanOrEqual(16);
  await page.waitForTimeout(800);
  await grow();
  await expect.poll(gap).toBeLessThanOrEqual(1);
  check("Following resumes when streaming consumes a checkpoint spacer", true);

  await page.getByRole("button", { name: "Next message", exact: true }).click();
  await grow();
  await expect.poll(gap).toBeLessThanOrEqual(1);
  check("Next-message navigation already at the tail preserves following", true);

  await page.getByRole("button", { name: "Jump to: Latest prompt", exact: true }).press("Enter");
  await expect.poll(tailOffset).toBeGreaterThanOrEqual(0);
  await expect.poll(tailOffset).toBeLessThanOrEqual(16);
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find(button => button.textContent === "Jump to start").click();
    requestAnimationFrame(() => {
      const body = document.querySelector('[data-testid="body"]');
      body.style.height = `${Number.parseFloat(body.style.height) + 900}px`;
    });
  });
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBe(0);
  await expect(atBottom).toHaveText("false");
  check("Upward navigation out of checkpoint blank space survives concurrent growth", true);

  await page.goto(`${base}/apps/desktop/src/renderer/harnesses/harness-sticky-bottom.html?rail&short`);
  await page.getByRole("button", { name: "Jump to: Latest prompt", exact: true }).press("Enter");
  await expect.poll(tailOffset).toBeGreaterThanOrEqual(0);
  await expect.poll(tailOffset).toBeLessThanOrEqual(16);
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find(button => button.textContent === "Jump to start").click();
    requestAnimationFrame(() => {
      const body = document.querySelector('[data-testid="body"]');
      body.style.height = `${Number.parseFloat(body.style.height) + 900}px`;
    });
  });
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBe(0);
  await expect(atBottom).toHaveText("false");
  check("Home from a short transcript's checkpoint spacer retains upward intent", true);
}
