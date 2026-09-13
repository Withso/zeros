// Layout-specific browser checks use the real inspector, runtime, and mutation
// lane. The fixture is reset by the caller before the broader workspace smoke.
export async function runDesignLayoutSmoke({ page, waitFor, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );
  const layers = page.locator("#design-layers-panel");
  const layout = page.locator("[data-design-layout-section]");
  await page
    .locator('[data-design-frame="home.html"] [data-design-frame-label]')
    .click();
  check(
    "a canvas frame with children exposes alignment and constraints",
    (await layout
      .getByRole("button", { name: "Pin right", exact: true })
      .count()) === 1 &&
      (await layout
        .getByRole("button", { name: "Align left", exact: true })
        .isEnabled()),
  );
  await layers.locator('[data-design-layer-id="home-heading"]').click();
  check(
    "an empty layer hides both child alignment and constraints",
    (await layout
      .getByRole("button", { name: "Align left", exact: true })
      .count()) === 0 &&
      (await layout.locator("[data-design-layout-constraints]").count()) === 0,
  );
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const heading = runtime.locator('[data-oid="home-heading"]');
  await layout
    .getByRole("button", { name: "Sizing limits", exact: true })
    .click();
  for (const [label, value, property, expected] of [
    ["Ratio", "1.5", "aspectRatio", "1.5 / 1"],
    ["Grow", "0.25", "flexGrow", "0.25"],
    ["Shrink", "0.5", "flexShrink", "0.5"],
    ["Min W", "0.5rem", "minWidth", "0.5rem"],
  ]) {
    const field = layout.getByLabel(label, { exact: true });
    await field.fill(value);
    await field.press("Enter");
    check(
      `Layout preserves fractional ${label} values`,
      await waitFor(
        () =>
          heading.evaluate(
            (element, [key, result]) => element.style[key] === result,
            [property, expected],
          ),
        `layout-fractional-${property}`,
      ),
    );
  }
  await layout
    .getByRole("button", { name: "Hide sizing limits", exact: true })
    .click();
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
      (await layout.getByLabel("X", { exact: true }).inputValue()) === "40",
    "layout-rounded-readback",
  );
  check(
    "Layout has a fixed plain header and two compact geometry rows",
    (await layout.locator("h3").textContent()) === "Layout" &&
      (await layout
        .getByRole("button", { name: /Collapse Layout|Expand Layout/ })
        .count()) === 0 &&
      (await layout.getByText("Position & size", { exact: true }).count()) ===
        0 &&
      (await layout.locator("[data-design-layout-geometry] input").count()) ===
        5,
  );
  check(
    "Layout presents integer coordinates, dimensions, and rotation",
    (await layout.getByLabel("Y", { exact: true }).inputValue()) === "30" &&
      (await layout.getByLabel("W", { exact: true }).inputValue()) === "100" &&
      (await layout.getByLabel("H", { exact: true }).inputValue()) === "60" &&
      (await layout.getByLabel("Rotation", { exact: true }).inputValue()) ===
        "10",
  );
  const x = layout.getByLabel("X", { exact: true });
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
  await layout
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
  await layout
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
  await layout
    .getByRole("button", { name: "Flip horizontal", exact: true })
    .click();
  await layout
    .getByRole("button", { name: "Flip vertical", exact: true })
    .click();
  check(
    "flips toggle independently",
    await waitFor(
      () => heading.evaluate((element) => element.style.scale === "1 -1"),
      "layout-flip-y",
    ),
  );
  await layers.locator('[data-design-layer-id="home-hero"]').click();
  check(
    "a nested frame with children enables alignment and constraints",
    await layout
      .getByRole("button", { name: "Pin right", exact: true })
      .isEnabled(),
  );
  await layout.getByRole("button", { name: "Pin right", exact: true }).click();
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
  // Wait for confirmed inspector readback before a direct fixture resize.
  await waitFor(
    async () =>
      (
        await layout
          .getByRole("combobox", { name: "Horizontal constraint" })
          .textContent()
      ).trim() === "Right",
    "layout-pin-committed",
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
  await layout.getByRole("button", { name: "Align left", exact: true }).click();
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
  await layout.getByRole("button", { name: "Pin center", exact: true }).click();
  check(
    "the center pin controls both axes",
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
  await layers.locator('[data-design-layer-id="home-heading"]').click();
  await layout.getByText("Clip content", { exact: true }).click();
  check(
    "Clip content clips both axes",
    await waitFor(
      () =>
        heading.evaluate(
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
        heading.evaluate(
          (element) => getComputedStyle(element).overflow === "visible",
        ),
      "layout-unclip",
    ),
  );
  await layout
    .getByRole("button", { name: "Auto layout: Stack", exact: true })
    .click();
  await waitFor(
    () =>
      heading.evaluate(
        (element) => getComputedStyle(element).display === "flex",
      ),
    "layout-stack",
  );
  await layout
    .getByRole("button", { name: "Auto layout: None", exact: true })
    .click();
  check(
    "None disables automatic layout while keeping the layer visible",
    await waitFor(
      () =>
        heading.evaluate(
          (element) =>
            getComputedStyle(element).display === "block" &&
            element.getBoundingClientRect().width > 0,
        ),
      "layout-none-visible",
    ),
  );
  const copy = runtime.locator('[data-oid="home-copy"]');
  const headingRotation = await heading.evaluate(
    (element) => parseFloat(element.style.rotate) || 0,
  );
  const copyRotation = await copy.evaluate(
    (element) => parseFloat(element.style.rotate) || 0,
  );
  await layout
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
  await layout.getByRole("button", { name: "Rotate 90° clockwise" }).click();
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
  // Three 24px transform buttons must still fit the narrowest supported panel.
  const widths = [];
  for (const width of [220, 280, 420]) {
    await page.locator("[data-design-inspector]").evaluate((element, value) => {
      element.style.setProperty("--zeros-design-style-width", `${value}px`);
    }, width);
    widths.push(
      await layout
        .locator("[data-design-layout-geometry]")
        .evaluate((element) => {
          const children = [...element.children];
          return children.map((child) => child.getBoundingClientRect().width);
        }),
    );
  }
  check(
    "rotation and transform tools grow with the other Layout columns",
    widths[1][2] > widths[0][2] &&
      widths[2][2] > widths[1][2] &&
      widths.every((row) => Math.abs(row[2] - row[5]) < 1 && row[5] >= 72) &&
      widths.slice(1).every((row) => Math.abs(row[0] - row[2]) < 1),
    JSON.stringify(widths),
  );
  await page.locator("[data-design-inspector]").evaluate((element) => {
    element.style.setProperty("--zeros-design-style-width", "220px");
  });
  const rows = await layout
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
    await layout
      .locator("[data-design-layout-geometry] input")
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
      await layout.getByRole("button", { name: button, exact: true }).click();
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
