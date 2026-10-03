import { expect } from "@playwright/test";

async function openStyleDesign(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await expect(
    page.getByRole("textbox", { name: "Size", exact: true }),
  ).toHaveValue("88");
}

const styleWrites = (page) =>
  page.evaluate(() => window.__zerosHarnessStyleMutationSources?.length ?? 0);

async function runtimeStyle(page, nodeId, property) {
  return page.evaluate(
    async ({ nodeId, property }) => {
      const { designFrameRuntime } =
        await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
      const details = await designFrameRuntime(
        "ws_design_harness",
        "home.html",
      ).getNodeDetails(nodeId);
      return details.styles[property];
    },
    { nodeId, property },
  );
}

async function writeSourceStyle(page, styles) {
  await page.evaluate(async (styles) => {
    const { designWorkspaceSnapshotCache, updateDesignNodeStylesCached } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const frame = designWorkspaceSnapshotCache
      .peekSnapshot("ws_design_harness")
      .data.frames.find((candidate) => candidate.file === "home.html");
    await updateDesignNodeStylesCached("ws_design_harness", {
      frame: frame.file,
      sourceVersion: frame.sourceVersion,
      nodeId: "home-heading",
      styles,
    });
  }, styles);
}

export async function runDesignColorGestureCancellationSmoke({ page, check }) {
  await openStyleDesign(page);
  await page.getByRole("button", { name: "Edit fill", exact: true }).click();
  const panel = page.locator("[data-design-color-panel]");
  const opacity = panel.getByRole("slider", {
    name: "Fill opacity",
    exact: true,
  });
  const value = panel.getByRole("textbox", {
    name: "Fill opacity value",
    exact: true,
  });
  await expect(value).toHaveValue("100");
  await opacity.hover();
  const bounds = await opacity.boundingBox();
  const start = {
    x: bounds.x + bounds.width * 0.5,
    y: bounds.y + bounds.height / 2,
  };

  for (const cancellation of ["capture", "blur", "escape"]) {
    await opacity.evaluate((element) => {
      element.removeAttribute("data-smoke-pointer-captured");
      element.addEventListener(
        "gotpointercapture",
        () => element.setAttribute("data-smoke-pointer-captured", "true"),
        { once: true },
      );
    });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    // Chromium applies pending capture on the next pointer event. Releasing
    // it before then emits no lostpointercapture, so establish a real drag.
    await page.mouse.move(start.x + 1, start.y);
    await page.mouse.move(start.x, start.y);
    await expect(opacity).toHaveAttribute("data-smoke-pointer-captured", "true");
    await expect(value).toHaveValue(/^(?:49|50|51)$/);
    if (cancellation === "capture")
      await opacity.evaluate((element) => element.releasePointerCapture(1));
    else if (cancellation === "blur")
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    else await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(panel).toBeVisible();
    await expect(
      value,
      `${cancellation} cancellation restores opacity`,
    ).toHaveValue("100");
    await expect
      .poll(() => runtimeStyle(page, "home-heading", "color"))
      .toBe("rgb(0, 0, 0)");
    expect(await styleWrites(page)).toBe(0);
  }

  await page.mouse.click(start.x, start.y, { button: "right" });
  await expect(value).toHaveValue("100");
  expect(await styleWrites(page)).toBe(0);

  await page.mouse.click(start.x, start.y);
  await expect(value).toHaveValue(/^(?:49|50|51)$/);
  await expect.poll(() => styleWrites(page)).toBe(1);
  check(
    "color drags cancel on Escape, lost capture, and window blur; only a primary release commits",
    true,
  );
}

export async function runDesignColorSamplingOwnerSmoke({ page, check }) {
  await openStyleDesign(page);
  await page.evaluate(() => {
    window.EyeDropper = class {
      open() {
        return new Promise((resolve) => {
          window.__zerosResolveStyleSample = () =>
            resolve({ sRGBHex: "#FF0044" });
        });
      }
    };
  });
  await page.getByRole("button", { name: "Edit fill", exact: true }).click();
  await page
    .getByRole("button", { name: "Pick fill from screen", exact: true })
    .click();
  const initialCopyColor = await runtimeStyle(page, "home-copy", "color");
  await page.locator('[data-design-layer-id="home-copy"]').click();
  await expect(
    page.getByRole("textbox", { name: "Size", exact: true }),
  ).toHaveValue("24");
  await page.evaluate(() => window.__zerosResolveStyleSample());
  await page.waitForTimeout(200);
  expect(await styleWrites(page)).toBe(0);
  expect(await runtimeStyle(page, "home-copy", "color")).toBe(initialCopyColor);
  check(
    "a color sample completed after changing layers cannot write to the new selection",
    true,
  );
}

export async function runDesignColorSamplingSelectionRaceSmoke({
  page,
  check,
}) {
  await openStyleDesign(page);
  await page.evaluate(() => {
    window.EyeDropper = class {
      open() {
        return new Promise((resolve) => {
          window.__zerosResolveStyleSample = () =>
            resolve({ sRGBHex: "#FF0044" });
        });
      }
    };
  });
  await page.getByRole("button", { name: "Edit fill", exact: true }).click();
  await page
    .getByRole("button", { name: "Pick fill from screen", exact: true })
    .click();
  await page.evaluate(async () => {
    const { useDesignWorkspaceUiStore } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    useDesignWorkspaceUiStore
      .getState()
      .setSelection("ws_design_harness", "home.html", "home-copy");
    // Settle sampling in the same task as the synchronous owner change,
    // before this test waits for React or its passive effect cleanup.
    window.__zerosResolveStyleSample();
  });
  await page.waitForTimeout(200);
  expect(await styleWrites(page)).toBe(0);
  check(
    "a sampling reply racing a synchronous selection change cannot dispatch a style write",
    true,
  );
}

export async function runDesignColorFocusedRefreshSmoke({ page, check }) {
  await openStyleDesign(page);
  await page.getByRole("button", { name: "Edit fill", exact: true }).click();
  const panel = page.locator("[data-design-color-panel]");
  const field = panel.getByRole("textbox", { name: "Fill value", exact: true });
  await field.focus();
  await writeSourceStyle(page, { color: "rgb(34 102 170 / 0.5)" });
  await expect(
    page.getByRole("textbox", { name: "Fill", exact: true }),
  ).toHaveValue("2266AA");
  await field.evaluate((element) => element.blur());
  await expect(field).toHaveValue("2266AA");
  await expect(
    panel.getByRole("textbox", { name: "Fill opacity value", exact: true }),
  ).toHaveValue("50");
  expect(await styleWrites(page)).toBe(1);
  check(
    "an untouched focused color field adopts a confirmed refresh on blur without writing stale color",
    true,
  );
}

export async function runDesignColorChannelRefreshSmoke({ page, check }) {
  await openStyleDesign(page);
  await page.getByRole("button", { name: "Edit fill", exact: true }).click();
  const panel = page.locator("[data-design-color-panel]");
  const alpha = panel.getByRole("textbox", {
    name: "Fill opacity value",
    exact: true,
  });
  await alpha.fill("60");
  await writeSourceStyle(page, { color: "rgb(34 102 170 / 0.5)" });
  await expect(
    page.getByRole("textbox", { name: "Fill", exact: true }),
  ).toHaveValue("2266AA");
  await expect(alpha).toHaveValue("60");
  await alpha.press("Enter");
  await expect.poll(() => styleWrites(page)).toBe(2);
  await expect
    .poll(() => runtimeStyle(page, "home-heading", "color"))
    .toBe("rgba(34, 102, 170, 0.6)");
  const hex = panel.getByRole("textbox", { name: "Fill value", exact: true });
  await hex.fill("FF00FF");
  await writeSourceStyle(page, { color: "rgb(34 102 170 / 0.25)" });
  await expect(
    page.getByRole("textbox", { name: "Fill opacity", exact: true }),
  ).toHaveValue("25");
  await expect(hex).toHaveValue("FF00FF");
  await hex.press("Enter");
  await expect.poll(() => styleWrites(page)).toBe(4);
  await expect
    .poll(() => runtimeStyle(page, "home-heading", "color"))
    .toBe("rgba(255, 0, 255, 0.25)");
  check(
    "color and opacity drafts compose with the latest confirmed other channels",
    true,
  );
}

export async function runDesignEffectKeyboardDraftSmoke({ page, check }) {
  await openStyleDesign(page);
  await page.getByRole("button", { name: "Add effect", exact: true }).click();
  await expect.poll(() => styleWrites(page)).toBe(1);
  await page
    .getByRole("button", { name: "Edit drop shadow", exact: true })
    .click();
  const field = page.getByRole("textbox", {
    name: "Drop shadow X",
    exact: true,
  });
  const baseline = await runtimeStyle(page, "home-heading", "textShadow");
  await field.focus();
  await field.press("ArrowUp");
  await expect(field).toHaveValue("1");
  await page.waitForTimeout(100);
  expect(await runtimeStyle(page, "home-heading", "textShadow")).toBe(baseline);
  expect(await styleWrites(page)).toBe(1);
  await field.press("Escape");
  await expect(field).toHaveValue("0");
  await field.focus();
  await field.press("Shift+ArrowUp");
  await expect(field).toHaveValue("10");
  await field.press("Enter");
  await expect.poll(() => styleWrites(page)).toBe(2);
  expect(await runtimeStyle(page, "home-heading", "textShadow")).not.toBe(
    baseline,
  );
  check(
    "effect arrow steps stay local until Enter or blur and Escape restores the field",
    true,
  );
}

export async function runDesignEffectScrubCancellationSmoke({ page, check }) {
  await openStyleDesign(page);
  await page.getByRole("button", { name: "Add effect", exact: true }).click();
  await expect.poll(() => styleWrites(page)).toBe(1);
  await page
    .getByRole("button", { name: "Edit drop shadow", exact: true })
    .click();
  const field = page.getByRole("textbox", {
    name: "Drop shadow X",
    exact: true,
  });
  const scrub = page.getByRole("button", {
    name: "Scrub Drop shadow X",
    exact: true,
  });
  await scrub.hover();
  const bounds = await scrub.boundingBox();
  const start = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const baseline = await runtimeStyle(page, "home-heading", "textShadow");
  for (const cancellation of ["capture", "blur", "escape"]) {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 20, start.y);
    await expect(field).toHaveValue("10");
    if (cancellation === "capture")
      await scrub.evaluate((element) => element.releasePointerCapture(1));
    else if (cancellation === "blur")
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    else await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(field).toHaveValue("0");
    await expect
      .poll(() => runtimeStyle(page, "home-heading", "textShadow"))
      .toBe(baseline);
    expect(await styleWrites(page)).toBe(1);
  }
  await field.fill("6");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 20, start.y);
  await page.mouse.up();
  await expect(field).toHaveValue("16");
  await expect.poll(() => styleWrites(page)).toBe(2);
  check(
    "effect scrubs restore on cancellation and start from the current typed draft",
    true,
  );
}

export async function runDesignInspectorPreviewOwnerSmoke({ page, check }) {
  for (const area of ["numeric", "color", "effect"]) {
    await openStyleDesign(page);
    let control;
    let property;
    if (area === "numeric") {
      property = "fontSize";
      control = page.getByRole("button", { name: "Scrub Size", exact: true });
    } else if (area === "color") {
      property = "color";
      await page
        .getByRole("button", { name: "Edit fill", exact: true })
        .click();
      control = page.getByRole("slider", { name: "Fill opacity", exact: true });
    } else {
      property = "textShadow";
      await page
        .getByRole("button", { name: "Add effect", exact: true })
        .click();
      await expect.poll(() => styleWrites(page)).toBe(1);
      await page
        .getByRole("button", { name: "Edit drop shadow", exact: true })
        .click();
      control = page.getByRole("button", {
        name: "Scrub Drop shadow X",
        exact: true,
      });
    }
    const initialOld = await runtimeStyle(page, "home-heading", property);
    const initialNew = await runtimeStyle(page, "home-copy", property);
    const initialWrites = await styleWrites(page);
    await control.hover();
    const bounds = await control.boundingBox();
    const start = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    if (area !== "color") await page.mouse.move(start.x + 20, start.y);
    await expect
      .poll(() => runtimeStyle(page, "home-heading", property))
      .not.toBe(initialOld);
    // Keyboard/programmatic selection does not synthesize a pointer blur on
    // the inspector. Its outgoing keyed editor must restore its own preview.
    await page
      .locator('[data-design-layer-id="home-copy"]')
      .evaluate((element) => element.click());
    await expect(
      page.getByRole("textbox", { name: "Size", exact: true }),
    ).toHaveValue("24");
    await page.mouse.up();
    await expect
      .poll(() => runtimeStyle(page, "home-heading", property))
      .toBe(initialOld);
    expect(await runtimeStyle(page, "home-copy", property)).toBe(initialNew);
    expect(await styleWrites(page)).toBe(initialWrites);
    check(
      `${area} preview retirement restores its previous layer without clearing or writing the new layer`,
      true,
    );
  }
}

export async function runDesignStyleRefinementsSmoke(context) {
  await runDesignColorGestureCancellationSmoke(context);
  await runDesignColorSamplingOwnerSmoke(context);
  await runDesignColorSamplingSelectionRaceSmoke(context);
  await runDesignColorFocusedRefreshSmoke(context);
  await runDesignColorChannelRefreshSmoke(context);
  await runDesignEffectKeyboardDraftSmoke(context);
  await runDesignEffectScrubCancellationSmoke(context);
  await runDesignInspectorPreviewOwnerSmoke(context);
}
