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

  await runDesignAgentActivitySmoke({ page, check, send });
  await runDesignAgentStylesheetSmoke({ page, check });
}

/** The chip names what the agent writes, places new frames where the canvas
 * document puts them, shows them on request and can follow the agent. */
async function runDesignAgentActivitySmoke({ page, check, send }) {
  const chip = page.locator("[data-design-agent-activity]");
  const label = chip.locator("[data-design-agent-activity-label]");
  await send({ id: "draftList", file: "list.html", revision: 1, text: "List draft", width: 390, height: 844, title: "List" });
  await chip.waitFor({ timeout: 5_000 });
  check(
    "the activity chip names the file the agent is writing",
    (await label.innerText()) === "Writing List" &&
      (await chip.locator("[data-design-agent-activity-show]").isEnabled()),
  );
  const listGhost = page.locator('[data-design-agent-draft-ghost="list.html"]');
  await listGhost.waitFor({ state: "attached", timeout: 5_000 });
  // The canvas document streams in after the HTML: the ghost moves to where
  // the agent registers it, under the registered title.
  await send({
    id: "draftCanvas",
    file: "meta/canvas.json",
    operation: "edit",
    revision: 1,
    registrations: [{ file: "list.html", x: 6000, y: 2400, width: 400, height: 800, title: "Checkout list" }],
  });
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-design-agent-draft-ghost="list.html"]');
    return element?.style.left === "6000px" && element.style.top === "2400px";
  });
  check(
    "a ghost starts where the in-flight canvas document registers it",
    (await listGhost.evaluate((element) => element.style.width)) === "400px" &&
      (await listGhost.innerText()).includes("Checkout list"),
  );
  check(
    "several drafts list in the chip's menu",
    (await label.innerText()) === "Writing Canvas layout" &&
      (await chip.locator("[data-design-agent-activity-more]").count()) === 1,
  );
  const inView = (selector) =>
    page.evaluate((target) => {
      const element = document.querySelector(target);
      const viewport = document.querySelector("[data-design-canvas-viewport]");
      if (!element || !viewport) return false;
      const a = element.getBoundingClientRect();
      const b = viewport.getBoundingClientRect();
      return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
    }, selector);
  const ghostSelector = '[data-design-agent-draft-ghost="list.html"]';
  const before = await inView(ghostSelector);
  await chip.locator("[data-design-agent-activity-show]").click();
  await page.waitForFunction((target) => {
    const element = document.querySelector(target);
    const viewport = document.querySelector("[data-design-canvas-viewport]");
    if (!element || !viewport) return false;
    const a = element.getBoundingClientRect();
    const b = viewport.getBoundingClientRect();
    return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
  }, ghostSelector, { timeout: 5_000 });
  check("Show brings the placed ghost into view", before === false && (await inView(ghostSelector)));

  // Following: each new draft is revealed once, without selecting it.
  await chip.locator("[data-design-agent-activity-follow]").click();
  check(
    "Follow is a pressed toggle",
    (await chip.locator("[data-design-agent-activity-follow]").getAttribute("aria-pressed")) === "true",
  );
  const pricingSelector = '[data-design-frame="pricing.html"]';
  if (await inView(pricingSelector)) {
    // Park the camera on the ghost so the pricing frame starts out of view.
    await chip.locator("[data-design-agent-activity-show]").click();
  }
  const pricingBefore = await inView(pricingSelector);
  await send({ id: "draftPricing", file: "pricing.html", revision: 1, text: "Pricing draft", width: 1440, height: 900, title: "Pricing" });
  await page.waitForFunction((target) => {
    const element = document.querySelector(target);
    const viewport = document.querySelector("[data-design-canvas-viewport]");
    if (!element || !viewport) return false;
    const a = element.getBoundingClientRect();
    const b = viewport.getBoundingClientRect();
    return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
  }, pricingSelector, { timeout: 5_000 });
  check("Following reveals the frame the agent starts writing", pricingBefore === false);
  await chip.locator("[data-design-agent-activity-follow]").click();
  for (const [id, file] of [["draftList", "list.html"], ["draftCanvas", "meta/canvas.json"], ["draftPricing", "pricing.html"]])
    await send({ id, file, revision: 9, phase: "discarded" });
  await chip.waitFor({ state: "detached", timeout: 5_000 });
  check("the chip leaves with the agent's last draft", (await chip.count()) === 0);
}

/** An in-flight linked stylesheet restyles the live frames that link it in
 * place, and a discarded one restores their saved styles. */
async function runDesignAgentStylesheetSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?designTokens`,
    { waitUntil: "networkidle" },
  );
  const frame = page.locator('[data-design-frame="home.html"]');
  await frame
    .locator('iframe[data-design-document-buffer="displayed"][data-design-document-ready]')
    .first()
    .waitFor({ timeout: 10_000 });
  const titleColor = () =>
    page
      .frameLocator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]')
      .locator('[data-oid="home-heading"]')
      .evaluate((element) => getComputedStyle(element).color);
  const saved = await titleColor();
  const send = (draft, holdSaved = false) =>
    page.evaluate(async ({ value, holdSaved }) => {
      const drafts = await import(
        "/apps/desktop/src/renderer/features/design-workspace/state/design-agent-drafts.ts"
      );
      const harness = window.__zerosHarnessAgentDrafts;
      harness.useDirectory();
      drafts.receiveDesignAgentDraft(harness.workspaceId, {
        id: "draftTokens",
        chatId: "chat-smoke",
        directory: harness.directory,
        file: "tokens.css",
        operation: "write",
        ...value,
      }, holdSaved ? Date.now() + 60_000 : undefined);
    }, { value: draft, holdSaved });
  const save = (color, version) => page.evaluate(async ({ color, version }) => {
    const cache = await import(
      "/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts"
    );
    const harness = window.__zerosHarnessAgentDrafts;
    harness.save(
      `<!doctype html><html><head><style data-zeros-source="tokens.css">:root{--brand:${color}}.title{color:var(--brand)}</style></head><body><main data-oid="home-main" data-zeros-frame-root><h1 data-oid="home-heading" class="title">Newer saved ${color}</h1></main></body></html>`,
      version,
    );
    cache.invalidateDesignWorkspacesForStyleBuild([harness.workspaceId]);
  }, { color, version });
  const retire = (id) => page.evaluate(async (id) => {
    const drafts = await import(
      "/apps/desktop/src/renderer/features/design-workspace/state/design-agent-drafts.ts"
    );
    drafts.retireDesignAgentDraft(window.__zerosHarnessAgentDrafts.workspaceId, id);
  }, id);
  const waitForColor = async (expected) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await titleColor() === expected) return true;
      await page.waitForTimeout(100);
    }
    return false;
  };
  await send({
    phase: "writing",
    revision: 1,
    stylesheet: { css: ":root { --brand: green; }\n.title { color: var(--brand); }" },
  });
  let previewed = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    previewed = await titleColor();
    if (previewed === "rgb(0, 128, 0)") break;
    await page.waitForTimeout(100);
  }
  check(
    "an in-flight tokens.css restyles the live frame in place, without reloading it",
    saved !== previewed &&
      previewed === "rgb(0, 128, 0)" &&
      (await frame.locator("iframe[data-design-document-buffer]").count()) === 1 &&
      (await page.locator("[data-design-agent-activity-label]").innerText()) === "Writing tokens.css",
  );
  await send({ phase: "discarded", revision: 2 });
  let restored = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    restored = await titleColor();
    if (restored === saved) break;
    await page.waitForTimeout(100);
  }
  check("a discarded stylesheet draft restores the frame's saved styles", restored === saved);

  await send({
    id: "savedTokens",
    phase: "saving",
    revision: 1,
    stylesheet: { css: ":root { --brand: green; } .title { color: var(--brand); }" },
  });
  check("the next stylesheet draft previews before saving", await waitForColor("rgb(0, 128, 0)"));
  // Hold retirement explicitly across the new generation; no race against
  // the activity chip's 1.5-second linger is needed to reproduce this handoff.
  await send({ id: "savedTokens", phase: "saved", revision: 2 }, true);
  check("a saved stylesheet stays on the old document during handoff", await titleColor() === "rgb(0, 128, 0)");
  const newerVersion = "bbbbbbbbbbbbbbbbbbbbbbbb";
  await save("blue", newerVersion);
  await frame.locator(`iframe[data-design-document-buffer="displayed"][data-design-document-ready][data-design-document-source-version="${newerVersion}"]`).waitFor({ timeout: 10_000 });
  check(
    "a newer saved generation keeps its own CSS while an older saved draft lingers",
    await titleColor() === "rgb(0, 0, 255)" && await page.locator("[data-design-agent-activity]").count() === 1,
  );
  await retire("savedTokens");
  await page.locator("[data-design-agent-activity]").waitFor({ state: "detached", timeout: 5_000 });
  check("retiring the older saved draft preserves the newer saved styles", await titleColor() === "rgb(0, 0, 255)");

  // The file watcher can publish a generation before the tool's success event.
  await send({ id: "lateSave", phase: "saving", revision: 1, stylesheet: { css: ":root { --brand: green; } .title { color: var(--brand); }" } });
  check("a later streaming draft still previews on the saved generation", await waitForColor("rgb(0, 128, 0)"));
  const earlyVersion = "cccccccccccccccccccccccc";
  await save("red", earlyVersion);
  await frame.locator(`iframe[data-design-document-buffer="displayed"][data-design-document-ready][data-design-document-source-version="${earlyVersion}"]`).waitFor({ timeout: 10_000 });
  check("a new generation continues an unsaved stylesheet preview", await titleColor() === "rgb(0, 128, 0)");
  await send({ id: "lateSave", phase: "saved", revision: 2 }, true);
  check("a delayed save event releases an inherited preview to the document's own CSS", await waitForColor("rgb(255, 0, 0)"));
  await retire("lateSave");
  await page.locator("[data-design-agent-activity]").waitFor({ state: "detached", timeout: 5_000 });
  check("retirement after a delayed save preserves the authoritative generation", await titleColor() === "rgb(255, 0, 0)");
}
