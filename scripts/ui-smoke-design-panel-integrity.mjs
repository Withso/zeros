import { expect } from "@playwright/test";

const panelWidthKey = "zeros.design.style.width";
const layersHeightKey = "zeros.design.layers.height";

async function withPanel(page, workbench, run) {
  const origin = new URL(page.url()).origin;
  const previousViewport = page.viewportSize();
  const previousStorage = await page.evaluate(() =>
    Object.entries(localStorage),
  );
  const url = `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`;
  try {
    await page.evaluate(() => {
      localStorage.removeItem("zeros.design.style.width");
      localStorage.removeItem("zeros.design.layers.height");
      localStorage.removeItem("zeros:design-workspace-ui-v1");
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${url}${workbench ? "?workbench" : ""}`, {
      waitUntil: "networkidle",
    });
    if (workbench)
      await page.getByRole("tab", { name: "Design", exact: true }).click();
    await page.locator("[data-design-floating-panel]:visible").waitFor();
    await run();
  } finally {
    await page.mouse.up();
    await page.evaluate((entries) => {
      localStorage.clear();
      for (const [key, value] of entries) localStorage.setItem(key, value);
    }, previousStorage);
    if (previousViewport) await page.setViewportSize(previousViewport);
    await page.goto(url, { waitUntil: "networkidle" });
  }
}

async function startResize(page, label, delta) {
  const handle = page.getByRole("separator", { name: label, exact: true });
  const box = await handle.boundingBox();
  if (!box) throw new Error(`${label} has no visible bounds`);
  const vertical = label === "Resize Layers panel";
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(
    start.x + (vertical ? 0 : delta),
    start.y + (vertical ? delta : 0),
    { steps: 4 },
  );
  await expect(handle).toHaveAttribute("data-dragging", "");
  return { handle, start };
}

export async function runDesignPanelResizeCancellationSmoke({ page, check }) {
  await withPanel(page, false, async () => {
    for (const [label, selector, axis, key, delta] of [
      [
        "Resize Style panel",
        "[data-design-floating-panel]",
        "width",
        panelWidthKey,
        -80,
      ],
      [
        "Resize Layers panel",
        "[data-design-layers-slot]",
        "height",
        layersHeightKey,
        64,
      ],
    ]) {
      const size = () =>
        page
          .locator(selector)
          .evaluate(
            (element, dimension) =>
              Math.round(element.getBoundingClientRect()[dimension]),
            axis,
          );
      const baseline = await size();
      const saved = await page.evaluate(
        (storageKey) => localStorage.getItem(storageKey),
        key,
      );
      for (const cancel of [
        "Escape",
        "pointercancel",
        "blur",
        "lostpointercapture",
      ]) {
        const { handle } = await startResize(page, label, delta);
        await expect.poll(size).not.toBe(baseline);
        if (cancel === "Escape") await page.keyboard.press("Escape");
        else if (cancel === "blur")
          await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        else
          await handle.evaluate((element, type) => {
            // Chromium's mouse pointer has id 1; exercise its cancellation path
            // after starting the gesture with real captured pointer input.
            element.dispatchEvent(
              new PointerEvent(type, { bubbles: true, pointerId: 1 }),
            );
          }, cancel);
        await expect.poll(size).toBe(baseline);
        await expect(handle).not.toHaveAttribute("data-dragging", "");
        await page.mouse.up();
        expect(
          await page.evaluate(
            (storageKey) => localStorage.getItem(storageKey),
            key,
          ),
        ).toBe(saved);
        expect(
          await page.evaluate(() => ({
            cursor: document.body.style.cursor,
            select: document.body.style.userSelect,
          })),
        ).toEqual({ cursor: "", select: "" });
        check(
          `${label}: ${cancel} restores the original size without saving`,
          true,
        );
      }
    }
  });
}

export async function runDesignPanelResizePointerOwnershipSmoke({
  page,
  check,
}) {
  await withPanel(page, false, async () => {
    const panel = page.locator("[data-design-floating-panel]");
    const size = () =>
      panel.evaluate((element) =>
        Math.round(element.getBoundingClientRect().width),
      );
    const baseline = await size();
    const { handle, start } = await startResize(
      page,
      "Resize Style panel",
      -80,
    );
    await expect.poll(size).toBeGreaterThan(baseline);
    await page.evaluate(() =>
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 99 })),
    );
    await expect(handle).toHaveAttribute("data-dragging", "");
    expect(
      await page.evaluate((key) => localStorage.getItem(key), panelWidthKey),
    ).toBeNull();
    await page.mouse.move(start.x, start.y);
    await page.mouse.up();
    await expect.poll(size).toBe(baseline);
    expect(
      await page.evaluate((key) => localStorage.getItem(key), panelWidthKey),
    ).toBeNull();
    check(
      "a panel drag ignores other pointers and returning to its start does not save",
      true,
    );

    const committed = await startResize(page, "Resize Style panel", -80);
    await expect.poll(size).toBeGreaterThan(baseline);
    const held = await size();
    await page.mouse.up();
    await expect.poll(size).toBe(held);
    expect(
      Number(
        await page.evaluate((key) => localStorage.getItem(key), panelWidthKey),
      ),
    ).toBe(held);
    await expect(committed.handle).not.toHaveAttribute("data-dragging", "");
    check(
      "a completed panel drag saves its final size once and keeps the seam in place",
      true,
    );
  });
}

export async function runDesignPanelResizeRetentionSmoke({ page, check }) {
  await withPanel(page, true, async () => {
    const canvas = page.locator(
      '[data-design-retained-workspace="ws_design_harness"]',
    );
    const panel = canvas.locator("[data-design-floating-panel]");
    const baseline = Math.round((await panel.boundingBox()).width);
    await startResize(page, "Resize Style panel", -80);
    await expect
      .poll(async () => Math.round((await panel.boundingBox()).width))
      .toBeGreaterThan(baseline);
    // Keyboard navigation can change tabs while the pointer is still captured.
    await page
      .getByRole("tab", { name: "Open file", exact: true })
      .press("Enter");
    await expect(canvas).toHaveAttribute("inert", "");
    await expect(
      canvas.locator('[data-design-panel-resize="left"]'),
    ).not.toHaveAttribute("data-dragging", "");
    await page.mouse.up();
    expect(
      await page.evaluate((key) => localStorage.getItem(key), panelWidthKey),
    ).toBeNull();
    await page.getByRole("tab", { name: "Design", exact: true }).click();
    await expect
      .poll(async () => Math.round((await panel.boundingBox()).width))
      .toBe(baseline);
    check(
      "switching away cancels a held panel resize before a retained surface becomes inactive",
      true,
    );
  });
}

export async function runDesignPanelSharedWidthSmoke({ page, check }) {
  await withPanel(page, true, async () => {
    const owner = (suffix) =>
      page.locator(
        `[data-design-retained-workspace="ws_design_harness${suffix}"]`,
      );
    const activate = async (suffix) => {
      await page.evaluate((value) => {
        // The loaded fixture owns its store; switching needs no module load.
        window.__zerosHarnessSelectWorkspace(`ws_design_harness${value}`);
      }, suffix);
      await owner(suffix)
        .locator("[data-design-canvas-viewport]")
        .waitFor({ state: "visible" });
    };
    const width = (suffix) =>
      owner(suffix)
        .locator("[data-design-floating-panel]")
        .evaluate((element) =>
          Math.round(element.getBoundingClientRect().width),
        );
    await activate("_second");
    await activate("");
    await owner("")
      .getByRole("separator", { name: "Resize Style panel" })
      .press("Shift+ArrowLeft");
    const committed = await width("");
    expect(committed).toBeGreaterThan(280);
    await activate("_second");
    await expect.poll(() => width("_second")).toBe(committed);
    await owner("_second")
      .getByRole("separator", { name: "Resize Style panel" })
      .press("ArrowRight");
    await activate("");
    await expect.poll(() => width("")).toBe(committed - 8);
    check(
      "retained workspaces share the current inspector width in both directions",
      true,
    );
    await page.evaluate((key) => {
      localStorage.setItem(key, "300");
      window.dispatchEvent(
        new StorageEvent("storage", { key, newValue: "300" }),
      );
    }, panelWidthKey);
    await expect.poll(() => width("")).toBe(300);
    await activate("_second");
    await expect.poll(() => width("_second")).toBe(300);
    check(
      "an inspector width changed in another window updates the retained panel",
      true,
    );
  });
}

export async function runDesignPanelIntegritySmoke(context) {
  await runDesignPanelResizeCancellationSmoke(context);
  await runDesignPanelResizePointerOwnershipSmoke(context);
  await runDesignPanelResizeRetentionSmoke(context);
  await runDesignPanelSharedWidthSmoke(context);
}
