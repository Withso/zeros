import { expect } from "@playwright/test";

/** Unknown coverage is not perpetual work. Keep readable rows and make an
 * empty unknown transcript recoverable without claiming it is empty. */
export async function checkTranscriptResumePresentation({ page, check, screenshotDir }) {
  const unavailable = page.getByRole("status", { name: "Chat history unavailable", exact: true });
  const loading = page.getByLabel("Loading conversation", { exact: true });
  await page.getByRole("button", { name: "Cloud", exact: true }).click();
  await page.evaluate(async () => {
    const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
    const chatId = "composer-chat-0";
    const projection = {
      organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
      generation: 1, engineInstanceId: "33333333-3333-4333-8333-333333333333", bootId: "44444444-4444-4444-8444-444444444444",
      writerEpoch: "55555555-5555-4555-8555-555555555555", fundingOwnerUserId: "66666666-6666-4666-8666-666666666666",
      fundingOwnerEpoch: 1, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
      mirroredSequence: 20, sealedSequence: null, complete: false,
    };
    // The composer harness uses compact chat IDs. Seed the already verified
    // receipt; the scoped bridge/store guards have separate integration tests.
    useSessionsStore.setState(state => ({ cloudHistoryRestoreHeads: { ...state.cloudHistoryRestoreHeads,
      [chatId]: { projection, conversationId: chatId, head: null } } }));
    useSessionsStore.getState().patchSession(chatId, { messages: [], hasTranscript: true,
      transcriptState: "loading", transcriptPresentation: null, status: "ready" });
  });
  await page.clock.runFor(250);
  await expect(unavailable).toBeVisible();
  await expect(page.getByLabel("Catching up conversation", { exact: true })).toHaveCount(0);
  await expect(loading).toHaveCount(0);
  await expect(unavailable.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(page.getByText("Add chat transcripts", { exact: true })).toHaveCount(0);
  await expect(page.getByText("No chat history.", { exact: true })).toHaveCount(0);
  const editor = page.locator('[data-slot="prompt-input"]:visible [contenteditable="true"]');
  await expect(editor).toBeVisible();
  for (const theme of ["dark", "light"]) {
    await page.evaluate(async theme => {
      const { setPrefs } = await import("/apps/desktop/src/renderer/shared/theme/store.ts");
      setPrefs({ mode: theme });
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/transcript-catching-up-${theme}.png`, animations: "disabled" });
  }
  for (const label of ["Local", "Organization local"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(unavailable).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Cloud", exact: true }).click();
  await expect(unavailable).toBeVisible();
  await page.evaluate(async () => {
    const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
    useSessionsStore.getState().patchSession("composer-chat-0", { transcriptState: "resident" });
  });
  await expect(unavailable).toBeVisible();
  await expect(page.getByText("Add chat transcripts", { exact: true })).toHaveCount(0);
  await expect(page.getByText("No chat history.", { exact: true })).toHaveCount(0);
  await page.evaluate(async () => {
    const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
    const chatId = "composer-chat-0";
    useSessionsStore.setState(state => ({ cloudHistoryRestoreHeads: { ...state.cloudHistoryRestoreHeads,
      [chatId]: { ...state.cloudHistoryRestoreHeads[chatId], head: {
        conversationId: chatId, originWriterEpoch: "55555555-5555-4555-8555-555555555555",
        source: { kind: "mutation", mutationId: "77777777-7777-4777-8777-777777777777", operation: "edit" },
        restoreRevision: 3, recordSequence: null, eventSequence: null, manifestSha256: null,
        deleted: false, incompleteReason: "capture_unavailable",
      } } } }));
    // The VM can preserve exact sealed NORMAL rows while the latest FULL head
    // remains incomplete. Residency is independent of completeness.
    useSessionsStore.getState().patchSession("composer-chat-0", {
      messages: Array.from({ length: 17 }, (_, index) => ({ id: `preserved-${index}`, kind: "text",
        role: index % 2 === 0 ? "user" : "agent", text: `Preserved native row ${index}`, createdAt: index + 1 })),
      transcriptState: "resident", transcriptPresentation: null,
    });
  });
  await expect(page.getByText("Preserved native row 16", { exact: true })).toBeVisible();
  await expect(unavailable).toHaveCount(0);
  await expect(page.getByLabel("Catching up conversation", { exact: true })).toHaveCount(0);
  await page.locator(".zeros-agent-body:visible").evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(unavailable).toHaveCount(0);
  for (const theme of ["dark", "light"]) {
    await page.evaluate(async theme => {
      const { setPrefs } = await import("/apps/desktop/src/renderer/shared/theme/store.ts");
      setPrefs({ mode: theme });
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/native-history-unknown-${theme}.png`, animations: "disabled" });
  }
  const retained = await page.evaluate(async () => {
    const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
    const chatId = "composer-chat-0", state = useSessionsStore.getState(), messages = state.sessions[chatId].messages;
    const head = state.cloudHistoryRestoreHeads[chatId];
    const before = { count: messages.length, incompleteReason: head.head.incompleteReason, manifestSha256: head.head.manifestSha256 };
    // A later verified complete head can confirm coverage without replacing
    // the native rows; the renderer does not manufacture that confirmation.
    useSessionsStore.setState({ cloudHistoryRestoreHeads: { ...state.cloudHistoryRestoreHeads,
      [chatId]: { ...head, head: { ...head.head, restoreRevision: 4, recordSequence: 4,
        manifestSha256: "a".repeat(64), incompleteReason: null } } } });
    return { ...before, sameRows: useSessionsStore.getState().sessions[chatId].messages === messages };
  });
  expect(retained).toEqual({ count: 17, incompleteReason: "capture_unavailable", manifestSha256: null, sameRows: true });
  await expect(unavailable).toHaveCount(0);
  check("Unknown history has a quiet empty recovery state; positive native rows never show a permanent coverage spinner", true);

  // A freshly created chat has no known prior history. Hold its initial read
  // beyond the old 180ms loading delay: neither a loader nor a false empty
  // claim should appear. The composer remains available.
  await page.evaluate(async () => {
    const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
    const store = useSessionsStore.getState(), id = "composer-chat-0";
    useSessionsStore.setState({ cloudHistoryRestoreHeads: {} });
    store.setSession(id, { ...store.sessions[id], messages: [], hasTranscript: false,
      transcriptState: "loading", transcriptPresentation: null });
  });
  await page.clock.runFor(3_000);
  await expect(loading).toHaveCount(0);
  await expect(unavailable).toHaveCount(0);
  await expect(editor).toBeVisible();
  await expect(page.getByText("Add chat transcripts", { exact: true })).toHaveCount(0);
  await expect(page.getByText("No chat history.", { exact: true })).toHaveCount(0);
  check("An empty new chat does not announce loading or infer confirmed-empty from a held read", true);

  // Known old history gets a short loading phase, then an honest static
  // recovery state. No transport or authority deadline is changed.
  await page.evaluate(async () => {
    const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
    useSessionsStore.getState().patchSession("composer-chat-0", { hasTranscript: true });
  });
  await page.clock.runFor(250);
  await expect(loading).toBeVisible();
  await page.clock.runFor(3_000);
  await expect(loading).toHaveCount(0);
  await expect(unavailable).toBeVisible();
  await unavailable.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(unavailable).toBeVisible();
  for (const label of ["Local", "Organization local"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.clock.runFor(3_000);
    await expect(loading).toHaveCount(0);
    await expect(unavailable).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Cloud", exact: true }).click();
  await expect(loading).toHaveCount(0);
  await expect(unavailable).toBeVisible();
  const stillUnknown = await page.evaluate(async () => {
    const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
    const state = useSessionsStore.getState();
    return { residency: state.sessions["composer-chat-0"].transcriptState,
      rows: state.sessions["composer-chat-0"].messages.length,
      sends: window.composerSendFailureFixture.sends };
  });
  expect(stillUnknown).toEqual({ residency: "loading", rows: 0, sends: 0 });
  check("A held history read settles to a quiet retry state, stays quiet on reveal, and never changes transcript or send authority", true);

  // The shared UI follows the same new/known distinction for both Local
  // owners. Retire the visible timer while hidden, then catch up immediately
  // from its original deadline instead of showing another loading cycle.
  for (const [label, id] of [["Local", "composer-chat-1"], ["Organization local", "composer-chat-2"]]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.evaluate(async id => {
      const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      const store = useSessionsStore.getState();
      store.setSession(id, { ...store.sessions[id], messages: [], hasTranscript: false,
        transcriptState: "loading", transcriptPresentation: null });
    }, id);
    await page.clock.runFor(3_000);
    await expect(loading).toHaveCount(0);
    await expect(unavailable).toHaveCount(0);
    await page.evaluate(async id => {
      const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      useSessionsStore.getState().patchSession(id, { hasTranscript: true });
    }, id);
    await page.clock.runFor(250);
    await expect(loading).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(loading).toHaveCount(0);
    await page.clock.runFor(3_000);
    await page.evaluate(() => {
      delete document.visibilityState;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(loading).toHaveCount(0);
    await expect(unavailable).toBeVisible();
    await page.evaluate(async id => {
      const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      useSessionsStore.getState().patchSession(id, { transcriptState: "resident" });
    }, id);
    await expect(unavailable).toHaveCount(0);
  }
  check("Both Local owners suppress new-chat loading and settle a held old-history read across window hide/reveal", true);
}
