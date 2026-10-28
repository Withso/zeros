import { expect } from "@playwright/test";

export async function runDesignSavedEditingSmoke({ page, check }) {
  await runDesignSavedEditingOwnerAdmissionSmoke({ page, check });
  await runDesignSavedEditingStationaryPointerSmoke({ page, check });
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.mouse.move(-10, -10);
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?designTokens`, { waitUntil: "networkidle" });
  const frame = page.locator('[data-design-frame="home.html"]');
  await frame.locator('iframe[data-design-document-buffer="displayed"][data-design-document-ready]').waitFor();
  const heading = () => page.frameLocator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]').locator('[data-oid="home-heading"]');
  const read = () => heading().evaluate((node) => ({ x: node.getBoundingClientRect().x, width: node.getBoundingClientRect().width, color: getComputedStyle(node).color }));
  const saved = await read();
  await page.evaluate(async () => {
    const { receiveDesignAgentDraft } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-agent-drafts.ts");
    const harness = window.__zerosHarnessAgentDrafts;
    harness.useDirectory();
    window.__savedEditingDraft = (revision) => {
      const base = { chatId: "saved-editing", directory: harness.directory, operation: "write", phase: "writing", revision };
      receiveDesignAgentDraft(harness.workspaceId, { ...base, id: "savedEditingHtml", file: "home.html", preview: { srcDoc: `<html><body><div id="advisory">Draft ${revision}</div></body></html>`, width: 1440, height: 900, title: "Advisory" } });
      receiveDesignAgentDraft(harness.workspaceId, { ...base, id: "savedEditingCss", file: "tokens.css", stylesheet: { css: `:root{--brand:green}.title{color:var(--brand);transform:translateX(${240 + revision}px) scale(.5);transform-origin:0 0}` } });
    };
    window.__savedEditingDraft(1);
  });
  await frame.locator('iframe[data-design-agent-draft-buffer="shown"]').waitFor();
  await expect.poll(async () => (await read()).x).toBe(saved.x + 241);
  check("passive viewing retains both HTML and CSS advisory previews", true);
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await expect(page.locator('[data-design-workspace-surface]')).toHaveAttribute("data-design-saved-editing", "viewing");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(frame.locator('iframe[data-design-agent-draft-buffer="shown"]')).toBeVisible();
  await expect.poll(async () => (await read()).x).toBe(saved.x + 241);
  check("layer selection and tree navigation retain passive HTML and CSS previews", true);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await expect.poll(() => frame.locator("iframe[data-design-agent-draft-buffer]").count()).toBe(0);
  await expect.poll(read).toEqual(saved);
  await page.evaluate(() => window.__savedEditingDraft(2));
  await expect.poll(read).toEqual(saved);
  expect(await frame.locator("iframe[data-design-agent-draft-buffer]").count()).toBe(0);
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await read()).x).toBe(saved.x + 1);
  check("direct editing restores saved pixels and admits a one-pixel nudge without replaying newer drafts", true);
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "outside-design";
    button.textContent = "Outside Design";
    document.body.append(button);
    button.focus();
  });
  await page.mouse.move(1439, 899);
  await frame.locator('iframe[data-design-agent-draft-buffer="shown"]').waitFor();
  await expect.poll(async () => (await read()).color).toBe("rgb(0, 128, 0)");
  check("leaving editing restores passive draft viewing without deleting the drafts", true);
  await runDesignSavedEditingRaceSmoke({ page, check });
  await runDesignSavedEditingTileSmoke({ page, check });
  await runDesignSavedEditingFreshDetailsSmoke({ page, check });
  await runDesignSavedEditingPendingSaveSmoke({ page, check });
}

export async function runDesignSavedEditingOwnerAdmissionSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  for (const entry of ["cold", "refreshed", "persisted"]) {
    const control = await page.context().browser().newPage({ viewport: { width: 1600, height: 1000 } });
    try {
      let previous;
      if (entry !== "cold") {
        await control.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`, { waitUntil: "networkidle" });
        await control.locator('[data-design-frame="home.html"] iframe[data-design-document-ready]').waitFor();
        previous = await control.evaluate(async () => {
          const { captureDesignPageOwner } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
          return captureDesignPageOwner("ws_design_harness");
        });
        expect(previous.directoryId).toBeUndefined();
        expect(previous.pageId).toBe("main");
      }
      await control.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?selectionReferences`, { waitUntil: "networkidle" });
      await control.locator('[data-design-frame="home.html"] iframe[data-design-document-ready]').waitFor();
      const resolved = await control.evaluate(async (entry) => {
        const { captureDesignPageOwner, useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
        const store = useDesignWorkspaceUiStore.getState();
        const owner = captureDesignPageOwner("ws_design_harness");
        if (entry === "refreshed") {
          store.setActivePage("ws_design_harness", "temporary");
          store.setActivePage("ws_design_harness", "main");
        }
        store.setPanels("ws_design_harness", { inspectorVisible: false });
        store.setViewport("ws_design_harness", { zoom: 0.25, panX: 64, panY: 96 });
        return owner;
      }, entry);
      expect(resolved.directoryId).toBe("design_harness");
      expect(resolved.pageId).toBe("main");
      if (previous) expect(resolved.revision).toBe(previous.revision);
      const home = await control.locator('[data-design-frame="home.html"]').boundingBox();
      const pricing = await control.locator('[data-design-frame="pricing.html"]').boundingBox();
      await control.mouse.move(home.x - 12, home.y + home.height + 20);
      await control.mouse.down();
      await control.mouse.move(pricing.x + pricing.width + 12, pricing.y - 12, { steps: 12 });
      await control.mouse.up();
      await expect(control.locator("[data-composer-design-frame]")).toHaveText("2 selected");
      check(`${entry} directory admission preserves the canonical two-frame marquee`, true);
    } finally {
      await control.close();
    }
  }
}

export async function runDesignSavedEditingStationaryPointerSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`, { waitUntil: "networkidle" });
  await page.mouse.move(100, 150);
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?designTokens`, { waitUntil: "networkidle" });
  await page.locator('[data-design-frame="home.html"] iframe[data-design-document-ready]').waitFor();
  await expect(page.locator('[data-design-workspace-surface]')).toHaveAttribute("data-design-saved-editing", "viewing");
  check("mounting beneath a stationary pointer does not turn passive viewing into editing", true);
}

export async function runDesignSavedEditingPendingSaveSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.mouse.move(-10, -10);
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?designTokens&layoutGestures&coldFoundation`, { waitUntil: "networkidle" });
  await page.locator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]').waitFor();
  await page.evaluate(async () => {
    const { receiveDesignAgentDraft } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-agent-drafts.ts");
    const harness = window.__zerosHarnessAgentDrafts;
    harness.useDirectory();
    window.__pendingSavedDraft = (revision) => receiveDesignAgentDraft(harness.workspaceId, {
      id: "pendingSavedCss", chatId: "saved-editing", directory: harness.directory, file: "tokens.css",
      operation: "write", phase: "writing", revision, stylesheet: { css: `.title{transform:translateX(${80 * revision}px)}` },
    });
    window.__pendingSavedDraft(1);
  });
  const heading = () => page.frameLocator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]').locator('[data-oid="home-heading"]');
  const x = () => heading().evaluate(node => node.getBoundingClientRect().x);
  await expect.poll(x).toBe(152);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await expect(page.locator('[data-design-workspace-surface]')).toHaveAttribute("data-design-saved-editing", "ready");
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => page.evaluate(() => window.__zerosHarnessFoundation.reads.length)).toBeGreaterThan(0);
  await expect.poll(x).toBe(73);
  await page.evaluate(() => {
    const outside = document.createElement("button");
    outside.textContent = "Outside Design";
    document.body.append(outside);
    outside.focus();
    window.__pendingSavedDraft(2);
  });
  await page.mouse.move(-10, -10);
  await expect(page.locator('[data-design-workspace-surface]')).toHaveAttribute("data-design-saved-editing", "ready");
  expect(await x()).toBe(73);
  expect(await page.evaluate(() => window.__zerosHarnessFoundation.transactions.length)).toBe(0);
  await page.evaluate(() => window.__zerosHarnessFoundation.release());
  await expect.poll(() => page.evaluate(() => window.__zerosHarnessFoundation.transactions.length)).toBe(1);
  await expect(page.locator('[data-design-workspace-surface]')).toHaveAttribute("data-design-saved-editing", "viewing");
  await expect.poll(x).toBe(233);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await expect(page.locator('[data-design-workspace-surface]')).toHaveAttribute("data-design-saved-editing", "ready");
  await expect.poll(x).toBe(73);
  await page.keyboard.press("Control+z");
  await expect.poll(x).toBe(72);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(x).toBe(73);
  check("passive drafts wait for a completed cold save and its saved geometry retains one undo and redo", true);
}

export async function runDesignSavedEditingFreshDetailsSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.mouse.move(-10, -10);
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?designTokens`, { waitUntil: "networkidle" });
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await page.evaluate(() => {
    const outside = document.createElement("button");
    outside.textContent = "Outside Design";
    document.body.append(outside);
    outside.focus();
  });
  await page.mouse.move(-10, -10);
  await expect(page.locator('[data-design-workspace-surface]')).toHaveAttribute("data-design-saved-editing", "viewing");
  await page.evaluate(async () => {
    const { receiveDesignAgentDraft } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-agent-drafts.ts");
    const harness = window.__zerosHarnessAgentDrafts;
    harness.useDirectory();
    receiveDesignAgentDraft(harness.workspaceId, { id: "detailDraft", chatId: "saved-editing", directory: harness.directory,
      file: "tokens.css", operation: "write", phase: "writing", revision: 1,
      stylesheet: { css: ".title{transform:translateX(80px)}" } });
  });
  const cachedX = () => page.evaluate(async () => {
    const { useDesignRuntimeStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-runtime-store.ts");
    return useDesignRuntimeStore.getState().byWorkspace.ws_design_harness.frames["home.html"].detailsByNode["home-heading"]?.rect.x;
  });
  await expect.poll(cachedX).toBe(152);
  await page.evaluate(async () => {
    const { designFrameRuntime } = await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
    const runtime = designFrameRuntime(window.__zerosHarnessAgentDrafts.workspaceId, "home.html");
    const read = runtime.getNodeDetails.bind(runtime);
    window.__savedDetailsBlocked = true;
    runtime.getNodeDetails = (...args) => window.__savedDetailsBlocked ? Promise.reject(new Error("Fresh geometry unavailable")) : read(...args);
  });
  await page.getByLabel("Design canvas", { exact: true }).focus();
  const heading = page.frameLocator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]').locator('[data-oid="home-heading"]');
  await expect.poll(() => heading.evaluate(node => node.getBoundingClientRect().x)).toBe(72);
  await expect(page.locator('[data-design-workspace-surface]')).toHaveAttribute("data-design-saved-editing", "preparing");
  await page.keyboard.press("ArrowRight");
  expect(await page.evaluate(() => window.__zerosHarnessFoundation.transactions.length)).toBe(0);
  await page.evaluate(() => { window.__savedDetailsBlocked = false; document.activeElement?.blur(); });
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await expect(page.locator('[data-design-workspace-surface]')).toHaveAttribute("data-design-saved-editing", "ready");
  await expect.poll(cachedX).toBe(72);
  check("restored CSS is not edit authority until fresh canonical geometry succeeds", true);
}

export async function runDesignSavedEditingTileSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.mouse.move(-10, -10);
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?designTokens`, { waitUntil: "networkidle" });
  const frame = page.locator('[data-design-frame="home.html"]');
  await frame.locator('iframe[data-design-document-buffer="displayed"][data-design-document-ready]').waitFor();
  await page.evaluate(async () => {
    const { receiveDesignAgentDraft } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-agent-drafts.ts");
    const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    const harness = window.__zerosHarnessAgentDrafts;
    harness.useDirectory();
    receiveDesignAgentDraft(harness.workspaceId, {
      id: "tileDraft", chatId: "saved-editing", directory: harness.directory, file: "tokens.css",
      operation: "write", phase: "writing", revision: 1,
      stylesheet: { css: ".title{color:green;transform:translateX(8px)}" },
    });
    useDesignWorkspaceUiStore.getState().setViewport(harness.workspaceId, { zoom: 8, panX: 0, panY: 0 });
  });
  const tile = frame.locator("[data-design-high-resolution-tile][data-design-tile-current]");
  await tile.waitFor();
  await page.evaluate(async () => {
    const { designFrameRuntime } = await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
    const runtime = designFrameRuntime(window.__zerosHarnessAgentDrafts.workspaceId, "home.html");
    const capture = runtime.captureViewportScreenshot.bind(runtime);
    const held = new Promise((resolve) => { window.__savedEditingTileRelease = resolve; });
    runtime.captureViewportScreenshot = async (...args) => { await held; return capture(...args); };
  });
  try {
    await page.getByLabel("Design canvas", { exact: true }).focus();
    await expect(page.locator('[data-design-workspace-surface]')).toHaveAttribute("data-design-saved-editing", "ready");
    await expect.poll(() => frame.locator("[data-design-high-resolution-tile]").count()).toBe(0);
    check("an old advisory zoom tile cannot cover the restored saved pixels while its replacement is held", true);
  } finally {
    await page.evaluate(() => window.__savedEditingTileRelease());
  }
}

export async function runDesignSavedEditingRevisionSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.mouse.move(-10, -10);
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?designTokens`, { waitUntil: "networkidle" });
  const frame = page.locator('[data-design-frame="home.html"]');
  await frame.locator('iframe[data-design-document-buffer="displayed"][data-design-document-ready]').waitFor();
  const x = () => page.frameLocator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]')
    .locator('[data-oid="home-heading"]').evaluate((node) => node.getBoundingClientRect().x);
  const savedX = await x();
  await page.evaluate(async () => {
    const { receiveDesignAgentDraft } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-agent-drafts.ts");
    const harness = window.__zerosHarnessAgentDrafts;
    harness.useDirectory();
    receiveDesignAgentDraft(harness.workspaceId, {
      id: "revisionDuringRestore", chatId: "saved-editing", directory: harness.directory,
      file: "tokens.css", operation: "write", phase: "writing", revision: 1,
      stylesheet: { css: ".title{transform:translateX(240px)}" },
    });
  });
  await expect.poll(x).toBe(savedX + 240);
  await page.evaluate(async () => {
    const { designFrameRuntime } = await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
    const runtime = designFrameRuntime(window.__zerosHarnessAgentDrafts.workspaceId, "home.html");
    const getSnapshot = runtime.getSnapshot.bind(runtime);
    window.__savedEditingRevisionChanged = false;
    runtime.getSnapshot = async (...args) => {
      const snapshot = await getSnapshot(...args);
      if (!window.__savedEditingRevisionChanged && document.querySelector('[data-design-workspace-surface]')?.dataset.designSavedEditing === "preparing") {
        window.__savedEditingRevisionChanged = true;
        // A late acknowledgement for the current theme advances the runtime
        // revision without changing the source, selection or intended pixels.
        await runtime.setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
      }
      return snapshot;
    };
  });
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await expect.poll(() => page.evaluate(() => window.__savedEditingRevisionChanged)).toBe(true);
  await expect(page.locator('[data-design-workspace-surface]')).toHaveAttribute("data-design-saved-editing", "ready");
  await expect.poll(x).toBe(savedX);
  expect(await page.evaluate(() => window.__zerosHarnessFoundation.transactions.length)).toBe(0);
  check("saved editing revalidates a revision that changes while confirming restored geometry", true);
}

export async function runDesignSavedEditingRaceSmoke({
  page,
  check,
  changes = ["held-revision", "source", "runtime", "directory-ABA", "page-ABA", "root-ABA", "owner-ABA", "visibility-ABA"],
}) {
  const origin = new URL(page.url()).origin;
  for (const change of changes) {
    await page.mouse.move(-10, -10);
    await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?designTokens`, { waitUntil: "networkidle" });
    const frame = page.locator('[data-design-frame="home.html"]');
    await frame.locator('iframe[data-design-document-buffer="displayed"][data-design-document-ready]').waitFor();
    const heading = () => page.frameLocator('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]').locator('[data-oid="home-heading"]');
    const x = () => heading().evaluate((node) => node.getBoundingClientRect().x);
    const savedX = await x();
    await page.evaluate(async () => {
      const { designFrameRuntime } = await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
      const { receiveDesignAgentDraft } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-agent-drafts.ts");
      const harness = window.__zerosHarnessAgentDrafts;
      harness.useDirectory();
      const runtime = designFrameRuntime(harness.workspaceId, "home.html");
      const preview = runtime.previewStylesheet.bind(runtime);
      const held = new Promise((resolve) => { window.__savedEditingRelease = resolve; });
      window.__savedEditingHeld = false;
      runtime.previewStylesheet = async (file, css, signal) => {
        const result = await preview(file, css, signal);
        if (css !== null && !window.__savedEditingHeld) {
          window.__savedEditingHeld = true;
          await held;
        }
        return result;
      };
      window.__heldEditingDraft = (revision) => receiveDesignAgentDraft(harness.workspaceId, {
        id: "heldEditingCss", chatId: "saved-editing", directory: harness.directory,
        file: "tokens.css", operation: "write", phase: "writing", revision,
        stylesheet: { css: `.title{transform:translateX(${revision * 240}px)}` },
      });
      window.__heldEditingDraft(1);
    });
    await page.waitForFunction(() => window.__savedEditingHeld);
    await expect.poll(x).toBe(savedX + 240);
    await page.evaluate(async () => {
      const { DesignSavedEditingSession } = await import("/apps/desktop/src/renderer/features/design-workspace/design-saved-editing.ts");
      const enter = DesignSavedEditingSession.prototype.enter;
      DesignSavedEditingSession.prototype.enter = function () {
        window.__savedEditingLatestSession = this;
        return enter.call(this);
      };
    });
    await page.getByLabel("Design canvas", { exact: true }).focus();
    await expect(page.locator('[data-design-workspace-surface]')).toHaveAttribute("data-design-saved-editing", "preparing");
    await page.evaluate(() => { window.__savedEditingFirstSession = window.__savedEditingLatestSession; });
    await page.keyboard.press("ArrowRight");
    expect(await page.evaluate(() => window.__zerosHarnessFoundation.transactions.length)).toBe(0);
    await page.evaluate(() => window.__heldEditingDraft(2));
    if (change === "source") {
      await page.evaluate(async () => {
        const cache = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
        const harness = window.__zerosHarnessAgentDrafts;
        harness.save('<html><head><style data-zeros-source="tokens.css">.title{color:blue}</style></head><body style="margin:0"><main data-oid="home-main" data-zeros-frame-root><h1 data-oid="home-heading" class="title" style="position:absolute;left:170px;top:80px">New source</h1></main></body></html>', "eeeeeeeeeeeeeeeeeeeeeeee");
        cache.invalidateDesignWorkspacesForStyleBuild([harness.workspaceId]);
      });
      await frame.locator('iframe[data-design-document-ready][data-design-document-source-version="eeeeeeeeeeeeeeeeeeeeeeee"]').waitFor();
    } else if (change === "runtime") {
      await page.evaluate(async () => {
        const { designFrameRuntime } = await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
        const id = window.__zerosHarnessAgentDrafts.workspaceId;
        window.__savedEditingOldRuntime = designFrameRuntime(id, "home.html");
        const iframe = document.querySelector('[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]');
        iframe.srcdoc = iframe.srcdoc;
      });
      await page.waitForFunction(async () => {
        const { designFrameRuntime } = await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
        const current = designFrameRuntime(window.__zerosHarnessAgentDrafts.workspaceId, "home.html");
        return current && current !== window.__savedEditingOldRuntime && current.supports("getSnapshot") &&
          current.sourceVersion === window.__savedEditingOldRuntime.sourceVersion && !window.__savedEditingOldRuntime.isActive();
      });
    } else if (change === "directory-ABA" || change === "page-ABA") {
      await page.evaluate(async (change) => {
        const { designWorkspaceView, useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
        const id = window.__zerosHarnessAgentDrafts.workspaceId;
        const view = designWorkspaceView(id), store = useDesignWorkspaceUiStore.getState();
        if (change === "directory-ABA") {
          store.bindDirectory(id, "other-directory");
          store.bindDirectory(id, view.directoryId);
        } else {
          store.setActivePage(id, "other-page");
          store.setActivePage(id, view.activePageId);
        }
      }, change);
    } else if (change === "root-ABA") {
      const original = await page.locator("[data-harness-design-root]").getAttribute("data-harness-design-root");
      await page.evaluate(() => window.__zerosHarnessDesignSurface.root(true));
      await expect(page.locator("[data-harness-design-root]")).toHaveAttribute("data-harness-design-root", `${original}-replacement`);
      await page.evaluate(() => window.__zerosHarnessDesignSurface.root(false));
      await expect(page.locator("[data-harness-design-root]")).toHaveAttribute("data-harness-design-root", original);
    } else if (change === "owner-ABA") {
      await page.evaluate(() => window.__zerosHarnessDesignSurface.owner("ws_design_other"));
      await expect(page.locator('[data-design-workspace-surface]')).toHaveAttribute("data-design-workspace-id", "ws_design_other");
      await frame.locator('iframe[data-design-document-buffer="displayed"][data-design-document-ready]').waitFor();
      await expect.poll(x).toBe(savedX);
      await page.evaluate(() => window.__zerosHarnessDesignSurface.owner(window.__zerosHarnessAgentDrafts.workspaceId));
      await expect(page.locator('[data-design-workspace-surface]')).toHaveAttribute("data-design-workspace-id", "ws_design_harness");
    } else if (change === "visibility-ABA") {
      await page.evaluate(() => window.__zerosHarnessDesignSurface.active(false));
      await expect(page.locator('[data-design-workspace-surface]')).toHaveAttribute("inert", "");
      await page.evaluate(() => window.__zerosHarnessDesignSurface.active(true));
      await expect(page.locator('[data-design-workspace-surface]')).not.toHaveAttribute("inert", "");
    }
    await page.evaluate(() => window.__savedEditingRelease());
    await page.evaluate(() => document.activeElement?.blur());
    await page.getByLabel("Design canvas", { exact: true }).focus();
    await expect(page.locator('[data-design-workspace-surface]')).toHaveAttribute("data-design-saved-editing", "ready");
    if (change.endsWith("-ABA")) {
      expect(await page.evaluate(() => window.__savedEditingFirstSession.isCurrent())).toBe(false);
      expect(await page.evaluate(() => window.__savedEditingLatestSession !== window.__savedEditingFirstSession)).toBe(true);
    }
    await expect.poll(x).toBe(change === "source" ? 170 : savedX);
    expect(await page.evaluate(() => window.__zerosHarnessFoundation.transactions.length)).toBe(0);
    await page.locator('[data-design-layer-id="home-heading"]').click();
    await page.getByLabel("Design canvas", { exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(x).toBe((change === "source" ? 170 : savedX) + 1);
    check(`held advisory CSS cannot admit stale edits through ${change}`, true);
  }
}
