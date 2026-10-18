// A Local agent's in-flight Write streams onto the canvas: a scriptless draft
// covers the frame while it writes, a file the canvas does not list yet shows
// as a ghost, and the saved generation replaces the draft without a flash.
// Drafts arrive through the production store exactly as DESIGN_AGENT_DRAFT
// messages do; the save is the harness's Design-only refresh.
export async function runDesignAgentDraftsSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );
  const frame = page.locator('[data-design-frame="home.html"]');
  await frame
    .locator('iframe[data-design-document-buffer="displayed"][data-design-document-ready]')
    .first()
    .waitFor({ timeout: 10_000 });
  await page.evaluate(async () => {
    const drafts = await import(
      "/apps/desktop/src/renderer/features/design-workspace/state/design-agent-drafts.ts"
    );
    const cache = await import(
      "/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts"
    );
    const harness = window.__zerosHarnessAgentDrafts;
    harness.useDirectory();
    const doc = (text) =>
      `<!doctype html><html><head><style>body{margin:0;font:48px system-ui}</style></head><body><main><h1 id="draft-title">${text}</h1></main></body></html>`;
    window.__agentDraftSmoke = {
      send(overrides) {
        drafts.receiveDesignAgentDraft(harness.workspaceId, {
          id: "draftHome",
          chatId: "chat-smoke",
          directory: harness.directory,
          file: "home.html",
          operation: "write",
          phase: "writing",
          revision: 1,
          ...overrides,
        });
      },
      doc,
      save(source, sourceVersion) {
        harness.save(source, sourceVersion);
        // The engine's DB_CHANGED { kinds: ["designStyles"] } for this workspace.
        cache.invalidateDesignWorkspacesForStyleBuild([harness.workspaceId]);
      },
    };
  });
  const send = (overrides) =>
    page.evaluate((value) => {
      const smoke = window.__agentDraftSmoke;
      const draft = { ...value };
      if (draft.text !== undefined) {
        draft.preview = {
          srcDoc: smoke.doc(draft.text),
          width: draft.width ?? 1440,
          height: draft.height ?? 900,
          title: draft.title ?? "Launch home",
        };
        delete draft.text;
        delete draft.width;
        delete draft.height;
        delete draft.title;
      }
      smoke.send(draft);
    }, overrides);
  const shownTitle = (selector) =>
    page
      .frameLocator(`${selector} iframe[data-design-agent-draft-buffer="shown"]`)
      .locator("#draft-title");

  await send({ revision: 1, text: "Drafting one" });
  await shownTitle('[data-design-frame="home.html"]').waitFor({ timeout: 5_000 });
  check(
    "a streaming draft covers its frame with a scriptless preview and a status",
    (await frame.locator("[data-design-agent-draft]").count()) === 1 &&
      (await shownTitle('[data-design-frame="home.html"]').textContent()) === "Drafting one" &&
      (await frame.locator("iframe[data-design-agent-draft-buffer]").first().getAttribute("sandbox")) === "" &&
      /Agent writing/.test(
        await frame.locator("[data-design-agent-draft-status]").innerText(),
      ),
  );

  // Every later revision loads beneath the shown one; the draft never blanks.
  await page.evaluate(() => {
    const home = document.querySelector('[data-design-frame="home.html"]');
    window.__agentDraftBuffers = [];
    window.__agentDraftObserver = new MutationObserver(() => {
      window.__agentDraftBuffers.push(
        home.querySelectorAll("iframe[data-design-agent-draft-buffer]").length,
      );
    });
    window.__agentDraftObserver.observe(home, { childList: true, subtree: true, attributes: true });
  });
  await send({ revision: 2, text: "Drafting two" });
  await page.waitForFunction(() => {
    const iframe = document.querySelector(
      '[data-design-frame="home.html"] iframe[data-design-agent-draft-buffer="shown"]',
    );
    return iframe?.getAttribute("srcdoc")?.includes("Drafting two");
  });
  const buffers = await page.evaluate(() => {
    window.__agentDraftObserver.disconnect();
    return window.__agentDraftBuffers;
  });
  check(
    "a newer draft revision swaps in without an empty frame",
    buffers.length > 0 && Math.min(...buffers) >= 1,
  );

  // A file the agent has not registered in meta/canvas.json yet.
  await send({ id: "draftCard", file: "card.html", revision: 1, text: "Card draft", width: 390, height: 844, title: "Card" });
  const ghost = page.locator('[data-design-agent-draft-ghost="card.html"]');
  await ghost.waitFor({ state: "attached", timeout: 5_000 });
  check(
    "an unregistered draft appears as a ghost frame right of the page's frames",
    (await ghost.evaluate((element) => element.style.left)) === "3160px" &&
      (await ghost.evaluate((element) => element.style.width)) === "390px",
  );

  // Hand-off: record what the live frame displayed when the draft let go.
  const savedVersion = "eeeeeeeeeeeeeeeeeeeeeeee";
  await page.evaluate((version) => {
    const home = document.querySelector('[data-design-frame="home.html"]');
    window.__agentDraftHandoff = null;
    const observer = new MutationObserver(() => {
      if (home.querySelector("[data-design-agent-draft]")) return;
      const displayed = home.querySelector('iframe[data-design-document-buffer="displayed"]');
      window.__agentDraftHandoff = {
        version: displayed?.getAttribute("data-design-document-source-version"),
        ready: displayed?.hasAttribute("data-design-document-ready") ?? false,
        expected: version,
      };
      observer.disconnect();
    });
    observer.observe(home, { childList: true, subtree: true });
  }, savedVersion);
  await send({ revision: 3, phase: "saved" });
  await page.evaluate((version) => {
    window.__agentDraftSmoke.save(
      '<!doctype html><html><body style="margin:0"><main data-oid="home-main" data-zeros-frame-root><h1 data-oid="home-heading">Saved by agent</h1></main></body></html>',
      version,
    );
  }, savedVersion);
  await page.waitForFunction(() => window.__agentDraftHandoff !== null, undefined, { timeout: 10_000 });
  const handoff = await page.evaluate(() => window.__agentDraftHandoff);
  check(
    "the saved generation is painted before the draft retires",
    handoff.version === handoff.expected && handoff.ready,
  );
  check(
    "the live frame shows the agent's saved content",
    (await page
      .frameLocator(
        '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]',
      )
      .locator('[data-oid="home-heading"]')
      .textContent()) === "Saved by agent",
  );

  await send({ id: "draftCard", file: "card.html", revision: 2, phase: "discarded" });
  await ghost.waitFor({ state: "detached", timeout: 5_000 });
  check("a discarded unsaved draft leaves the canvas", (await ghost.count()) === 0);
}
