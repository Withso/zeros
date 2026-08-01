// Design-workspace portion of the real-browser interaction contract. Keeping
// it beside (rather than embedded in) ui-smoke-composer lets the design surface
// grow independently from the coding-agent/GitHub smoke path.

export async function runDesignWorkspaceSmoke({ page, waitFor, check }) {
  // The harness uses a sandboxed runtime and production Radix primitives;
  // bridge-backed writes are covered by the engine suites.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${new URL(page.url()).origin}/harness-design-workspace.html`,
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
      initialSidebarBox.width >= 320,
  );
  check(
    "design workspace mounts no coding-agent chat",
    (await page.getByRole("region", { name: "Agent chat preview" }).count()) ===
      0 &&
      (await page.getByLabel("Agent Workspace").count()) === 0,
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
    "compact design keeps the 42/58 sidebar-canvas split usable",
    !!compactSidebarBox &&
      compactSidebarBox.width >= 290 &&
      !!compactCanvasBox &&
      compactCanvasBox.width >= 400,
  );
  await page.setViewportSize({ width: 1440, height: 900 });

  const designCanvas = page.getByRole("region", {
    name: "Design workspace",
    exact: true,
  });
  await designCanvas.waitFor({ state: "visible", timeout: 10_000 });
  const homeFrame = page.locator('[data-design-frame="home.html"]');
  await homeFrame.waitFor({ state: "visible", timeout: 10_000 });
  check(
    "design inspector exposes editable fill",
    await page
      .getByLabel("Fill")
      .isEditable()
      .catch(() => false),
  );
  check(
    "design inspector exposes typography controls",
    (await page.getByText("Typography", { exact: true }).count()) === 1,
  );
  check(
    "design inspector exposes the token themes table",
    (await page.getByText("Themes", { exact: true }).count()) === 1 &&
      (await page.getByLabel("Base").count()) === 1,
  );
  check(
    "design inspector exposes PNG export",
    await page
      .getByRole("button", { name: "Export PNG" })
      .isEnabled()
      .catch(() => false),
  );
  check(
    "design inspector reuses the pull request affordance",
    (await page
      .getByRole("button", { name: "Open PR #42", exact: true })
      .count()) === 1,
  );
  check(
    "design advisories are grouped and explicitly non-blocking",
    (await page.getByText("Review 1 rule", { exact: true }).count()) === 1 &&
      (await page.getByText(/95 non-blocking design findings/).count()) === 1 &&
      (await page.getByText(/Spacing scale · 95 findings/).count()) === 1,
  );

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

  const codeToggle = page.getByRole("button", { name: "Toggle frame source" });
  await codeToggle.click();
  check(
    "code tool opens authored frame source",
    await page.getByText("Zeros Design/home.html").isVisible(),
  );
  await codeToggle.click();

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
}
