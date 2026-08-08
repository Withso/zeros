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
  await layersPanel.waitFor({ state: "visible", timeout: 10_000 });
  await designSidebar.waitFor({ state: "visible", timeout: 10_000 });
  const initialLayersBox = await layersPanel.boundingBox();
  const initialSidebarBox = await designSidebar.boundingBox();
  check(
    "design Layers fill a dedicated native sidebar",
    !!initialLayersBox &&
      initialLayersBox.height > 800 &&
      !!initialSidebarBox &&
      initialSidebarBox.width >= 240,
  );
  check(
    "design workspace mounts no coding-agent chat",
    (await page.getByRole("region", { name: "Agent chat preview" }).count()) ===
      0 && (await page.getByLabel("Agent Workspace").count()) === 0,
  );

  await page.getByLabel("Search layers").fill("Layer");
  const layersViewport = layersPanel.locator(
    "[data-radix-scroll-area-viewport]",
  );
  check(
    "long Layers results own vertical scrolling",
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
  await page.getByLabel("Search layers").fill("");

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

  const designSplitter = page.getByRole("separator", {
    name: "Resize design sidebar",
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

  const designCanvas = page.getByRole("region", {
    name: "Design workspace",
    exact: true,
  });
  await designCanvas.waitFor({ state: "visible", timeout: 10_000 });
  const homeFrame = page.locator('[data-design-frame="home.html"]');
  await homeFrame.waitFor({ state: "visible", timeout: 10_000 });
  const homeRuntime = homeFrame.locator("iframe").contentFrame();
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
  const propertySearch = page.getByLabel("Find a style property");
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
    "authored inspector values use a filled 13px proportional control",
    !!appliedInspectorVisual &&
      appliedInspectorVisual.background !== "rgba(0, 0, 0, 0)" &&
      appliedInspectorVisual.borderWidth === "0px" &&
      appliedInspectorVisual.fontSize === "13px" &&
      !appliedInspectorVisual.fontFamily?.toLowerCase().includes("mono"),
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
      (await authoredMarginTop.locator("input").inputValue()) === "0px" &&
      (await authoredMarginTop.evaluate(
        (element) =>
          getComputedStyle(element).backgroundColor !== "rgba(0, 0, 0, 0)",
      )),
  );
  check(
    "an untouched style field shows a neutral dash without a fill",
    (await untouchedPaddingTop.getAttribute("data-design-applied")) === null &&
      (await untouchedPaddingTop.locator("input").inputValue()) === "" &&
      (await untouchedPaddingTop
        .locator("input")
        .getAttribute("placeholder")) === "-" &&
      (await untouchedPaddingTop.evaluate(
        (element) =>
          getComputedStyle(element).backgroundColor === "rgba(0, 0, 0, 0)",
      )),
  );
  const untouchedPaddingInput = untouchedPaddingTop.locator("input");
  await untouchedPaddingInput.fill("12px");
  check(
    "typing into a neutral dash starts a clean style value",
    await waitFor(
      () =>
        homeRuntime
          .locator('[data-oid="home-heading"]')
          .evaluate(
            (element) =>
              element.style.getPropertyValue("padding-top") === "12px",
          )
          .catch(() => false),
      "design-neutral-style-preview",
    ),
  );
  await page.keyboard.press("Escape");
  check(
    "Escape restores a neutral dash without authoring a style",
    await waitFor(
      async () =>
        (await untouchedPaddingInput.inputValue()) === "" &&
        (await homeRuntime
          .locator('[data-oid="home-heading"]')
          .evaluate(
            (element) => element.style.getPropertyValue("padding-top") === "",
          )
          .catch(() => false)),
      "design-neutral-style-cancel",
    ),
  );
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
            field.querySelector("input")?.value === "72px" &&
            getComputedStyle(field).backgroundColor !== "rgba(0, 0, 0, 0)",
        ),
      )),
  );
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
    "13px editor chrome remains horizontally contained",
    await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          "[data-design-workspace-surface] [data-radix-scroll-area-viewport]",
        ),
      ].every((element) => element.scrollWidth === element.clientWidth),
    ),
  );
  await propertySearch.fill("shadow");
  check(
    "property search reveals matching controls without another expand click",
    await page
      .getByText("Box shadow", { exact: true })
      .isVisible()
      .catch(() => false),
  );
  await propertySearch.fill("");
  check(
    "selected elements expose eight direct resize handles",
    (await homeFrame
      .getByRole("button", {
        name: /^Resize Make the next move unmistakable\. from /,
      })
      .count()) === 8,
  );
  check(
    "selected elements expose inline duplicate and delete tools",
    (await homeFrame.getByRole("button", { name: /^Duplicate / }).count()) ===
      1 &&
      (await homeFrame.getByRole("button", { name: /^Delete / }).count()) === 1,
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
  await page.getByRole("tab", { name: "Data" }).click();
  check(
    "inspector remains interactive while the theme editor stays open",
    (await page.getByRole("button", { name: "Export PNG" }).isEnabled()) &&
      (await themeDialog.isVisible()),
  );
  await page.getByRole("tab", { name: "Style" }).click();
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
  const zoomLabel = page.getByRole("button", { name: "Fit all frames" });
  const zoomBeforeThemeInteraction = await zoomLabel.textContent();
  await page.getByRole("button", { name: "Zoom in" }).click();
  check(
    "canvas tooling remains interactive while the theme editor stays open",
    (await waitFor(
      async () =>
        (await zoomLabel.textContent()) !== zoomBeforeThemeInteraction,
      "design-theme-nonmodal-canvas",
    )) && (await themeDialog.isVisible()),
  );
  await page.getByRole("button", { name: "Zoom out" }).click();
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
  await page.getByRole("tab", { name: "Data" }).click();
  check(
    "design inspector exposes PNG export",
    await page.getByRole("button", { name: "Export PNG" }).isEnabled(),
  );
  check(
    "design inspector reuses the pull request affordance",
    (await page
      .getByRole("button", { name: "Open PR #42", exact: true })
      .count()) === 1,
  );
  await page.getByRole("tab", { name: "Style" }).click();

  await page.getByRole("button", { name: "Edit fill" }).click();
  const fillInput = page.getByRole("textbox", { name: "Fill color value" });
  const selectedHeading = homeRuntime.locator('[data-oid="home-heading"]');
  const authoredFill = await selectedHeading.evaluate((element) =>
    element.style.getPropertyValue("background-color"),
  );
  await fillInput.fill("rgb(1, 2, 3)");
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
    "style edits preview immediately inside the live frame runtime",
    stylePreviewApplied,
    `inline=${await selectedHeading.evaluate((element) => element.style.getPropertyValue("background-color"))}`,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  check(
    "Escape clears inspector-only inline style previews",
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
  await page.keyboard.press("Escape");
  check(
    "Escape restores the complete pre-offset inline style",
    await waitFor(
      () =>
        selectedHeading
          .evaluate(
            (element) =>
              element.style.getPropertyValue("position") === "" &&
              element.style.getPropertyValue("left") === "",
          )
          .catch(() => false),
      "design-static-offset-escape",
    ),
  );
  await propertySearch.fill("transform");
  await page.getByRole("button", { name: "Edit transform" }).click();
  const transformInput = page.getByLabel("Transform CSS value");
  await transformInput.press("ControlOrMeta+A");
  await transformInput.press("Backspace");
  await transformInput.pressSequentially("rotate(12deg)");
  check(
    "transform CSS input preserves an in-progress authored expression",
    (await transformInput.inputValue()) === "rotate(12deg)",
  );
  check(
    "transform CSS expressions preview on the selected runtime element",
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
  await page.keyboard.press("Escape");
  check(
    "Escape cancels transform text without persisting the draft",
    await waitFor(
      () =>
        selectedHeading
          .evaluate(
            (element) => element.style.getPropertyValue("transform") === "",
          )
          .catch(() => false),
      "design-transform-escape",
    ),
  );
  await propertySearch.fill("");
  check(
    "design advisories are compact and explicitly non-blocking",
    (await page
      .getByText("Review 1 rule · non-blocking", { exact: true })
      .count()) === 1,
  );

  await page.getByRole("button", { name: "Toggle motion timeline" }).click();
  const motionTimeline = page.getByRole("region", { name: "Motion timeline" });
  check(
    "motion opens as a persistent canvas timeline",
    await motionTimeline.isVisible(),
  );
  check(
    "motion timeline exposes draggable property keyframes",
    (await motionTimeline
      .getByRole("button", { name: /opacity keyframe at/ })
      .count()) === 2 &&
      (await motionTimeline.getByLabel("Animation duration").inputValue()) ===
        "300ms",
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
    "motion tracks remain unboxed at rest",
    motionTrackVisual?.background === "rgba(0, 0, 0, 0)" &&
      motionTrackVisual.borderBottomWidth === "0px",
  );
  await motionTimeline
    .getByRole("button", { name: "Close motion timeline" })
    .click();

  await page.getByRole("button", { name: "Text tool" }).click();
  const inlineText = page.getByLabel(/^Edit text for /);
  check(
    "text tool opens inline editor",
    await waitFor(
      () => inlineText.isVisible().catch(() => false),
      "design-inline-text-ready",
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
    "escaping inline text returns to the Select tool",
    (await page
      .getByRole("button", { name: "Select" })
      .getAttribute("aria-pressed")) === "true" &&
      (await page
        .getByRole("button", { name: "Text tool" })
        .getAttribute("aria-pressed")) === "false",
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
  check(
    "double-click descends one nested canvas level",
    await waitFor(
      () =>
        selectedLayer("home-heading")
          .isVisible()
          .catch(() => false),
      "design-canvas-double-click-descend",
    ),
  );
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
  await page
    .getByRole("textbox", { name: "Fill color value" })
    .fill("rgb(4, 5, 6)");
  check(
    "style previews apply to every selected layer",
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
  await page.keyboard.press("Escape");
  check(
    "Escape restores every layer in a group preview",
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
  check(
    "Option reveals exact nearest-layer distance feedback",
    await waitFor(
      async () =>
        (await homeFrame.locator("[data-design-spacing]").count()) > 0,
      "design-option-measurements",
    ),
  );
  await page.keyboard.up("Alt");

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
  await propertySearch.fill("transform");
  await page
    .getByRole("button", { name: "Edit transform" })
    .waitFor({ state: "visible" });
  const rotateHandle = homeFrame.getByRole("button", {
    name: "Rotate Make the next move unmistakable.",
  });
  const rotateBox = await rotateHandle.boundingBox();
  if (!rotateBox) throw new Error("rotation handle has no geometry");
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
    "rotation handle previews authored transforms on canvas",
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
    "cancelled rotation restores the authored transform",
    await waitFor(
      () =>
        selectedHeading
          .evaluate(
            (element, baseline) =>
              element.style.getPropertyValue("transform") === baseline,
            authoredTransform,
          )
          .catch(() => false),
      "design-rotation-cancel",
    ),
  );
  await propertySearch.fill("");

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

  // Frame-level actions intentionally appear only when the frame itself is
  // selected. Selecting its canvas label mirrors the production workflow and
  // keeps this check independent from how many nested levels Escape must climb.
  await homeFrame.getByRole("button", { name: /^Launch home/ }).click();
  const deleteFrameTrigger = page.getByRole("button", {
    name: "Delete frame",
  });
  await deleteFrameTrigger.click();
  const deleteFrameDialog = page.getByRole("dialog", {
    name: "Delete Launch home?",
  });
  check(
    "frame delete requires confirmation",
    await waitFor(
      () => deleteFrameDialog.isVisible().catch(() => false),
      "design-delete-dialog",
    ),
  );
  await waitFor(
    () =>
      page.evaluate(
        () => document.activeElement?.textContent?.trim() === "Cancel",
      ),
    "design-delete-cancel-focus",
  );
  await page.keyboard.press("Escape");
  check(
    "Escape closes frame delete confirmation",
    await waitFor(
      async () => !(await deleteFrameDialog.isVisible().catch(() => false)),
      "design-delete-escape",
    ),
  );
  check(
    "frame delete dialog returns focus",
    await waitFor(
      () =>
        page.evaluate(
          () =>
            document.activeElement?.getAttribute("aria-label") ===
            "Delete frame",
        ),
      "design-delete-focus-return",
    ),
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
  check(
    "dense Layers reports the complete 10k-node document",
    await waitFor(async () => {
      const text = await denseLayersPanel
        .locator('[aria-label$=" layers"]')
        .first()
        .getAttribute("aria-label");
      return Number.parseInt(text ?? "0", 10) > 10_000;
    }, "design-dense-layer-count"),
  );
  const denseTree = denseLayersPanel.getByRole("tree");
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
    "virtualized Layers preserves End-key travel to the final authored row",
    (await waitFor(
      () =>
        page.evaluate((firstLayerId) => {
          const row = document.activeElement;
          return (
            row instanceof HTMLElement &&
            row.hasAttribute("data-design-layer-id") &&
            row.dataset.designLayerId !== firstLayerId &&
            row.closest('[role="tree"]') !== null
          );
        }, firstDenseLayerId),
      "design-dense-layer-end",
    )) && (await denseViewport.evaluate((element) => element.scrollTop > 0)),
  );
}
