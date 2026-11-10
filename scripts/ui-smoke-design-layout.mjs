import { openLayersDrawer } from "./ui-smoke-design-helpers.mjs";
// Layout-specific browser checks use the real inspector, runtime, and mutation
// lane. The fixture is reset by the caller before the broader workspace smoke.
export async function runDesignLayoutSmoke({ page, waitFor, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );
  await openLayersDrawer(page);
  const layers = page.locator("[data-design-sidebar-panel]");
  const layout = page.locator("[data-design-layout-section]");
  const position = page.locator("[data-design-position-section]");
  await page
    .locator('[data-design-frame="home.html"] [data-design-frame-label]')
    .click();
  check(
    "a canvas auto layout frame exposes child alignment",
    (await layout
      .getByRole("group", { name: "Align children", exact: true })
      .count()) === 1,
  );
  await layers.locator('[data-design-layer-id="home-heading"]').click();
  await layout.getByRole("button", { name: "More layout actions" }).click();
  const childActions = await page
    .getByRole("menuitem", { name: /^Align children / })
    .count();
  await page.keyboard.press("Escape");
  check(
    "an empty layer its parent's auto layout places offers no child actions and no constraints",
    childActions === 0 &&
      (await position.locator("[data-design-position-placed]").count()) === 1 &&
      (await position.locator("[data-design-layout-constraints]").count()) === 0,
  );
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const heading = runtime.locator('[data-oid="home-heading"]');
  check(
    "the design inspector omits raw flex factors and margins",
    (await layout.getByLabel("Grow", { exact: true }).count()) === 0 &&
      (await layout
        .locator('[data-design-style-property="margin-top"]')
        .count()) === 0,
  );
  await heading.evaluate((element) => {
    element.parentElement.style.cssText =
      "position:relative;display:block;width:400px;height:300px;padding:0;border:0;box-sizing:border-box";
    element.style.cssText =
      "position:absolute;left:40.4px;top:30.2px;width:100.4px;height:60.2px;margin:0;padding:0;border:0;box-sizing:border-box;font-size:12px;transform:translate(5px, 8px) rotate(10deg)";
  });
  await layers.locator('[data-design-layer-id="home-copy"]').click();
  await layers.locator('[data-design-layer-id="home-heading"]').click();
  // The fixture above changes the DOM directly; publish its explicit runtime
  // readback rather than depending on the production mutation debounce.
  await page.evaluate(async () => {
    const { designFrameRuntime } =
      await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
    const { useDesignRuntimeStore } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-runtime-store.ts");
    const store = useDesignRuntimeStore.getState();
    const workspaceId = "ws_design_harness";
    const owner = store.byWorkspace[workspaceId];
    const details = await designFrameRuntime(
      workspaceId,
      "home.html",
    ).getNodeDetails("home-heading");
    store.publishNodeDetails(
      workspaceId,
      owner.folder,
      "home.html",
      details,
      details.sourceVersion,
    );
  });
  await waitFor(
    async () =>
      (await position.getByLabel("X", { exact: true }).inputValue()) === "40",
    "layout-rounded-readback",
  );
  check(
    "Position and Layout have fixed plain headers and compact geometry rows",
    (await position.locator("h3").textContent()) === "Position" &&
      (await layout.locator("h3").textContent()) === "Layout" &&
      (await page
        .getByRole("button", {
          name: /Collapse (Layout|Position)|Expand (Layout|Position)/,
        })
        .count()) === 0 &&
      (await layout.getByText("Position & size", { exact: true }).count()) ===
        0 &&
      (await position.locator("[data-design-layout-geometry] input").count()) ===
        3 &&
      (await layout.locator("[data-design-size-axis] input").count()) === 2,
  );
  check(
    "Position and Layout present integer coordinates, dimensions, and rotation",
    (await position.getByLabel("Y", { exact: true }).inputValue()) === "30" &&
      (await layout.getByLabel("W", { exact: true }).inputValue()) === "100" &&
      (await layout.getByLabel("H", { exact: true }).inputValue()) === "60" &&
      (await position.getByLabel("Rotation", { exact: true }).inputValue()) ===
        "10",
  );
  const x = position.getByLabel("X", { exact: true });
  await x.focus();
  await x.press("Tab");
  check(
    "merely focusing a rounded value preserves fractional CSS",
    await heading.evaluate((element) => element.style.left === "40.4px"),
  );
  await x.fill("70.6");
  await x.press("Escape");
  check(
    "Escape cancels a Layout draft",
    await heading.evaluate((element) => element.style.left === "40.4px"),
  );
  await x.fill("70.6");
  await x.press("Enter");
  check(
    "committing Layout coordinates authors whole pixels",
    await waitFor(
      () => heading.evaluate((element) => element.style.left === "71px"),
      "layout-integer-commit",
    ),
  );
  await position
    .getByRole("button", { name: "Rotate 90° clockwise" })
    .evaluate((button) => {
      for (let index = 0; index < 4; index++) button.click();
    });
  check(
    "four rapid rotation clicks accumulate four clockwise quarter turns",
    await waitFor(
      () =>
        heading.evaluate(
          (element) =>
            element.style.rotate === "360deg" &&
            element.style.transform === "translate(5px, 8px) rotate(10deg)",
        ),
      "layout-repeat-rotate",
    ),
  );
  await position
    .getByRole("button", { name: "Flip horizontal", exact: true })
    .click();
  check(
    "horizontal flip preserves authored rotation and translation",
    await waitFor(
      () =>
        heading.evaluate(
          (element) =>
            element.style.scale === "-1 1" && element.style.rotate === "360deg",
        ),
      "layout-flip-x",
    ),
  );
  await position
    .getByRole("button", { name: "Flip horizontal", exact: true })
    .click();
  await position
    .getByRole("button", { name: "Flip vertical", exact: true })
    .click();
  check(
    "flips toggle independently",
    await waitFor(
      () => heading.evaluate((element) => element.style.scale === "1 -1"),
      "layout-flip-y",
    ),
  );
  const constraint = (axis) =>
    position.getByRole("combobox", {
      name: axis === "x" ? "Horizontal constraint" : "Vertical constraint",
    });
  const constrain = async (axis, name) => {
    await constraint(axis).click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  check(
    "a freely placed layer offers its own alignment and constraints",
    (await position
      .getByRole("button", { name: "Align right", exact: true })
      .isEnabled()) &&
      (await constraint("x").isEnabled()),
  );
  await constrain("x", "Right");
  check(
    "pinning keeps the layer in place",
    await waitFor(
      () =>
        heading.evaluate(
          (element) =>
            element.style.right === "229px" &&
            element.style.left === "auto" &&
            element.offsetLeft === 71,
        ),
      "layout-pin-right",
    ),
  );
  // The parent participates in the same transaction when pinning flow children.
  // The inspector's Right value is optimistic. Wait for the authored pin and
  // its runtime generation before resizing a parent the save still owns.
  const pinCommitted = await waitFor(
    () =>
      page.evaluate(async () => {
        const { designFrame } =
          await import("/apps/desktop/src/renderer/platform/git.ts");
        const { designFrameRuntime } =
          await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
        const frame = await designFrame("ws_design_harness", "home.html");
        const node = new DOMParser()
          .parseFromString(frame.source, "text/html")
          .querySelector('[data-oid="home-heading"]');
        return (
          node?.style.right === "229px" &&
          node.style.left === "auto" &&
          designFrameRuntime("ws_design_harness", "home.html")
            ?.sourceVersion === frame.sourceVersion
        );
      }),
    "layout-pin-committed",
  );
  if (!pinCommitted)
    throw new Error(
      "The pin transaction did not settle before the parent resize.",
    );
  await heading.evaluate((element) => {
    element.parentElement.style.width = "600px";
  });
  check(
    "a pinned layer follows its parent resizing",
    await waitFor(
      () => heading.evaluate((element) => element.offsetLeft === 271),
      "layout-parent-resize",
    ),
  );
  await position
    .getByRole("button", { name: "Align left", exact: true })
    .click();
  check(
    "alignment works with no automatic layout",
    await waitFor(
      () =>
        heading.evaluate(
          (element) =>
            element.style.left === "0px" &&
            element.style.right === "auto" &&
            getComputedStyle(element.parentElement).display === "block",
        ),
      "layout-align-none",
    ),
  );
  await constrain("x", "Center");
  await constrain("y", "Center");
  check(
    "a Center constraint on each axis centers the layer both ways",
    await waitFor(
      () =>
        heading.evaluate(
          (element) =>
            element.style.getPropertyValue("--zeros-layout-x") === "center" &&
            element.style.getPropertyValue("--zeros-layout-y") === "center",
        ),
      "layout-center",
    ),
  );
  await layers.locator('[data-design-layer-id="home-hero"]').click();
  await layout.getByText("Clip content", { exact: true }).click();
  check(
    "Clip content clips both axes",
    await waitFor(
      () =>
        runtime
          .locator('[data-oid="home-hero"]')
          .evaluate(
            (element) =>
              getComputedStyle(element).overflowX === "hidden" &&
              getComputedStyle(element).overflowY === "hidden",
          ),
      "layout-clip",
    ),
  );
  await layout.getByText("Clip content", { exact: true }).click();
  check(
    "unchecking Clip content reveals overflow",
    await waitFor(
      () =>
        runtime
          .locator('[data-oid="home-hero"]')
          .evaluate(
            (element) => getComputedStyle(element).overflow === "visible",
          ),
      "layout-unclip",
    ),
  );
  await layout
    .getByRole("button", { name: "Auto layout: Vertical", exact: true })
    .click();
  await waitFor(
    () =>
      runtime
        .locator('[data-oid="home-hero"]')
        .evaluate((element) => getComputedStyle(element).display === "flex"),
    "layout-stack",
  );
  await layout
    .getByRole("button", { name: "Auto layout: None", exact: true })
    .click();
  check(
    "None disables automatic layout while keeping the layer visible",
    await waitFor(
      () =>
        runtime
          .locator('[data-oid="home-hero"]')
          .evaluate(
            (element) =>
              getComputedStyle(element).display === "block" &&
              element.getBoundingClientRect().width > 0,
          ),
      "layout-none-visible",
    ),
  );
  await layers.locator('[data-design-layer-id="home-heading"]').click();
  const copy = runtime.locator('[data-oid="home-copy"]');
  const headingRotation = await heading.evaluate(
    (element) => parseFloat(element.style.rotate) || 0,
  );
  const copyRotation = await copy.evaluate(
    (element) => parseFloat(element.style.rotate) || 0,
  );
  await position
    .getByRole("button", { name: "Rotate 90° clockwise" })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await layers.locator('[data-design-layer-id="home-copy"]').click();
  check(
    "queued relative actions stay with their original selection",
    await waitFor(
      async () =>
        (await heading.evaluate((element) =>
          parseFloat(element.style.rotate),
        )) ===
          headingRotation + 180 &&
        (await copy.evaluate(
          (element) => parseFloat(element.style.rotate) || 0,
        )) === copyRotation,
      "layout-selection-race",
    ),
  );
  await layers
    .locator('[data-design-layer-id="home-heading"]')
    .click({ modifiers: ["Shift"] });
  await position.getByRole("button", { name: "Rotate 90° clockwise" }).click();
  check(
    "multi-selection rotates each layer from its own angle",
    await waitFor(
      async () =>
        (await heading.evaluate((element) =>
          parseFloat(element.style.rotate),
        )) ===
          headingRotation + 270 &&
        (await copy.evaluate(
          (element) => parseFloat(element.style.rotate) || 0,
        )) ===
          copyRotation + 90,
      "layout-multiple-rotations",
    ),
  );
  await layers.locator('[data-design-layer-id="home-heading"]').click();
  // The rotation and flip buttons must still fit the narrowest supported panel.
  const widths = [];
  for (const width of [220, 280, 420]) {
    await page
      .locator("[data-design-canvas-area]")
      .evaluate((element, value) => {
        element.style.setProperty("--zeros-design-style-width", `${value}px`);
      }, width);
    widths.push(
      await position
        .locator("[data-design-layout-geometry]")
        .evaluate((element) => {
          const children = [...element.children];
          return children.map((child) => child.getBoundingClientRect().width);
        }),
    );
  }
  // X | Y over Rotation | rotate and flip: two equal columns at every width.
  check(
    "geometry keeps two equal columns that grow with the panel",
    widths[2][0] > widths[1][0] &&
      widths.every(
        (row) =>
          row.every((width) => Math.abs(width - row[0]) < 1) && row[3] >= 72,
      ),
    JSON.stringify(widths),
  );
  await page.locator("[data-design-canvas-area]").evaluate((element) => {
    element.style.setProperty("--zeros-design-style-width", "220px");
  });
  const rows = await position
    .locator("[data-design-layout-geometry]")
    .evaluate((element) => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
  check(
    "Layout geometry fits its panel without horizontal overflow",
    rows.scrollWidth <= rows.width,
  );
  check(
    "four-digit Layout values remain readable at the narrowest panel width",
    await page
      .locator(
        "[data-design-position-section] [data-design-layout-geometry] input, [data-design-layout-section] [data-design-size-axis] input",
      )
      .evaluateAll((inputs) => {
        const context = document.createElement("canvas").getContext("2d");
        return inputs.every((input) => {
          const style = getComputedStyle(input);
          context.font = `${style.fontSize} ${style.fontFamily}`;
          return (
            context.measureText("1395").width <=
            input.clientWidth -
              parseFloat(style.paddingLeft) -
              parseFloat(style.paddingRight)
          );
        });
      }),
  );

  // Exercise the flip buttons together with the real canvas gesture, using a
  // fresh frame so the earlier pinning and multi-selection fixtures do not
  // change its pivot or clipping.
  const readRotatedNode = () =>
    page.evaluate(async () => {
      const { designFrameRuntime } =
        await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
      return designFrameRuntime(
        "ws_design_harness",
        "home.html",
      ).getNodeDetails("home-heading");
    });
  const angleDelta = (angle, base) => ((angle - base + 540) % 360) - 180;
  const overlay = page.locator('[data-design-element-overlay="home-heading"]');
  for (const [buttons, expectedScale] of [
    [["Flip horizontal"], "-1 1"],
    [["Flip vertical"], "1 -1"],
    [["Flip horizontal", "Flip vertical"], "-1"],
  ]) {
    await page.goto(
      `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
      { waitUntil: "networkidle" },
    );
    await openLayersDrawer(page);
    await heading.waitFor();
    await layers.locator('[data-design-layer-id="home-heading"]').click();
    for (const [label, value] of [
      ["W", "400"],
      ["H", "120"],
    ]) {
      const field = layout.getByLabel(label, { exact: true });
      await field.fill(value);
      await field.press("Enter");
    }
    await waitFor(
      () =>
        page.evaluate(
          () =>
            window.__zerosHarnessDesignShortcutOperations.filter(
              (operation) => operation === "style:end",
            ).length === 2,
        ),
      "layout-rotation-size",
    );
    const commitsBeforeFlip = await page.evaluate(
      () =>
        window.__zerosHarnessDesignShortcutOperations.filter(
          (operation) => operation === "style:end",
        ).length,
    );
    for (const button of buttons)
      await position.getByRole("button", { name: button, exact: true }).click();
    await waitFor(
      () =>
        page.evaluate(
          async ({ scale, commits }) => {
            const { designRuntimeFrameState } =
              await import("/apps/desktop/src/renderer/features/design-workspace/state/design-runtime-store.ts");
            const node = designRuntimeFrameState(
              "ws_design_harness",
              "home.html",
            )?.detailsByNode["home-heading"];
            return (
              node?.styles.scale === scale &&
              window.__zerosHarnessDesignShortcutOperations.filter(
                (operation) => operation === "style:end",
              ).length >= commits
            );
          },
          { scale: expectedScale, commits: commitsBeforeFlip + buttons.length },
        ),
      "layout-rotation-flip",
    );
    const before = await readRotatedNode();
    await waitFor(async () => {
      const angle = await overlay.evaluate((element) => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform);
        return (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
      });
      return Math.abs(angleDelta(angle, before.box.rotation)) < 0.1;
    }, "layout-rotation-overlay");
    const bounds = await overlay.boundingBox();
    const corner = await overlay
      .locator("[data-design-rotate-corner]")
      .first()
      .boundingBox();
    const center = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
    const start = {
      x: corner.x + corner.width / 2,
      y: corner.y + corner.height / 2,
    };
    const dx = start.x - center.x,
      dy = start.y - center.y;
    const angle = Math.PI / 6;
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(
      center.x + dx * Math.cos(angle) - dy * Math.sin(angle),
      center.y + dx * Math.sin(angle) + dy * Math.cos(angle),
      { steps: 10 },
    );
    await page.mouse.up();
    check(
      `canvas rotation follows the pointer with scale ${expectedScale}`,
      await waitFor(async () => {
        // Source adoption can invalidate an in-flight read. Retry the exact
        // confirmed generation instead of sampling only the transient turn.
        const after = await readRotatedNode().catch(() => null);
        if (!after) return false;
        return (
          after.sourceVersion !== before.sourceVersion &&
          (await overlay.getAttribute("data-design-overlay-source-version")) ===
            after.sourceVersion &&
          (await page.evaluate(() =>
            window.__zerosHarnessDesignShortcutOperations.at(-1),
          )) === "style:end" &&
          after.styles.scale === expectedScale &&
          Math.abs(angleDelta(after.box.rotation, before.box.rotation) - 30) <
            0.2
        );
      }, "layout-flipped-rotation"),
    );
  }
}
