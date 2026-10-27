import { expect } from "@playwright/test";
import { designFrameElementBox } from "./ui-smoke-design-helpers.mjs";
import { runDesignSavedEditingRaceSmoke, runDesignSavedEditingRevisionSmoke } from "./ui-smoke-design-saved-editing.mjs";

/* global window, getComputedStyle */

/** Real canvas controls, opaque production runtime and retained-surface lifecycle. */
export async function runDesignFramePlaybackSmoke({ page, check }) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await runDesignSavedEditingRevisionSmoke({ page, check });
  // A folder change must retire the editing document as well as a playing
  // document, including any pending restoration of advisory stylesheets.
  await runDesignSavedEditingRaceSmoke({ page, check, changes: ["root-ABA"] });
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?frameMotion&framePlayback`,
    { waitUntil: "networkidle" },
  );
  const canvas = page.locator("[data-design-canvas-viewport]");
  const frame = page.locator('[data-design-frame="home.html"]');
  const play = frame.getByRole("button", {
    name: "Play Launch home",
    exact: true,
  });
  const content = () =>
    page.frameLocator(
      '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]',
    );
  const root = () => content().locator('[data-oid="home-main"]');
  const running = () =>
    root().evaluate((node) =>
      node
        .getAnimations()
        .some((animation) => animation.playState === "running"),
    );
  const stopped = async () => {
    await expect(play).toHaveAttribute("aria-pressed", "false");
    await expect(
      frame.locator("iframe[data-design-document-ready]"),
    ).toBeVisible();
    await expect.poll(running).toBe(false);
  };

  await expect(page.locator("[data-design-frame-play]")).toHaveCount(2);
  await stopped();
  await expect(frame.locator("iframe")).toHaveAttribute("inert", "");
  const frameRect = await frame.boundingBox();
  const controlRect = await play.boundingBox();
  expect(
    Math.abs(
      controlRect.x + controlRect.width - (frameRect.x + frameRect.width),
    ),
  ).toBeLessThan(2);
  expect(controlRect.y + controlRect.height).toBeLessThan(frameRect.y);
  check(
    "every artboard has an accessible Play toggle above its top-right corner",
    true,
  );

  await page.locator('[data-design-frame-row="home.html"]').click();
  await page.getByRole("button", { name: "Edit motion wash" }).click();
  const timeline = page.getByRole("region", { name: "Motion timeline" });
  await expect(timeline).toBeVisible();
  await timeline.getByLabel("Animation duration", { exact: true }).fill("23");
  await timeline
    .getByLabel("Animation duration", { exact: true })
    .press("Enter");
  await play.click();
  await expect(play).toHaveAttribute("aria-pressed", "true");
  await expect.poll(running).toBe(true);
  await expect(frame.locator("iframe")).not.toHaveAttribute("inert", "");
  await expect(
    page.getByRole("region", { name: "Motion timeline" }),
  ).toBeHidden();
  await expect(
    frame.locator(
      "[data-design-high-resolution-tile], [data-design-frame-transition-cover]",
    ),
  ).toHaveCount(0);
  const initial = await root().evaluate(
    (node) => node.getAnimations()[0].currentTime,
  );
  await expect
    .poll(() => root().evaluate((node) => node.getAnimations()[0].currentTime))
    .toBeGreaterThan(initial + 250);
  check(
    "Play runs the main frame's authored loop and closes editing overlays",
    true,
  );

  const control = content().getByLabel("Try this control");
  const controlBox = await designFrameElementBox(content().owner(), control);
  await page.mouse.click(
    controlBox.x + controlBox.width / 2,
    controlBox.y + controlBox.height / 2,
  );
  await expect(control).toBeChecked();
  const hoverBox = await designFrameElementBox(
    content().owner(),
    content().getByRole("button", { name: "Hover preview" }),
  );
  await page.mouse.move(
    hoverBox.x + hoverBox.width / 2,
    hoverBox.y + hoverBox.height / 2,
  );
  await expect
    .poll(() =>
      content()
        .getByRole("button", { name: "Hover preview" })
        .evaluate((node) => getComputedStyle(node).borderRadius),
    )
    .toBe("24px");
  await page.keyboard.press("Escape");
  await stopped();
  await expect(content().getByLabel("Try this control")).not.toBeChecked();
  await expect(play).toBeFocused();
  check(
    "native HTML controls and hover transitions work; Escape restores the saved editing document",
    true,
  );

  await page.locator('[data-design-frame-row="home.html"]').click();
  await page.getByRole("button", { name: "Edit motion wash" }).click();
  await expect(
    timeline.getByLabel("Animation duration", { exact: true }),
  ).toHaveValue("23");
  await expect(
    timeline.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  await timeline.getByRole("button", { name: "Close motion timeline" }).click();
  check("whole-frame playback preserves unsaved Motion drafts", true);

  // Native keyboard activation must not be swallowed by the canvas's Space pan.
  await play.press("Space");
  await expect.poll(running).toBe(true);
  await play.press("Enter");
  await stopped();
  check(
    "the Play toggle supports Space and Enter without starting a canvas gesture",
    true,
  );

  await play.click();
  await expect.poll(running).toBe(true);
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await stopped();
  await expect(
    frame.locator('[data-design-element-overlay="home-heading"]'),
  ).toBeVisible();
  check(
    "selecting a layer inside the playing frame restores editing and its selection geometry",
    true,
  );

  await play.click();
  await expect.poll(running).toBe(true);
  const pricing = page.locator('[data-design-frame="pricing.html"]');
  const pricingPlay = pricing.getByRole("button", {
    name: "Play Pricing",
    exact: true,
  });
  await pricingPlay.click();
  await expect(pricingPlay).toHaveAttribute("aria-pressed", "true");
  await expect(pricing.locator("iframe[data-design-frame-live]")).toBeVisible();
  await stopped();
  await expect(page.locator("[data-design-frame-playing]")).toHaveCount(1);
  await pricingPlay.click();
  check(
    "playing another frame retires the first, including frames without authored motion",
    true,
  );

  await play.click();
  await expect.poll(running).toBe(true);
  await page.evaluate(() => window.__zerosHarnessDesignSurface.active(false));
  const hiddenPlay = frame.locator("[data-design-frame-play]");
  await expect(hiddenPlay).toHaveAttribute("aria-pressed", "false");
  await expect(hiddenPlay).toBeHidden();
  await page.evaluate(() => window.__zerosHarnessDesignSurface.active(true));
  await stopped();
  check(
    "hiding and revealing a retained Design surface never resumes playback",
    true,
  );

  await play.click();
  await expect.poll(running).toBe(true);
  await page.locator('[data-design-frame-row="pricing.html"]').click();
  await stopped();
  await play.click();
  await expect.poll(running).toBe(true);
  await page.evaluate(() =>
    window.__zerosHarnessDesignSurface.owner("playback-org-local"),
  );
  await page.evaluate(() =>
    window.__zerosHarnessDesignSurface.owner("ws_design_harness"),
  );
  await stopped();
  check(
    "editing another frame and owner round trips retire the playback session",
    true,
  );

  await play.click();
  await expect.poll(running).toBe(true);
  await page.evaluate(() => {
    window.__zerosHarnessDesignSurface.ui
      .getState()
      .setViewport("ws_design_harness", { panX: -10_000, panY: -10_000 });
  });
  await expect(play).toHaveAttribute("aria-pressed", "false");
  await canvas.focus();
  await page.keyboard.press("Shift+1");
  await stopped();
  check("panning a playing frame out of view stops background animation", true);

  // Exercise both sides of the high-resolution cutoff and a label long enough
  // to overlap the control without the reserved screen-space width.
  await page.evaluate(() => {
    const { snapshots } = window.__zerosHarnessDesignSurface;
    const snapshot = snapshots.getSnapshot("ws_design_harness").data;
    snapshots.setData("ws_design_harness", {
      ...snapshot,
      frames: snapshot.frames.map((item) =>
        item.file === "home.html"
          ? {
              ...item,
              title:
                "Launch home with a very long title that must leave room for playback",
            }
          : item,
      ),
    });
  });
  const renamedPlay = frame.locator("[data-design-frame-play]");
  for (const zoom of [0.1, 0.5, 1.5]) {
    await page.evaluate((zoom) => {
      window.__zerosHarnessDesignSurface.ui
        .getState()
        .setViewport("ws_design_harness", {
          zoom,
          panX: 900 - 1440 * zoom,
          panY: 120,
        });
    }, zoom);
    const button = await renamedPlay.boundingBox();
    const bounds = await frame.boundingBox();
    const label = await frame
      .locator("[data-design-frame-label]")
      .boundingBox();
    expect(Math.abs(button.width - controlRect.width)).toBeLessThan(1);
    expect(
      Math.abs(button.x + button.width - bounds.x - bounds.width),
    ).toBeLessThan(1);
    expect(label.x + label.width).toBeLessThan(button.x);
  }
  await renamedPlay.click();
  await expect.poll(running).toBe(true);
  await expect(frame.locator("[data-design-high-resolution-tile]")).toHaveCount(
    0,
  );
  check(
    "Play stays aligned and constant-size at small and large zooms, with no still tile covering playback",
    true,
  );

  // Publish a new exact generation through the same caches as a file watcher.
  await page.evaluate(() => {
    const { snapshots, documents, documentKey } =
      window.__zerosHarnessDesignSurface;
    const snapshot = snapshots.getSnapshot("ws_design_harness").data;
    const frame = snapshot.frames.find((item) => item.file === "home.html");
    const document = documents.getSnapshot(
      documentKey("ws_design_harness", frame.file, frame.sourceVersion),
    ).data;
    const sourceVersion = "e".repeat(24);
    documents.setData(
      documentKey("ws_design_harness", frame.file, sourceVersion),
      {
        ...document,
        sourceVersion,
        srcDoc: document.srcDoc.replaceAll(frame.sourceVersion, sourceVersion),
      },
    );
    snapshots.setData("ws_design_harness", {
      ...snapshot,
      frames: snapshot.frames.map((item) =>
        item.file === frame.file
          ? { ...item, title: "Launch home", sourceVersion }
          : item,
      ),
    });
  });
  await stopped();
  check(
    "a source update stops playback before the replacement document becomes interactive",
    true,
  );

  await play.click();
  await expect.poll(running).toBe(true);
  await page.evaluate(() => {
    const { snapshots } = window.__zerosHarnessDesignSurface;
    const snapshot = snapshots.getSnapshot("ws_design_harness").data;
    snapshots.setData("ws_design_harness", {
      ...snapshot,
      protocolCapability: "c".repeat(64),
    });
  });
  await stopped();
  check(
    "an engine capability replacement retires the old playback session",
    true,
  );

  // Model an engine whose still-valid v2 document predates the opt-in method.
  await page.evaluate(() => {
    const { snapshots, documents, documentKey } =
      window.__zerosHarnessDesignSurface;
    const snapshot = snapshots.getSnapshot("ws_design_harness").data;
    const frame = snapshot.frames.find((item) => item.file === "home.html");
    const key = documentKey(
      "ws_design_harness",
      frame.file,
      frame.sourceVersion,
    );
    const document = documents.getSnapshot(key).data;
    const srcDoc = document.srcDoc.replace(
      'var OPT_IN_METHODS = ["previewStylesheet", "setPlayback"];',
      'var OPT_IN_METHODS = ["previewStylesheet"];',
    );
    if (srcDoc === document.srcDoc)
      throw new Error(
        "Legacy runtime fixture did not remove playback capability",
      );
    documents.setData(key, { ...document, srcDoc });
  });
  await play.click();
  await expect(
    page.getByText(/Frame playback needs an updated Design runtime/),
  ).toBeVisible();
  await stopped();
  await expect(page.locator("iframe[data-design-frame-live]")).toHaveCount(0);
  check(
    "an older runtime returns to editing with a restart message instead of a false playing state",
    true,
  );

  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?pages&frameMotion&framePlayback`,
    { waitUntil: "networkidle" },
  );
  const pageFrame = page.locator('[data-design-frame="page-1/home.html"]');
  const pagePlay = pageFrame.getByRole("button", {
    name: "Play Launch home",
    exact: true,
  });
  await pagePlay.click();
  await expect(
    pageFrame.locator("iframe[data-design-frame-live]"),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Page: / }).click();
  await page.getByRole("menuitem", { name: "New page", exact: true }).click();
  await expect(pageFrame).toHaveCount(0);
  await expect(page.locator("iframe[data-design-frame-live]")).toHaveCount(0);
  await page.getByRole("button", { name: /^Page: / }).click();
  await page
    .getByRole("menuitemradio", { name: "Page 1", exact: true })
    .click();
  await expect(pagePlay).toHaveAttribute("aria-pressed", "false");
  await expect(
    pageFrame.locator("iframe[data-design-document-ready]"),
  ).toHaveAttribute("inert", "");
  check(
    "page switching disposes playback and returning to the original page stays in editing mode",
    true,
  );
}
