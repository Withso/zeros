// The inspector names the tokens a frame's styles read and where they are
// declared: an imported style source ("App styles") or tokens.css ("Manual").
// The real frame runtime resolves the winning declarations in Chromium.
export async function runDesignStyleTokensSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?designTokens`,
    { waitUntil: "networkidle" },
  );
  await page
    .locator(
      '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
    )
    .first()
    .waitFor({ timeout: 10_000 });
  const select = (nodeId) =>
    page.evaluate(async (nodeId) => {
      const { selectDesignNode } = await import(
        "/apps/desktop/src/renderer/features/design-workspace/state/design-selection.ts"
      );
      const { designWorkspaceSnapshotCache } = await import(
        "/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts"
      );
      const workspaceId = "ws_design_harness";
      const snapshot = designWorkspaceSnapshotCache.getSnapshot(workspaceId).data;
      await selectDesignNode({
        workspaceId,
        folder: snapshot.lint.workspacePath,
        frame: snapshot.frames.find((item) => item.file === "home.html"),
        nodeId,
      });
    }, nodeId);

  await select("home-cta");
  const fill = page.locator(
    '[data-design-inspector] [data-design-style-property="background-color"] input[aria-label="Fill"]',
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector(
          '[data-design-inspector] [data-design-style-property="background-color"] input[aria-label="Fill"]',
        )
        ?.getAttribute("data-design-style-token") === "--primary-button-bg",
    undefined,
    { timeout: 10_000 },
  );
  const title = (await fill.getAttribute("title")) ?? "";
  check(
    "Fill names the token and the source that declares it",
    (await fill.inputValue()) === "primary-button-bg" &&
      title.includes("--primary-button-bg") &&
      title.includes("App styles") &&
      title.includes("darkslategray"),
    title,
  );
  await fill.focus();
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") === "Fill" &&
      !document.activeElement.hasAttribute("data-design-style-token"),
  );
  check(
    "focusing the Fill edits its color value as before",
    /^[0-9A-F]{6}$/i.test(await fill.inputValue()),
    await fill.inputValue(),
  );
  await fill.press("Escape");
  await page.waitForFunction(
    () =>
      document
        .querySelector(
          '[data-design-inspector] [data-design-style-property="background-color"] input[aria-label="Fill"]',
        )
        ?.getAttribute("data-design-style-token") === "--primary-button-bg",
  );

  await page.getByRole("button", { name: "CSS", exact: true }).click();
  const editor = page.locator('.cm-content[aria-label="Computed CSS declarations"]');
  await editor.waitFor({ timeout: 5_000 });
  const declarations = await editor.innerText();
  const hint = await page
    .locator(".cm-line[data-design-css-hint]")
    .filter({ hasText: "background-color" })
    .first()
    .getAttribute("data-design-css-hint");
  check(
    "the CSS panel shows the declaration as written, with computed value and source as detail",
    declarations.includes("background-color: var(--primary-button-bg);") &&
      hint === "rgb(47, 79, 79) · App styles" &&
      !declarations.includes("App styles"),
    `${declarations} | ${hint}`,
  );
  await page.getByRole("button", { name: "Style", exact: true }).click();

  await select("home-heading");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-design-inspector] [data-design-style-property="color"] input[data-design-style-token]')
        ?.getAttribute("data-design-style-token") === "--brand",
    undefined,
    { timeout: 10_000 },
  );
  const text = page
    .locator('[data-design-inspector] [data-design-style-property="color"] input[data-design-style-token]')
    .first();
  check(
    "a text color read from tokens.css names the Manual source",
    (await text.inputValue()) === "brand" &&
      ((await text.getAttribute("title")) ?? "").includes("Manual"),
    (await text.getAttribute("title")) ?? "",
  );
}
