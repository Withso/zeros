import { mkdir } from "node:fs/promises";
import { expect } from "@playwright/test";

/** Real composer, session store, IndexedDB journal and HTTPS outbox. The
 * server replies stay held while the first actual rendering frame is sampled. */
export async function checkCloudTurnFeedback({ page, check, harnessBase, screenshotDir }) {
  await page.clock.resume();
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  for (const theme of ["dark", "light"]) {
    let epoch = "0";
    const rows = [], enqueues = [], stops = [];
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS" };
    const reply = (route, json) => route.fulfill({ status: 200, headers, json });
    const pattern = "https://api.example.test/v1/cloud-v2/workspaces/*/prompts**";
    const route = async route => {
      const request = route.request();
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (request.method() === "GET") return reply(route, { epoch, items: rows, nextAfter: null });
      if (new URL(request.url()).pathname.endsWith("/stop")) { stops.push(route); return; }
      const payload = request.postDataJSON();
      const receipt = { workspaceId: "22222222-2222-4222-8222-222222222222", chatId: payload.chatId,
        userMessageId: payload.userMessageId, sequence: String(rows.length + 1), epoch, acceptedAt: new Date().toISOString(), workspaceState: "running" };
      rows.push({ receipt, payload, state: "accepted", cancelRequested: false });
      enqueues.push({ route, receipt });
    };
    await page.route(pattern, route);
    try {
      await page.goto(`${harnessBase}/harness-composer-send-failures.html?cloud-feedback`);
      const editor = page.locator('[data-slot="prompt-input"]:visible').locator("..").locator('[contenteditable="true"]');
      await expect(editor).toBeVisible();
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      // Observe the first bubble commit, then read its first rendering frame.
      // No grace period or elapsed-time advance precedes this measurement.
      await page.evaluate(() => {
        const capture = () => {
          const prompt = document.querySelector(".zeros-agent-turn-prompt");
          const submit = [...document.querySelectorAll('[data-slot="prompt-input-submit"]')].find(button => button.getClientRects().length > 0);
          const editor = [...document.querySelectorAll('[contenteditable="true"]')].find(element => element.getClientRects().length > 0);
          return { bubble: !!prompt, working: !!document.querySelector('[aria-label="Agent working"]'),
            composerEmpty: editor?.textContent.trim() === "",
            stopped: document.body.textContent.includes("STOPPED BY USER"),
            send: submit?.getAttribute("aria-label") === "Send message",
            stop: submit?.getAttribute("data-status") === "streaming",
            footer: !!document.querySelector('[aria-label="Copy output"]'),
            duration: document.querySelector('[aria-label^="Turn usage,"]')?.getAttribute("aria-label") ?? null };
        };
        window.feedbackCapture = capture;
        const observer = new MutationObserver(() => {
          if (!document.querySelector(".zeros-agent-turn-prompt")) return;
          observer.disconnect();
          requestAnimationFrame(() => { window.feedbackSendFrame = capture(); });
        });
        observer.observe(document.body, { subtree: true, childList: true });
      });
      await editor.fill("Inspect the cloud workspace and explain the next change.");
      await editor.press("Enter");
      await expect.poll(() => page.evaluate(() => window.feedbackSendFrame)).toBeTruthy();
      expect(await page.evaluate(() => window.feedbackSendFrame)).toMatchObject({ bubble: true, working: true, stop: true, footer: false, composerEmpty: true });
      await expect.poll(() => enqueues.length).toBe(1);
      expect(await page.evaluate(() => window.composerSendFailureFixture.cloudSession.cloudOutbox.states)).toEqual({});
      check(`${theme}: durable cloud Send clears the composer and paints its bubble and working indicator in the first frame before HTTPS acceptance`, true);
      if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/cloud-working-${theme}.png`, animations: "disabled" });
      await reply(enqueues[0].route, { receipt: enqueues[0].receipt });
      await page.evaluate(() => window.composerSendFailureFixture.refreshCloud());
      await expect.poll(async () => Object.values(await page.evaluate(() => window.composerSendFailureFixture.cloudSession.cloudOutbox.states))).toEqual(["accepted"]);

      const submit = page.locator('[data-slot="prompt-input-submit"]:visible');
      await submit.evaluate(button => {
        button.addEventListener("click", () => {
          requestAnimationFrame(() => { window.feedbackStopFrame = window.feedbackCapture(); });
        }, { once: true, capture: true });
      });
      await submit.click();
      await expect.poll(() => page.evaluate(() => window.feedbackStopFrame)).toBeTruthy();
      const stopped = await page.evaluate(() => window.feedbackStopFrame);
      expect(stopped).toMatchObject({ bubble: true, working: false, stop: false, send: true, stopped: true, footer: true });
      expect(stopped.duration).toMatch(/^Turn usage,/);
      check(`${theme}: Stop's first frame has Send, the stopped pill and frozen footer before the Stop reply`, true);
      if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/cloud-stopped-${theme}.png`, animations: "disabled" });

      await expect.poll(() => stops.length).toBe(1);
      await page.evaluate(() => window.composerSendFailureFixture.cloudNative("running"));
      await expect(page.getByLabel("Agent working", { exact: true })).toHaveCount(0);
      await page.clock.fastForward(2500);
      await expect(page.getByRole("button", { name: stopped.duration, exact: true })).toBeVisible();
      // Native completion wins over the optimistic cancellation, even while
      // both the accepted prompt receipt and the Stop response remain unsettled.
      await page.evaluate(() => {
        window.composerSendFailureFixture.cloudNative("completed");
        requestAnimationFrame(() => { window.feedbackCompletedFrame = window.feedbackCapture(); });
      });
      await expect.poll(() => page.evaluate(() => window.feedbackCompletedFrame)).toBeTruthy();
      expect(await page.evaluate(() => window.feedbackCompletedFrame)).toMatchObject({ working: false, stopped: false, footer: true, duration: stopped.duration });
      expect(Object.values(await page.evaluate(() => window.composerSendFailureFixture.cloudSession.cloudOutbox.states))).toEqual(["accepted"]);
      check(`${theme}: native completion wins before receipt retirement; late running events and time do not restart the stopped clock`, true);
      epoch = "1"; rows[0].state = "completed";
      await reply(stops[0], { chatId: rows[0].receipt.chatId, epoch });
      await page.evaluate(() => window.composerSendFailureFixture.refreshCloud());
      await expect.poll(() => page.evaluate(() => window.composerSendFailureFixture.cloudSession.cloudOutbox.pendingCount)).toBe(0);
    } finally {
      await page.evaluate(() => window.composerSendFailureFixture?.stopRuntime?.());
      await page.unroute(pattern, route);
    }
  }
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
}
