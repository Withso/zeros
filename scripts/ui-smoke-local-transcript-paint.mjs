import { expect } from "@playwright/test";

const DEV_PAINT_REGRESSION_GUARD_MS = 250;
const STORE = "/apps/desktop/src/renderer/features/agent/sessions-store.ts";

/** Local Personal and organization-local chats through the production
 * AgentChat. A cold Local chat paints its remembered window (the Local boot
 * cache) with no "Loading conversation…", stays read-only until the engine
 * confirms it, keeps its DOM through that confirmation, and a window that
 * starts inside one long turn still shows that turn's opening prompt. The
 * provider/cache wiring itself is covered by local-transcript-hydrate.test.ts. */
export async function checkLocalTranscriptPaint({ page, check, screenshotDir }) {
  await page.clock.resume();
  const loading = page.getByLabel("Loading conversation", { exact: true });
  const samples = [];
  for (const [label, chatId] of [["Local", "composer-chat-1"], ["Organization local", "composer-chat-2"]]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.evaluate(async ({ chatId, store }) => {
      const { useSessionsStore } = await import(store);
      useSessionsStore.getState().patchSession(chatId, { messages: [], hasTranscript: true,
        transcriptState: "loading", transcriptPresentation: null });
    }, { chatId, store: STORE });
    // A genuine cold read with nothing remembered stays truthful.
    await expect(loading).toBeVisible();

    const sample = await page.evaluate(async ({ chatId, store }) => {
      const { useSessionsStore } = await import(store);
      const messages = Array.from({ length: 200 }, (_, index) => ({ id: `${chatId}-${index}`, kind: "text",
        role: index % 2 ? "agent" : "user", text: `${chatId} transcript row ${index}`, createdAt: index + 1 }));
      const started = performance.now();
      useSessionsStore.getState().patchSession(chatId, { messages, transcriptState: "loading",
        transcriptPresentation: { source: "cache" }, transcriptDirty: false });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { durationMs: performance.now() - started,
        authority: useSessionsStore.getState().sessions[chatId].transcriptState,
        painted: [...document.querySelectorAll(".zeros-agent-messages")].some(node => node.textContent.includes(`${chatId} transcript row 199`)),
        loading: !!document.querySelector('[aria-label="Loading conversation"]') };
    }, { chatId, store: STORE });
    samples.push(sample.durationMs);
    expect(sample.authority).toBe("loading");
    expect(sample.loading).toBe(false);
    expect(sample.painted).toBe(true);
    await expect(page.getByText(`${chatId} transcript row 199`, { exact: true })).toBeVisible();
    // Provisional rows are presentation only: no edit, usage or reset controls.
    await expect(page.getByRole("button", { name: "Edit message", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Turn usage,/ })).toHaveCount(0);
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/local-transcript-${chatId}.png`, animations: "disabled" });

    // Engine confirmation with unchanged rows keeps the painted DOM.
    const stable = await page.evaluate(async ({ chatId, store }) => {
      const { useSessionsStore } = await import(store);
      const before = document.querySelector(`[data-checkpoint-id="${chatId}-198"]`);
      const messages = useSessionsStore.getState().sessions[chatId].messages;
      useSessionsStore.getState().patchSession(chatId, { messages, transcriptState: "resident", transcriptPresentation: null });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { node: document.querySelector(`[data-checkpoint-id="${chatId}-198"]`) === before && before !== null,
        messages: useSessionsStore.getState().sessions[chatId].messages === messages };
    }, { chatId, store: STORE });
    expect(stable).toEqual({ node: true, messages: true });
    await expect(loading).toHaveCount(0);
  }
  check("A remembered Local window paints without Loading for Personal and organization Local, read-only until confirmed (dev regression guard)",
    samples.every(duration => duration < DEV_PAINT_REGRESSION_GUARD_MS), `visible paint samples (ms): ${samples.map(value => value.toFixed(2)).join(", ")}`);

  // One autonomous turn longer than the window: its opening prompt travels
  // beside the rows and renders as the turn's prompt and checkpoint.
  await page.getByRole("button", { name: "Local", exact: true }).click();
  await page.evaluate(async ({ store }) => {
    const { useSessionsStore } = await import(store);
    const tail = Array.from({ length: 40 }, (_, index) => ({ id: `long-${index}`, kind: "text", role: "agent",
      text: `Long turn output ${index}`, createdAt: 100 + index }));
    useSessionsStore.getState().patchSession("composer-chat-1", { messages: tail,
      leadingPrompt: { id: "long-turn-opening", kind: "text", role: "user", text: "Opening prompt of a long turn", createdAt: 99 },
      transcriptState: "resident", transcriptPresentation: null });
  }, { store: STORE });
  await expect(page.getByText("Opening prompt of a long turn", { exact: true })).toBeVisible();
  await expect(page.locator('[data-checkpoint-id="long-turn-opening"]')).toHaveCount(1);
  await expect(page.getByText("Long turn output 39", { exact: true })).toBeVisible();
  await page.getByText("Opening prompt of a long turn", { exact: true }).scrollIntoViewIfNeeded();
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/local-transcript-long-turn.png`, animations: "disabled" });
  check("A Local window that begins inside one long turn still shows that turn's opening prompt", true);
  expect(await page.evaluate(() => window.composerSendFailureFixture.sends)).toBe(0);
  await page.clock.pauseAt(new Date());
}
