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
  const pill = pane.getByRole("button", { name: `transcript of ${PROMPT}` });
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
  await checkCloudTranscriptRow({ page, check, harnessBase, screenshotDir });
  await runTranscriptFocusSmoke({ page, check, harnessBase });
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
}

/** Hold the production transcript read across another edit, then deliver a
 * fork attachment to the same mounted chat without transferring its focus. */
export async function runTranscriptFocusSmoke({ page, check, harnessBase }) {
  for (const cloud of [false, true]) {
    for (const moveFocus of [true, false]) {
      await page.goto(`${harnessBase}/harness-transcript-row.html?focus-races${cloud ? "&cloud" : ""}`);
      const pane = page.locator('[data-chat-pane="chat-empty"]');
      await pane.getByRole("button", { name: /^Attach transcript of Cold focus/ }).click();
      await expect.poll(() => page.evaluate(() => window.transcriptRowFixture.transcriptReleases.length)).toBeGreaterThan(0);
      const other = page.getByRole("textbox", { name: "Other editor" });
      if (moveFocus) await other.fill("A newer edit");
      await page.evaluate(() => {
        const fixture = window.transcriptRowFixture;
        fixture.holdTranscript = false;
        for (const release of fixture.transcriptReleases.splice(0)) release();
      });
      await expect(pane.getByRole("button", { name: /^Remove transcript of Cold focus/ })).toBeVisible();
      await expect(pane.locator(".composer-pm")).toContainText("cold-focus.concise.txt");
      await expect(moveFocus ? other : pane.locator(".composer-pm")).toBeFocused();
      check(`${cloud ? "cloud" : "Local"}: cold transcript attachment ${moveFocus ? "preserves a newer edit" : "completes its uninterrupted focus handoff"}`, true);

      await other.fill("Keep editing here");
      await page.evaluate(async () => {
        const { deliverTextAttachmentToChat } = await import("/apps/desktop/src/renderer/features/agent/composer-text-attachment-delivery.ts");
        const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
        deliverTextAttachmentToChat(useWorkspaceStore.getState().activeChatId, {
          sourceKey: "focus-fork", name: "fork-focus.txt", text: "Completed fork transcript",
        });
      });
      await expect(pane.locator(".composer-pm")).toContainText("fork-focus.txt");
      await expect(other).toBeFocused();
      check(`${cloud ? "cloud" : "Local"}: background fork attachment preserves the current focus`, true);
    }
  }
  await runFileDeliveryFocusSmoke({ page, check, harnessBase });
}

/** Retained delivery is background work even when its destination registers
 * again. Its files append without taking focus or disturbing the draft. */
export async function runFileDeliveryFocusSmoke({ page, check, harnessBase }) {
  for (const cloud of [false, true]) {
    await page.goto(`${harnessBase}/harness-transcript-row.html?focus-races${cloud ? "&cloud" : ""}`);
    const empty = page.locator('[data-chat-pane="chat-empty"]');
    const sender = page.locator('[data-chat-pane="chat-sender"]');
    await empty.locator(".composer-pm").fill("Existing draft");
    await empty.locator(".composer-pm").press("Home");
    const emptyId = await page.evaluate(async () => {
      const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
      return useWorkspaceStore.getState().activeChatId;
    });
    const other = page.getByRole("textbox", { name: "Other editor" });
    await other.fill("Keep this edit");
    const queue = (chatId, name) => page.evaluate(async ({ chatId, name }) => {
      const { deliverFilesToChat } = await import("/apps/desktop/src/renderer/features/agent/composer-file-attachment-delivery.ts");
      return deliverFilesToChat(chatId ?? window.transcriptRowFixture.senderId, {
        id: name, files: [new File(["Queued delivery"], name, { type: "text/plain" })],
      });
    }, { chatId, name });
    expect(await queue(null, "retained-sender.txt")).toBe("queued");
    // A background navigation/recovery publishes the surface without a new
    // pointer or keyboard interaction taking focus from the current editor.
    await page.getByRole("button", { name: "Sender", exact: true }).evaluate(button => button.click());
    await expect(sender.locator(".composer-pm")).toContainText("retained-sender.txt");
    await expect(other).toBeFocused();
    await expect(other).toHaveValue("Keep this edit");

    const remount = page.getByRole("button", { name: "Remount chat", exact: true });
    await remount.click();
    await expect(remount).toBeFocused();
    expect(await queue(emptyId, "retained-empty.txt")).toBe("queued");
    await page.getByRole("button", { name: cloud ? "Empty A" : "Empty", exact: true }).evaluate(button => button.click());
    await expect(empty.locator(".composer-pm")).toContainText("retained-empty.txt");
    await expect(remount).toBeFocused();
    expect(await empty.locator(".composer-pm").innerText()).toMatch(/Existing draft.*retained-empty\.txt/s);
    check(`${cloud ? "cloud" : "Local"}: queued file delivery preserves input and pointer-button focus across retained chat registration`, true);

    await page.getByRole("button", { name: "Deliver files", exact: true }).click();
    await expect(empty.locator(".composer-pm")).toContainText("live-focus.txt");
    await expect(empty.locator(".composer-pm")).toBeFocused();
    check(`${cloud ? "cloud" : "Local"}: a direct file action still focuses the destination composer`, true);

    await other.fill("Newer than the file read");
    await page.evaluate(async (chatId) => {
      const { deliverFilesToChat } = await import("/apps/desktop/src/renderer/features/agent/composer-file-attachment-delivery.ts");
      deliverFilesToChat(chatId, {
        id: "late-file", files: [new File(["Late bytes"], "late-file.txt", { type: "text/plain" })],
      }, { focus: false });
    }, emptyId);
    await expect(empty.locator(".composer-pm")).toContainText("late-file.txt");
    await expect(other).toBeFocused();
    check(`${cloud ? "cloud" : "Local"}: a file producer can complete without reclaiming focus after newer input`, true);
  }
}

async function checkCloudTranscriptRow({ page, check, harnessBase, screenshotDir }) {
  const prompt = "Research the cloud workspace";
  await page.goto(`${harnessBase}/harness-transcript-row.html?cloud&resident&hold`);
  const pane = page.locator('[data-chat-pane="chat-empty"]');
  const pill = pane.getByRole("button", { name: `transcript of ${prompt}` });
  await expect(pill).toBeVisible();
  expect(await page.evaluate(() => ({ first: window.transcriptRowFixture.rowAtFirstRead,
    created: window.transcriptRowFixture.createdCommits, grace: window.transcriptRowFixture.graceTimers })))
    .toEqual({ first: true, created: 0, grace: 0 });
  await page.getByRole("button", { name: "Empty B", exact: true }).click();
  await expect(page.locator('[data-chat-pane="chat-empty-b"]').getByRole("button", { name: `transcript of ${prompt}` })).toBeVisible();
  expect(await page.evaluate(() => window.transcriptRowFixture.summaryReads)).toBe(1);
  expect(await page.evaluate(() => window.transcriptRowFixture.createdCommits)).toBe(0);
  check("Two new cloud tabs paint resident transcript pills before the shared summary read, with no Created/Branched commit or grace timer", true);

  const deleted = await page.evaluate(async () => {
    const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
    const f = window.transcriptRowFixture;
    useWorkspaceStore.getState().dispatch({ type: "DELETE_CHAT", id: f.senderId });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { answers: f.summaryAnswers, pill: document.querySelector('[data-chat-pane="chat-empty-b"]')?.textContent.includes("Add chat transcripts") };
  });
  expect(deleted).toEqual({ answers: 0, pill: false });
  check("Deleting the only memory-seeded cloud transcript removes its pill before the held summary read answers", true);

  await page.goto(`${harnessBase}/harness-transcript-row.html?cloud&resident`);
  await expect(pill).toBeVisible();

  await page.evaluate(prompt => {
    const f = window.transcriptRowFixture;
    f.setRows([{ chatId: f.senderId, folder: f.folder, title: "Untitled", summary: prompt, summaryAt: 0,
      agentId: "codex", agentName: "Codex", userMessageCount: 1, lastMessageAt: 1 }]);
  }, prompt);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("zeros-cloud-transcript-summaries:v1")?.includes("Research the cloud workspace")), { timeout: 10_000 }).toBe(true);

  // No resident prompt survives this navigation: the account envelope is the
  // only synchronous source, and the engine still holds its answer for 3 s.
  await page.goto(`${harnessBase}/harness-transcript-row.html?cloud`);
  await expect(pill).toBeVisible();
  expect(await page.evaluate(() => ({ first: window.transcriptRowFixture.rowAtFirstRead,
    created: window.transcriptRowFixture.createdCommits, grace: window.transcriptRowFixture.graceTimers })))
    .toEqual({ first: true, created: 0, grace: 0 });
  check("A cloud restart paints the account-scoped transcript pills in the first commit while the summary read is held", true);
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/cloud-transcript-row-${theme}.png`, animations: "disabled" });
  }
  await page.evaluate(() => { window.transcriptRowFixture.failSummaries = true; });
  await expect.poll(() => page.evaluate(() => window.transcriptRowFixture.summaryAnswers), { timeout: 10_000 }).toBe(1);
  await expect(pill).toBeVisible();
  expect(await page.evaluate(() => window.transcriptRowFixture.createdCommits)).toBe(0);
  check("A stopped-cloud summary failure keeps the confirmed transcript pills without a workspace-row flash", true);

  await page.evaluate(() => {
    localStorage.removeItem("zeros-cloud-transcript-summaries:v1");
    window.transcriptRowFixture.setRows([]); window.transcriptRowFixture.setDelay(0);
  });
  await page.reload();
  await expect(pane.getByText("Created", { exact: true })).toBeVisible();
  await expect(pane.getByText("Add chat transcripts", { exact: true })).toHaveCount(0);
  check("A cloud workspace containing only untouched Untitled tabs shows workspace rows after a confirmed empty list", true);
}
