import { expect } from "@playwright/test";

const SUMMARIES = "/apps/desktop/src/renderer/features/agent/use-chat-transcript-summaries.ts";
const STORE = "/apps/desktop/src/renderer/features/agent/sessions-store.ts";
const FOLDER = "/Users/dev/zeros/workspaces/example/amber";
const PROMPT = "can you research this project??";
/** Dev-mode guard for the grace before the workspace rows stand in. */
const DEV_FALLBACK_GUARD_MS = 1_000;

/** The empty Local chat's block ("Created …" rows or "Add chat transcripts")
 * through the production AgentChat, against an engine whose transcript-list
 * answer is slow: it never stays blank, a sibling chat's prompt appears in the
 * next frame, a remount keeps it, and a restart paints the persisted list
 * before the engine is even asked. */
export async function checkEmptyChatTranscriptRow({ page, check, harnessBase, screenshotDir }) {
  await page.clock.resume();
  // The retained hidden sibling renders its own (correct) empty state; every
  // assertion is about the visible empty chat.
  const pane = page.locator('[data-chat-pane="chat-empty"]');
  const created = pane.getByText("Created", { exact: true });
  const row = pane.getByText("Add chat transcripts", { exact: true });
  const pill = pane.getByRole("button", { name: new RegExp(`transcript of ${PROMPT.replace(/[?]/g, "\\?")}`) });
  const fixture = () => page.evaluate(() => {
    const { summaryReads, firstReadAt, workspaceRowsAt, rowAtFirstRead } = window.transcriptRowFixture;
    return { summaryReads, firstReadAt, workspaceRowsAt, rowAtFirstRead };
  });

  await page.goto(`${harnessBase}/harness-transcript-row.html`);
  await page.evaluate(() => window.transcriptRowFixture.setDelay(3_000));
  // Nothing is remembered for this folder yet: the cold-start grace applies.
  await page.evaluate(async ({ summaries }) => {
    const { flushPersistedTranscriptSummaries } = await import(summaries);
    flushPersistedTranscriptSummaries();
    localStorage.clear();
  }, { summaries: SUMMARIES });
  await page.reload();
  // Dev-mode boot is not part of the measurement; the in-page marks are.
  await expect(created).toBeVisible({ timeout: 15_000 });
  const cold = await fixture();
  expect(cold.summaryReads).toBe(1);
  const fallbackMs = cold.workspaceRowsAt - cold.firstReadAt;
  check("An empty Local chat shows its workspace rows while a slow transcript list is still pending (dev regression guard)",
    fallbackMs < DEV_FALLBACK_GUARD_MS, `${fallbackMs.toFixed(0)} ms after mount, with the list answer held for 3000 ms`);

  // The user sends a first prompt in another chat of this workspace.
  const noted = await page.evaluate(async ({ summaries, folder, prompt }) => {
    const { noteLocalChatPrompt } = await import(summaries);
    const pane = document.querySelector('[data-chat-pane="chat-empty"]');
    const begin = performance.now();
    noteLocalChatPrompt({ chatId: "chat-sender", folder, text: prompt, title: "Untitled", agentId: "codex", agentName: "Codex" });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { ms: performance.now() - begin, shown: pane.textContent.includes("Add chat transcripts") };
  }, { summaries: SUMMARIES, folder: FOLDER, prompt: PROMPT });
  expect(noted.shown).toBe(true);
  await expect(row).toBeVisible();
  await expect(pill).toBeVisible();
  await expect(created).toHaveCount(0);
  check("A prompt sent in a sibling Local chat appears in the empty chat's transcript row within two frames",
    noted.shown, `${noted.ms.toFixed(1)} ms, before the engine's list answered`);
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/empty-chat-transcript-row.png`, animations: "disabled" });

  // A remount (tab switch, deck re-entry) reads the same folder list at once.
  await page.getByRole("button", { name: "Remount chat", exact: true }).click();
  await expect(pill).toBeVisible({ timeout: 300 });

  // The engine reports the same chat: the pill stays and the pending row
  // yields to the engine's.
  await page.evaluate(({ folder, prompt }) => {
    window.transcriptRowFixture.setRows([{ chatId: "chat-sender", title: "Untitled", folder, summary: prompt, summaryAt: 0,
      agentId: "codex", agentName: "Codex", userMessageCount: 1, lastMessageAt: Date.now() }]);
    window.transcriptRowFixture.emit("DB_CHANGED", { kinds: ["messages"], chatIds: ["chat-sender"] });
  }, { folder: FOLDER, prompt: PROMPT });
  await expect.poll(() => page.evaluate(async ({ summaries, folder }) => {
    const { visibleTranscriptSummaries } = await import(summaries);
    return visibleTranscriptSummaries(folder, [], "chat-empty").length;
  }, { summaries: SUMMARIES, folder: FOLDER }), { timeout: 10_000 }).toBe(0);
  await expect(pill).toBeVisible();
  await expect(created).toHaveCount(0);

  // The debounced save lands (an app quit flushes it on page hide).
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((key) =>
    key.endsWith("chat-transcript-summaries-v1") && localStorage.getItem(key).includes('"chat-sender"'))), { timeout: 5_000 }).toBe(true);

  // Restart with the slow engine: the persisted folder list is on screen
  // before the first list request leaves, and the engine still confirms it.
  await page.reload();
  await expect(pill).toBeVisible({ timeout: 15_000 });
  const restarted = await fixture();
  expect(restarted.rowAtFirstRead).toBe(true);
  await expect(created).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.transcriptRowFixture.summaryAnswers), { timeout: 10_000 }).toBe(1);
  await expect(pill).toBeVisible();
  await expect(created).toHaveCount(0);
  check("After a restart the empty chat paints the persisted transcript row before the engine is asked",
    restarted.rowAtFirstRead, "row present when the first list request left; answer held for 3000 ms");

  // A chat known to be empty whose engine read is still pending (a restart
  // while the engine starts) keeps its empty state instead of a blank pane or
  // "Loading conversation…".
  const provisional = await page.evaluate(async ({ store }) => {
    const { useSessionsStore } = await import(store);
    const pane = document.querySelector('[data-chat-pane="chat-empty"]');
    const frames = { total: 0, missing: 0, loading: 0 };
    const sample = () => {
      frames.total += 1;
      if (!pane.textContent.includes("Add chat transcripts")) frames.missing += 1;
      if (pane.querySelector('[aria-label="Loading conversation"]')) frames.loading += 1;
    };
    const sampleFor = (ms) => new Promise((resolve) => {
      const end = performance.now() + ms;
      const tick = () => { sample(); if (performance.now() < end) requestAnimationFrame(tick); else resolve(); };
      requestAnimationFrame(tick);
    });
    useSessionsStore.getState().patchSession("chat-empty", { transcriptState: "loading",
      transcriptPresentation: { source: "cache", empty: true } });
    await sampleFor(600);
    useSessionsStore.getState().patchSession("chat-empty", { transcriptState: "resident", transcriptPresentation: null });
    await sampleFor(100);
    return frames;
  }, { store: STORE });
  await expect(pill).toBeVisible();
  check("A Local chat known to be empty keeps its empty state while its read is pending, without Loading",
    provisional.total > 0 && provisional.missing === 0 && provisional.loading === 0,
    `${provisional.total} frames: ${provisional.missing} without the row, ${provisional.loading} with Loading`);
  await page.evaluate(() => window.transcriptRowFixture.setDelay(0));
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
}
