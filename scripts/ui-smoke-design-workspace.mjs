// Design-workspace portion of the real-browser interaction contract. Keeping
// it beside (rather than embedded in) ui-smoke-composer lets the design surface
// grow independently from the coding-agent/GitHub smoke path.

export async function runDesignWorkspaceSmoke({ page, waitFor, check }) {
  // The harness uses a sandboxed runtime and production Radix primitives;
  // bridge-backed writes are covered by the engine suites.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );

  const layersPanel = page.locator("#design-layers-panel");
  const designSidebar = page.getByRole("region", {
    name: "Design workspace sidebar",
  });
  const workspaceModeHeader = designSidebar.locator(
    "[data-workspace-mode-header]",
  );
  await layersPanel.waitFor({ state: "visible", timeout: 10_000 });
  await designSidebar.waitFor({ state: "visible", timeout: 10_000 });
  await workspaceModeHeader.waitFor({ state: "visible", timeout: 10_000 });
  const initialLayersBox = await layersPanel.boundingBox();
  const initialSidebarBox = await designSidebar.boundingBox();
  const initialStylePanelBox = await page
    .locator("[data-design-inspector]")
    .boundingBox();
  const workspaceModeHeaderBox = await workspaceModeHeader.boundingBox();
  check(
    "design Layers fill a dedicated native sidebar",
    !!initialLayersBox &&
      initialLayersBox.height > 800 &&
      !!initialSidebarBox &&
      Math.abs(initialSidebarBox.width - 240) < 0.5,
  );
  check(
    "Style opens at 280px while Layers opens at 240px",
    !!initialStylePanelBox &&
      Math.abs(initialStylePanelBox.width - 280) < 0.5 &&
      !!initialSidebarBox &&
      Math.abs(initialSidebarBox.width - 240) < 0.5,
  );
  check(
    "workspace name and icon-only mode toggle sit above Layers",
    !!workspaceModeHeaderBox &&
      !!initialLayersBox &&
      workspaceModeHeaderBox.y + workspaceModeHeaderBox.height <=
        initialLayersBox.y &&
      (await workspaceModeHeader
        .locator("[data-workspace-mode-name]")
        .count()) === 1 &&
      (await workspaceModeHeader.getByRole("button").count()) === 2 &&
      (await workspaceModeHeader
        .getByRole("button", { name: "Code mode" })
        .count()) === 1 &&
      (await workspaceModeHeader
        .getByRole("button", { name: "Design mode" })
        .getAttribute("aria-pressed")) === "true" &&
      (await workspaceModeHeader
        .locator("[data-workspace-mode-toggle]")
        .innerText()) === "",
  );
  const workspaceModeChrome = await workspaceModeHeader.evaluate((header) => {
    const toggle = header.querySelector("[data-workspace-mode-toggle]");
    const buttons = [...header.querySelectorAll("[data-workspace-mode]")];
    const icons = [...header.querySelectorAll("[data-workspace-mode] svg")];
    const toggleStyle = toggle ? window.getComputedStyle(toggle) : null;
    const headerStyle = window.getComputedStyle(header);
    const resolveColor = (token) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      header.appendChild(probe);
      const color = window.getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    return {
      buttonSizes: buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return [box.width, box.height];
      }),
      buttonStyles: buttons.map((button) => {
        const style = window.getComputedStyle(button);
        return {
          active: button.getAttribute("aria-pressed") === "true",
          backgroundColor: style.backgroundColor,
          color: style.color,
        };
      }),
      fg1: resolveColor("--fg1"),
      fg3: resolveColor("--fg3"),
      gap: toggleStyle?.columnGap ?? "",
      iconSizes: icons.map((icon) => {
        const box = icon.getBoundingClientRect();
        return [box.width, box.height];
      }),
      padding: toggleStyle
        ? [
            toggleStyle.paddingTop,
            toggleStyle.paddingRight,
            toggleStyle.paddingBottom,
            toggleStyle.paddingLeft,
          ]
        : [],
      separator: headerStyle.borderBottomWidth,
    };
  });
  check(
    "workspace mode chrome uses 16px buttons and icons with a 4px inset and 8px gap",
    workspaceModeChrome.buttonSizes.length === 2 &&
      workspaceModeChrome.buttonSizes.every(
        ([width, height]) => width === 16 && height === 16,
      ) &&
      workspaceModeChrome.gap === "8px" &&
      workspaceModeChrome.iconSizes.length === 2 &&
      workspaceModeChrome.iconSizes.every(
        ([width, height]) => width === 16 && height === 16,
      ) &&
      workspaceModeChrome.padding.every((value) => value === "4px") &&
      workspaceModeChrome.separator === "1px",
  );
  const selectedModeStyle = workspaceModeChrome.buttonStyles.find(
    ({ active }) => active,
  );
  const unselectedModeStyle = workspaceModeChrome.buttonStyles.find(
    ({ active }) => !active,
  );
  check(
    "workspace mode selection uses fg1 and fg3 without a selected fill",
    selectedModeStyle?.backgroundColor === "rgba(0, 0, 0, 0)" &&
      selectedModeStyle.color === workspaceModeChrome.fg1 &&
      unselectedModeStyle?.color === workspaceModeChrome.fg3,
  );
  check(
    "design workspace mounts no coding-agent chat",
    (await page.getByRole("region", { name: "Agent chat preview" }).count()) ===
      0 && (await page.getByLabel("Agent Workspace").count()) === 0,
  );
  check(
    "design inspector omits the code-column collapse control",
    (await page.getByRole("button", { name: "Hide design panel" }).count()) ===
      0 &&
      (await page
        .getByRole("button", { name: "Show design panel" })
        .count()) === 0,
  );

  check(
    "the Layers panel carries no search field or layer tally",
    (await page.getByLabel("Search layers").count()) === 0 &&
      (await layersPanel.getByLabel(/^\d+ layers$/).count()) === 0,
  );

  const layersViewport = layersPanel.locator(
    "[data-radix-scroll-area-viewport]",
  );
  check(
    "long Layers trees own vertical scrolling",
    await layersViewport.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  );
  await layersViewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  check(
    "Layers viewport can reach its final rows",
    await layersViewport.evaluate((element) => element.scrollTop > 0),
  );
  await layersViewport.evaluate((element) => {
    element.scrollTop = 0;
  });

  // Depth reads from the row's content, never from its fill: every row spans the
  // panel so a selection and the rows it owns can share one continuous block.
  const readLayerRow = (oid) =>
    layersPanel.evaluate((panel, target) => {
      const row =
        panel.querySelector(`[data-design-frame-row="${target}"]`) ??
        panel.querySelector(
          `[data-design-layer-row="${target}"] [data-design-layer-id]`,
        );
      if (!row) return null;
      const icons = row.querySelectorAll("svg");
      const icon = icons[icons.length - 1];
      const box = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      return {
        left: box.left,
        width: box.width,
        iconLeft: icon ? icon.getBoundingClientRect().left : null,
        discloses: row.querySelector("[data-layer-disclosure]") !== null,
        radius: [
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomRightRadius,
          style.borderBottomLeftRadius,
        ].map((value) => Number.parseFloat(value)),
        transition: style.transitionProperty,
      };
    }, oid);
  const frameRowMetrics = await readLayerRow("home.html");
  const bodyRowMetrics = await readLayerRow("home-body");
  const mainRowMetrics = await readLayerRow("home-main");
  const headingRowMetrics = await readLayerRow("home-heading");
  const layerNames = await layersPanel.evaluate((panel) => {
    const name = (selector) =>
      panel.querySelector(selector)?.textContent?.trim() ?? null;
    return {
      frame: name('[data-design-frame-row="home.html"]'),
      body: name('[data-design-layer-id="home-body"]'),
      main: name('[data-design-layer-id="home-main"]'),
      heading: name('[data-design-layer-id="home-heading"]'),
    };
  });
  check(
    "Layers uses only designer-facing names instead of HTML tags or content",
    layerNames.frame === "Frame" &&
      layerNames.body === "Frame" &&
      layerNames.main === "Frame" &&
      layerNames.heading === "Text",
    JSON.stringify(layerNames),
  );
  const homeLayoutIcons = await layersPanel.evaluate((panel) => {
    const icon = (selector) =>
      panel
        .querySelector(selector)
        ?.querySelector("[data-design-layout-icon]")
        ?.getAttribute("data-design-layout-icon") ?? null;
    return {
      frame: icon('[data-design-frame-row="home.html"]'),
      body: icon('[data-design-layer-id="home-body"]'),
      main: icon('[data-design-layer-id="home-main"]'),
      nav: icon('[data-design-layer-id="home-nav"]'),
    };
  });
  check(
    "Frame icons describe block, vertical flex, and horizontal flex layouts",
    homeLayoutIcons.frame === "flex-vertical" &&
      homeLayoutIcons.body === "frame" &&
      homeLayoutIcons.main === "flex-vertical" &&
      homeLayoutIcons.nav === "flex-horizontal",
    JSON.stringify(homeLayoutIcons),
  );
  check(
    "layer rows indent their content one step per depth below the frame row",
    !!frameRowMetrics &&
      !!bodyRowMetrics &&
      !!mainRowMetrics &&
      bodyRowMetrics.iconLeft - frameRowMetrics.iconLeft === 12 &&
      mainRowMetrics.iconLeft - bodyRowMetrics.iconLeft === 12,
  );
  check(
    "every Layers row fills the panel width so a block can stay continuous",
    !!frameRowMetrics &&
      !!bodyRowMetrics &&
      !!headingRowMetrics &&
      bodyRowMetrics.left === frameRowMetrics.left &&
      headingRowMetrics.left === frameRowMetrics.left &&
      bodyRowMetrics.width === frameRowMetrics.width &&
      headingRowMetrics.width === frameRowMetrics.width,
  );
  const heroRowMetrics = await readLayerRow("home-hero");
  check(
    "childless layers reserve the disclosure column instead of a chevron",
    !!headingRowMetrics &&
      !!heroRowMetrics &&
      !headingRowMetrics.discloses &&
      heroRowMetrics.discloses &&
      headingRowMetrics.iconLeft - heroRowMetrics.iconLeft === 12,
  );
  check(
    "Layers rows repaint their fill without a transition",
    frameRowMetrics?.transition === "none" &&
      headingRowMetrics?.transition === "none",
  );

  const dormantLayerRow = layersPanel
    .locator('[data-design-layer-id]:not([aria-selected="true"])')
    .first();
  const selectedLayerRow = layersPanel
    .locator('[data-design-layer-id][aria-selected="true"]')
    .first();
  const dormantLayerVisual =
    (await dormantLayerRow.count()) > 0
      ? await dormantLayerRow.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            borderWidth: style.borderWidth,
          };
        })
      : null;
  const selectedLayerVisual =
    (await selectedLayerRow.count()) > 0
      ? await selectedLayerRow.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            borderWidth: style.borderWidth,
          };
        })
      : null;
  check(
    "dormant Layers rows stay transparent and borderless",
    dormantLayerVisual?.background === "rgba(0, 0, 0, 0)" &&
      dormantLayerVisual.borderWidth === "0px",
  );
  check(
    "selected Layers rows use fill instead of a border",
    !!selectedLayerVisual &&
      selectedLayerVisual.background !== "rgba(0, 0, 0, 0)" &&
      selectedLayerVisual.borderWidth === "0px",
  );

  // Selecting the frame owns every row it contains, so the fills must close as
  // one rounded container: rounded at the run's first and last row, square in
  // between, and never interrupted by a gap.
  const homeFrameRow = layersPanel.locator(
    '[data-design-frame-row="home.html"]',
  );
  const frameDisclosure = homeFrameRow.locator("[data-layer-disclosure]");
  const homeLayerRows = layersPanel.locator(
    '[data-design-panel-row^="layer:home.html:"]',
  );
  const readOwnedBlock = () =>
    layersPanel.evaluate((panel) => {
      const rows = [
        panel.querySelector('[data-design-panel-row="frame:home.html"]'),
        ...panel.querySelectorAll(
          '[data-design-panel-row^="layer:home.html:"]',
        ),
      ].filter(Boolean);
      if (rows.length < 3) return null;
      const filled = rows.filter(
        (row) => getComputedStyle(row).backgroundColor !== "rgba(0, 0, 0, 0)",
      );
      const corner = (row, side) =>
        Number.parseFloat(getComputedStyle(row)[side]);
      const gaps = rows
        .slice(1)
        .map(
          (row, index) =>
            row.getBoundingClientRect().top -
            rows[index].getBoundingClientRect().bottom,
        );
      return {
        rows: rows.length,
        filled: filled.length,
        firstFilled: filled[0] === rows[0],
        lastFilled: filled.at(-1) === rows.at(-1),
        topRadius: corner(rows[0], "borderTopLeftRadius"),
        topBottomRadius: corner(rows[0], "borderBottomLeftRadius"),
        middleRadius: corner(rows[1], "borderTopLeftRadius"),
        lastRadius: corner(rows.at(-1), "borderBottomLeftRadius"),
        maxGap: gaps.length > 0 ? Math.max(...gaps) : 0,
      };
    });
  await homeFrameRow.click();
  await waitFor(async () => {
    const block = await readOwnedBlock();
    return !!block && block.filled === block.rows;
  }, "design-frame-owned-block");
  const ownedBlock = await readOwnedBlock();
  check(
    "a selected frame paints its owned rows as one rounded block",
    !!ownedBlock &&
      ownedBlock.filled === ownedBlock.rows &&
      ownedBlock.firstFilled &&
      ownedBlock.lastFilled &&
      ownedBlock.topRadius > 0 &&
      ownedBlock.topBottomRadius === 0 &&
      ownedBlock.middleRadius === 0 &&
      ownedBlock.lastRadius > 0 &&
      ownedBlock.maxGap === 0,
    JSON.stringify(ownedBlock),
  );

  // The top frame row folds its whole tree, and reopening restores it.
  await frameDisclosure.click();
  check(
    "the frame row collapses the entire frame",
    await waitFor(
      async () =>
        (await homeLayerRows.count()) === 0 &&
        (await homeFrameRow.getAttribute("aria-expanded")) === "false",
      "design-frame-tree-folded",
    ),
  );
  await frameDisclosure.click();
  check(
    "reopening the frame row restores its tree",
    await waitFor(
      async () =>
        (await layersPanel
          .locator('[data-design-layer-row="home-hero"]')
          .count()) === 1,
      "design-frame-tree-unfolded",
    ),
  );

  // Every frame owns its own fold: opening a second one keeps the first open,
  // and selecting either of them changes nothing about what is expanded.
  const pricingFrameRow = layersPanel.locator(
    '[data-design-frame-row="pricing.html"]',
  );
  const pricingLayerRows = layersPanel.locator(
    '[data-design-panel-row^="layer:pricing.html:"]',
  );
  const navDisclosure = layersPanel.locator(
    '[data-design-layer-row="home-nav"] [data-layer-disclosure]',
  );
  await navDisclosure.click();
  await waitFor(
    async () =>
      (await layersPanel
        .locator('[data-design-layer-row="home-mark"]')
        .count()) === 1,
    "design-layer-nav-expanded",
  );
  await pricingFrameRow.locator("[data-layer-disclosure]").click();
  check(
    "two frames stay open at the same time",
    await waitFor(
      async () =>
        (await pricingLayerRows.count()) > 0 &&
        (await homeLayerRows.count()) > 0 &&
        (await homeFrameRow.getAttribute("aria-expanded")) === "true" &&
        (await pricingFrameRow.getAttribute("aria-expanded")) === "true",
      "design-two-frames-open",
    ),
  );
  for (const target of ["pricing-body", "pricing-main"]) {
    const row = layersPanel.locator(`[data-design-layer-id="${target}"]`);
    await row.waitFor({ state: "visible", timeout: 10_000 });
    if ((await row.getAttribute("aria-expanded")) !== "true") {
      await layersPanel
        .locator(`[data-design-layer-row="${target}"] [data-layer-disclosure]`)
        .click();
    }
  }
  await layersPanel
    .locator('[data-design-layer-id="pricing-plans"]')
    .waitFor({ state: "visible", timeout: 10_000 });
  const pricingLayoutIcons = await layersPanel.evaluate((panel) => {
    const icon = (selector) =>
      panel
        .querySelector(selector)
        ?.querySelector("[data-design-layout-icon]")
        ?.getAttribute("data-design-layout-icon") ?? null;
    return {
      frame: icon('[data-design-frame-row="pricing.html"]'),
      body: icon('[data-design-layer-id="pricing-body"]'),
      main: icon('[data-design-layer-id="pricing-main"]'),
      plans: icon('[data-design-layer-id="pricing-plans"]'),
    };
  });
  check(
    "Frame icons use the grid icon for grid layout",
    pricingLayoutIcons.frame === "flex-vertical" &&
      pricingLayoutIcons.body === "frame" &&
      pricingLayoutIcons.main === "flex-vertical" &&
      pricingLayoutIcons.plans === "grid",
    JSON.stringify(pricingLayoutIcons),
  );
  await pricingFrameRow.click();
  check(
    "selecting another frame never folds the frame already open",
    await waitFor(
      async () =>
        (await pricingFrameRow.getAttribute("aria-selected")) === "true" &&
        (await homeFrameRow.getAttribute("aria-expanded")) === "true" &&
        (await layersPanel
          .locator('[data-design-layer-row="home-mark"]')
          .count()) === 1,
      "design-frame-switch-keeps-expansion",
    ),
  );

  // One click closes the whole workspace, and the control is only inert once
  // nothing anywhere is open.
  const collapseAllLayers = layersPanel.getByRole("button", {
    name: "Collapse all layers",
  });
  check(
    "Collapse all stays available while any frame is open",
    !(await collapseAllLayers.isDisabled()),
  );
  await collapseAllLayers.click();
  check(
    "Collapse all closes every frame in the workspace",
    await waitFor(
      async () =>
        (await layersPanel.locator("[data-design-layer-id]").count()) === 0 &&
        (await homeFrameRow.getAttribute("aria-expanded")) === "false" &&
        (await pricingFrameRow.getAttribute("aria-expanded")) === "false" &&
        (await collapseAllLayers.isDisabled()),
      "design-collapse-all-layers",
    ),
  );

  // Reopen the path the rest of this suite works in: a frame the user closed
  // stays closed until they open it, so nothing reopens it behind their back.
  for (const target of ["home.html", "home-body", "home-main", "home-hero"]) {
    const disclosure = layersPanel.locator(
      target.endsWith(".html")
        ? `[data-design-frame-row="${target}"] [data-layer-disclosure]`
        : `[data-design-layer-row="${target}"] [data-layer-disclosure]`,
    );
    await disclosure.click();
    await page.waitForTimeout(60);
  }
  await layersPanel.locator('[data-design-layer-id="home-heading"]').click();
  await waitFor(
    async () =>
      (await layersPanel
        .locator('[data-design-layer-id="home-heading"][aria-selected="true"]')
        .count()) === 1,
    "design-layer-selection-restored",
  );

  const designSplitter = page.getByRole("separator", {
    name: "Resize Layers panel",
  });
  await designSplitter.focus();
  await page.keyboard.press("ArrowRight");
  const keyboardSidebarBox = await designSidebar.boundingBox();
  check(
    "keyboard splitter resizes the design sidebar",
    !!initialSidebarBox &&
      !!keyboardSidebarBox &&
      keyboardSidebarBox.width > initialSidebarBox.width,
  );

  await page.setViewportSize({ width: 700, height: 700 });
  const compactSidebarBox = await designSidebar.boundingBox();
  const compactCanvasBox = await page
    .getByRole("region", { name: "Design workspace", exact: true })
    .boundingBox();
  check(
    "compact design keeps the 34/66 sidebar-canvas split usable",
    !!compactSidebarBox &&
      compactSidebarBox.width >= 235 &&
      !!compactCanvasBox &&
      compactCanvasBox.width >= 455,
  );
  await page.setViewportSize({ width: 1440, height: 900 });

  const styleSplitter = page.getByRole("separator", {
    name: "Resize Style panel",
  });
  const stylePanelBeforeKeyboard = await page
    .locator("[data-design-inspector]")
    .boundingBox();
  await styleSplitter.focus();
  await page.keyboard.press("ArrowLeft");
  const stylePanelAfterKeyboard = await page
    .locator("[data-design-inspector]")
    .boundingBox();
  check(
    "keyboard splitter resizes the Style panel",
    !!stylePanelBeforeKeyboard &&
      !!stylePanelAfterKeyboard &&
      stylePanelAfterKeyboard.width > stylePanelBeforeKeyboard.width,
  );
  await page.keyboard.press("ArrowRight");

  const designCanvas = page.getByRole("region", {
    name: "Design workspace",
    exact: true,
  });
  await designCanvas.waitFor({ state: "visible", timeout: 10_000 });
  const homeFrame = page.locator('[data-design-frame="home.html"]');
  await homeFrame.waitFor({ state: "visible", timeout: 10_000 });
  const homeRuntime = homeFrame.locator("iframe").contentFrame();
  const canvasViewport = page.getByLabel("Design canvas");
  const zoomCanvasWorld = page.locator("[data-design-canvas-world]");
  const readCanvasTransform = () =>
    zoomCanvasWorld.evaluate((world) => {
      const matrix = new DOMMatrix(getComputedStyle(world).transform);
      return { zoom: matrix.a, panX: matrix.e, panY: matrix.f };
    });
  // Returns the canvas-relative anchor exactly as the app observed it. The
  // WheelEvent constructor coerces MouseEventInit clientX/clientY through
  // WebIDL long — integers — so the handler zooms around the truncated
  // coordinate; a fractional expected anchor would accumulate an offset that
  // the focal checks amplify by the total zoom ratio.
  const dispatchZoomBurst = async (modifier) => {
    return await canvasViewport.evaluate(
      (canvas, input) => {
        const bounds = canvas.getBoundingClientRect();
        let anchor = null;
        for (let index = 0; index < input.count; index += 1) {
          const event = new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            clientX: bounds.left + bounds.width * input.anchorX,
            clientY: bounds.top + bounds.height * input.anchorY,
            deltaY: input.deltaY,
            deltaMode: WheelEvent.DOM_DELTA_PIXEL,
            ctrlKey: input.modifier === "ctrl",
            metaKey: input.modifier === "meta",
          });
          anchor ??= {
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top,
          };
          canvas.dispatchEvent(event);
        }
        return anchor;
      },
      {
        modifier,
        count: 8,
        deltaY: -12,
        anchorX: 0.62,
        anchorY: 0.41,
      },
    );
  };
  const stylePanelHeader = page.locator("[data-design-style-panel-header]");
  const styleZoomButton = stylePanelHeader.getByRole("button", {
    name: /^Canvas zoom \d+%$/,
  });
  const fitAllFrames = async () => {
    await canvasViewport.focus();
    await page.keyboard.press("Shift+1");
  };
  await fitAllFrames();
  const readCameraChrome = () =>
    zoomCanvasWorld.evaluate((world) => {
      const matrix = new DOMMatrix(getComputedStyle(world).transform);
      const label = world.querySelector(
        '[data-design-frame="home.html"] [data-design-frame-label]',
      );
      const handle = world.querySelector(
        '[data-design-frame="home.html"] .zd-design-selection-handle',
      );
      const spacingRoot = world.querySelector(
        "[data-design-inline-spacing-root]",
      );
      const labelBounds = label?.getBoundingClientRect();
      const handleBounds = handle?.getBoundingClientRect();
      return {
        zoom: matrix.a,
        cssZoom: Number(
          getComputedStyle(world).getPropertyValue("--design-canvas-zoom"),
        ),
        inverseZoom: Number(
          getComputedStyle(world).getPropertyValue(
            "--design-canvas-inverse-zoom",
          ),
        ),
        gesture: world.hasAttribute("data-design-camera-gesture"),
        label: labelBounds
          ? {
              width: labelBounds.width,
              height: labelBounds.height,
              fontSize: Number.parseFloat(getComputedStyle(label).fontSize),
            }
          : null,
        handle: handleBounds
          ? { width: handleBounds.width, height: handleBounds.height }
          : null,
        spacingVisibility: spacingRoot
          ? getComputedStyle(spacingRoot).visibility
          : null,
      };
    });
  const chromeBeforePinch = await readCameraChrome();
  await canvasViewport.evaluate((canvas) => {
    const bounds = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + bounds.width * 0.5,
        clientY: bounds.top + bounds.height * 0.5,
        deltaY: -120,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        ctrlKey: true,
      }),
    );
  });
  const chromeDuringPinch = await readCameraChrome();
  check(
    "unsettled pinch synchronizes camera CSS and keeps canvas chrome screen-stable",
    chromeDuringPinch.gesture &&
      Math.abs(chromeDuringPinch.cssZoom - chromeDuringPinch.zoom) < 0.0001 &&
      Math.abs(chromeDuringPinch.inverseZoom * chromeDuringPinch.zoom - 1) <
        0.0001 &&
      !!chromeBeforePinch.label &&
      !!chromeDuringPinch.label &&
      Math.abs(
        chromeDuringPinch.label.height - chromeBeforePinch.label.height,
      ) < 0.25 &&
      Math.abs(
        chromeDuringPinch.label.fontSize - chromeBeforePinch.label.fontSize,
      ) < 0.01 &&
      (!chromeBeforePinch.handle ||
        (!!chromeDuringPinch.handle &&
          Math.abs(
            chromeDuringPinch.handle.width - chromeBeforePinch.handle.width,
          ) < 0.25 &&
          Math.abs(
            chromeDuringPinch.handle.height - chromeBeforePinch.handle.height,
          ) < 0.25)) &&
      chromeDuringPinch.spacingVisibility !== "visible",
    JSON.stringify({ chromeBeforePinch, chromeDuringPinch }),
  );
  await page.waitForTimeout(120);
  await fitAllFrames();
  await canvasViewport.evaluate((canvas) => {
    const frame = canvas.querySelector('[data-design-frame="home.html"]');
    const bounds =
      frame?.getBoundingClientRect() ?? canvas.getBoundingClientRect();
    for (let index = 0; index < 2; index += 1) {
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: bounds.left + bounds.width / 2,
          clientY: bounds.top + bounds.height / 2,
          deltaY: 2_000,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          metaKey: true,
        }),
      );
    }
  });
  await waitFor(async () => {
    const current = await readCanvasTransform();
    return current.zoom <= 0.011;
  }, "design-frame-name-minimum-zoom");
  const zoomedOutFrameName = await homeFrame.evaluate((frame) => {
    const label = frame.querySelector("[data-design-frame-label]");
    const name = frame.querySelector("[data-design-frame-name]");
    const frameBounds = frame.getBoundingClientRect();
    const labelBounds = label?.getBoundingClientRect();
    return {
      text: label?.textContent?.trim() ?? "",
      hasIcon: Boolean(label?.querySelector("svg")),
      hasDimensions: Boolean(label?.querySelector("[data-design-frame-size]")),
      frameWidth: frameBounds.width,
      labelWidth: labelBounds?.width ?? 0,
      truncated: Boolean(name && name.scrollWidth > name.clientWidth),
    };
  });
  check(
    "zoomed-out frame labels are plain names clipped to projected frame width",
    zoomedOutFrameName.text.length > 0 &&
      !zoomedOutFrameName.hasIcon &&
      !zoomedOutFrameName.hasDimensions &&
      zoomedOutFrameName.labelWidth <= zoomedOutFrameName.frameWidth + 0.5 &&
      zoomedOutFrameName.truncated,
    JSON.stringify(zoomedOutFrameName),
  );
  await fitAllFrames();
  const zoomBeforePinch = await readCanvasTransform();
  const zoomAnchor = await dispatchZoomBurst("ctrl");
  // Chromium encodes pinch as ctrl+wheel with deltaY ≈ -100·ln(scale); the
  // canvas must invert that mapping so content tracks the fingers 1:1.
  const expectedBurstZoom = zoomBeforePinch.zoom * Math.exp(8 * 12 * 0.01);
  const pinchBurstAccumulated = await waitFor(async () => {
    const current = await readCanvasTransform();
    return Math.abs(current.zoom - expectedBurstZoom) < 0.002;
  }, "design-pinch-zoom-accumulation");
  const zoomAfterPinch = await readCanvasTransform();
  const worldBeforePinch = {
    x: (zoomAnchor.x - zoomBeforePinch.panX) / zoomBeforePinch.zoom,
    y: (zoomAnchor.y - zoomBeforePinch.panY) / zoomBeforePinch.zoom,
  };
  const worldAfterPinch = {
    x: (zoomAnchor.x - zoomAfterPinch.panX) / zoomAfterPinch.zoom,
    y: (zoomAnchor.y - zoomAfterPinch.panY) / zoomAfterPinch.zoom,
  };
  const anchoredScreenAfterPinch = {
    x: worldBeforePinch.x * zoomAfterPinch.zoom + zoomAfterPinch.panX,
    y: worldBeforePinch.y * zoomAfterPinch.zoom + zoomAfterPinch.panY,
  };
  check(
    "rapid trackpad pinch deltas accumulate smoothly at the gesture focal point",
    pinchBurstAccumulated &&
      Math.abs(anchoredScreenAfterPinch.x - zoomAnchor.x) < 0.25 &&
      Math.abs(anchoredScreenAfterPinch.y - zoomAnchor.y) < 0.25,
    JSON.stringify({
      zoomBeforePinch,
      zoomAfterPinch,
      worldBeforePinch,
      worldAfterPinch,
      anchoredScreenAfterPinch,
      zoomAnchor,
    }),
  );
  await waitFor(
    async () =>
      (await styleZoomButton.textContent()) ===
      `${Math.round(expectedBurstZoom * 100)}%`,
    "design-pinch-zoom-store-settle",
  );
  await fitAllFrames();
  await waitFor(async () => {
    const current = await readCanvasTransform();
    return Math.abs(current.zoom - zoomBeforePinch.zoom) < 0.0001;
  }, "design-pinch-zoom-fit-reset");
  const zoomBeforeCommandScroll = await readCanvasTransform();
  await dispatchZoomBurst("meta");
  const expectedCommandZoom =
    zoomBeforeCommandScroll.zoom * Math.exp(8 * 12 * 0.002);
  check(
    "Cmd-scroll keeps its flat trackpad curve while pinch runs 5x per delta unit",
    (await waitFor(async () => {
      const current = await readCanvasTransform();
      return Math.abs(current.zoom - expectedCommandZoom) < 0.002;
    }, "design-command-scroll-zoom-parity")) &&
      Math.abs(
        Math.log(expectedBurstZoom / zoomBeforePinch.zoom) /
          Math.log(expectedCommandZoom / zoomBeforeCommandScroll.zoom) -
          5,
      ) < 0.0001,
  );
  await waitFor(
    async () =>
      (await styleZoomButton.textContent()) ===
      `${Math.round(expectedCommandZoom * 100)}%`,
    "design-command-scroll-store-settle",
  );
  await fitAllFrames();
  await waitFor(async () => {
    const current = await readCanvasTransform();
    return Math.abs(current.zoom - zoomBeforePinch.zoom) < 0.0001;
  }, "design-command-scroll-fit-reset");
  await dispatchZoomBurst("ctrl");
  await fitAllFrames();
  await page.waitForTimeout(120);
  const zoomAfterImmediateFit = await readCanvasTransform();
  check(
    "Fit shortcut overrides an in-flight pinch without a delayed zoom snap-back",
    Math.abs(zoomAfterImmediateFit.zoom - zoomBeforePinch.zoom) < 0.0001,
    JSON.stringify({ zoomBeforePinch, zoomAfterImmediateFit }),
  );
  const highZoomFrameBounds = await homeFrame.boundingBox();
  if (!highZoomFrameBounds) throw new Error("Home frame has no zoom bounds");
  await canvasViewport.evaluate(
    (canvas, anchor) => {
      for (let index = 0; index < 2; index += 1) {
        canvas.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            clientX: anchor.x,
            clientY: anchor.y,
            deltaY: -2_000,
            deltaMode: WheelEvent.DOM_DELTA_PIXEL,
            metaKey: true,
          }),
        );
      }
    },
    {
      x: highZoomFrameBounds.x + highZoomFrameBounds.width / 2,
      y: highZoomFrameBounds.y + highZoomFrameBounds.height / 2,
    },
  );
  await waitFor(async () => {
    const current = await readCanvasTransform();
    return current.zoom >= 255;
  }, "design-extreme-zoom-settle");
  const highResolutionTile = homeFrame.locator(
    "[data-design-high-resolution-tile][data-design-tile-current]",
  );
  const highResolutionTileReady = await waitFor(
    async () => (await highResolutionTile.count()) === 1,
    "design-high-resolution-viewport-tile",
    10_000,
  );
  const highResolutionMetrics = highResolutionTileReady
    ? await highResolutionTile.evaluate((image) => {
        const element = image;
        const bounds = element.getBoundingClientRect();
        return {
          naturalWidth: element.naturalWidth,
          naturalHeight: element.naturalHeight,
          displayWidth: bounds.width,
          displayHeight: bounds.height,
          scale: Number(element.dataset.designTileScale),
          sourceVersion: element.dataset.designTileSourceVersion,
          frameSourceVersion: element
            .closest("[data-design-frame]")
            ?.querySelector("iframe[data-design-source-version]")
            ?.getAttribute("data-design-source-version"),
        };
      })
    : null;
  check(
    "extreme zoom publishes only the decoded current crop with oversampled pixels",
    !!highResolutionMetrics &&
      highResolutionMetrics.naturalWidth >=
        Math.floor(highResolutionMetrics.displayWidth * 1.8) &&
      highResolutionMetrics.naturalHeight >=
        Math.floor(highResolutionMetrics.displayHeight * 1.8) &&
      highResolutionMetrics.scale >= 255 &&
      highResolutionMetrics.sourceVersion ===
        highResolutionMetrics.frameSourceVersion,
    JSON.stringify(highResolutionMetrics),
  );
  check(
    "resolution tiling keeps the authoritative live frame mounted",
    (await homeFrame.locator("iframe").count()) === 1,
  );
  // One settled camera step invalidates the mounted tile's key while its
  // replacement rasterizes. The stale capture must keep painting — hiding it
  // flashed magnified iframe pixels on every zoom step.
  await canvasViewport.evaluate((canvas) => {
    const bounds = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
        deltaY: 40,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        metaKey: true,
      }),
    );
  });
  await page.waitForTimeout(140);
  const retainedTile = await homeFrame
    .locator("[data-design-high-resolution-tile]")
    .evaluateAll((tiles) =>
      tiles.map((tile) => ({
        visibility: getComputedStyle(tile).visibility,
        decodedPixels: tile.naturalWidth > 0 && tile.naturalHeight > 0,
      })),
    );
  check(
    "a camera step keeps the previous world-anchored tile painted while recapturing",
    retainedTile.length === 1 &&
      retainedTile[0].visibility === "visible" &&
      retainedTile[0].decodedPixels,
    JSON.stringify(retainedTile),
  );
  check(
    "the settled camera republishes a decoded current-crop tile",
    await waitFor(
      async () => (await highResolutionTile.count()) === 1,
      "design-high-resolution-tile-recapture",
      10_000,
    ),
  );
  await fitAllFrames();
  await waitFor(async () => {
    const current = await readCanvasTransform();
    return Math.abs(current.zoom - zoomBeforePinch.zoom) < 0.0001;
  }, "design-high-resolution-fit-reset");
  check(
    "normal zoom removes the optional high-resolution tile",
    await waitFor(
      async () => (await highResolutionTile.count()) === 0,
      "design-high-resolution-tile-release",
    ),
  );
  await homeFrame
    .locator(
      'iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
    )
    .waitFor({ state: "visible", timeout: 10_000 });
  await page
    .locator('[data-design-element-overlay="home-heading"]')
    .waitFor({ state: "visible", timeout: 10_000 });
  const inspector = page.locator("[data-design-inspector]");
  const inspectorHeader = inspector.locator("[data-design-inspector-header]");
  const expandStyleSection = async (title) => {
    const trigger = inspector.getByRole("button", {
      name: `Expand ${title}`,
      exact: true,
    });
    if ((await trigger.count()) > 0) await trigger.click();
  };
  const canvasBoxForPageSelection = await canvasViewport.boundingBox();
  if (canvasBoxForPageSelection) {
    await canvasViewport.click({
      position: {
        x: canvasBoxForPageSelection.width - 12,
        y: canvasBoxForPageSelection.height - 12,
      },
    });
  }
  await waitFor(
    async () => (await inspectorHeader.textContent())?.trim() === "Page",
    "design-page-background-selection",
  );
  const pageBackgroundEditor = inspector.locator(
    "[data-design-canvas-background]",
  );
  const canvasSurface = await canvasViewport.evaluate((canvas) => {
    const style = getComputedStyle(canvas);
    const probe = document.createElement("span");
    probe.style.color = "var(--bg2)";
    canvas.appendChild(probe);
    const bg2 = getComputedStyle(probe).color;
    probe.remove();
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      bg2,
    };
  });
  check(
    "empty selection exposes Page color and opacity on a solid --bg2 canvas",
    (await pageBackgroundEditor.isVisible()) &&
      (await pageBackgroundEditor.textContent())?.includes("100 %") &&
      canvasSurface.backgroundImage === "none" &&
      canvasSurface.backgroundColor === canvasSurface.bg2,
    JSON.stringify(canvasSurface),
  );
  await pageBackgroundEditor
    .getByRole("button", { name: "Edit canvas background" })
    .click();
  check(
    "Page background uses the shared color picker with opacity",
    await page.getByLabel("Canvas background opacity value").isVisible(),
  );
  await page.keyboard.press("Escape");
  await layersPanel.locator('[data-design-layer-id="home-heading"]').click();
  await waitFor(
    async () => (await inspectorHeader.textContent())?.trim() === "Text",
    "design-page-background-return-to-layer",
  );
  check(
    "Style panel has one icon-free zoom menu and no property search",
    (await stylePanelHeader.getByText("Style", { exact: true }).count()) ===
      1 &&
      (await styleZoomButton.locator("svg").count()) === 0 &&
      (await page.getByLabel("Find a style property").count()) === 0,
  );
  await styleZoomButton.click();
  const styleZoomMenu = page.getByRole("menu");
  check(
    "Style zoom menu contains only Zoom in and Zoom out",
    (await styleZoomMenu.getByRole("menuitem").count()) === 2 &&
      (await styleZoomMenu
        .getByRole("menuitem", { name: "Zoom in", exact: true })
        .count()) === 1 &&
      (await styleZoomMenu
        .getByRole("menuitem", { name: "Zoom out", exact: true })
        .count()) === 1,
  );
  await page.keyboard.press("Escape");
  const inspectorScrollViewport = inspector
    .locator("[data-radix-scroll-area-viewport]")
    .first();
  const stylePanelFooter = inspector.locator(
    "[data-design-style-panel-footer]",
  );
  const cssModeButton = stylePanelFooter.getByRole("button", {
    name: "CSS",
    exact: true,
  });
  const styleHeaderTopBeforeScroll = (await stylePanelHeader.boundingBox())?.y;
  const styleFooterTopBeforeScroll = (await stylePanelFooter.boundingBox())?.y;
  await inspectorScrollViewport.evaluate((element) => {
    element.scrollTop = 320;
  });
  const styleHeaderTopAfterScroll = (await stylePanelHeader.boundingBox())?.y;
  const styleFooterTopAfterScroll = (await stylePanelFooter.boundingBox())?.y;
  check(
    "Style header and CSS footer stay fixed while inspector contents scroll",
    (await inspectorScrollViewport.evaluate((element) => element.scrollTop)) >
      0 &&
      styleHeaderTopBeforeScroll !== undefined &&
      styleHeaderTopAfterScroll !== undefined &&
      styleFooterTopBeforeScroll !== undefined &&
      styleFooterTopAfterScroll !== undefined &&
      Math.abs(styleHeaderTopAfterScroll - styleHeaderTopBeforeScroll) < 0.5 &&
      Math.abs(styleFooterTopAfterScroll - styleFooterTopBeforeScroll) < 0.5,
  );
  await inspectorScrollViewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  const styleFooterButtonCount = await stylePanelFooter
    .locator("button")
    .count();
  const initialCssPressed = await cssModeButton.getAttribute("aria-pressed");
  check(
    "Style footer contains only the CSS toggle",
    styleFooterButtonCount === 1 && initialCssPressed === "false",
    JSON.stringify({ styleFooterButtonCount, initialCssPressed }),
  );
  await cssModeButton.click();
  const computedCssEditor = page.getByLabel("Computed CSS declarations");
  const computedCssLines = computedCssEditor.locator(".cm-line");
  const originalComputedCss = (await computedCssLines.allTextContents()).join(
    "\n",
  );
  check(
    "CSS mode keeps the Style and selection rows above one-line computed declarations",
    (await stylePanelHeader.isVisible()) &&
      (await inspectorHeader.textContent())?.trim() === "Text" &&
      (await computedCssEditor.isVisible()) &&
      (await computedCssLines.count()) > 0 &&
      (await computedCssLines.allTextContents()).every(
        (line) => !line.includes("\n"),
      ) &&
      (await page.getByText("Apply CSS", { exact: true }).count()) === 0 &&
      (await cssModeButton.getAttribute("aria-pressed")) === "true",
  );
  const cssStyleOperationStart = await page.evaluate(
    () => window.__zerosHarnessDesignShortcutOperations?.length ?? 0,
  );
  await computedCssEditor.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("justi");
  await page.keyboard.press("Control+Space");
  const cssPropertyCompletion = page
    .locator(".cm-tooltip-autocomplete .cm-completionLabel")
    .filter({ hasText: /^justify-content$/ });
  await waitFor(
    () => cssPropertyCompletion.isVisible().catch(() => false),
    "design-css-property-completion",
  );
  const propertySuggestionVisible = await cssPropertyCompletion.isVisible();
  if (propertySuggestionVisible) await cssPropertyCompletion.click();
  await page.keyboard.type("c");
  await page.keyboard.press("Control+Space");
  const centerValueCompletion = page
    .locator(".cm-tooltip-autocomplete .cm-completionLabel")
    .filter({ hasText: /^center$/ });
  const spacedValueCompletion = page
    .locator(".cm-tooltip-autocomplete .cm-completionLabel")
    .filter({ hasText: /^space-between$/ });
  await waitFor(
    () => centerValueCompletion.isVisible().catch(() => false),
    "design-css-value-completion",
  );
  const centerSuggestionVisible = await centerValueCompletion.isVisible();
  const spacedSuggestionVisible = await spacedValueCompletion.isVisible();
  check(
    "CSS editor recommends both properties and property-aware values",
    propertySuggestionVisible &&
      centerSuggestionVisible &&
      spacedSuggestionVisible,
    JSON.stringify({
      propertySuggestionVisible,
      centerSuggestionVisible,
      spacedSuggestionVisible,
    }),
  );
  if (centerSuggestionVisible) await centerValueCompletion.click();
  await page.keyboard.type(";");
  const cssEditCommitted = await waitFor(async () => {
    const operations = await page.evaluate(
      () => window.__zerosHarnessDesignShortcutOperations ?? [],
    );
    const justifyContent = await homeRuntime
      .locator('[data-oid="home-heading"]')
      .evaluate((heading) => getComputedStyle(heading).justifyContent)
      .catch(() => null);
    return (
      operations.length >= cssStyleOperationStart + 2 &&
      operations.at(-2) === "style:start" &&
      operations.at(-1) === "style:end" &&
      justifyContent === "center"
    );
  }, "design-css-autosave");
  check(
    "valid CSS previews and persists without a save or add action",
    cssEditCommitted,
  );
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(originalComputedCss);
  const cssEditRestored = await waitFor(async () => {
    const operations = await page.evaluate(
      () => window.__zerosHarnessDesignShortcutOperations ?? [],
    );
    const justifyContent = await homeRuntime
      .locator('[data-oid="home-heading"]')
      .evaluate((heading) => getComputedStyle(heading).justifyContent)
      .catch(() => null);
    return (
      operations.length >= cssStyleOperationStart + 4 &&
      operations.at(-2) === "style:start" &&
      operations.at(-1) === "style:end" &&
      justifyContent !== "center"
    );
  }, "design-css-autosave-restore");
  check("removing a CSS line also persists automatically", cssEditRestored);
  await cssModeButton.click();
  check(
    "CSS toggle returns to the visual Style controls without a save or add action",
    (await page.locator("[data-design-style-editor]").isVisible()) &&
      (await computedCssEditor.count()) === 0 &&
      (await cssModeButton.getAttribute("aria-pressed")) === "false",
  );
  await homeFrameRow.click();
  const frameStyleReady = await waitFor(
    async () =>
      (await inspectorHeader.textContent())?.trim() === "Frame" &&
      (await inspector.locator("[data-design-style-editor]").isVisible()) &&
      (await inspector.getByLabel("Opacity", { exact: true }).count()) === 1,
    "design-frame-complete-style-editor",
  );
  const frameStyleGeometry = frameStyleReady
    ? {
        x: await inspector.getByLabel("X", { exact: true }).inputValue(),
        y: await inspector.getByLabel("Y", { exact: true }).inputValue(),
        width: await inspector.getByLabel("W", { exact: true }).inputValue(),
        height: await inspector.getByLabel("H", { exact: true }).inputValue(),
      }
    : null;
  check(
    "a selected canvas Frame exposes the complete Style editor and canvas geometry",
    frameStyleReady &&
      frameStyleGeometry?.x === "0" &&
      frameStyleGeometry.y === "0" &&
      frameStyleGeometry.width === "1440" &&
      frameStyleGeometry.height === "900" &&
      (await inspector
        .getByRole("button", { name: "Collapse Layout", exact: true })
        .count()) === 1 &&
      (await inspector
        .getByRole("button", { name: "Collapse Appearance", exact: true })
        .count()) === 1 &&
      (await inspector.getByText("Frame position & size").count()) === 0,
    JSON.stringify(frameStyleGeometry),
  );
  const readHomeFlexIcons = () =>
    layersPanel.evaluate((panel) => ({
      frame:
        panel
          .querySelector('[data-design-frame-row="home.html"]')
          ?.querySelector("[data-design-layout-icon]")
          ?.getAttribute("data-design-layout-icon") ?? null,
      main:
        panel
          .querySelector('[data-design-layer-id="home-main"]')
          ?.querySelector("[data-design-layout-icon]")
          ?.getAttribute("data-design-layout-icon") ?? null,
    }));
  await inspector.getByRole("button", { name: "Row", exact: true }).click();
  const horizontalFrameIcons = await waitFor(async () => {
    const icons = await readHomeFlexIcons();
    return (
      icons.frame === "flex-horizontal" && icons.main === "flex-horizontal"
    );
  }, "design-frame-horizontal-icon-update");
  check(
    "changing Frame flow updates both canvas-frame and layer icons immediately",
    horizontalFrameIcons,
    JSON.stringify(await readHomeFlexIcons()),
  );
  await inspector.getByRole("button", { name: "Column", exact: true }).click();
  await waitFor(async () => {
    const icons = await readHomeFlexIcons();
    return icons.frame === "flex-vertical" && icons.main === "flex-vertical";
  }, "design-frame-vertical-icon-restore");
  const frameOpacity = inspector.getByLabel("Opacity", { exact: true });
  await frameOpacity.fill("0.92");
  await page.keyboard.press("Enter");
  check(
    "normal Frame style edits apply to the live frame root",
    await waitFor(
      () =>
        homeRuntime
          .locator('[data-oid="home-main"]')
          .evaluate(
            (element) => element.style.getPropertyValue("opacity") === "0.92",
          )
          .catch(() => false),
      "design-frame-style-commit",
    ),
  );
  await frameOpacity.fill("");
  await page.keyboard.press("Enter");
  await waitFor(
    () =>
      homeRuntime
        .locator('[data-oid="home-main"]')
        .evaluate((element) => element.style.getPropertyValue("opacity") === "")
        .catch(() => false),
    "design-frame-style-restore",
  );
  await layersPanel.locator('[data-design-layer-id="home-heading"]').click();
  await waitFor(
    async () =>
      (await inspectorHeader.textContent())?.trim() === "Text" &&
      (await inspector.locator("[data-design-style-editor]").isVisible()),
    "design-heading-style-editor-restored",
  );
  check(
    "design inspector shows one name row without tags, metadata, or frame actions",
    (await inspectorHeader.textContent())?.trim() === "Text" &&
      (await inspectorHeader.evaluate(
        (header) => header.parentElement?.children.length,
      )) === 1 &&
      (await inspector
        .getByRole("button", { name: "Duplicate frame" })
        .count()) === 0 &&
      (await inspector
        .getByRole("button", { name: "Delete frame" })
        .count()) === 0,
  );
  check(
    "design inspector exposes the custom fill editor",
    await page.getByRole("button", { name: "Edit fill" }).isEnabled(),
  );
  check(
    "design inspector exposes typography controls",
    (await page.getByText("Typography", { exact: true }).count()) === 1,
  );
  check(
    "design inspector keeps themes out of element styles",
    (await page.getByText("Themes", { exact: true }).count()) === 0,
  );
  check(
    "style selects and segmented controls expose their visible property labels",
    (await page.getByRole("combobox", { name: "Box sizing" }).isVisible()) &&
      (await page.getByRole("group", { name: "Display" }).isVisible()),
  );
  const quietInspectorField = page
    .locator("[data-design-inspector-field]")
    .first();
  const quietInspectorVisual =
    (await quietInspectorField.count()) > 0
      ? await quietInspectorField.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            borderWidth: style.borderWidth,
          };
        })
      : null;
  check(
    "inspector fields are quiet until hover or focus",
    quietInspectorVisual?.background === "rgba(0, 0, 0, 0)" &&
      quietInspectorVisual.borderWidth === "0px",
  );
  const appliedInspectorField = page
    .locator('[data-design-inspector-field][data-design-applied=""]')
    .first();
  await waitFor(
    async () => (await appliedInspectorField.count()) > 0,
    "design-authored-style-state",
  );
  const appliedInspectorVisual =
    (await appliedInspectorField.count()) > 0
      ? await appliedInspectorField.evaluate((element) => {
          const style = getComputedStyle(element);
          const input = element.querySelector("input");
          const inputStyle = input ? getComputedStyle(input) : null;
          return {
            background: style.backgroundColor,
            borderWidth: style.borderWidth,
            fontSize: inputStyle?.fontSize,
            fontFamily: inputStyle?.fontFamily,
          };
        })
      : null;
  check(
    "authored inspector values use a filled compact numeric control",
    !!appliedInspectorVisual &&
      appliedInspectorVisual.background !== "rgba(0, 0, 0, 0)" &&
      appliedInspectorVisual.borderWidth === "0px" &&
      appliedInspectorVisual.fontSize === "11px" &&
      appliedInspectorVisual.fontFamily?.toLowerCase().includes("mono"),
  );
  const authoredMarginTop = page.locator(
    '[data-design-style-property="margin-top"]',
  );
  const untouchedPaddingTop = page.locator(
    '[data-design-style-property="padding-top"]',
  );
  check(
    "an authored margin shorthand fills every affected side field",
    (await authoredMarginTop.getAttribute("data-design-applied")) === "" &&
      (await authoredMarginTop.locator("input").inputValue()) === "0" &&
      (
        await authoredMarginTop.getByLabel("Unit for T").textContent()
      )?.includes("px") &&
      (await authoredMarginTop.evaluate(
        (element) =>
          getComputedStyle(element).backgroundColor !== "rgba(0, 0, 0, 0)",
      )),
  );
  check(
    "an untouched style field shows its computed value without a fill",
    (await untouchedPaddingTop.getAttribute("data-design-applied")) === null &&
      (await untouchedPaddingTop.locator("input").inputValue()) === "0" &&
      (await untouchedPaddingTop
        .locator("input")
        .getAttribute("placeholder")) === "-" &&
      (await untouchedPaddingTop.evaluate(
        (element) =>
          getComputedStyle(element).backgroundColor === "rgba(0, 0, 0, 0)",
      )),
  );
  const untouchedPaddingInput = untouchedPaddingTop.locator("input");
  await untouchedPaddingInput.fill("12");
  // An inspector input is a draft until it is committed. Typing used to write
  // the canvas on every character, which reflowed the document through every
  // intermediate string — including the empty one a backspace leaves behind.
  await page.waitForTimeout(150);
  check(
    "typing in an inspector field leaves the canvas untouched",
    await homeRuntime
      .locator('[data-oid="home-heading"]')
      .evaluate(
        (element) => element.style.getPropertyValue("padding-top") === "",
      )
      .catch(() => false),
  );
  await page.keyboard.press("Enter");
  check(
    "committing a bare geometry value applies it as pixels",
    await waitFor(
      () =>
        homeRuntime
          .locator('[data-oid="home-heading"]')
          .evaluate(
            (element) =>
              element.style.getPropertyValue("padding-top") === "12px",
          )
          .catch(() => false),
      "design-neutral-style-commit",
    ),
  );
  const untouchedPaddingUnit = untouchedPaddingTop.getByLabel("Unit for T");
  await untouchedPaddingUnit.click();
  await page.getByRole("option", { name: "%", exact: true }).click();
  check(
    "a numeric field changes units without rewriting its value",
    await waitFor(
      () =>
        homeRuntime
          .locator('[data-oid="home-heading"]')
          .evaluate(
            (element) =>
              element.style.getPropertyValue("padding-top") === "12%",
          )
          .catch(() => false),
      "design-style-unit-percent",
    ),
  );
  await untouchedPaddingUnit.click();
  await page.getByRole("option", { name: "px", exact: true }).click();
  await waitFor(
    () =>
      homeRuntime
        .locator('[data-oid="home-heading"]')
        .evaluate(
          (element) => element.style.getPropertyValue("padding-top") === "12px",
        )
        .catch(() => false),
    "design-style-unit-pixels",
  );
  // An empty field means "remove the authored declaration", so this restores
  // the fixture without leaving a 0px of its own behind.
  await untouchedPaddingInput.fill("");
  await page.keyboard.press("Enter");
  await waitFor(
    () =>
      homeRuntime
        .locator('[data-oid="home-heading"]')
        .evaluate(
          (element) => element.style.getPropertyValue("padding-top") === "",
        )
        .catch(() => false),
    "design-neutral-style-removal",
  );
  await untouchedPaddingInput.fill("12");
  await page.keyboard.press("Escape");
  check(
    "Escape restores the computed value without authoring a style",
    await waitFor(
      async () =>
        (await untouchedPaddingInput.inputValue()) === "0" &&
        (await homeRuntime
          .locator('[data-oid="home-heading"]')
          .evaluate(
            (element) => element.style.getPropertyValue("padding-top") === "",
          )
          .catch(() => false)),
      "design-neutral-style-cancel",
    ),
  );
  // Hiding a layer changes the live document, so the runtime must republish its
  // generation: the row fades, the affordance flips to Show, and one more click
  // brings the layer back. Without that republication the tree kept reporting
  // the layer as visible and every later click repeated the same hide.
  const headingLayerRow = layersPanel.locator(
    '[data-design-layer-row="home-heading"]',
  );
  const headingVisibility = headingLayerRow.getByRole("button", {
    name: /^(Hide|Show) /,
  });
  const headingDimmed = headingLayerRow.locator(
    "[data-design-layer-id].zd-design-layer-dimmed",
  );
  const headingPainted = () =>
    homeRuntime
      .locator('[data-oid="home-heading"]')
      .evaluate((element) => getComputedStyle(element).display !== "none")
      .catch(() => false);
  await headingLayerRow.hover();
  await headingVisibility.click();
  check(
    "hiding a layer fades its row and offers to show it again",
    await waitFor(
      async () =>
        (await headingDimmed.count()) === 1 &&
        /^Show /.test(
          (await headingVisibility.getAttribute("aria-label")) ?? "",
        ) &&
        !(await headingPainted()),
      "design-layer-hidden",
    ),
  );
  await headingVisibility.click();
  check(
    "the same control returns a hidden layer to the canvas",
    await waitFor(
      async () =>
        (await headingDimmed.count()) === 0 &&
        /^Hide /.test(
          (await headingVisibility.getAttribute("aria-label")) ?? "",
        ) &&
        (await headingPainted()),
      "design-layer-shown",
    ),
  );

  const widthInput = page
    .locator('[data-design-style-property="width"]')
    .locator("input");
  const heightInput = page
    .locator('[data-design-style-property="height"]')
    .locator("input");
  await page.evaluate(() => {
    const iframe = document.querySelector(
      '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
    );
    const frame = iframe?.closest('[data-design-frame="home.html"]');
    const selection = frame?.querySelector(
      '[data-design-element-overlay="home-heading"]',
    );
    const styleEditor = document.querySelector("[data-design-style-editor]");
    if (
      !(iframe instanceof HTMLIFrameElement) ||
      !frame ||
      !selection ||
      !styleEditor
    ) {
      throw new Error(
        `The live style identity surfaces are unavailable: ${JSON.stringify({
          iframe: iframe instanceof HTMLIFrameElement,
          frame: Boolean(frame),
          selection: Boolean(selection),
          styleEditor: Boolean(styleEditor),
        })}`,
      );
    }
    let iframeLoads = 0;
    iframe.addEventListener("load", () => {
      iframeLoads += 1;
    });
    window.__zerosDesignLiveStyleIdentity = {
      iframe,
      frame,
      selection,
      styleEditor,
      iframeLoads: () => iframeLoads,
    };
  });
  await homeRuntime.locator('[data-oid="home-heading"]').evaluate((heading) => {
    window.__zerosDesignHeadingIdentity = {
      heading,
      textNode: heading.firstChild,
    };
  });
  await widthInput.fill("640");
  await page.waitForTimeout(150);
  check(
    "typing a width leaves the element and its outline alone",
    (await page.evaluate(
      () => window.__zerosDesignLiveStyleIdentity?.selection.style.width,
    )) === "900px" &&
      (await homeRuntime
        .locator('[data-oid="home-heading"]')
        .evaluate((heading) => getComputedStyle(heading).width === "900px")),
  );
  await page.keyboard.press("Enter");
  check(
    "committing a width updates element pixels and selection geometry together",
    await waitFor(async () => {
      const parentStable = await page.evaluate(() => {
        const identity = window.__zerosDesignLiveStyleIdentity;
        return (
          !!identity &&
          identity.selection.style.width === "640px" &&
          identity.iframe.isConnected &&
          identity.iframeLoads() === 0
        );
      });
      const documentStable = await homeRuntime
        .locator('[data-oid="home-heading"]')
        .evaluate((heading) => {
          const identity = window.__zerosDesignHeadingIdentity;
          return (
            getComputedStyle(heading).width === "640px" &&
            identity?.heading === heading &&
            heading.firstChild === identity?.textNode
          );
        });
      return parentStable && documentStable;
    }, "design-live-width-commit"),
  );
  await widthInput.fill("900");
  await page.keyboard.press("Enter");
  await waitFor(
    () =>
      homeRuntime
        .locator('[data-oid="home-heading"]')
        .evaluate((heading) => getComputedStyle(heading).width === "900px")
        .catch(() => false),
    "design-live-width-restore",
  );
  await widthInput.fill("640");
  await page.keyboard.press("Escape");
  check(
    "cancelling width restores element and selection without rebuilding text",
    await waitFor(async () => {
      const parentStable = await page.evaluate(() => {
        const identity = window.__zerosDesignLiveStyleIdentity;
        return (
          !!identity &&
          identity.selection.style.width === "900px" &&
          identity.iframeLoads() === 0
        );
      });
      const documentStable = await homeRuntime
        .locator('[data-oid="home-heading"]')
        .evaluate((heading) => {
          const identity = window.__zerosDesignHeadingIdentity;
          return (
            getComputedStyle(heading).width === "900px" &&
            identity?.heading === heading &&
            heading.firstChild === identity?.textNode
          );
        });
      return parentStable && documentStable;
    }, "design-live-width-cancel"),
  );
  const styleMutationCount = await page.evaluate(
    () => window.__zerosHarnessStyleMutationSources?.length ?? 0,
  );
  await widthInput.fill("640");
  await page.keyboard.press("Enter");
  await heightInput.fill("190");
  await page.keyboard.press("Enter");
  const rapidStyleStable = await waitFor(async () => {
    const parentStable = await page.evaluate(
      ({ previousMutationCount }) => {
        const identity = window.__zerosDesignLiveStyleIdentity;
        const sources = window.__zerosHarnessStyleMutationSources ?? [];
        const recentSources = sources.slice(previousMutationCount);
        const iframe = document.querySelector(
          '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
        );
        return (
          !!identity &&
          recentSources.length === 2 &&
          recentSources[0] !== recentSources[1] &&
          iframe === identity.iframe &&
          iframe?.closest('[data-design-frame="home.html"]') ===
            identity.frame &&
          identity.frame.querySelector(
            '[data-design-element-overlay="home-heading"]',
          ) === identity.selection &&
          document.querySelector("[data-design-style-editor]") ===
            identity.styleEditor &&
          identity.selection.style.width === "640px" &&
          identity.selection.style.height === "190px" &&
          identity.iframeLoads() === 0
        );
      },
      { previousMutationCount: styleMutationCount },
    );
    const documentStable = await homeRuntime
      .locator('[data-oid="home-heading"]')
      .evaluate((heading) => {
        const identity = window.__zerosDesignHeadingIdentity;
        return (
          getComputedStyle(heading).width === "640px" &&
          getComputedStyle(heading).height === "190px" &&
          identity?.heading === heading &&
          heading.firstChild === identity?.textNode
        );
      });
    return parentStable && documentStable;
  }, "design-rapid-style-commit");
  check(
    "rapid property commits rebase in order and keep canvas, text, and inspector mounted",
    rapidStyleStable &&
      (await page.getByText(/Couldn't update width/i).count()) === 0 &&
      (await page.getByText(/Couldn't update height/i).count()) === 0,
  );
  const restoreMutationCount = await page.evaluate(
    () => window.__zerosHarnessStyleMutationSources?.length ?? 0,
  );
  await widthInput.fill("900");
  await page.keyboard.press("Enter");
  await heightInput.fill("168");
  await page.keyboard.press("Enter");
  await waitFor(async () => {
    const committed = await page.evaluate(
      ({ previousMutationCount }) =>
        (window.__zerosHarnessStyleMutationSources?.length ?? 0) ===
        previousMutationCount + 2,
      { previousMutationCount: restoreMutationCount },
    );
    const restored = await homeRuntime
      .locator('[data-oid="home-heading"]')
      .evaluate(
        (heading) =>
          getComputedStyle(heading).width === "900px" &&
          getComputedStyle(heading).height === "168px",
      );
    return committed && restored;
  }, "design-rapid-style-fixture-restore");
  await page.locator('[data-design-layer-id="home-main"]').click();
  await waitFor(
    () =>
      page
        .locator('[data-design-layer-id="home-main"][aria-selected="true"]')
        .isVisible()
        .catch(() => false),
    "design-authored-padding-selection",
  );
  const authoredPaddingSides = page.locator(
    '[data-design-style-property^="padding-"]',
  );
  check(
    "an authored padding shorthand fills all four computed side fields",
    (await authoredPaddingSides.count()) === 4 &&
      (await authoredPaddingSides.evaluateAll((fields) =>
        fields.every(
          (field) =>
            field.getAttribute("data-design-applied") === "" &&
            field.querySelector("input")?.value === "72" &&
            field
              .querySelector('button[aria-label^="Unit for "]')
              ?.textContent?.includes("px") &&
            getComputedStyle(field).backgroundColor !== "rgba(0, 0, 0, 0)",
        ),
      )),
  );
  const inlinePaddingHandles = homeFrame.locator(
    '[data-design-inline-spacing^="padding-"]',
  );
  const inlineGapHandle = homeFrame.locator(
    '[data-design-inline-spacing="gap"]',
  );
  check(
    "auto-layout selections expose four padding lines on canvas",
    (await inlinePaddingHandles.count()) === 4 &&
      (await inlinePaddingHandles
        .locator("[data-design-inline-spacing-line]")
        .count()) === 4,
  );
  await page.mouse.move(8, 8);
  check(
    "spacing lines, values, and side highlights stay hidden at rest",
    (await inlinePaddingHandles.evaluateAll((handles) =>
      handles.every((handle) => {
        const line = handle.querySelector("[data-design-inline-spacing-line]");
        const label = handle.querySelector(
          "[data-design-inline-spacing-value]",
        );
        if (!(line instanceof HTMLElement) || !(label instanceof HTMLElement)) {
          return false;
        }
        const lineStyle = getComputedStyle(line);
        const labelStyle = getComputedStyle(label);
        return (
          lineStyle.getPropertyValue("opacity") === "0" &&
          (labelStyle.getPropertyValue("opacity") === "0" ||
            labelStyle.getPropertyValue("visibility") === "hidden")
        );
      }),
    )) &&
      (await homeFrame
        .locator('[data-design-inline-spacing-highlight^="padding-"]')
        .evaluateAll((highlights) =>
          highlights.every(
            (highlight) =>
              getComputedStyle(highlight).getPropertyValue("opacity") === "0",
          ),
        )),
  );
  const selectedMainOverlay = homeFrame.locator(
    '[data-design-element-overlay="home-main"]',
  );
  const selectedMainBox = await selectedMainOverlay.boundingBox();
  if (selectedMainBox) {
    await page.mouse.move(selectedMainBox.x + 12, selectedMainBox.y + 12);
  }
  check(
    "hovering inside the selected layout reveals spacing lines without labels or hatching",
    !!selectedMainBox &&
      (await inlinePaddingHandles.evaluateAll((handles) =>
        handles.every((handle) => {
          const line = handle.querySelector(
            "[data-design-inline-spacing-line]",
          );
          const label = handle.querySelector(
            "[data-design-inline-spacing-value]",
          );
          return (
            line instanceof HTMLElement &&
            getComputedStyle(line).opacity === "1" &&
            label instanceof HTMLElement &&
            getComputedStyle(label).opacity === "0"
          );
        }),
      )) &&
      (await homeFrame
        .locator('[data-design-inline-spacing-highlight^="padding-"]')
        .evaluateAll((highlights) =>
          highlights.every(
            (highlight) => getComputedStyle(highlight).opacity === "0",
          ),
        )),
  );
  const inlinePaddingLeft = homeFrame.locator(
    '[data-design-inline-spacing="padding-left"]',
  );
  check(
    "padding handles sit at the center of their padding bands",
    await inlinePaddingLeft.evaluate((handle) => {
      const root = handle.closest("[data-design-inline-spacing-root]");
      const highlight = root?.querySelector(
        '[data-design-inline-spacing-highlight="padding-left"]',
      );
      if (
        !(root instanceof HTMLElement) ||
        !(highlight instanceof HTMLElement)
      ) {
        return false;
      }
      const handleBox = handle.getBoundingClientRect();
      const rootBox = root.getBoundingClientRect();
      const highlightBox = highlight.getBoundingClientRect();
      const handleCenter = handleBox.left + handleBox.width / 2;
      const bandCenter = rootBox.left + highlightBox.width / 2;
      return Math.abs(handleCenter - bandCenter) < 1;
    }),
  );
  check(
    "padding uses blue and gap uses pink with white line borders",
    (await inlinePaddingLeft
      .locator("[data-design-inline-spacing-line]")
      .evaluate((line) => {
        const style = getComputedStyle(line);
        return (
          style.backgroundColor === "rgb(12, 140, 233)" &&
          style.borderColor === "rgb(255, 255, 255)"
        );
      })) &&
      (await inlineGapHandle
        .first()
        .locator("[data-design-inline-spacing-line]")
        .evaluate((line) => {
          const style = getComputedStyle(line);
          return (
            style.backgroundColor === "rgb(245, 49, 179)" &&
            style.borderColor === "rgb(255, 255, 255)"
          );
        })),
  );
  check(
    "gap controls are derived from real spaces between direct children",
    await waitFor(
      async () =>
        (await inlineGapHandle.count()) >= 2 &&
        (await inlineGapHandle.evaluateAll((handles) =>
          handles.every(
            (handle) =>
              !!handle.getAttribute("data-design-inline-gap-region") &&
              !!handle.querySelector("[data-design-inline-spacing-line]"),
          ),
        )),
      "design-inline-gap-regions",
    ),
  );
  check(
    "the canvas omits the redundant auto-layout badge",
    (await homeFrame.getByText(/^Auto layout(?: ·|$)/).count()) === 0,
  );
  const inlinePaddingBox = await inlinePaddingLeft.boundingBox();
  if (inlinePaddingBox) {
    await page.mouse.move(
      inlinePaddingBox.x + inlinePaddingBox.width / 2,
      inlinePaddingBox.y + inlinePaddingBox.height / 2,
    );
    check(
      "hover reveals only the active padding value and hatched side",
      await waitFor(
        async () =>
          (await inlinePaddingLeft
            .locator('[data-design-inline-spacing-value="padding-left"]')
            .evaluate(
              (label) =>
                getComputedStyle(label).getPropertyValue("opacity") === "1",
            )) &&
          (await homeFrame
            .locator('[data-design-inline-spacing-highlight="padding-left"]')
            .evaluate(
              (highlight) =>
                getComputedStyle(highlight).getPropertyValue("opacity") === "1",
            )) &&
          (await homeFrame
            .locator('[data-design-inline-spacing-highlight="padding-right"]')
            .evaluate(
              (highlight) =>
                getComputedStyle(highlight).getPropertyValue("opacity") === "0",
            )) &&
          (await inlinePaddingLeft.evaluate(
            (handle) => getComputedStyle(handle).cursor === "ew-resize",
          )),
        "design-inline-padding-hover",
      ),
    );
    await page.mouse.down();
    await page.mouse.move(
      inlinePaddingBox.x + inlinePaddingBox.width / 2 + 24,
      inlinePaddingBox.y + inlinePaddingBox.height / 2,
      { steps: 3 },
    );
    const draggedPaddingBox = await inlinePaddingLeft.boundingBox();
    check(
      "canvas spacing lines and values move together during live drag",
      (await inlinePaddingLeft.textContent()) !== "72" &&
        !!draggedPaddingBox &&
        Math.abs(draggedPaddingBox.x - inlinePaddingBox.x) > 8,
    );
    await page.keyboard.press("Escape");
    await page.mouse.up();
    check(
      "Escape restores both inline spacing value and line geometry",
      await waitFor(async () => {
        const restoredBox = await inlinePaddingLeft.boundingBox();
        return (
          (await inlinePaddingLeft.textContent()) === "72" &&
          !!restoredBox &&
          Math.abs(restoredBox.x - inlinePaddingBox.x) < 1
        );
      }, "design-inline-spacing-cancel"),
    );
  } else {
    check(
      "hover reveals only the active padding value and hatched side",
      false,
    );
    check(
      "canvas spacing lines and values move together during live drag",
      false,
    );
    check("Escape restores both inline spacing value and line geometry", false);
  }
  const distributedGapHandle = homeFrame
    .locator(
      '[data-design-inline-gap-region][data-design-inline-spacing="gap"]',
    )
    .first();
  const distributedGapBox = await distributedGapHandle.boundingBox();
  if (distributedGapBox) {
    await page.mouse.move(
      distributedGapBox.x + distributedGapBox.width / 2,
      distributedGapBox.y + distributedGapBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      distributedGapBox.x + distributedGapBox.width / 2,
      distributedGapBox.y + distributedGapBox.height / 2 + 16,
      { steps: 4 },
    );
    check(
      "dragging an Auto-distributed flex gap switches to live fixed spacing",
      await waitFor(async () => {
        const draggedBox = await distributedGapHandle.boundingBox();
        return (
          (await distributedGapHandle.textContent()) !== "0" &&
          !!draggedBox &&
          (Math.abs(draggedBox.y - distributedGapBox.y) > 2 ||
            Math.abs(draggedBox.height - distributedGapBox.height) > 2)
        );
      }, "design-inline-distributed-gap-live-geometry"),
    );
    await page.keyboard.press("Escape");
    await page.mouse.up();
    check(
      "Escape restores Auto-distributed flex spacing",
      await waitFor(async () => {
        const restoredBox = await distributedGapHandle.boundingBox();
        return (
          (await distributedGapHandle.textContent()) === "0" &&
          !!restoredBox &&
          Math.abs(restoredBox.y - distributedGapBox.y) < 1 &&
          Math.abs(restoredBox.height - distributedGapBox.height) < 1
        );
      }, "design-inline-distributed-gap-cancel"),
    );
  } else {
    check(
      "dragging an Auto-distributed flex gap switches to live fixed spacing",
      false,
    );
    check("Escape restores Auto-distributed flex spacing", false);
  }
  const mainGapVisual = distributedGapHandle.locator(
    "[data-design-inline-gap-visual]",
  );
  const mainGapVisualBeforeResize = await mainGapVisual.boundingBox();
  const mainOverlayBeforeResize = await selectedMainOverlay.boundingBox();
  const mainSizeFeedback = selectedMainOverlay.locator(
    "[data-design-selection-size]",
  );
  const mainSizeBeforeResize = await mainSizeFeedback.textContent();
  const mainSouthResizeEdge = selectedMainOverlay.locator(
    '[data-design-resize-edge="s"]',
  );
  const mainSouthResizeBox = await mainSouthResizeEdge.boundingBox();
  if (
    mainGapVisualBeforeResize &&
    mainOverlayBeforeResize &&
    mainSouthResizeBox
  ) {
    await page.mouse.move(
      mainSouthResizeBox.x + mainSouthResizeBox.width / 2,
      mainSouthResizeBox.y + mainSouthResizeBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      mainSouthResizeBox.x + mainSouthResizeBox.width / 2,
      mainSouthResizeBox.y + mainSouthResizeBox.height / 2 + 48,
      { steps: 4 },
    );
    const mainGapResizePassed = await waitFor(async () => {
      const visual = await mainGapVisual.boundingBox();
      const overlay = await selectedMainOverlay.boundingBox();
      return (
        !!visual &&
        !!overlay &&
        (Math.abs(visual.y - mainGapVisualBeforeResize.y) > 2 ||
          Math.abs(visual.height - mainGapVisualBeforeResize.height) > 2) &&
        (await mainSizeFeedback.textContent()) !== mainSizeBeforeResize &&
        visual.y >= overlay.y - 1 &&
        visual.y + visual.height <= overlay.y + overlay.height + 1
      );
    }, "design-gap-container-resize");
    const mainGapResizeDiagnostic = await Promise.all([
      mainGapVisual.boundingBox(),
      selectedMainOverlay.boundingBox(),
      mainSizeFeedback.textContent(),
      homeRuntime.locator('[data-oid="home-main"]').evaluate((main) => ({
        height: getComputedStyle(main).height,
        rect: main.getBoundingClientRect().toJSON(),
        children: Array.from(main.children).map((child) => ({
          oid: child.getAttribute("data-oid"),
          rect: child.getBoundingClientRect().toJSON(),
        })),
      })),
    ]);
    check(
      "gap bands follow live container resize geometry without drifting",
      mainGapResizePassed,
      mainGapResizePassed
        ? ""
        : JSON.stringify({
            beforeVisual: mainGapVisualBeforeResize,
            beforeOverlay: mainOverlayBeforeResize,
            beforeSize: mainSizeBeforeResize,
            after: mainGapResizeDiagnostic,
          }),
    );
    await page.evaluate(() => {
      window.dispatchEvent(
        new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }),
      );
    });
    await page.mouse.up();
    check(
      "cancelled container resize restores its gap bands and selection box",
      await waitFor(async () => {
        const visual = await mainGapVisual.boundingBox();
        const overlay = await selectedMainOverlay.boundingBox();
        return (
          !!visual &&
          !!overlay &&
          Math.abs(visual.y - mainGapVisualBeforeResize.y) < 1 &&
          Math.abs(visual.height - mainGapVisualBeforeResize.height) < 1 &&
          Math.abs(overlay.height - mainOverlayBeforeResize.height) < 1 &&
          (await mainSizeFeedback.textContent()) === mainSizeBeforeResize
        );
      }, "design-gap-container-resize-cancel"),
    );
  } else {
    check(
      "gap bands follow live container resize geometry without drifting",
      false,
    );
    check(
      "cancelled container resize restores its gap bands and selection box",
      false,
    );
  }
  // Two invariants of direct manipulation, on the element the user drags:
  //
  //  1. the edge the pointer is NOT holding does not move. Authoring `left` and
  //     `width` with independent rounding from fractional layout bases used to
  //     make the anchored edge oscillate a whole pixel twice per pixel of drag;
  //  2. the outline describes the element exactly, at every settled moment of
  //     the drag — no half-pixel gap, no frames of lead.
  const westResizeEdge = selectedMainOverlay.locator(
    '[data-design-resize-edge="w"]',
  );
  const westResizeBox = await westResizeEdge.boundingBox();
  const mainRuntimeBox = () =>
    homeRuntime.locator('[data-oid="home-main"]').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, right: rect.x + rect.width, width: rect.width };
    });
  const mainOverlayPaint = () =>
    selectedMainOverlay.evaluate((element) => ({
      left: Number.parseFloat(element.style.left),
      width: Number.parseFloat(element.style.width),
    }));
  if (westResizeBox) {
    const restingRuntime = await mainRuntimeBox();
    await page.mouse.move(
      westResizeBox.x + westResizeBox.width / 2,
      westResizeBox.y + westResizeBox.height / 2,
    );
    await page.mouse.down();
    const anchoredEdges = [];
    const outlineGaps = [];
    for (let step = 1; step <= 12; step += 1) {
      await page.mouse.move(
        westResizeBox.x + westResizeBox.width / 2 - step * 1.35,
        westResizeBox.y + westResizeBox.height / 2,
      );
      const runtimeBox = await mainRuntimeBox();
      const paint = await mainOverlayPaint();
      anchoredEdges.push(Number(runtimeBox.right.toFixed(2)));
      outlineGaps.push(
        Number(Math.abs(paint.width - runtimeBox.width).toFixed(2)),
      );
    }
    const anchoredDrift = Math.max(
      ...anchoredEdges.map((edge) => Math.abs(edge - restingRuntime.right)),
    );
    check(
      "the edge a resize is not dragging never moves",
      anchoredDrift < 0.51,
      JSON.stringify({ restingRight: restingRuntime.right, anchoredEdges }),
    );
    check(
      "the selection outline stays on the element it describes while dragging",
      Math.max(...outlineGaps) < 0.51,
      JSON.stringify(outlineGaps),
    );
    // A held gesture is modal, so Escape belongs to it and not to the canvas
    // selection stack. Escape used to fall through: the selection jumped to the
    // parent — unmounting the overlay the drag was painting — and the resize
    // committed anyway on release. Selection is asserted here because that
    // fall-through is invisible in the width alone.
    const overlaysBeforeEscape = await page
      .locator("[data-design-element-overlay]")
      .count();
    await page.keyboard.press("Escape");
    await page.mouse.up();
    check(
      "Escape cancels a resize instead of walking the selection up",
      (await page.locator("[data-design-element-overlay]").count()) ===
        overlaysBeforeEscape &&
        (await waitFor(
          async () =>
            Math.abs((await mainRuntimeBox()).width - restingRuntime.width) < 1,
          "design-anchored-edge-escape",
        )),
    );

    // The canvas key handler only listens while the viewport itself holds
    // focus, and a drag is as often started from a Layers selection — which
    // leaves focus in the sidebar. The gesture owns Escape either way.
    await page.locator('[data-design-layer-id="home-main"]').click();
    await page.mouse.move(
      westResizeBox.x + westResizeBox.width / 2,
      westResizeBox.y + westResizeBox.height / 2,
    );
    await page.mouse.down();
    for (let step = 1; step <= 6; step += 1) {
      await page.mouse.move(
        westResizeBox.x + westResizeBox.width / 2 - step * 3,
        westResizeBox.y + westResizeBox.height / 2,
      );
    }
    const focusOutsideCanvas = await page.evaluate(() => {
      const viewport = document.querySelector("[data-design-active-tool]");
      return !(
        viewport instanceof HTMLElement &&
        viewport.contains(document.activeElement)
      );
    });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    check(
      "Escape cancels a drag started from a Layers selection too",
      focusOutsideCanvas &&
        (await waitFor(
          async () =>
            Math.abs((await mainRuntimeBox()).width - restingRuntime.width) < 1,
          "design-escape-sidebar-focus",
        )),
    );

    // pointercancel remains the OS-level abort and must stay equivalent.
    await page.mouse.move(
      westResizeBox.x + westResizeBox.width / 2,
      westResizeBox.y + westResizeBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      westResizeBox.x + westResizeBox.width / 2 - 24,
      westResizeBox.y + westResizeBox.height / 2,
    );
    await page.evaluate(() => {
      window.dispatchEvent(
        new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }),
      );
    });
    await page.mouse.up();
    check(
      "a cancelled resize returns the element to its authored width",
      await waitFor(
        async () =>
          Math.abs((await mainRuntimeBox()).width - restingRuntime.width) < 1,
        "design-anchored-edge-cancel",
      ),
    );
  } else {
    check("the edge a resize is not dragging never moves", false);
    check(
      "the selection outline stays on the element it describes while dragging",
      false,
    );
    check("Escape cancels a resize instead of walking the selection up", false);
    check("Escape cancels a drag started from a Layers selection too", false);
    check(
      "a cancelled resize returns the element to its authored width",
      false,
    );
  }

  await page.locator('[data-design-layer-id="home-hero"]').click();
  await waitFor(
    () =>
      page
        .locator('[data-design-layer-id="home-hero"][aria-selected="true"]')
        .isVisible()
        .catch(() => false),
    "design-inline-gap-selection",
  );
  const heroGapHandles = homeFrame.locator(
    '[data-design-inline-gap-region][data-design-inline-spacing="gap"]',
  );
  const heroPaddingHandles = homeFrame.locator(
    '[data-design-inline-spacing^="padding-"]',
  );
  check(
    "zero-padding layouts keep one addressable control on every element edge",
    (await heroPaddingHandles.count()) === 4 &&
      (await heroPaddingHandles.evaluateAll((handles) => {
        const root = handles[0]?.closest("[data-design-inline-spacing-root]");
        if (!(root instanceof HTMLElement)) return false;
        const rootBox = root.getBoundingClientRect();
        const centers = Object.fromEntries(
          handles.map((handle) => {
            const box = handle.getBoundingClientRect();
            return [
              handle.getAttribute("data-design-inline-spacing"),
              { x: box.left + box.width / 2, y: box.top + box.height / 2 },
            ];
          }),
        );
        return (
          Math.abs(centers["padding-top"].y - rootBox.top) < 1 &&
          Math.abs(centers["padding-right"].x - rootBox.right) < 1 &&
          Math.abs(centers["padding-bottom"].y - rootBox.bottom) < 1 &&
          Math.abs(centers["padding-left"].x - rootBox.left) < 1
        );
      })),
  );
  check(
    "a three-child layout exposes one gap line in each inter-item space",
    await waitFor(
      async () => (await heroGapHandles.count()) === 2,
      "design-inline-gap-count",
    ),
  );
  const heroGapHandle = heroGapHandles.first();
  check(
    "non-wrapping flex gap bands span the complete content width",
    await waitFor(async () => {
      const visual = await heroGapHandle
        .locator("[data-design-inline-gap-visual]")
        .boundingBox();
      const widestChild = await homeRuntime
        .locator('[data-oid="home-heading"]')
        .boundingBox();
      return (
        !!visual &&
        !!widestChild &&
        Math.abs(visual.x - widestChild.x) < 1 &&
        Math.abs(visual.width - widestChild.width) < 1
      );
    }, "design-inline-gap-full-cross-span"),
  );
  const heroGapBox = await heroGapHandle.boundingBox();
  if (heroGapBox) {
    await page.mouse.move(
      heroGapBox.x + heroGapBox.width / 2,
      heroGapBox.y + heroGapBox.height / 2,
    );
    check(
      "gap hover reveals only that inter-item value and hatch",
      (await heroGapHandle
        .locator("[data-design-inline-spacing-value]")
        .evaluate(
          (label) =>
            getComputedStyle(label).getPropertyValue("opacity") === "1",
        )) &&
        (await heroGapHandle
          .locator("[data-design-inline-spacing-highlight]")
          .evaluate(
            (highlight) =>
              getComputedStyle(highlight).getPropertyValue("opacity") === "1",
          )) &&
        (await heroGapHandles
          .nth(1)
          .locator("[data-design-inline-spacing-highlight]")
          .evaluate(
            (highlight) =>
              getComputedStyle(highlight).getPropertyValue("opacity") === "0",
          )),
    );
    await page.mouse.down();
    await page.mouse.move(
      heroGapBox.x + heroGapBox.width / 2,
      heroGapBox.y + heroGapBox.height / 2 + 16,
      { steps: 4 },
    );
    check(
      "gap bands reconcile live child layout while dragging",
      await waitFor(async () => {
        const draggedBox = await heroGapHandle.boundingBox();
        return (
          (await heroGapHandle.textContent()) !== "24" &&
          !!draggedBox &&
          (Math.abs(draggedBox.y - heroGapBox.y) > 2 ||
            Math.abs(draggedBox.height - heroGapBox.height) > 2)
        );
      }, "design-inline-gap-live-geometry"),
    );
    await page.keyboard.press("Escape");
    await page.mouse.up();
    check(
      "Escape restores gap value and rendered inter-item geometry",
      await waitFor(async () => {
        const restoredBox = await heroGapHandle.boundingBox();
        return (
          (await heroGapHandle.textContent()) === "24" &&
          !!restoredBox &&
          Math.abs(restoredBox.y - heroGapBox.y) < 1 &&
          Math.abs(restoredBox.height - heroGapBox.height) < 1
        );
      }, "design-inline-gap-cancel"),
    );
  } else {
    check("gap hover reveals only that inter-item value and hatch", false);
    check("gap bands reconcile live child layout while dragging", false);
    check("Escape restores gap value and rendered inter-item geometry", false);
  }
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await waitFor(
    () =>
      page
        .locator('[data-design-layer-id="home-heading"][aria-selected="true"]')
        .isVisible()
        .catch(() => false),
    "design-authored-padding-restore-heading",
  );
  check(
    "compact editor chrome remains horizontally contained",
    await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          "[data-design-workspace-surface] [data-radix-scroll-area-viewport]",
        ),
      ].every((element) => element.scrollWidth === element.clientWidth),
    ),
  );
  const elementResizeLabels = await homeFrame
    .locator(
      '.zd-design-selection-handle[aria-label^="Resize Make the next move unmistakable. from "]',
    )
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label") ?? ""),
    );
  check(
    "selected elements expose only four corner resize handles",
    elementResizeLabels.length === 4 &&
      elementResizeLabels.every((label) =>
        / from (?:nw|ne|se|sw)$/.test(label),
      ),
    JSON.stringify(elementResizeLabels),
  );
  check(
    "selected elements keep invisible edge strips for mid-edge resizing",
    (await homeFrame
      .locator(
        '[data-design-element-overlay="home-heading"] [data-design-resize-edge]',
      )
      .count()) === 4,
  );
  await homeFrame.locator("[data-design-frame-label]").click();
  await waitFor(
    async () =>
      (await homeFrame
        .locator('.zd-design-selection-handle[aria-label^="Resize "]')
        .count()) === 4,
    "design-frame-corner-handles",
  );
  const frameResizeLabels = await homeFrame
    .locator('.zd-design-selection-handle[aria-label^="Resize "]')
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label") ?? ""),
    );
  check(
    "top-level frame selection exposes only four corner resize handles",
    frameResizeLabels.length === 4 &&
      frameResizeLabels.every((label) => / from (?:nw|ne|se|sw)$/.test(label)),
    JSON.stringify(frameResizeLabels),
  );
  const frameResizeEdges = homeFrame.locator("[data-design-resize-edge]");
  check(
    "every frame edge is an invisible horizontal or vertical resize target",
    (await frameResizeEdges.count()) === 4 &&
      (await frameResizeEdges.evaluateAll((edges) =>
        edges.every((edge) => {
          const handle = edge.getAttribute("data-design-resize-edge");
          const cursor = getComputedStyle(edge).cursor;
          return handle === "n" || handle === "s"
            ? cursor === "ns-resize"
            : (handle === "e" || handle === "w") && cursor === "ew-resize";
        }),
      )),
  );
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await waitFor(
    () =>
      page
        .locator('[data-design-layer-id="home-heading"][aria-selected="true"]')
        .isVisible()
        .catch(() => false),
    "design-heading-reselection-after-frame",
  );
  check(
    "selected elements carry no inline identity or action chrome on canvas",
    (await homeFrame.getByRole("button", { name: /^Duplicate / }).count()) ===
      0 &&
      (await homeFrame.getByRole("button", { name: /^Delete / }).count()) ===
        0 &&
      (await homeFrame
        .getByRole("button", { name: /^Edit text in / })
        .count()) === 0,
  );

  const themeEditorTrigger = page.getByRole("button", {
    name: "Open theme editor",
  });
  await themeEditorTrigger.click();
  const themeDialog = page.getByRole("dialog", { name: "Theme editor" });
  check(
    "theme editor opens as a persistent non-modal tool window",
    (await waitFor(
      () => themeDialog.isVisible().catch(() => false),
      "design-theme-dialog",
    )) &&
      (await themeDialog.getAttribute("aria-modal")) === "false" &&
      (await page.locator(".bg-scrim").count()) === 0,
  );
  const themeStartBox = await themeDialog.boundingBox();
  const themeDragHandle = themeDialog.getByRole("button", {
    name: "Move theme editor",
  });
  const themeDragBox = await themeDragHandle.boundingBox();
  if (!themeStartBox || !themeDragBox) {
    throw new Error("theme editor drag geometry is unavailable");
  }
  await page.mouse.move(
    themeDragBox.x + themeDragBox.width / 2,
    themeDragBox.y + themeDragBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    themeDragBox.x + themeDragBox.width / 2 + 44,
    themeDragBox.y + themeDragBox.height / 2 + 28,
  );
  await page.mouse.up();
  const themeMovedBox = await themeDialog.boundingBox();
  check(
    "theme editor can be dragged and remains viewport constrained",
    !!themeMovedBox &&
      themeMovedBox.x > themeStartBox.x + 30 &&
      themeMovedBox.y > themeStartBox.y + 16 &&
      themeMovedBox.x >= 0 &&
      themeMovedBox.y >= 0 &&
      themeMovedBox.x + themeMovedBox.width <= 1440 &&
      themeMovedBox.y + themeMovedBox.height <= 900,
  );
  check(
    "inspector remains interactive while the theme editor stays open",
    (await page.getByRole("button", { name: "Export PNG" }).isEnabled()) &&
      (await themeDialog.isVisible()),
  );
  await page.locator('[data-design-layer-id="home-copy"]').click();
  check(
    "Layers remain interactive while the theme editor stays open",
    (await waitFor(
      () =>
        page
          .locator('[data-design-layer-id="home-copy"][aria-selected="true"]')
          .isVisible()
          .catch(() => false),
      "design-theme-nonmodal-layers",
    )) && (await themeDialog.isVisible()),
  );
  const marqueeResetLayer = page.locator(
    '[data-design-layer-id="home-heading"]',
  );
  await marqueeResetLayer.click();
  await waitFor(
    () =>
      page
        .locator('[data-design-layer-id="home-heading"][aria-selected="true"]')
        .isVisible()
        .catch(() => false),
    "design-theme-restore-heading",
  );
  const zoomBeforeThemeInteraction = await styleZoomButton.textContent();
  await styleZoomButton.click();
  await page.getByRole("menuitem", { name: "Zoom in", exact: true }).click();
  check(
    "canvas tooling remains interactive while the theme editor stays open",
    (await waitFor(
      async () =>
        (await styleZoomButton.textContent()) !== zoomBeforeThemeInteraction &&
        (await styleZoomMenu.count()) === 0,
      "design-theme-nonmodal-canvas",
    )) && (await themeDialog.isVisible()),
  );
  await styleZoomButton.click();
  await page.getByRole("menuitem", { name: "Zoom out", exact: true }).click();
  await waitFor(
    async () => (await styleZoomMenu.count()) === 0,
    "design-style-zoom-menu-close",
  );
  check(
    "theme editor exposes a Base and named-mode matrix",
    (await themeDialog.getByText("Base", { exact: true }).count()) >= 2 &&
      (await themeDialog
        .getByRole("button", { name: "dark", exact: true })
        .count()) === 1,
  );
  const inheritedThemeValue = themeDialog.locator(
    '[data-design-theme-inherited="true"]',
  );
  check(
    "named modes distinguish inherited token values from explicit overrides",
    (await inheritedThemeValue.count()) > 0 &&
      (await inheritedThemeValue.first().inputValue()) === "" &&
      (
        await inheritedThemeValue.first().getAttribute("placeholder")
      )?.startsWith("Inherited:") === true &&
      (await inheritedThemeValue
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor)) ===
        "rgba(0, 0, 0, 0)",
  );
  const themeValue = themeDialog.locator("[data-design-theme-value]").first();
  const themeValueVisual =
    (await themeValue.count()) > 0
      ? await themeValue.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            borderWidth: style.borderWidth,
          };
        })
      : null;
  check(
    "theme values use an applied fill without permanent borders",
    !!themeValueVisual &&
      themeValueVisual.background !== "rgba(0, 0, 0, 0)" &&
      themeValueVisual.borderWidth === "0px",
  );
  const themeScrollViewport = themeDialog
    .locator("[data-design-theme-scroll] [data-radix-scroll-area-viewport]")
    .first();
  const canvasWorld = page.locator("[data-design-canvas-world]");
  const worldTransformBeforeThemeScroll =
    await canvasWorld.getAttribute("style");
  const themeScrollTopBefore = await themeScrollViewport.evaluate(
    (element) => element.scrollTop,
  );
  await themeScrollViewport.hover();
  await page.mouse.wheel(0, 480);
  await page.waitForTimeout(100);
  check(
    "theme scrolling is contained and never pans the canvas",
    (await themeScrollViewport.evaluate(
      (element, before) => element.scrollTop > before,
      themeScrollTopBefore,
    )) &&
      (await canvasWorld.getAttribute("style")) ===
        worldTransformBeforeThemeScroll,
  );
  await themeDialog.getByRole("button", { name: "dark", exact: true }).click();
  const themePreviewApplied = await waitFor(
    () =>
      homeRuntime
        .locator("html")
        .getAttribute("data-zd-theme")
        .then((theme) => theme === "dark")
        .catch(() => false),
    "design-theme-preview",
  );
  check(
    "theme mode previews inside the live frame runtime",
    themePreviewApplied,
    `mode=${await themeDialog.getByLabel("Preview theme").textContent()} attr=${await homeRuntime.locator("html").getAttribute("data-zd-theme")}`,
  );
  await themeDialog.getByRole("button", { name: "Paste CSS" }).click();
  await themeDialog
    .getByLabel("CSS variables to import")
    .fill(
      ':root { --accent: rebeccapurple; }\n[data-theme="dark"] { --accent: mediumpurple; }',
    );
  check(
    "theme editor parses pasted CSS variables before import",
    await themeDialog
      .getByText("1 variable · 1 theme", { exact: true })
      .isVisible()
      .catch(() => false),
  );
  await themeDialog.getByRole("button", { name: "Done" }).click();
  await waitFor(
    async () => !(await themeDialog.isVisible().catch(() => false)),
    "design-theme-close",
  );
  check(
    "theme editor returns focus to its canvas tool",
    await waitFor(
      () =>
        themeEditorTrigger.evaluate(
          (element) => document.activeElement === element,
        ),
      "design-theme-focus-return",
    ),
  );
  check(
    "Style inspector exposes PNG export",
    await page.getByRole("button", { name: "Export PNG" }).isEnabled(),
  );
  check(
    "stage, undo, and redo are keyboard-only in the Style inspector",
    (await page.getByRole("button", { name: "Save designs" }).count()) === 0 &&
      (await page.getByRole("button", { name: "Undo design edit" }).count()) ===
        0 &&
      (await page.getByRole("button", { name: "Redo design edit" }).count()) ===
        0,
  );
  check(
    "design inspector has no Data or pull request surface",
    (await page.locator("[data-design-inspector]").getByRole("tab").count()) ===
      0 &&
      (await page
        .getByRole("button", { name: "Open PR #42", exact: true })
        .count()) === 0 &&
      (await page.getByRole("button", { name: "Create PR" }).count()) === 0,
  );

  // One Enter is one source write. The colour picker used to commit from its
  // own key handler and then blur — and blur commits too — so a single keypress
  // authored the same value twice and one undo left it in place.
  await page.getByRole("button", { name: "Edit text color" }).click();
  const textColorInput = page.getByRole("textbox", {
    name: "Text color value",
  });
  const beforeTextColorCommit = await page.evaluate(
    () => window.__zerosHarnessStyleMutationSources?.length ?? 0,
  );
  await textColorInput.fill("rgb(7, 8, 9)");
  await textColorInput.press("Enter");
  await waitFor(
    async () =>
      (await page.evaluate(
        () => window.__zerosHarnessStyleMutationSources?.length ?? 0,
      )) > beforeTextColorCommit,
    "design-text-color-commit",
  );
  await page.waitForTimeout(400);
  const textColorWrites =
    (await page.evaluate(
      () => window.__zerosHarnessStyleMutationSources?.length ?? 0,
    )) - beforeTextColorCommit;
  check(
    "committing a colour with Enter writes the source exactly once",
    textColorWrites === 1,
    `writes=${textColorWrites}`,
  );
  // Done takes focus from the field, so the value arrives once by blur and once
  // by click; the same interaction must still be one write.
  const beforeDoneCommit = await page.evaluate(
    () => window.__zerosHarnessStyleMutationSources?.length ?? 0,
  );
  await textColorInput.fill("rgb(10, 11, 12)");
  await page.getByRole("button", { name: "Done" }).click();
  await waitFor(
    async () =>
      (await page.evaluate(
        () => window.__zerosHarnessStyleMutationSources?.length ?? 0,
      )) > beforeDoneCommit,
    "design-text-color-done",
  );
  await page.waitForTimeout(400);
  const doneWrites =
    (await page.evaluate(
      () => window.__zerosHarnessStyleMutationSources?.length ?? 0,
    )) - beforeDoneCommit;
  check(
    "closing a colour popover with Done writes the source exactly once",
    doneWrites === 1,
    `writes=${doneWrites}`,
  );
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Edit fill" }).click();
  const fillInput = page.getByRole("textbox", { name: "Fill color value" });
  const selectedHeading = homeRuntime.locator('[data-oid="home-heading"]');
  const authoredFill = await selectedHeading.evaluate((element) =>
    element.style.getPropertyValue("background-color"),
  );
  await fillInput.fill("rgb(1, 2, 3)");
  await page.waitForTimeout(150);
  check(
    "a typed fill value stays a draft until it is committed",
    (await selectedHeading.evaluate((element) =>
      element.style.getPropertyValue("background-color"),
    )) === authoredFill,
  );
  await fillInput.press("Enter");
  const stylePreviewApplied = await waitFor(
    () =>
      selectedHeading
        .evaluate(
          (element) =>
            element.style.getPropertyValue("background-color") ===
            "rgb(1, 2, 3)",
        )
        .catch(() => false),
    "design-style-preview-applied",
  );
  check(
    "a committed style edit applies inside the live frame runtime",
    stylePreviewApplied,
    `inline=${await selectedHeading.evaluate((element) => element.style.getPropertyValue("background-color"))}`,
  );
  await fillInput.fill(authoredFill);
  await fillInput.press("Enter");
  await waitFor(
    () =>
      selectedHeading
        .evaluate(
          (element, expected) =>
            element.style.getPropertyValue("background-color") === expected,
          authoredFill,
        )
        .catch(() => false),
    "design-style-preview-restore",
  );
  await fillInput.fill("rgb(4, 5, 6)");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  check(
    "Escape leaves an uncommitted inspector draft with nothing to undo",
    await waitFor(
      () =>
        selectedHeading
          .evaluate(
            (element, expected) =>
              element.style.getPropertyValue("background-color") === expected,
            authoredFill,
          )
          .catch(() => false),
      "design-style-preview-escape",
    ),
  );
  const xField = page.getByLabel("X", { exact: true });
  await xField.fill("12px");
  await xField.press("Enter");
  check(
    "X/Y fields make offsets effective on static HTML elements",
    await waitFor(
      () =>
        selectedHeading
          .evaluate(
            (element) =>
              element.style.getPropertyValue("position") === "relative" &&
              element.style.getPropertyValue("left") === "12px",
          )
          .catch(() => false),
      "design-static-offset-preview",
    ),
  );
  await xField.fill("");
  await xField.press("Enter");
  check(
    "clearing the field removes the offset it authored",
    await waitFor(
      () =>
        selectedHeading
          .evaluate((element) => element.style.getPropertyValue("left") === "")
          .catch(() => false),
      "design-static-offset-removal",
    ),
  );
  await waitFor(
    () =>
      page.evaluate(() => {
        const operations = window.__zerosHarnessDesignShortcutOperations ?? [];
        const starts = operations.filter(
          (operation) => operation === "style:start",
        ).length;
        const ends = operations.filter(
          (operation) => operation === "style:end",
        ).length;
        return starts === ends;
      }),
    "design-static-offset-removal-settled",
  );
  const beforeStageShortcut = await page.evaluate(
    () => window.__zerosHarnessDesignShortcutOperations?.length ?? 0,
  );
  await xField.fill("16px");
  await xField.press("ControlOrMeta+S");
  const stageShortcutSettled = await waitFor(
    async () =>
      (await page.evaluate(
        (start) =>
          (window.__zerosHarnessDesignShortcutOperations?.length ?? 0) >=
          start + 4,
        beforeStageShortcut,
      )) === true,
    "design-command-stage",
  );
  const stageShortcutOperations = await page.evaluate(
    (start) =>
      (window.__zerosHarnessDesignShortcutOperations ?? []).slice(start),
    beforeStageShortcut,
  );
  check(
    "Command-S stages a focused inspector draft without creating a commit",
    stageShortcutSettled &&
      stageShortcutOperations.slice(0, 4).join(",") ===
        "style:start,style:end,stage:start,stage:end" &&
      (await selectedHeading.evaluate(
        (element) => element.style.getPropertyValue("left") === "16px",
      )),
    JSON.stringify(stageShortcutOperations),
  );
  const beforeRapidStageShortcuts = await page.evaluate(
    () => window.__zerosHarnessDesignShortcutOperations?.length ?? 0,
  );
  await xField.fill("20px");
  await xField.press("ControlOrMeta+S");
  await xField.fill("24px");
  await xField.press("ControlOrMeta+S");
  const rapidStageShortcutsSettled = await waitFor(
    async () =>
      (await page.evaluate(
        (start) =>
          (window.__zerosHarnessDesignShortcutOperations?.length ?? 0) >=
          start + 8,
        beforeRapidStageShortcuts,
      )) === true,
    "design-rapid-command-stage",
  );
  const rapidStageShortcutOperations = await page.evaluate(
    (start) =>
      (window.__zerosHarnessDesignShortcutOperations ?? []).slice(start),
    beforeRapidStageShortcuts,
  );
  check(
    "rapid Command-S requests stage every newly published inspector draft",
    rapidStageShortcutsSettled &&
      rapidStageShortcutOperations.slice(0, 8).join(",") ===
        "style:start,style:end,stage:start,stage:end,style:start,style:end,stage:start,stage:end" &&
      (await selectedHeading.evaluate(
        (element) => element.style.getPropertyValue("left") === "24px",
      )),
    JSON.stringify(rapidStageShortcutOperations),
  );
  const beforeStageShortcutReset = await page.evaluate(
    () => window.__zerosHarnessDesignShortcutOperations?.length ?? 0,
  );
  await xField.fill("");
  await xField.press("Enter");
  await waitFor(
    async () =>
      (await selectedHeading
        .evaluate((element) => element.style.getPropertyValue("left") === "")
        .catch(() => false)) &&
      (await page.evaluate(
        (start) =>
          (window.__zerosHarnessDesignShortcutOperations?.length ?? 0) >=
          start + 2,
        beforeStageShortcutReset,
      )),
    "design-command-stage-reset",
  );

  const beforeHistoryShortcuts = await page.evaluate(
    () => window.__zerosHarnessDesignShortcutOperations?.length ?? 0,
  );
  await page.getByLabel("Design canvas").focus();
  await page.keyboard.press("ControlOrMeta+Z");
  await page.keyboard.press("ControlOrMeta+Z");
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  const historyShortcutsSettled = await waitFor(
    async () =>
      (await page.evaluate(
        (start) =>
          (window.__zerosHarnessDesignShortcutOperations?.length ?? 0) >=
          start + 6,
        beforeHistoryShortcuts,
      )) === true,
    "design-rapid-history-shortcuts",
  );
  const historyShortcutOperations = await page.evaluate(
    (start) =>
      (window.__zerosHarnessDesignShortcutOperations ?? []).slice(start),
    beforeHistoryShortcuts,
  );
  check(
    "rapid undo and redo keypresses execute once each in input order",
    historyShortcutsSettled &&
      historyShortcutOperations.slice(0, 6).join(",") ===
        "undo:start,undo:end,undo:start,undo:end,redo:start,redo:end",
    JSON.stringify(historyShortcutOperations),
  );
  await expandStyleSection("Transform");
  await page.getByRole("button", { name: "Edit transform" }).click();
  const transformInput = page.getByLabel("Transform CSS value");
  await transformInput.press("ControlOrMeta+A");
  await transformInput.press("Backspace");
  await transformInput.pressSequentially("rotate(12deg)");
  check(
    "transform CSS input preserves an in-progress authored expression",
    (await transformInput.inputValue()) === "rotate(12deg)",
  );
  await page.waitForTimeout(150);
  check(
    "a half-typed transform never reaches the element",
    (await selectedHeading.evaluate((element) =>
      element.style.getPropertyValue("transform"),
    )) === "",
  );
  await transformInput.press("Enter");
  check(
    "committed transform CSS expressions apply to the selected runtime element",
    await waitFor(
      () =>
        selectedHeading
          .evaluate(
            (element) =>
              element.style.getPropertyValue("transform") === "rotate(12deg)",
          )
          .catch(() => false),
      "design-transform-preview",
    ),
  );
  await transformInput.press("ControlOrMeta+A");
  await transformInput.press("Backspace");
  await transformInput.press("Enter");
  check(
    "clearing transform CSS returns the element upright",
    await waitFor(
      () =>
        selectedHeading
          .evaluate((element) =>
            ["", "none"].includes(element.style.getPropertyValue("transform")),
          )
          .catch(() => false),
      "design-transform-clear",
    ),
  );
  check(
    "design advisories are compact and explicitly non-blocking",
    (await page
      .getByText("Review 1 rule · non-blocking", { exact: true })
      .count()) === 1,
  );
  check(
    "style keyframe actions stay unavailable until Motion mode opens",
    (await page
      .locator("[data-design-inspector]")
      .getByRole("button", { name: /^Animate /i })
      .count()) === 0,
  );

  await page.getByRole("button", { name: "Toggle motion timeline" }).click();
  const motionTimeline = page.getByRole("region", { name: "Motion timeline" });
  check(
    "motion opens as a persistent canvas timeline",
    await motionTimeline.isVisible(),
  );
  await motionTimeline.getByLabel("More motion settings").click();
  check(
    "secondary motion controls remain available in a focused settings popover",
    (await page.getByLabel("Animation name").isVisible()) &&
      (await page.getByLabel("Animation delay").isVisible()) &&
      (await page.getByLabel("Animation iterations").isVisible()) &&
      (await page.getByLabel("Animation direction").isVisible()) &&
      (await page.getByLabel("Animation fill mode").isVisible()),
  );
  await page.keyboard.press("Escape");
  check(
    "motion settings dismiss without closing the timeline",
    (await waitFor(
      () => page.getByLabel("Animation name").isHidden(),
      "design-motion-settings-dismiss",
    )) && (await motionTimeline.isVisible()),
  );
  check(
    "a new layer starts with no inherited or placeholder keyframes",
    (await motionTimeline.locator(".zd-design-motion-keyframe").count()) ===
      0 &&
      (await motionTimeline.getByText(/No motion on this layer/).isVisible()) &&
      (await motionTimeline
        .getByRole("button", { name: "Play motion preview" })
        .isDisabled()) &&
      (await motionTimeline.getByLabel("Animation duration").inputValue()) ===
        "300ms",
  );
  await page.getByRole("button", { name: /^Animate opacity$/i }).click();
  check(
    "inspector diamonds create node-local draggable keyframes",
    await waitFor(
      async () =>
        (await motionTimeline
          .getByRole("button", { name: /opacity keyframe at/ })
          .count()) === 2,
      "design-motion-first-track",
    ),
  );
  const firstOpacityKeyframe = motionTimeline
    .getByRole("button", { name: /opacity keyframe at/ })
    .first();
  await firstOpacityKeyframe.click();
  await firstOpacityKeyframe.press("ArrowRight");
  check(
    "keyboard arrows retime a focused keyframe",
    (await motionTimeline
      .getByRole("button", { name: /opacity keyframe at 1%/ })
      .count()) === 1,
  );
  await motionTimeline
    .getByRole("button", { name: /opacity keyframe at 1%/ })
    .press("Home");
  const deleteSelectedKeyframe = motionTimeline.getByRole("button", {
    name: "Delete selected keyframe",
  });
  check(
    "endpoint keyframes can be deleted",
    await deleteSelectedKeyframe.isEnabled(),
  );
  await deleteSelectedKeyframe.click();
  check(
    "deleting an endpoint removes that exact keyframe",
    (await motionTimeline
      .getByRole("button", { name: /opacity keyframe at/ })
      .count()) === 1,
  );
  await motionTimeline
    .getByRole("button", { name: "Clear motion draft" })
    .click();
  await waitFor(
    async () =>
      (await motionTimeline.locator(".zd-design-motion-keyframe").count()) ===
      0,
    "design-motion-draft-clear",
  );
  await page.getByRole("button", { name: /^Animate opacity$/i }).click();
  await waitFor(
    async () =>
      (await motionTimeline
        .getByRole("button", { name: /opacity keyframe at/ })
        .count()) === 2,
    "design-motion-track-restore",
  );
  const motionTrackRow = motionTimeline
    .locator("[data-design-motion-track-row]")
    .first();
  const motionTrackVisual =
    (await motionTrackRow.count()) > 0
      ? await motionTrackRow.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            borderBottomWidth: style.borderBottomWidth,
          };
        })
      : null;
  check(
    "selected motion tracks use a quiet fill without a box",
    !!motionTrackVisual &&
      motionTrackVisual.background !== "rgba(0, 0, 0, 0)" &&
      motionTrackVisual.borderBottomWidth === "0px",
  );
  check(
    "motion ruler uses effect-local millisecond timing",
    (
      await motionTimeline.getByLabel("Motion time ruler").textContent()
    )?.includes("300ms"),
  );
  const motionDurationBeforeHotCommit =
    motionTimeline.getByLabel("Animation duration");
  await motionDurationBeforeHotCommit.fill("450ms");
  await page.locator('[data-design-layer-id="home-copy"]').click();
  await waitFor(
    () =>
      page
        .locator('[data-design-layer-id="home-copy"][aria-selected="true"]')
        .isVisible()
        .catch(() => false),
    "design-motion-draft-other-layer",
  );
  await page.locator('[data-design-layer-id="home-heading"]').click();
  check(
    "unsaved motion survives a layer selection round trip",
    await waitFor(
      async () =>
        (await motionTimeline.getByLabel("Animation duration").inputValue()) ===
        "450ms",
      "design-motion-draft-selection-round-trip",
    ),
  );
  await page.evaluate(() => {
    const iframe = document.querySelector(
      '[data-design-frame="home.html"] iframe',
    );
    const styleEditor = document.querySelector("[data-design-style-editor]");
    const timeline = document.querySelector('[aria-label="Motion timeline"]');
    const review = document.querySelector("[data-design-lint-review]");
    const frame = iframe?.closest('[data-design-frame="home.html"]');
    const selection = frame?.querySelector(
      "[data-design-element-overlay].zd-design-selection-outline",
    );
    if (
      !(iframe instanceof HTMLIFrameElement) ||
      !frame ||
      !selection ||
      !styleEditor ||
      !timeline ||
      !review
    ) {
      throw new Error("The hot-generation identity surfaces are unavailable.");
    }
    let iframeLoads = 0;
    iframe.addEventListener("load", () => {
      iframeLoads += 1;
    });
    window.__zerosDesignHotIdentity = {
      iframe,
      frame,
      selection,
      styleEditor,
      timeline,
      review,
      iframeLoads: () => iframeLoads,
    };
  });
  const adoptedSourceVersion = await page.evaluate(() =>
    window.__zerosHarnessCommitStyleGeneration(),
  );
  const hotGenerationStable = await waitFor(
    () =>
      page.evaluate(
        ({ nextSourceVersion }) => {
          const identity = window.__zerosDesignHotIdentity;
          const iframe = document.querySelector(
            '[data-design-frame="home.html"] iframe',
          );
          return (
            !!identity &&
            iframe === identity.iframe &&
            iframe?.closest('[data-design-frame="home.html"]') ===
              identity.frame &&
            identity.selection.isConnected &&
            identity.frame.querySelector(
              "[data-design-element-overlay].zd-design-selection-outline",
            ) === identity.selection &&
            document.querySelector("[data-design-style-editor]") ===
              identity.styleEditor &&
            document.querySelector('[aria-label="Motion timeline"]') ===
              identity.timeline &&
            identity.review.isConnected &&
            document.querySelector("[data-design-lint-review]") ===
              identity.review &&
            identity.review.textContent?.includes(
              "Review 1 rule · non-blocking",
            ) &&
            identity.iframeLoads() === 0 &&
            iframe?.getAttribute("data-design-source-version") ===
              nextSourceVersion &&
            iframe?.getAttribute("data-design-document-source-version") !==
              nextSourceVersion
          );
        },
        { nextSourceVersion: adoptedSourceVersion },
      ),
    "design-hot-generation-stability",
  );
  const hotGenerationDiagnostic = await page.evaluate(
    ({ nextSourceVersion }) => {
      const identity = window.__zerosDesignHotIdentity;
      const iframe = document.querySelector(
        '[data-design-frame="home.html"] iframe',
      );
      return {
        iframeIdentity: iframe === identity?.iframe,
        frameIdentity:
          iframe?.closest('[data-design-frame="home.html"]') ===
          identity?.frame,
        selectionIdentity:
          identity?.selection.isConnected === true &&
          identity?.frame.querySelector(
            "[data-design-element-overlay].zd-design-selection-outline",
          ) === identity?.selection,
        editorIdentity:
          document.querySelector("[data-design-style-editor]") ===
          identity?.styleEditor,
        timelineIdentity:
          document.querySelector('[aria-label="Motion timeline"]') ===
          identity?.timeline,
        reviewConnected: identity?.review.isConnected ?? false,
        reviewText: identity?.review.textContent ?? null,
        iframeLoads: identity?.iframeLoads() ?? null,
        source: iframe?.getAttribute("data-design-source-version") ?? null,
        documentSource:
          iframe?.getAttribute("data-design-document-source-version") ?? null,
        expectedSource: nextSourceVersion,
      };
    },
    { nextSourceVersion: adoptedSourceVersion },
  );
  check(
    "style commits keep canvas, inspector, and motion draft continuously mounted",
    hotGenerationStable &&
      hotGenerationDiagnostic.frameIdentity &&
      hotGenerationDiagnostic.selectionIdentity &&
      (await motionDurationBeforeHotCommit.inputValue()) === "450ms",
    JSON.stringify(hotGenerationDiagnostic),
  );
  await page.evaluate(() => {
    const iframe = document.querySelector(
      '[data-design-frame="home.html"] iframe',
    );
    const frame = iframe?.closest('[data-design-frame="home.html"]');
    const hotIdentity = window.__zerosDesignHotIdentity;
    if (!(iframe instanceof HTMLIFrameElement) || !frame || !hotIdentity) {
      throw new Error("The structural-generation surfaces are unavailable.");
    }
    let running = true;
    let incomingLoads = 0;
    let sawDualDocumentBuffers = false;
    let maxDocumentBuffers = 0;
    let outgoingStayedConnectedUntilReady = true;
    let incomingBecameReady = false;
    let sawRasterCover = false;
    let selectionDisconnected = false;
    const observeBuffers = () => {
      const buffers = Array.from(frame.querySelectorAll("iframe"));
      maxDocumentBuffers = Math.max(maxDocumentBuffers, buffers.length);
      const incoming = buffers.find(
        (candidate) =>
          candidate.getAttribute("data-design-document-buffer") === "incoming",
      );
      if (buffers.length === 2 && incoming) sawDualDocumentBuffers = true;
      if (
        incoming?.hasAttribute("data-design-document-ready") &&
        incoming.getAttribute("data-design-document-buffer") === "incoming"
      ) {
        incomingBecameReady = true;
      }
      if (!incomingBecameReady && !iframe.isConnected) {
        outgoingStayedConnectedUntilReady = false;
      }
      if (frame.querySelector("[data-design-frame-transition-cover]")) {
        sawRasterCover = true;
      }
      if (
        !hotIdentity.selection.isConnected ||
        frame.querySelector(
          "[data-design-element-overlay].zd-design-selection-outline",
        ) !== hotIdentity.selection
      ) {
        selectionDisconnected = true;
      }
    };
    const observer = new MutationObserver(observeBuffers);
    observer.observe(frame, {
      attributes: true,
      attributeFilter: [
        "data-design-document-buffer",
        "data-design-document-ready",
      ],
      childList: true,
      subtree: true,
    });
    const sample = () => {
      if (!running) return;
      observeBuffers();
      requestAnimationFrame(sample);
    };
    frame.addEventListener(
      "load",
      (event) => {
        if (
          event.target instanceof HTMLIFrameElement &&
          event.target !== iframe
        ) {
          incomingLoads += 1;
        }
      },
      true,
    );
    observeBuffers();
    requestAnimationFrame(sample);
    window.__zerosDesignStructuralIdentity = {
      iframe,
      frame,
      styleEditor: hotIdentity.styleEditor,
      timeline: hotIdentity.timeline,
      review: hotIdentity.review,
      selection: hotIdentity.selection,
      incomingLoads: () => incomingLoads,
      sawDualDocumentBuffers: () => sawDualDocumentBuffers,
      maxDocumentBuffers: () => maxDocumentBuffers,
      outgoingStayedConnectedUntilReady: () =>
        outgoingStayedConnectedUntilReady,
      sawRasterCover: () => sawRasterCover,
      selectionDisconnected: () => selectionDisconnected,
      stop: () => {
        running = false;
        observer.disconnect();
      },
    };
  });
  const structuralSourceVersion = await page.evaluate(() =>
    window.__zerosHarnessCommitStructuralGeneration(),
  );
  const structuralGenerationReady = await waitFor(
    () =>
      page.evaluate(
        ({ nextSourceVersion }) => {
          const identity = window.__zerosDesignStructuralIdentity;
          const iframe = document.querySelector(
            '[data-design-frame="home.html"] iframe',
          );
          return (
            !!identity &&
            iframe !== identity.iframe &&
            iframe?.getAttribute("data-design-source-version") ===
              nextSourceVersion &&
            iframe?.getAttribute("data-design-document-source-version") ===
              nextSourceVersion &&
            iframe?.getAttribute("data-design-document-buffer") ===
              "displayed" &&
            iframe?.hasAttribute("data-design-document-ready") &&
            identity.selection.getAttribute(
              "data-design-overlay-source-version",
            ) === nextSourceVersion &&
            !identity.frame.querySelector(
              "[data-design-frame-transition-cover]",
            )
          );
        },
        { nextSourceVersion: structuralSourceVersion },
      ),
    "design-structural-generation-ready",
  );
  const structuralGenerationDiagnostic = await page.evaluate(() => {
    const identity = window.__zerosDesignStructuralIdentity;
    const currentIframe = document.querySelector(
      '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]',
    );
    const diagnostic = {
      outgoingReplaced: currentIframe !== identity?.iframe,
      outgoingDisconnected: identity?.iframe.isConnected === false,
      editorIdentity:
        document.querySelector("[data-design-style-editor]") ===
        identity?.styleEditor,
      timelineIdentity:
        document.querySelector('[aria-label="Motion timeline"]') ===
        identity?.timeline,
      reviewIdentity:
        document.querySelector("[data-design-lint-review]") ===
        identity?.review,
      incomingLoads: identity?.incomingLoads() ?? null,
      sawDualDocumentBuffers: identity?.sawDualDocumentBuffers() ?? false,
      maxDocumentBuffers: identity?.maxDocumentBuffers() ?? null,
      outgoingStayedConnectedUntilReady:
        identity?.outgoingStayedConnectedUntilReady() ?? false,
      sawRasterCover: identity?.sawRasterCover() ?? false,
      selectionIdentity:
        identity?.selection.isConnected === true &&
        identity?.frame.querySelector(
          "[data-design-element-overlay].zd-design-selection-outline",
        ) === identity?.selection,
      selectionDisconnected: identity?.selectionDisconnected() ?? true,
    };
    identity?.stop();
    return diagnostic;
  });
  check(
    "structural commits keep confirmed pixels and editor chrome continuously visible",
    structuralGenerationReady &&
      structuralGenerationDiagnostic.outgoingReplaced &&
      structuralGenerationDiagnostic.outgoingDisconnected &&
      structuralGenerationDiagnostic.editorIdentity &&
      structuralGenerationDiagnostic.timelineIdentity &&
      structuralGenerationDiagnostic.reviewIdentity &&
      structuralGenerationDiagnostic.selectionIdentity &&
      !structuralGenerationDiagnostic.selectionDisconnected &&
      structuralGenerationDiagnostic.incomingLoads === 1 &&
      structuralGenerationDiagnostic.sawDualDocumentBuffers &&
      structuralGenerationDiagnostic.maxDocumentBuffers === 2 &&
      structuralGenerationDiagnostic.outgoingStayedConnectedUntilReady &&
      !structuralGenerationDiagnostic.sawRasterCover &&
      (await motionDurationBeforeHotCommit.inputValue()) === "450ms",
    JSON.stringify(structuralGenerationDiagnostic),
  );
  await page.getByRole("button", { name: "Animate W", exact: true }).click();
  check(
    "inspector diamonds create a valid persistent motion track",
    await waitFor(
      async () =>
        (await motionTimeline
          .getByRole("button", { name: /width keyframe at/ })
          .count()) === 2,
      "design-motion-inspector-keyframe",
    ),
  );
  await expandStyleSection("Transform");
  await page
    .getByRole("button", {
      name: /^(Animate transform|Add transform keyframe at the playhead)$/,
    })
    .click();
  const transformKeyframeValue = motionTimeline.getByLabel(
    "transform keyframe value",
  );
  await transformKeyframeValue.fill("translateY(64px)");
  const motionPathPoints = page.locator("[data-design-motion-path-point]");
  check(
    "style-editor diamonds expose selectable canvas motion paths",
    await waitFor(
      async () => (await motionPathPoints.count()) === 2,
      "design-motion-canvas-path",
    ),
  );
  await page.getByRole("button", { name: "Seek motion to 450ms" }).click();
  const soughtMotionTime = await waitFor(
    async () =>
      (await motionTimeline.getByLabel("Motion current time").inputValue()) ===
      "450",
    "design-motion-canvas-seek",
  );
  check(
    "canvas motion points seek the exact timeline time",
    soughtMotionTime,
    await motionTimeline.getByLabel("Motion current time").inputValue(),
  );
  const motionPreset = motionTimeline.getByLabel("Motion preset");
  await motionPreset.click();
  await page.getByRole("option", { name: "Pulse", exact: true }).click();
  check(
    "motion presets create editable multi-point tracks",
    (await motionTimeline
      .getByRole("button", { name: /transform keyframe at/ })
      .count()) === 3 &&
      (await motionTimeline.getByLabel("Animation duration").inputValue()) ===
        "600ms" &&
      (await motionPreset.textContent())?.includes("Pulse"),
  );
  const animationEasing = motionTimeline.getByLabel("Animation easing");
  await animationEasing.fill("steps(5, end)");
  check(
    "motion easing accepts editable CSS timing functions and marks a preset customized",
    (await animationEasing.inputValue()) === "steps(5, end)" &&
      (await motionPreset.textContent())?.includes("Custom"),
  );
  await animationEasing.fill("spring(1, 100, 10)");
  check(
    "invalid non-CSS easing cannot be saved",
    (await animationEasing.getAttribute("aria-invalid")) === "true" &&
      (await motionTimeline
        .getByRole("button", { name: "Save", exact: true })
        .isDisabled()),
  );
  await animationEasing.fill("steps(5, end)");
  await motionTimeline
    .getByRole("button", { name: "Close motion timeline" })
    .click();

  await page.getByRole("button", { name: "Text tool" }).click();
  check(
    "Text tool enters insertion mode with a crosshair cursor",
    (await page
      .getByRole("button", { name: "Text tool" })
      .getAttribute("aria-pressed")) === "true" &&
      (await page
        .getByLabel("Design canvas")
        .evaluate((element) => getComputedStyle(element).cursor)) ===
        "crosshair",
  );
  const inlineHeadingOverlay = homeFrame.locator(
    "[data-design-selected-element]",
  );
  const inlineHeadingBox = await inlineHeadingOverlay.boundingBox();
  if (!inlineHeadingBox) {
    throw new Error("Selected heading overlay has no bounds");
  }
  await page.mouse.click(
    inlineHeadingBox.x + inlineHeadingBox.width / 2,
    inlineHeadingBox.y + inlineHeadingBox.height / 2,
  );
  const inlineText = page.getByLabel(/^Edit text for /);
  check(
    "Text-tool click on existing text opens the inline editor",
    await waitFor(
      () => inlineText.isVisible().catch(() => false),
      "design-inline-text-ready",
    ),
  );
  await page.keyboard.type("!");
  const runtimeHeading = homeFrame
    .frameLocator('iframe[data-design-document-buffer="displayed"]')
    .locator('[data-oid="home-heading"]');
  check(
    "inline keystrokes mirror into the painted runtime immediately",
    await waitFor(
      async () =>
        (await runtimeHeading.textContent().catch(() => ""))?.endsWith("!") ===
        true,
      "design-inline-text-live-preview",
    ),
  );
  await page.keyboard.press("Escape");
  check(
    "Escape closes inline text editor",
    await waitFor(
      async () => !(await inlineText.isVisible().catch(() => false)),
      "design-inline-text-escape",
    ),
  );
  check(
    "Escape restores authored runtime text",
    await waitFor(
      async () =>
        (await runtimeHeading.textContent().catch(() => "")) ===
        "Make the next move unmistakable.",
      "design-inline-text-restore",
    ),
  );
  check(
    "escaping inline text returns to the Select tool",
    (await page
      .getByRole("button", { name: "Select" })
      .getAttribute("aria-pressed")) === "true" &&
      (await page
        .getByRole("button", { name: "Text tool" })
        .getAttribute("aria-pressed")) === "false",
  );

  // Text-tool targeting refreshes semantic geometry from the runtime. Re-read
  // the selected overlay so this exercises the visible text rather than an
  // earlier motion-preview coordinate or an edge resize hit target.
  const selectedHeadingBox = await inlineHeadingOverlay.boundingBox();
  if (!selectedHeadingBox) {
    throw new Error("Selected heading overlay has no refreshed bounds");
  }
  await page.mouse.click(
    selectedHeadingBox.x + selectedHeadingBox.width / 2,
    selectedHeadingBox.y + selectedHeadingBox.height * 0.4,
  );
  const singleClickState = {
    editorVisible: await inlineText.isVisible().catch(() => false),
    resizeHandleCount: await homeFrame
      .locator('.zd-design-selection-handle[aria-label^="Resize "]')
      .count(),
    selectedNode: await homeFrame
      .locator("[data-design-selected-element]")
      .getAttribute("data-design-element-overlay")
      .catch(() => null),
  };
  check(
    "a single click keeps text selected without entering text edit mode",
    !singleClickState.editorVisible && singleClickState.resizeHandleCount === 4,
    JSON.stringify(singleClickState),
  );
  const headingEastResize = inlineHeadingOverlay.locator(
    '[data-design-resize-edge="e"]',
  );
  const headingEastResizeBox = await headingEastResize.boundingBox();
  const headingRuntimeBeforeResize = await runtimeHeading.boundingBox();
  if (!headingEastResizeBox || !headingRuntimeBeforeResize) {
    throw new Error("Text resize geometry is unavailable");
  }
  await page.mouse.move(
    headingEastResizeBox.x + headingEastResizeBox.width / 2,
    headingEastResizeBox.y + headingEastResizeBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    headingEastResizeBox.x + headingEastResizeBox.width / 2 - 180,
    headingEastResizeBox.y + headingEastResizeBox.height / 2,
    { steps: 4 },
  );
  check(
    "horizontal text resize reflows auto-height without a stale clipping box",
    await waitFor(async () => {
      const runtime = await runtimeHeading.boundingBox();
      const overlay = await inlineHeadingOverlay.boundingBox();
      return (
        !!runtime &&
        !!overlay &&
        runtime.height > headingRuntimeBeforeResize.height + 20 &&
        Math.abs(runtime.height - overlay.height) < 2
      );
    }, "design-text-horizontal-reflow"),
  );
  await page.evaluate(() => {
    window.dispatchEvent(
      new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }),
    );
  });
  await page.mouse.up();
  await waitFor(async () => {
    const restored = await runtimeHeading.boundingBox();
    return (
      !!restored &&
      Math.abs(restored.width - headingRuntimeBeforeResize.width) < 1 &&
      Math.abs(restored.height - headingRuntimeBeforeResize.height) < 1
    );
  }, "design-text-horizontal-reflow-cancel");
  await page.mouse.dblclick(
    selectedHeadingBox.x + selectedHeadingBox.width / 2,
    selectedHeadingBox.y + selectedHeadingBox.height * 0.4,
  );
  check(
    "double-clicking text enters inline editing from Select mode",
    await waitFor(
      () => inlineText.isVisible().catch(() => false),
      "design-inline-text-double-click",
    ),
  );
  check(
    "text edit mode replaces transform handles with one clean editing boundary",
    await waitFor(async () => {
      const outline = await inlineText.evaluate(
        (editor) => getComputedStyle(editor).outlineColor,
      );
      const runtimePaint = await runtimeHeading.evaluate((heading) => ({
        color: getComputedStyle(heading).color,
        fill: getComputedStyle(heading).webkitTextFillColor,
      }));
      return (
        (await homeFrame.locator(".zd-design-selection-handle").count()) ===
          0 &&
        outline === "rgb(12, 140, 233)" &&
        runtimePaint.color !== "rgba(0, 0, 0, 0)" &&
        runtimePaint.fill === "rgba(0, 0, 0, 0)"
      );
    }, "design-inline-text-clean-boundary"),
  );
  const headingBeforeCommit = (await inlineText.textContent()) ?? "";
  const headingSuffix = " edited once";
  await page.keyboard.type(headingSuffix);
  const committedHeading = `${headingBeforeCommit}${headingSuffix}`;
  check(
    "double-click editing keeps the host glyph and caret visibly paintable",
    await waitFor(async () => {
      const state = await inlineText.evaluate((editor) => ({
        text: editor.innerText,
        color: getComputedStyle(editor).color,
        fill: getComputedStyle(editor).webkitTextFillColor,
      }));
      return (
        state.text === committedHeading &&
        state.color !== "rgba(0, 0, 0, 0)" &&
        state.fill !== "rgba(0, 0, 0, 0)"
      );
    }, "design-inline-text-visible-draft"),
  );
  await page.evaluate(() => {
    const displayed = document.querySelector(
      '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]',
    );
    const initialSource = displayed?.getAttribute(
      "data-design-document-source-version",
    );
    const state = {
      initialSource,
      blankBeforeSwap: false,
      duplicateAfterSwap: false,
      completed: false,
    };
    window.__zerosTextCommitHandoff = state;
    const sample = () => {
      if (state.completed) return;
      const currentDisplayed = document.querySelector(
        '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]',
      );
      const source = currentDisplayed?.getAttribute(
        "data-design-document-source-version",
      );
      const editor = document.querySelector("[data-design-inline-text-editor]");
      const editorPainted =
        editor instanceof HTMLElement &&
        getComputedStyle(editor).visibility !== "hidden" &&
        getComputedStyle(editor).display !== "none" &&
        getComputedStyle(editor).webkitTextFillColor !== "rgba(0, 0, 0, 0)" &&
        getComputedStyle(editor).color !== "rgba(0, 0, 0, 0)";
      if (source === state.initialSource && !editor) {
        state.blankBeforeSwap = true;
      }
      if (source && source !== state.initialSource) {
        state.duplicateAfterSwap = editorPainted;
        state.completed = true;
        return;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.keyboard.press("ControlOrMeta+Enter");
  const textCommitHandoffPassed = await waitFor(async () => {
    const handoff = await page.evaluate(() => window.__zerosTextCommitHandoff);
    return Boolean(
      handoff?.completed &&
      !handoff.blankBeforeSwap &&
      !handoff.duplicateAfterSwap &&
      !(await inlineText.isVisible().catch(() => false)),
    );
  }, "design-inline-text-commit-handoff");
  const textCommitHandoff = await page.evaluate(
    () => window.__zerosTextCommitHandoff,
  );
  check(
    "Cmd/Ctrl+Enter hands committed text between buffers without blank or duplicate paint",
    textCommitHandoffPassed,
    JSON.stringify(textCommitHandoff),
  );
  check(
    "committed text has one visible runtime owner and no cloned host line",
    await waitFor(async () => {
      if ((await runtimeHeading.count()) !== 1) return false;
      const state = await runtimeHeading.evaluate((heading) => ({
        text: heading.textContent,
        color: getComputedStyle(heading).color,
        fill: getComputedStyle(heading).webkitTextFillColor,
      }));
      return (
        state.text === committedHeading &&
        state.color !== "rgba(0, 0, 0, 0)" &&
        state.fill !== "rgba(0, 0, 0, 0)"
      );
    }, "design-inline-text-committed-owner"),
  );
  const committedHeadingBox = await inlineHeadingOverlay.boundingBox();
  if (!committedHeadingBox) {
    throw new Error("Committed heading overlay has no bounds");
  }
  await page.mouse.dblclick(
    committedHeadingBox.x + committedHeadingBox.width / 2,
    committedHeadingBox.y + committedHeadingBox.height * 0.4,
  );
  check(
    "reopening committed text restores its complete visible draft",
    await waitFor(async () => {
      if (!(await inlineText.isVisible().catch(() => false))) return false;
      const state = await inlineText.evaluate((editor) => ({
        text: editor.innerText,
        color: getComputedStyle(editor).color,
      }));
      return (
        state.text === committedHeading && state.color !== "rgba(0, 0, 0, 0)"
      );
    }, "design-inline-text-reopen-visible"),
  );
  await page.keyboard.type(" again");
  check(
    "reopened text accepts the first and subsequent keystrokes exactly once",
    await waitFor(
      async () =>
        (await inlineText.textContent()) === `${committedHeading} again`,
      "design-inline-text-reopen-type",
    ),
  );
  await inlineText.evaluate((editor) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", " pasted\nonce");
    transfer.setData("text/html", "<b>must not become markup</b>");
    editor.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  });
  const pastedHeading = `${committedHeading} again pasted\nonce`;
  check(
    "plain-text paste preserves line breaks without cloning rich markup",
    await waitFor(async () => {
      const state = await inlineText.evaluate((editor) => ({
        text: editor.innerText,
        boldChildren: editor.querySelectorAll("b").length,
      }));
      return state.text === pastedHeading && state.boldChildren === 0;
    }, "design-inline-text-plain-paste"),
  );
  await page.keyboard.press("Enter");
  await page.keyboard.type("next line");
  check(
    "multiline editing inserts one intentional line exactly once",
    await waitFor(
      async () =>
        (await inlineText.evaluate((editor) => editor.innerText)) ===
        `${pastedHeading}\nnext line`,
      "design-inline-text-multiline",
    ),
  );
  await page.keyboard.press("Escape");
  check(
    "Escape after multiline editing restores the exact committed source text",
    await waitFor(async () => {
      if (await inlineText.isVisible().catch(() => false)) return false;
      return (await runtimeHeading.textContent()) === committedHeading;
    }, "design-inline-text-multiline-cancel"),
  );

  const imeHeadingBox = await inlineHeadingOverlay.boundingBox();
  if (!imeHeadingBox) {
    throw new Error("IME heading overlay has no bounds");
  }
  await page.mouse.dblclick(
    imeHeadingBox.x + imeHeadingBox.width / 2,
    imeHeadingBox.y + imeHeadingBox.height * 0.4,
  );
  await inlineText.waitFor({ state: "visible" });
  const imeHeading = `${committedHeading} 構`;
  await inlineText.evaluate((editor, text) => {
    editor.dispatchEvent(
      new CompositionEvent("compositionstart", {
        bubbles: true,
        data: "",
      }),
    );
    editor.textContent = text;
    editor.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "構",
        inputType: "insertCompositionText",
        isComposing: true,
      }),
    );
  }, imeHeading);
  await page.getByLabel("Design canvas").focus();
  await inlineText.evaluate((editor) => {
    editor.dispatchEvent(
      new CompositionEvent("compositionend", {
        bubbles: true,
        data: "構",
      }),
    );
  });
  check(
    "IME completion after a composition-time blur commits once without losing text",
    await waitFor(async () => {
      if (await inlineText.isVisible().catch(() => false)) return false;
      return (
        (await runtimeHeading.count()) === 1 &&
        (await runtimeHeading.textContent()) === imeHeading
      );
    }, "design-inline-text-ime-blur"),
  );

  await page.locator('[data-design-layer-id="home-action"]').click();
  const actionOverlay = page.locator(
    '[data-design-element-overlay="home-action"]',
  );
  const actionOverlayBox = await actionOverlay.boundingBox();
  if (!actionOverlayBox) throw new Error("Action text overlay has no bounds");
  const runtimeAction = homeFrame
    .frameLocator('iframe[data-design-document-buffer="displayed"]')
    .locator('[data-oid="home-action"]');
  const actionTextBeforeEdit = (await runtimeAction.textContent()) ?? "";
  await page.mouse.dblclick(
    actionOverlayBox.x + actionOverlayBox.width / 2,
    actionOverlayBox.y + actionOverlayBox.height / 2,
  );
  await inlineText.waitFor({ state: "visible" });
  const actionEditorBeforeType = await inlineText.boundingBox();
  const actionRuntimeBeforeType = await runtimeAction.boundingBox();
  if (!actionEditorBeforeType || !actionRuntimeBeforeType) {
    throw new Error("Action text edit geometry is unavailable");
  }
  const actionEditZoom = (await readCanvasTransform()).zoom;
  const actionSuffix = " — coordinate every launch decision clearly";
  await page.keyboard.type(actionSuffix);
  let intrinsicTextDiagnostic = null;
  check(
    "intrinsic-width text grows on one line without a cloned wrapped copy",
    await waitFor(async () => {
      const editorBox = await inlineText.boundingBox();
      const runtimeBox = await runtimeAction.boundingBox();
      intrinsicTextDiagnostic = {
        editorBox,
        runtimeBox,
        actionEditorBeforeType,
        actionRuntimeBeforeType,
        editorText: await inlineText.evaluate((editor) => editor.innerText),
        runtimeText: await runtimeAction.textContent(),
      };
      return Boolean(
        editorBox &&
        runtimeBox &&
        editorBox.width > actionEditorBeforeType.width + 100 * actionEditZoom &&
        runtimeBox.width >
          actionRuntimeBeforeType.width + 100 * actionEditZoom &&
        Math.abs(editorBox.width - runtimeBox.width) < 2 &&
        Math.abs(editorBox.height - runtimeBox.height) < 2 &&
        (await inlineText.evaluate((editor) => editor.innerText)) ===
          `${actionTextBeforeEdit}${actionSuffix}`,
      );
    }, "design-inline-text-intrinsic-width"),
    JSON.stringify(intrinsicTextDiagnostic),
  );
  await page.keyboard.press("Escape");
  await waitFor(
    () => inlineText.isHidden().catch(() => true),
    "design-inline-text-intrinsic-cancel",
  );
  check(
    "cancelling intrinsic-width text restores its exact authored line",
    (await runtimeAction.textContent()) === actionTextBeforeEdit,
  );

  await page.getByRole("button", { name: "Text tool" }).click();
  const frameToolBox = await homeFrame.boundingBox();
  if (!frameToolBox) throw new Error("Home frame has no bounds");
  await page.mouse.move(
    frameToolBox.x + frameToolBox.width * 0.72,
    frameToolBox.y + frameToolBox.height * 0.72,
  );
  await page.mouse.down();
  await page.mouse.move(
    frameToolBox.x + frameToolBox.width * 0.88,
    frameToolBox.y + frameToolBox.height * 0.82,
  );
  await page.mouse.up();
  const newInlineText = page.getByLabel("New canvas text");
  check(
    "Text-tool drag creates a fixed text box and starts typing immediately",
    await waitFor(
      () => newInlineText.isVisible().catch(() => false),
      "design-new-inline-text",
    ),
  );
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Text tool" }).click();
  await page.mouse.click(
    frameToolBox.x + frameToolBox.width * 0.92,
    frameToolBox.y + frameToolBox.height * 0.5,
  );
  const flowInlineText = page.getByLabel("New canvas text");
  await flowInlineText.waitFor({ state: "visible" });
  await page.keyboard.type("Flow label");
  await page.keyboard.press("ControlOrMeta+Enter");
  const flowRuntimeText = homeFrame
    .frameLocator('iframe[data-design-document-buffer="displayed"]')
    .locator('[data-oid^="text-"]');
  check(
    "text added to a flex frame participates in layout by default",
    await waitFor(async () => {
      if ((await flowRuntimeText.count()) !== 1) return false;
      return flowRuntimeText.evaluate(
        (node) =>
          node.parentElement?.getAttribute("data-oid") === "home-main" &&
          getComputedStyle(node).position !== "absolute",
      );
    }, "design-flow-text-commit"),
  );
  await page.locator('[data-design-layer-id="home-heading"]').click();

  const canvasBounds = await page.getByLabel("Design canvas").boundingBox();
  if (!canvasBounds) throw new Error("Design canvas has no bounds");
  const emptyCanvasPoint = await page.evaluate((bounds) => {
    const candidates = [
      { x: bounds.x + 36, y: bounds.y + 36 },
      { x: bounds.x + bounds.width - 36, y: bounds.y + 36 },
      { x: bounds.x + 36, y: bounds.y + bounds.height - 72 },
    ];
    return (
      candidates.find((point) => {
        const target = document.elementFromPoint(point.x, point.y);
        return (
          target instanceof Element &&
          !target.closest("[data-design-frame]") &&
          !target.closest("[data-design-controls]")
        );
      }) ?? candidates[0]
    );
  }, canvasBounds);
  await page.getByRole("button", { name: "Text tool" }).click();
  await page.mouse.click(emptyCanvasPoint.x, emptyCanvasPoint.y);
  const looseCanvasText = page.getByLabel("New canvas text");
  check(
    "Text-tool click on bare canvas starts typing without a placeholder frame",
    await waitFor(
      () => looseCanvasText.isVisible().catch(() => false),
      "design-loose-text-editor",
    ),
  );
  await page.keyboard.type("Canvas label");
  await page.keyboard.press("ControlOrMeta+Enter");
  const looseTextFrame = page.locator('[data-design-frame-kind="text"]');
  check(
    "bare-canvas text commits to one transparent source-owned layer",
    await waitFor(async () => {
      const runtimeText = looseTextFrame
        .frameLocator('iframe[data-design-document-buffer="displayed"]')
        .locator("[data-oid]");
      return (
        (await looseTextFrame.count()) === 1 &&
        !(await looseCanvasText.isVisible().catch(() => false)) &&
        (await runtimeText.textContent().catch(() => "")) === "Canvas label" &&
        (await looseTextFrame.locator("[data-design-frame-label]").count()) ===
          0
      );
    }, "design-loose-text-commit"),
  );
  await page.getByLabel("Design canvas").focus();
  await page.keyboard.press("Delete");
  check(
    "Delete removes top-level text immediately without a confirmation",
    await waitFor(
      async () => (await looseTextFrame.count()) === 0,
      "design-loose-text-delete",
    ),
  );
  check(
    "top-level text deletion emits no success toast or dialog",
    (await page.getByRole("dialog").count()) === 0 &&
      (await page
        .getByText("Design frame deleted", { exact: true })
        .count()) === 0,
  );
  await page.keyboard.press("ControlOrMeta+Z");
  check(
    "Command-Z restores deleted top-level text immediately",
    await waitFor(
      async () => (await looseTextFrame.count()) === 1,
      "design-loose-text-undo",
    ),
  );
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  check(
    "Command-Shift-Z redoes top-level text deletion",
    await waitFor(
      async () => (await looseTextFrame.count()) === 0,
      "design-loose-text-redo",
    ),
  );
  await homeFrame.getByRole("button", { name: /^Launch home/ }).click();
  await page.locator('[data-design-layer-id="home-heading"]').click();

  await page.getByRole("button", { name: "Frame tool" }).click();
  await page.mouse.move(canvasBounds.x + 40, canvasBounds.y + 80);
  await page.mouse.down();
  await page.mouse.move(canvasBounds.x + 180, canvasBounds.y + 180);
  const frameCreationDraft = page.locator(
    '[data-design-creation-draft="frame"]',
  );
  check(
    "Frame-tool drag paints its exact live creation rectangle",
    await frameCreationDraft.isVisible(),
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  check(
    "Escape cancels frame creation and restores Select",
    !(await frameCreationDraft.isVisible()) &&
      (await page
        .getByRole("button", { name: "Select" })
        .getAttribute("aria-pressed")) === "true",
  );

  const codeToggle = page.getByRole("button", { name: "Toggle frame source" });
  await codeToggle.click();
  check(
    "code tool opens authored frame source",
    await page.getByText("Zeros Design/home.html").isVisible(),
  );
  await codeToggle.click();

  const canvasFocusTarget = page.getByLabel("Design canvas");
  const selectedLayer = (nodeId) =>
    page.locator(`[data-design-layer-id="${nodeId}"][aria-selected="true"]`);
  await canvasFocusTarget.focus();
  await page.keyboard.press("ControlOrMeta+A");
  check(
    "canvas shortcuts never create browser-wide text selection",
    (await page.evaluate(() => window.getSelection()?.toString() ?? "")) === "",
  );
  await page.keyboard.press("Shift+Enter");
  check(
    "Shift+Enter climbs from a nested element to its parent",
    await waitFor(
      () =>
        selectedLayer("home-hero")
          .isVisible()
          .catch(() => false),
      "design-select-parent",
    ),
  );
  const nestedHeadingBox = await selectedHeading.boundingBox();
  if (!nestedHeadingBox) throw new Error("nested heading has no geometry");
  await page.mouse.dblclick(
    nestedHeadingBox.x + nestedHeadingBox.width / 2,
    nestedHeadingBox.y + nestedHeadingBox.height / 2,
  );
  const nestedDoubleClickState = async () => ({
    selectedHeading: await selectedLayer("home-heading")
      .isVisible()
      .catch(() => false),
    selectedHero: await selectedLayer("home-hero")
      .isVisible()
      .catch(() => false),
    editorVisible: await inlineText.isVisible().catch(() => false),
    selectedOverlay: await homeFrame
      .locator("[data-design-selected-element]")
      .getAttribute("data-design-element-overlay")
      .catch(() => null),
  });
  const nestedDescended = await waitFor(
    () =>
      selectedLayer("home-heading")
        .isVisible()
        .catch(() => false),
    "design-canvas-double-click-descend",
  );
  check(
    "double-click descends one nested canvas level",
    nestedDescended,
    JSON.stringify(await nestedDoubleClickState()),
  );
  const nestedEditorReady = await waitFor(
    () => inlineText.isVisible().catch(() => false),
    "design-nested-inline-text-ready",
  );
  check(
    "double-clicking nested text enters inline editing",
    nestedEditorReady,
    JSON.stringify(await nestedDoubleClickState()),
  );
  await page.keyboard.press("Escape");
  await waitFor(
    async () => !(await inlineText.isVisible().catch(() => false)),
    "design-nested-inline-text-cancel",
  );
  await canvasFocusTarget.focus();
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.down("Control");
  await page.mouse.click(
    nestedHeadingBox.x + nestedHeadingBox.width / 2,
    nestedHeadingBox.y + nestedHeadingBox.height / 2,
  );
  await page.keyboard.up("Control");
  check(
    "Cmd/Ctrl-click deep-selects through an already selected container",
    await waitFor(
      () =>
        selectedLayer("home-heading")
          .isVisible()
          .catch(() => false),
      "design-canvas-deep-select",
    ),
  );
  const runtimeCopyForPeerSelection = homeRuntime.locator(
    '[data-oid="home-copy"]',
  );
  const nestedCopyBox = await runtimeCopyForPeerSelection.boundingBox();
  if (!nestedCopyBox) throw new Error("nested copy has no geometry");
  await page.mouse.click(
    nestedCopyBox.x + nestedCopyBox.width / 2,
    nestedCopyBox.y + nestedCopyBox.height / 2,
  );
  check(
    "a normal click selects a nested peer without jumping to the outer frame",
    await waitFor(
      () =>
        selectedLayer("home-copy")
          .isVisible()
          .catch(() => false),
      "design-canvas-nested-peer",
    ),
  );
  await page.mouse.click(
    nestedHeadingBox.x + nestedHeadingBox.width / 2,
    nestedHeadingBox.y + nestedHeadingBox.height / 2,
  );
  await waitFor(
    () =>
      selectedLayer("home-heading")
        .isVisible()
        .catch(() => false),
    "design-canvas-return-to-heading",
  );
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Enter");
  check(
    "Enter descends to the first child",
    await waitFor(
      () =>
        selectedLayer("home-heading")
          .isVisible()
          .catch(() => false),
      "design-select-child",
    ),
  );
  await page.keyboard.press("Tab");
  check(
    "Tab advances across nested sibling layers",
    await waitFor(
      () =>
        selectedLayer("home-copy")
          .isVisible()
          .catch(() => false),
      "design-select-next-sibling",
    ),
  );
  await page.keyboard.press("Shift+Tab");
  check(
    "Shift+Tab returns to the previous sibling",
    await waitFor(
      () =>
        selectedLayer("home-heading")
          .isVisible()
          .catch(() => false),
      "design-select-previous-sibling",
    ),
  );

  const copyLayerRow = page.locator('[data-design-layer-id="home-copy"]');
  await copyLayerRow.click({ modifiers: ["Shift"] });
  check(
    "Shift-click creates one additive layer selection",
    await waitFor(
      async () =>
        (await page
          .locator('[data-design-layer-id][aria-selected="true"]')
          .count()) === 2 &&
        (await homeFrame.locator("[data-design-multi-selection]").count()) ===
          1,
      "design-multi-select",
    ),
  );
  check(
    "multi-selection is explicit in the inspector",
    await page.getByText("2 layers", { exact: true }).last().isVisible(),
  );

  const selectedCopy = homeRuntime.locator('[data-oid="home-copy"]');
  const groupResizeHandle = homeFrame.getByRole("button", {
    name: "Resize 2 selected layers from nw",
  });
  const groupSelectionOverlay = homeFrame.locator(
    "[data-design-multi-selection]",
  );
  const groupSelectionStart = await groupSelectionOverlay.boundingBox();
  const groupResizeBox = await groupResizeHandle.boundingBox();
  if (!groupResizeBox || !groupSelectionStart) {
    throw new Error("group resize controls have no geometry");
  }
  const headingGroupWidth = await selectedHeading.evaluate((element) =>
    element.style.getPropertyValue("width"),
  );
  const copyGroupWidth = await selectedCopy.evaluate((element) =>
    element.style.getPropertyValue("width"),
  );
  await page.mouse.move(
    groupResizeBox.x + groupResizeBox.width / 2,
    groupResizeBox.y + groupResizeBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    groupResizeBox.x + groupResizeBox.width / 2 - 36,
    groupResizeBox.y + groupResizeBox.height / 2 - 18,
  );
  const groupResizeRoots = await groupSelectionOverlay.getAttribute(
    "data-design-resize-roots",
  );
  check(
    `group resize starts with bounded top-level roots — ${groupResizeRoots ?? "none"}`,
    (await groupSelectionOverlay.getAttribute("data-design-gesture")) ===
      "resize" && groupResizeRoots === "2",
  );
  const groupSelectionPreview = await groupSelectionOverlay.boundingBox();
  check(
    "group resize paints its aggregate box synchronously",
    Boolean(
      groupSelectionPreview &&
      groupSelectionPreview.width > groupSelectionStart.width + 10,
    ),
  );
  check(
    "group resize previews every top-level selected layer",
    await waitFor(
      async () =>
        (await selectedHeading.evaluate(
          (element, baseline) =>
            element.style.getPropertyValue("width") !== baseline,
          headingGroupWidth,
        )) &&
        (await selectedCopy.evaluate(
          (element, baseline) =>
            element.style.getPropertyValue("width") !== baseline,
          copyGroupWidth,
        )),
      "design-group-resize-preview",
    ),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  const selectedAfterGroupResize = await page
    .locator('[data-design-layer-id][aria-selected="true"]')
    .count();
  check(
    `cancelled group resize retains additive selection — ${selectedAfterGroupResize} layers`,
    selectedAfterGroupResize === 2,
  );
  check(
    "cancelled group resize restores every selected layer",
    await waitFor(
      async () =>
        (await selectedHeading.evaluate(
          (element, baseline) =>
            element.style.getPropertyValue("width") === baseline,
          headingGroupWidth,
        )) &&
        (await selectedCopy.evaluate(
          (element, baseline) =>
            element.style.getPropertyValue("width") === baseline,
          copyGroupWidth,
        )),
      "design-group-resize-cancel",
    ),
  );

  const additiveCopyOverlay = homeFrame.locator(
    '[data-design-element-overlay="home-copy"]',
  );
  const additiveCopyBox = await additiveCopyOverlay.boundingBox();
  if (!additiveCopyBox)
    throw new Error("additive layer has no canvas geometry");
  const headingGroupLeft = await selectedHeading.evaluate((element) =>
    element.style.getPropertyValue("left"),
  );
  const copyGroupLeft = await selectedCopy.evaluate((element) =>
    element.style.getPropertyValue("left"),
  );
  await page.keyboard.down("Control");
  await page.mouse.move(
    additiveCopyBox.x + additiveCopyBox.width / 2,
    additiveCopyBox.y + additiveCopyBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    additiveCopyBox.x + additiveCopyBox.width / 2 + 24,
    additiveCopyBox.y + additiveCopyBox.height / 2 + 12,
  );
  check(
    "dragging an additive outline moves the complete selection",
    await waitFor(
      async () =>
        (await selectedHeading.evaluate(
          (element, baseline) =>
            element.style.getPropertyValue("left") !== baseline,
          headingGroupLeft,
        )) &&
        (await selectedCopy.evaluate(
          (element, baseline) =>
            element.style.getPropertyValue("left") !== baseline,
          copyGroupLeft,
        )),
      "design-group-move-preview",
    ),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  await page.keyboard.up("Control");
  check(
    "cancelled group movement restores all additive members",
    await waitFor(
      async () =>
        (await selectedHeading.evaluate(
          (element, baseline) =>
            element.style.getPropertyValue("left") === baseline,
          headingGroupLeft,
        )) &&
        (await selectedCopy.evaluate(
          (element, baseline) =>
            element.style.getPropertyValue("left") === baseline,
          copyGroupLeft,
        )),
      "design-group-move-cancel",
    ),
  );

  const headingGroupFill = await selectedHeading.evaluate((element) =>
    element.style.getPropertyValue("background-color"),
  );
  const copyGroupFill = await selectedCopy.evaluate((element) =>
    element.style.getPropertyValue("background-color"),
  );
  await page.getByRole("button", { name: "Edit fill" }).click();
  const groupFillInput = page.getByRole("textbox", {
    name: "Fill color value",
  });
  await groupFillInput.fill("rgb(4, 5, 6)");
  await groupFillInput.press("Enter");
  check(
    "a committed style edit applies to every selected layer",
    await waitFor(
      async () =>
        (await selectedHeading.evaluate(
          (element) =>
            element.style.getPropertyValue("background-color") ===
            "rgb(4, 5, 6)",
        )) &&
        (await selectedCopy.evaluate(
          (element) =>
            element.style.getPropertyValue("background-color") ===
            "rgb(4, 5, 6)",
        )),
      "design-multi-style-preview",
    ),
  );
  await groupFillInput.fill(headingGroupFill);
  await groupFillInput.press("Enter");
  check(
    "committing again restores every layer in the group",
    await waitFor(
      async () =>
        (await selectedHeading.evaluate(
          (element, expected) =>
            element.style.getPropertyValue("background-color") === expected,
          headingGroupFill,
        )) &&
        (await selectedCopy.evaluate(
          (element, expected) =>
            element.style.getPropertyValue("background-color") === expected,
          copyGroupFill,
        )),
      "design-multi-style-escape",
    ),
  );

  // Toggling the primary member off promotes the remaining member without
  // collapsing through a stale async runtime response.
  const selectedCopyOverlay = homeFrame.locator(
    '[data-design-element-overlay="home-copy"]',
  );
  const selectedCopyOverlayBox = await selectedCopyOverlay.boundingBox();
  if (!selectedCopyOverlayBox) {
    throw new Error("selected additive outline has no geometry");
  }
  await page.keyboard.down("Shift");
  await page.mouse.click(
    selectedCopyOverlayBox.x + selectedCopyOverlayBox.width / 2,
    selectedCopyOverlayBox.y + selectedCopyOverlayBox.height / 2,
  );
  await page.keyboard.up("Shift");
  check(
    "canvas Shift-click toggles a group member and keeps the remaining layer",
    await waitFor(
      async () =>
        (await selectedLayer("home-heading").count()) === 1 &&
        (await homeFrame.locator("[data-design-multi-selection]").count()) ===
          0,
      "design-multi-toggle",
    ),
  );

  await canvasFocusTarget.focus();
  await page.keyboard.down("Alt");
  const measurementsVisible = () =>
    waitFor(
      async () =>
        (await homeFrame.locator("[data-design-measure]").count()) > 0 &&
        (await homeFrame.locator("[data-design-measure-target]").count()) === 1,
      "design-option-measurements",
    );
  check(
    "Option reveals red distance lines against the measured target",
    await measurementsVisible(),
  );
  await page.keyboard.up("Alt");
  await waitFor(
    async () =>
      (await homeFrame.locator("[data-design-measure]").count()) === 0,
    "design-option-measurements-released",
  );
  // Measuring must not depend on which surface owns focus: reading a layer in
  // the sidebar and then holding Option is the ordinary way to compare spacing.
  await layersPanel.locator('[data-design-layer-id="home-heading"]').click();
  await waitFor(
    () =>
      selectedLayer("home-heading")
        .isVisible()
        .catch(() => false),
    "design-option-layers-selection",
  );
  await page.keyboard.down("Alt");
  check(
    "Option measures with focus parked in the Layers panel",
    (await measurementsVisible()) &&
      !(await page.evaluate(() =>
        document
          .querySelector('[aria-label="Design canvas"]')
          ?.contains(document.activeElement),
      )),
  );
  await page.keyboard.up("Alt");
  check(
    "releasing Option clears every measurement line",
    await waitFor(
      async () =>
        (await homeFrame.locator("[data-design-measure]").count()) === 0 &&
        (await homeFrame.locator("[data-design-measure-overlay]").count()) ===
          0,
      "design-option-measurements-cleared",
    ),
  );

  await page.keyboard.press("v");
  const headingOverlay = homeFrame.locator(
    '[data-design-element-overlay="home-heading"]',
  );
  const liveLeftField = page.locator('[data-design-style-property="left"]');
  const liveLeftInput = liveLeftField.locator("input");
  const leftBeforeCanvasMove = await liveLeftInput.inputValue();
  await liveLeftField.evaluate((element) => {
    element.dataset.designLiveIdentity = "heading-left";
  });
  const headingOverlayBox = await headingOverlay.boundingBox();
  if (!headingOverlayBox) throw new Error("heading overlay has no geometry");
  await page.mouse.move(
    headingOverlayBox.x + headingOverlayBox.width / 2,
    headingOverlayBox.y + headingOverlayBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    headingOverlayBox.x + headingOverlayBox.width / 2 + 5,
    headingOverlayBox.y + headingOverlayBox.height / 2 + 1,
  );
  check(
    "nested element movement snaps to peer axes with a live guide",
    await waitFor(
      () =>
        page
          .locator('[data-design-guide="vertical"]')
          .evaluate((element) => getComputedStyle(element).display !== "none"),
      "design-element-snap-guide",
    ),
  );
  check(
    "canvas movement updates only the keyed inspector scalar without remounting it",
    await waitFor(
      async () =>
        (await liveLeftInput.inputValue()) !== leftBeforeCanvasMove &&
        (await liveLeftField.getAttribute("data-design-live-identity")) ===
          "heading-left",
      "design-live-left-scalar",
    ),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  check(
    "cancelled direct manipulation clears its snapping guide",
    await waitFor(
      () =>
        page
          .locator('[data-design-guide="vertical"]')
          .evaluate((element) => getComputedStyle(element).display === "none"),
      "design-element-snap-cancel",
    ),
  );
  check(
    "a selected element carries no identity-and-actions pill",
    (await homeFrame
      .getByRole("button", {
        name: "Duplicate Make the next move unmistakable.",
      })
      .count()) === 0 &&
      (await homeFrame
        .getByRole("button", {
          name: "Delete Make the next move unmistakable.",
        })
        .count()) === 0 &&
      (await homeFrame
        .getByRole("button", {
          name: "Edit text in Make the next move unmistakable.",
        })
        .count()) === 0,
  );

  await expandStyleSection("Transform");
  await page
    .getByRole("button", { name: "Edit transform" })
    .waitFor({ state: "visible" });
  const rotationCorners = headingOverlay.locator("[data-design-rotate-corner]");
  check(
    "every corner rotates from just outside the bounding box",
    (await rotationCorners.count()) === 4 &&
      (await rotationCorners
        .first()
        .evaluate((element) =>
          getComputedStyle(element).cursor.startsWith("url("),
        )),
  );
  const rotateHandle = headingOverlay.locator(
    '[data-design-rotate-corner="ne"]',
  );
  const rotateBox = await rotateHandle.boundingBox();
  const overlayBeforeRotation = await headingOverlay.boundingBox();
  if (!rotateBox || !overlayBeforeRotation) {
    throw new Error("rotation corner has no geometry");
  }
  check(
    "the rotation corner sits outside the selection it turns",
    rotateBox.x + rotateBox.width >
      overlayBeforeRotation.x + overlayBeforeRotation.width &&
      rotateBox.y < overlayBeforeRotation.y,
  );
  const authoredTransform = await selectedHeading.evaluate((element) =>
    element.style.getPropertyValue("transform"),
  );
  await page.mouse.move(
    rotateBox.x + rotateBox.width / 2,
    rotateBox.y + rotateBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    rotateBox.x + rotateBox.width / 2 + 24,
    rotateBox.y + rotateBox.height / 2 + 12,
  );
  check(
    "rotation from a corner previews authored transforms on canvas",
    await waitFor(
      () =>
        selectedHeading
          .evaluate(
            (element, baseline) =>
              element.style.getPropertyValue("transform") !== baseline,
            authoredTransform,
          )
          .catch(() => false),
      "design-rotation-preview",
    ),
  );
  check(
    "the selection box turns with the element instead of staying upright",
    await waitFor(
      () =>
        headingOverlay
          .evaluate((element) => {
            const matrix = new DOMMatrixReadOnly(
              getComputedStyle(element).transform,
            );
            return Math.abs(matrix.b) > 0.02;
          })
          .catch(() => false),
      "design-rotation-overlay-turns",
    ),
  );
  check(
    "canvas rotation streams the transform value into its inspector control",
    await waitFor(
      async () =>
        (
          await page
            .getByRole("button", { name: "Edit transform" })
            .textContent()
        )?.includes("rotate(") === true,
      "design-live-transform-scalar",
    ),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  check(
    "cancelled rotation restores the authored transform and upright box",
    (await waitFor(
      () =>
        selectedHeading
          .evaluate(
            (element, baseline) =>
              element.style.getPropertyValue("transform") === baseline,
            authoredTransform,
          )
          .catch(() => false),
      "design-rotation-cancel",
    )) &&
      (await headingOverlay.evaluate(
        (element) => element.style.transform === "",
      )),
  );

  // The origin marker holds a constant screen size, so it retires on a
  // selection only a few marker-widths across — which is what zooming out far
  // enough always produces — and returns once there is room for it. Zooming
  // about the selection's own center keeps it under the pointer and clear of
  // the Layers sidebar.
  const originHandle = headingOverlay.locator("[data-design-origin-handle]");
  const zoomAboutSelection = async (anchor, deltaY, steps) => {
    await canvasViewport.evaluate(
      (canvas, input) => {
        for (let index = 0; index < input.steps; index += 1) {
          canvas.dispatchEvent(
            new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              clientX: input.x,
              clientY: input.y,
              deltaY: input.deltaY,
              deltaMode: WheelEvent.DOM_DELTA_PIXEL,
              ctrlKey: true,
            }),
          );
        }
      },
      { x: Math.round(anchor.x), y: Math.round(anchor.y), deltaY, steps },
    );
    // The camera paints per event and publishes one update after an 80ms idle.
    await page.waitForTimeout(200);
  };
  let originOverlayBox = await headingOverlay.boundingBox();
  if (!originOverlayBox) throw new Error("heading overlay has no geometry");
  check(
    "a selection too small for the origin marker does not draw one",
    originOverlayBox.height < 108 && (await originHandle.count()) === 0,
    JSON.stringify(originOverlayBox),
  );
  const originZoomAnchor = {
    x: originOverlayBox.x + originOverlayBox.width / 2,
    y: originOverlayBox.y + originOverlayBox.height / 2,
  };
  const originZoomSteps = 4;
  await zoomAboutSelection(originZoomAnchor, -40, originZoomSteps);
  originOverlayBox = await headingOverlay.boundingBox();
  check(
    "zooming in past the marker's own size brings the rotation origin back",
    (await waitFor(
      () => originHandle.count().then((count) => count === 1),
      "design-origin-restored",
    )) &&
      !!originOverlayBox &&
      originOverlayBox.height >= 108,
    JSON.stringify(originOverlayBox),
  );
  const originBox = await originHandle.boundingBox();
  const overlayForOrigin = await headingOverlay.boundingBox();
  if (!originBox || !overlayForOrigin) {
    throw new Error("rotation origin has no geometry");
  }
  check(
    "the origin marker keeps one constant screen size",
    originBox.width > 12 && originBox.width < 24,
    JSON.stringify(originBox),
  );
  check(
    "the rotation origin rests at the selection's center",
    Math.abs(
      originBox.x +
        originBox.width / 2 -
        (overlayForOrigin.x + overlayForOrigin.width / 2),
    ) < 2 &&
      Math.abs(
        originBox.y +
          originBox.height / 2 -
          (overlayForOrigin.y + overlayForOrigin.height / 2),
      ) < 2,
  );
  check(
    "the resting pivot leaves the selection's center to moving and editing",
    await originHandle.evaluate(
      (element) => getComputedStyle(element).pointerEvents === "none",
    ),
  );
  // Approaching rotation arms its pivot: the corner and the origin belong to
  // the same intent, and nothing else may claim the element's center.
  const armingCorner = await headingOverlay
    .locator('[data-design-rotate-corner="ne"]')
    .boundingBox();
  if (!armingCorner) throw new Error("rotation corner has no geometry");
  await page.mouse.move(
    armingCorner.x + armingCorner.width / 2,
    armingCorner.y + armingCorner.height / 2,
  );
  check(
    "entering a rotation corner arms the pivot for dragging",
    await waitFor(
      () =>
        originHandle
          .evaluate(
            (element) => getComputedStyle(element).pointerEvents === "auto",
          )
          .catch(() => false),
      "design-origin-armed",
    ),
  );
  // Zoomed in this far, the selection runs past the left edge of the viewport,
  // so the drag has to aim at a corner the pointer can actually reach.
  const originSnapTarget = {
    x: overlayForOrigin.x + overlayForOrigin.width - 2,
    y: overlayForOrigin.y + overlayForOrigin.height - 2,
  };
  const canvasViewportBox = await canvasFocusTarget.boundingBox();
  if (
    !canvasViewportBox ||
    originSnapTarget.x < canvasViewportBox.x ||
    originSnapTarget.y < canvasViewportBox.y
  ) {
    throw new Error("origin snap target is outside the canvas viewport");
  }
  await page.mouse.move(
    originBox.x + originBox.width / 2,
    originBox.y + originBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(originSnapTarget.x - 60, originSnapTarget.y - 40);
  // Pointer-target state, so a failure here says which element took the press
  // rather than only that nothing happened.
  const originDragDiagnostic = await headingOverlay.evaluate((overlay) => {
    const marker = overlay.querySelector("[data-design-origin-handle]");
    const anchors = overlay.querySelector("[data-design-origin-anchors]");
    return {
      dragging: overlay.hasAttribute("data-design-origin-dragging"),
      armed: overlay.hasAttribute("data-design-origin-armed"),
      pointerEvents: marker ? getComputedStyle(marker).pointerEvents : null,
      anchorsDisplay: anchors ? getComputedStyle(anchors).display : null,
    };
  });
  check(
    "dragging the origin reveals its snap anchors and previews the pivot",
    await waitFor(
      async () =>
        (await headingOverlay
          .locator("[data-design-origin-anchors]")
          .evaluate((element) => getComputedStyle(element).display !== "none")
          .catch(() => false)) &&
        (await selectedHeading
          .evaluate((element) =>
            element.style.getPropertyValue("transform-origin"),
          )
          .catch(() => "")) !== "",
      "design-origin-preview",
    ),
    JSON.stringify(originDragDiagnostic),
  );
  await page.mouse.move(originSnapTarget.x, originSnapTarget.y);
  check(
    "the origin snaps onto a box corner within tolerance",
    await waitFor(
      async () =>
        (
          await selectedHeading
            .evaluate((element) =>
              element.style.getPropertyValue("transform-origin"),
            )
            .catch(() => "")
        ).startsWith("100% 100%"),
      "design-origin-snap",
    ),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  check(
    "a cancelled origin drag restores the authored pivot",
    await waitFor(
      async () =>
        (await selectedHeading
          .evaluate((element) =>
            element.style.getPropertyValue("transform-origin"),
          )
          .catch(() => "x")) === "",
      "design-origin-cancel",
    ),
  );

  // A committed rotation is the release path users actually take. Sampling the
  // painted outline every frame across pointer-up proves it never flashes back
  // upright while the write travels to the engine and returns a generation.
  const committedRotateBox = await headingOverlay
    .locator('[data-design-rotate-corner="ne"]')
    .boundingBox();
  if (!committedRotateBox) throw new Error("rotation corner has no geometry");
  await page.mouse.move(
    committedRotateBox.x + committedRotateBox.width / 2,
    committedRotateBox.y + committedRotateBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    committedRotateBox.x + committedRotateBox.width / 2 + 40,
    committedRotateBox.y + committedRotateBox.height / 2 + 90,
    { steps: 6 },
  );
  await headingOverlay.evaluate((element) => {
    const owner = window;
    owner.__zerosRotationSamples = [];
    const sample = () => {
      const { transform } = getComputedStyle(element);
      const previous = owner.__zerosRotationSamples.at(-1);
      if (transform !== previous) owner.__zerosRotationSamples.push(transform);
      owner.__zerosRotationSampler = requestAnimationFrame(sample);
    };
    sample();
  });
  await page.mouse.up();
  const committedRotation = await waitFor(
    async () =>
      (
        await page.getByRole("button", { name: "Edit transform" }).textContent()
      )?.includes("rotate(") === true,
    "design-rotation-commit",
  );
  await page.waitForTimeout(700);
  const rotationSamples = await page.evaluate(() => {
    cancelAnimationFrame(window.__zerosRotationSampler);
    const samples = window.__zerosRotationSamples ?? [];
    const upright = samples.filter((value) => {
      if (value === "none") return true;
      const matrix = new DOMMatrixReadOnly(value);
      return Math.abs(matrix.b) < 0.01 && Math.abs(matrix.c) < 0.01;
    });
    return { samples, uprightCount: upright.length };
  });
  check(
    "releasing a rotation never flashes the selection box back upright",
    committedRotation && rotationSamples.uprightCount === 0,
    JSON.stringify(rotationSamples),
  );
  check(
    "the committed rotation is the angle the pointer released at",
    await headingOverlay.evaluate((element) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return Math.abs(matrix.b) > 0.02;
    }),
  );
  check(
    "constraint guides stay screen-aligned while the element is turned",
    await homeFrame
      .locator("[data-design-parent-guides] [data-design-parent-guide]")
      .evaluateAll(
        (guides) =>
          guides.length > 0 &&
          guides.every((guide) => {
            const matrix = new DOMMatrixReadOnly(
              getComputedStyle(guide).transform,
            );
            const box = guide.getBoundingClientRect();
            return (
              Math.abs(matrix.b) < 0.001 &&
              Math.abs(matrix.c) < 0.001 &&
              (box.width < 1.5 || box.height < 1.5)
            );
          }),
      ),
  );
  // Return the harness to an upright heading so later checks measure the same
  // geometry they always have.
  await page.getByRole("button", { name: "Edit transform" }).click();
  const resetTransformInput = page.getByLabel("Transform CSS value");
  await resetTransformInput.press("ControlOrMeta+A");
  await resetTransformInput.press("Backspace");
  await resetTransformInput.pressSequentially("none");
  await resetTransformInput.press("Enter");
  check(
    "an inspector transform reset returns the box upright",
    await waitFor(
      () =>
        headingOverlay
          .evaluate((element) => {
            const { transform } = getComputedStyle(element);
            if (transform === "none") return true;
            const matrix = new DOMMatrixReadOnly(transform);
            return Math.abs(matrix.b) < 0.001 && Math.abs(matrix.c) < 0.001;
          })
          .catch(() => false),
      "design-rotation-reset",
    ),
  );
  await zoomAboutSelection(originZoomAnchor, 40, originZoomSteps);

  // A constraint reaches only the parent edges the element's CSS pins it to. A
  // static box in flow is pinned to the start edges, and the run measures the
  // real distance there — nothing at all on an edge it already sits against.
  await layersPanel.locator('[data-design-layer-id="home-copy"]').click();
  await waitFor(
    () =>
      selectedLayer("home-copy")
        .isVisible()
        .catch(() => false),
    "design-constraint-copy-selection",
  );
  const readConstraintRuns = () =>
    homeFrame
      .locator("[data-design-parent-guides] [data-design-parent-guide]")
      .evaluateAll((guides) =>
        guides.map((guide) => ({
          side: guide.getAttribute("data-design-parent-guide"),
          hidden: getComputedStyle(guide).display === "none",
          width: guide.getBoundingClientRect().width,
          height: guide.getBoundingClientRect().height,
        })),
      );
  await waitFor(async () => {
    const runs = await readConstraintRuns();
    return runs.length === 2 && runs.some((run) => !run.hidden);
  }, "design-constraint-runs");
  const constraintRuns = await readConstraintRuns();
  check(
    "constraint runs measure the pinned edges a static box flows from",
    constraintRuns.map((run) => run.side).join(",") === "left,top" &&
      constraintRuns.every((run) => run.width < 1.5 || run.height < 1.5) &&
      // Flush against the parent's left edge, a real gap below its top.
      constraintRuns.find((run) => run.side === "left")?.hidden === true &&
      constraintRuns.find((run) => run.side === "top")?.hidden === false &&
      (constraintRuns.find((run) => run.side === "top")?.height ?? 0) > 4,
    JSON.stringify(constraintRuns),
  );
  // Gesture paints own the runs too: the parent stays put while one element
  // moves, so the dashed distance has to follow it and snap back on cancel.
  const copyOverlayBox = await homeFrame
    .locator('[data-design-element-overlay="home-copy"]')
    .boundingBox();
  if (!copyOverlayBox) throw new Error("copy overlay has no geometry");
  const restingTopRun =
    constraintRuns.find((run) => run.side === "top")?.height ?? 0;
  await page.mouse.move(
    copyOverlayBox.x + copyOverlayBox.width / 2,
    copyOverlayBox.y + copyOverlayBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    copyOverlayBox.x + copyOverlayBox.width / 2,
    copyOverlayBox.y + copyOverlayBox.height / 2 + 24,
    { steps: 4 },
  );
  check(
    "a moved element drags its constraint distance with it",
    await waitFor(async () => {
      const runs = await readConstraintRuns();
      const top = runs.find((run) => run.side === "top")?.height ?? 0;
      return top > restingTopRun + 12;
    }, "design-constraint-live-run"),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  check(
    "a cancelled move restores the resting constraint distance",
    await waitFor(async () => {
      const runs = await readConstraintRuns();
      const top = runs.find((run) => run.side === "top")?.height ?? 0;
      return Math.abs(top - restingTopRun) < 1.5;
    }, "design-constraint-restored-run"),
  );
  await layersPanel.locator('[data-design-layer-id="home-heading"]').click();
  await waitFor(
    () =>
      selectedLayer("home-heading")
        .isVisible()
        .catch(() => false),
    "design-constraint-heading-reselection",
  );

  const canvasBox = await canvasFocusTarget.boundingBox();
  const frameBox = await homeFrame.boundingBox();
  if (!canvasBox || !frameBox) {
    throw new Error("design canvas marquee geometry is unavailable");
  }
  const marqueeStart = {
    x: Math.max(canvasBox.x + 4, frameBox.x - 12),
    y: frameBox.y + 8,
  };
  await page.mouse.move(marqueeStart.x, marqueeStart.y);
  await page.mouse.down();
  await page.mouse.move(
    frameBox.x + frameBox.width * 0.9,
    frameBox.y + frameBox.height * 0.75,
  );
  check(
    "empty-canvas drag paints a native selection marquee",
    await page
      .locator("[data-design-marquee]")
      .evaluate((element) => getComputedStyle(element).display !== "none"),
  );
  await page.mouse.up();
  check(
    "marquee resolves rendered siblings through the frame runtime",
    await waitFor(
      async () =>
        (await page
          .locator('[data-design-layer-id][aria-selected="true"]')
          .count()) >= 2,
      "design-marquee-selection",
    ),
  );
  await page.locator('[data-design-layer-id="home-heading"]').click();
  const selectedAfterMarqueeReset = page.locator(
    '[data-design-layer-id][aria-selected="true"]',
  );
  const marqueeReset = await waitFor(
    async () => (await selectedAfterMarqueeReset.count()) === 1,
    "design-marquee-reset",
  );
  check(
    "a direct layer click replaces a marquee selection",
    marqueeReset,
    marqueeReset
      ? ""
      : `selected=${(await selectedAfterMarqueeReset.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-design-layer-id")))).join(",")}`,
  );

  const inFrameMarqueeStart = {
    x: frameBox.x + frameBox.width * 0.96,
    y: frameBox.y + frameBox.height * 0.96,
  };
  await page.mouse.move(inFrameMarqueeStart.x, inFrameMarqueeStart.y);
  await page.mouse.down();
  await page.mouse.move(
    frameBox.x + frameBox.width * 0.22,
    frameBox.y + frameBox.height * 0.22,
  );
  check(
    "dragging an empty area inside a frame paints a scoped marquee",
    await page
      .locator("[data-design-marquee]")
      .evaluate((element) => getComputedStyle(element).display !== "none"),
  );
  await page.mouse.up();
  check(
    "in-frame marquee resolves layers without first clearing the frame context",
    await waitFor(
      async () =>
        (await page
          .locator('[data-design-layer-id][aria-selected="true"]')
          .count()) >= 2,
      "design-in-frame-marquee-selection",
    ),
  );
  await page.locator('[data-design-layer-id="home-heading"]').click();
  const selectedAfterScopedMarqueeReset = page.locator(
    '[data-design-layer-id][aria-selected="true"]',
  );
  const scopedMarqueeReset = await waitFor(
    async () => (await selectedAfterScopedMarqueeReset.count()) === 1,
    "design-in-frame-marquee-reset",
  );
  check(
    "a direct layer click replaces a scoped marquee selection",
    scopedMarqueeReset,
    scopedMarqueeReset
      ? ""
      : `selected=${(await selectedAfterScopedMarqueeReset.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-design-layer-id")))).join(",")}`,
  );

  await homeFrame
    .locator('[data-design-element-overlay="home-heading"]')
    .click({ button: "right" });
  const hitStack = page.getByRole("menu", { name: "Layers under pointer" });
  check(
    "right-click exposes the complete nested hit stack",
    await waitFor(
      async () =>
        (await hitStack.isVisible().catch(() => false)) &&
        (await hitStack.getByRole("menuitem").count()) >= 3,
      "design-hit-stack",
    ),
  );
  check(
    "nested hit stack puts the deepest layer first",
    (await hitStack.getByRole("menuitem").first().textContent())?.includes(
      "Make the next move unmistakable.",
    ) === true,
  );
  const deepestHitText = await hitStack
    .getByRole("menuitem")
    .first()
    .textContent();
  await page.keyboard.press("ArrowDown");
  check(
    "nested hit stack supports roving arrow-key focus",
    await page.evaluate(
      (deepest) =>
        document.activeElement?.getAttribute("role") === "menuitem" &&
        document.activeElement.textContent !== deepest,
      deepestHitText,
    ),
  );
  await page.keyboard.press("Escape");
  check(
    "Escape closes the nested hit stack",
    await waitFor(
      async () => !(await hitStack.isVisible().catch(() => false)),
      "design-hit-stack-close",
    ),
  );

  // Frame deletion is keyboard-only and intentionally frictionless. Selecting
  // its canvas label mirrors the production workflow and proves the deletion
  // itself—not a confirmation UI—is the history entry.
  await homeFrame.getByRole("button", { name: /^Launch home/ }).click();
  await canvasViewport.focus();
  await page.keyboard.press("Delete");
  check(
    "frame delete is immediate and confirmation-free",
    await waitFor(
      async () => (await homeFrame.count()) === 0,
      "design-delete-frame",
    ),
  );
  check(
    "frame deletion emits no success toast",
    (await page.getByText("Design frame deleted", { exact: true }).count()) ===
      0,
  );
  await page.keyboard.press("ControlOrMeta+Z");
  check(
    "Command-Z restores the deleted frame",
    await waitFor(
      async () => (await homeFrame.count()) === 1,
      "design-delete-frame-undo",
    ),
  );
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  check(
    "Command-Shift-Z deletes the restored frame again",
    await waitFor(
      async () => (await homeFrame.count()) === 0,
      "design-delete-frame-redo",
    ),
  );
  await page.keyboard.press("ControlOrMeta+Z");
  await waitFor(
    async () => (await homeFrame.count()) === 1,
    "design-delete-frame-final-restore",
  );

  // A separate dense fixture keeps the ordinary visual harness readable while
  // proving that the Layers tree does not mount ten thousand interactive rows.
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?denseLayers=1`,
    { waitUntil: "networkidle" },
  );
  const denseLayersPanel = page.locator("#design-layers-panel");
  await denseLayersPanel.waitFor({ state: "visible", timeout: 30_000 });
  const denseTree = denseLayersPanel.getByRole("tree");
  check(
    "dense Layers spans the complete 10k-node document",
    await waitFor(
      async () =>
        (await denseTree.evaluate(
          (tree) => tree.getBoundingClientRect().height,
        )) >
        10_000 * 28,
      "design-dense-layer-span",
    ),
  );
  const denseRows = denseTree.locator("[data-design-layer-id]");
  check(
    "dense Layers mounts only a bounded virtual window",
    (await denseRows.count()) < 100,
  );
  const firstDenseLayerId = await denseRows
    .first()
    .getAttribute("data-design-layer-id");
  const initialDenseRowCount = await denseRows.count();
  await denseRows.first().focus();
  await page.keyboard.press("ArrowDown");
  check(
    "dense Layers keeps the measured tall window during nearby arrow travel",
    (await denseRows.count()) >= initialDenseRowCount,
  );
  const denseViewport = denseLayersPanel.locator(
    "[data-radix-scroll-area-viewport]",
  );
  await denseViewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
  });
  await waitFor(
    async () =>
      (await denseRows.first().getAttribute("data-design-layer-id")) !==
      firstDenseLayerId,
    "design-dense-layer-scroll-window",
  );
  check(
    "dense Layers keeps one roving tab stop inside the rendered window",
    (await denseTree
      .locator('[data-design-layer-id][tabindex="0"]')
      .count()) === 1,
  );
  await denseRows.first().focus();
  await page.keyboard.press("End");
  check(
    "virtualized Layers preserves End-key travel to the tree's final row",
    (await waitFor(
      () =>
        // The panel is one tree across every frame, so End lands on the last
        // row of the last frame once the window has travelled there.
        page.evaluate(() => {
          const rows =
            document
              .querySelector('[role="tree"]')
              ?.querySelectorAll("[data-design-panel-row]") ?? [];
          const last = rows[rows.length - 1];
          return !!last && document.activeElement === last;
        }),
      "design-dense-layer-end",
    )) && (await denseViewport.evaluate((element) => element.scrollTop > 0)),
  );
}
