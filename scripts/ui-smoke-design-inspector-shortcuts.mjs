/* global window, getComputedStyle */
import { expect } from "@playwright/test";

export async function runDesignInspectorShortcutsSmoke({ page, check }) {
  // Earlier canvas scenarios may still be publishing previews. Start with a
  // fresh event log, then wait for each complete sequence before the next one.
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );
  await page
    .locator(
      '[data-design-sidebar-panel] [data-design-layer-id="home-heading"]',
    )
    .click();
  const selectedHeading = page
    .frameLocator(
      '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
    )
    .locator('[data-oid="home-heading"]');
  const offset = () =>
    selectedHeading.evaluate((element) =>
      element.style.getPropertyValue("left"),
    );
  const operations = () =>
    page.evaluate(() => window.__zerosHarnessDesignShortcutOperations ?? []);
  const completed = [];
  const settle = async (...sequence) => {
    completed.push(...sequence);
    // Equal start/end counts can occur between queued writes, and a minimum
    // event count can include the preceding write's tail. Assert the full log:
    // order, completion, exactly-once execution, and no stage/commit events.
    await expect.poll(operations).toEqual(completed);
  };
  const style = ["style:start", "style:end"];
  const save = [...style, "save:start", "save:end"];
  await page.evaluate(() => {
    // Make preview/persistence overlap deterministic without runner sleeps.
    window.__zerosHarnessStyleDelay = 450;
  });
  const xField = page.getByLabel("X", { exact: true });
  await xField.fill("12px");
  await xField.press("Enter");
  await expect.poll(offset).toBe("12px");
  await expect
    .poll(() => selectedHeading.evaluate((element) => element.style.position))
    .toBe("relative");
  check("X/Y fields make offsets effective on static HTML elements", true);
  await xField.fill("");
  await xField.press("Enter");
  await expect.poll(offset).toBe("");
  check("clearing the field removes the offset it authored", true);
  await settle(...style, ...style);
  check(
    "Design uses the shared Git tabs without a second review dialog",
    (await page
      .getByRole("button", { name: "Review Design changes", exact: true })
      .count()) === 0 &&
      (await page
        .getByRole("dialog", { name: "Review Design changes", exact: true })
        .count()) === 0,
  );

  await xField.fill("16px");
  await xField.press("ControlOrMeta+S");
  await settle(...save);
  await expect.poll(offset).toBe("16px");
  check("Command-S saves a focused draft without staging or committing", true);

  await xField.fill("20px");
  await xField.press("ControlOrMeta+S");
  await xField.fill("24px");
  await xField.press("ControlOrMeta+S");
  await settle(...save, ...save);
  await expect.poll(offset).toBe("24px");
  check(
    "rapid Command-S requests validate every newly published inspector draft",
    true,
  );

  await xField.fill("");
  await xField.press("Enter");
  await settle(...style);
  await expect.poll(offset).toBe("");

  await page.getByLabel("Design canvas").focus();
  await page.keyboard.press("ControlOrMeta+Z");
  await page.keyboard.press("ControlOrMeta+Z");
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await settle(
    "undo:start",
    "undo:end",
    "undo:start",
    "undo:end",
    "redo:start",
    "redo:end",
  );
  check(
    "rapid undo and redo keypresses execute once each in input order",
    true,
  );

  await runDesignPendingHistoryInspectorSmoke({ page, check });
}

export async function runDesignPendingHistoryInspectorSmoke({ page, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures=1&measureManipulation=1&engineDelayMs=0`,
    { waitUntil: "networkidle" },
  );
  await page.locator('[data-design-frame-row="home.html"]').click();
  await page.locator('[data-design-sidebar-panel] [data-design-layer-id="home-hero"]').click();
  const radius = page.getByLabel("Radius", { exact: true });
  const element = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  ).locator('[data-oid="home-hero"]');
  const paintedRadius = () => element.evaluate(node => getComputedStyle(node).borderRadius);
  await expect(radius).toHaveValue("0");
  await expect.poll(paintedRadius).toBe("0px");
  await page.evaluate(() => {
    const measurement = window.__zerosHarnessDesignSurface.measurement;
    measurement.hold("design.node.styles");
    measurement.hold("design.transaction.apply");
  });
  try {
    await radius.fill("24");
    await radius.press("Enter");
    await page.waitForFunction(() => window.__zerosHarnessDesignSurface.measurement.requests.some(
      request => ["design.node.styles", "design.transaction.apply"].includes(request.op) && request.released === null,
    ));
    await expect.poll(paintedRadius).toBe("24px");
    await expect(radius).toHaveValue("24");
    await page.locator("[data-design-canvas-viewport]").focus();
    await page.keyboard.press("ControlOrMeta+Z");
    await expect.poll(paintedRadius).toBe("0px");
    // The write cannot finish until finally releases it. This is an ordering
    // assertion on the real inspector, not a machine-dependent latency gate.
    await expect(radius).toHaveValue("0");
    const held = await page.evaluate(() => {
      const measurement = window.__zerosHarnessDesignSurface.measurement;
      return measurement.editing("ws_design_harness") &&
        measurement.requests.some(request => ["design.node.styles", "design.transaction.apply"].includes(request.op) && request.released === null) &&
        !measurement.requests.some(request => request.op === "design.history.undo");
    });
    check("Undo presents Radius with the inverse pixels while the previous edit write is held", held);
  } finally {
    await page.evaluate(() => {
      const measurement = window.__zerosHarnessDesignSurface.measurement;
      measurement.release("design.node.styles");
      measurement.release("design.transaction.apply");
    });
  }
  await page.waitForFunction(() => !window.__zerosHarnessDesignSurface.measurement.editing("ws_design_harness"));
  await expect.poll(paintedRadius).toBe("0px");
  await expect(radius).toHaveValue("0");
}
