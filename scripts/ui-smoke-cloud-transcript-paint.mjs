import { expect } from "@playwright/test";

const DEV_PAINT_REGRESSION_GUARD_MS = 250;

/** Uses the production AgentChat and session store in the composer harness.
 * Cache/head eligibility and queued-send authority are covered by the real
 * history/cache and extracted-provider regression suites. Here we measure the
 * actual visible surface with a running browser clock, not a mocked duration. */
export async function checkCloudTranscriptPaint({ page, check, screenshotDir }) {
  await page.clock.resume();
  const loading = page.getByLabel("Loading conversation", { exact: true });
  const samples = [];
  for (const phase of ["waking", "setting_up"]) {
    await page.evaluate(async phase => {
      const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      window.composerSendFailureFixture.publish({ status: phase });
      const store = useSessionsStore.getState();
      // Seed the known-history flag explicitly. patchSession derives it from
      // message mutations, so an empty array on a new slot cannot set it.
      store.setSession("composer-chat-0", { ...store.sessions["composer-chat-0"],
        messages: [], hasTranscript: true, transcriptState: "loading", transcriptPresentation: null });
      useSessionsStore.getState().setScrollPosition("composer-chat-0", phase === "setting_up"
        ? { top: 0, anchorId: "cached-100", anchorOffset: 0, atBottom: false }
        : { top: 0, atBottom: true });
    }, phase);
    await page.getByRole("button", { name: "Remount chat", exact: true }).click();
    await expect(loading).toBeVisible();
    const sample = await page.evaluate(async () => {
      const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      const messages = Array.from({ length: 200 }, (_, index) => ({ id: `cached-${index}`, kind: "text",
        role: index % 2 ? "agent" : "user", text: `Cached transcript row ${index}`, createdAt: index + 1 }));
      const started = performance.now();
      useSessionsStore.getState().patchSession("composer-chat-0", { messages, transcriptState: "loading",
        transcriptPresentation: { source: "cache" }, transcriptDirty: false });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { durationMs: performance.now() - started, authority: useSessionsStore.getState().sessions["composer-chat-0"].transcriptState,
        available: useSessionsStore.getState().sessions["composer-chat-0"].messages.length,
        painted: document.querySelector(".zeros-agent-messages")?.textContent.includes("Cached transcript row"),
        loading: !!document.querySelector('[aria-label="Loading conversation"]') };
    });
    samples.push(sample.durationMs);
    expect(sample.painted).toBe(true);
    expect(sample.authority).toBe("loading");
    expect(sample.available).toBe(200);
    expect(sample.loading).toBe(false);
    await expect(page.getByRole("button", { name: /^Turn usage,/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit message", exact: true })).toHaveCount(0);
    await expect(loading).toHaveCount(0);
    await expect(page.getByText(`Cached transcript row ${phase === "setting_up" ? 100 : 199}`, { exact: true })).toBeVisible();
    await expect(page.locator("[data-checkpoint-id]")).toHaveCount(100);
    expect(await page.locator("[data-transcript-deferred]").count()).toBeGreaterThan(0);
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/cloud-transcript-${phase}.png`, animations: "disabled" });
    await page.evaluate(() => {
      const scroller = document.querySelector(".zeros-agent-body");
      scroller.dispatchEvent(new CustomEvent("zeros-chat-scroll-navigation", { detail: { target: 0 } }));
      scroller.scrollTop = 0;
    });
    await expect(page.getByText("Cached transcript row 0", { exact: true })).toBeVisible();
    await expect(loading).toHaveCount(0);
    if (phase === "setting_up") {
      const stable = await page.evaluate(async () => {
        const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
        const previous = document.querySelector('[data-checkpoint-id="cached-0"] .zeros-agent-turn-prompt');
        const messages = useSessionsStore.getState().sessions["composer-chat-0"].messages;
        useSessionsStore.getState().patchSession("composer-chat-0", { transcriptState: "resident", transcriptPresentation: null });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { node: document.querySelector('[data-checkpoint-id="cached-0"] .zeros-agent-turn-prompt') === previous,
          messages: useSessionsStore.getState().sessions["composer-chat-0"].messages === messages };
      });
      expect(stable).toEqual({ node: true, messages: true });
      await expect(page.locator("[data-transcript-deferred]")).toHaveCount(0);
    }
  }
  // Development React is not the acceptance build. The user-facing <100 ms
  // criterion is measured on the minified production build (see
  // docs/ui-interaction-performance.md); this dev-mode smoke is a regression
  // guard against the original ~850 ms render, with headroom for CI runners.
  check("An eligible 200-row cloud window paints during start/resume without Loading or granting history authority (dev regression guard)",
    samples.every(duration => duration < DEV_PAINT_REGRESSION_GUARD_MS), `visible paint samples (ms): ${samples.map(value => value.toFixed(2)).join(", ")}`);
  check("Cached turns retain scroll-back and the saved reading anchor; unchanged validation keeps visible DOM and message references", true);

  // An invalidated/evicted window has no eligible bytes. It must show truthful
  // unavailability and never borrow content from another owner/placement.
  await page.evaluate(async () => {
    const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
    useSessionsStore.getState().patchSession("composer-chat-0", { messages: [], transcriptState: "loading", transcriptPresentation: null });
  });
  await expect(loading).toBeVisible();
  await expect(page.getByText("Cached transcript row 199", { exact: true })).toHaveCount(0);
  for (const label of ["Local", "Organization local"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(loading).toHaveCount(0);
    await expect(page.getByText("Cached transcript row 199", { exact: true })).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Cloud", exact: true }).click();
  await expect(loading).toBeVisible();
  expect(await page.evaluate(() => window.composerSendFailureFixture.sends)).toBe(0);
  check("Cloud cache misses/invalidation stay truthful and cached rows never cross either Local placement", true);
  // Earlier deterministic scenarios may have advanced the browser clock past
  // wall time. Pause at its next second, never rewind it to the host clock.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
}
