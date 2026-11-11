// The inspector names the tokens a frame's styles read and where they are
// declared: an imported style source ("App styles") or tokens.css ("Manual").
// A token shows as a pill; the panel's hover card says where it comes from.
// The real frame runtime resolves the winning declarations in Chromium.
const pill = (page, property) =>
  page.locator(
    `[data-design-inspector] [data-design-style-property="${property}"] [data-design-style-token]`,
  ).first();
const hoverText = async (page, locator) => {
  await locator.hover();
  const card = page.locator("[data-design-style-card]");
  await card.waitFor({ timeout: 5_000 });
  const text = (await card.textContent()) ?? "";
  await page.mouse.move(1, 1);
  await card.waitFor({ state: "detached", timeout: 5_000 });
  return text;
};

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
  const fillPill = pill(page, "background-color");
  await fillPill.waitFor({ timeout: 10_000 });
  const title = await hoverText(page, fillPill);
  check(
    "Fill names the token as a pill, and its hover the source that declares it",
    (await fillPill.getAttribute("data-design-style-token")) === "--primary-button-bg" &&
      (await fillPill.getAttribute("aria-label")) === "Fill: token primary-button-bg" &&
      ((await fillPill.textContent()) ?? "").trim() === "primary-button-bg" &&
      title.includes("primary-button-bg") &&
      title.includes("App styles") &&
      title.includes("darkslategray"),
    title,
  );
  const fill = page.locator(
    '[data-design-inspector] [data-design-style-property="background-color"] input[aria-label="Fill"]',
  );
  await fillPill.focus();
  await page.keyboard.press("1");
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") === "Fill" &&
      document.activeElement.tagName === "INPUT",
  );
  check(
    "a key typed on the Fill pill starts a plain colour in its field",
    (await fill.inputValue()) === "1",
    await fill.inputValue(),
  );
  await fill.press("Escape");
  await fillPill.waitFor({ timeout: 5_000 });

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

  // A field holding a token offers Detach token on hover, which writes the
  // value the token resolves to as a plain value.
  const fillField = page.locator(
    '[data-design-inspector] [data-design-style-property="background-color"]',
  );
  await fillPill.waitFor({ timeout: 5_000 });
  await fillField.hover();
  await fillField
    .getByRole("button", { name: "Detach token", exact: true })
    .click();
  await page.waitForFunction(
    () => {
      const input = document.querySelector(
        '[data-design-inspector] [data-design-style-property="background-color"] input[aria-label="Fill"]',
      );
      return input && /^2F4F4F$/i.test(input.value);
    },
    undefined,
    { timeout: 10_000 },
  );
  check(
    "Detach token keeps the colour and drops the token",
    (await fillField.getByRole("button", { name: "Detach token", exact: true }).count()) === 0 &&
      (await fillField.locator("[data-design-style-token]").count()) === 0,
  );

  await select("home-heading");
  const text = pill(page, "color");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-design-inspector] [data-design-style-property="color"] [data-design-style-token]')
        ?.getAttribute("data-design-style-token") === "--brand",
    undefined,
    { timeout: 10_000 },
  );
  const textHover = await hoverText(page, text);
  check(
    "a text color read from tokens.css names the Manual source",
    ((await text.textContent()) ?? "").trim() === "brand" && textHover.includes("Manual"),
    textHover,
  );

  // A number field detaches the same way: the resolved length, as a plain value.
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?designTokens&numberToken`,
    { waitUntil: "networkidle" },
  );
  await page
    .locator(
      '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
    )
    .first()
    .waitFor({ timeout: 10_000 });
  await select("home-heading");
  const tracking = page.locator(
    '[data-design-inspector] [data-design-style-property="letter-spacing"]',
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-design-inspector] [data-design-style-property="letter-spacing"] [data-design-style-token]')
        ?.getAttribute("data-design-style-token") === "--tracking",
    undefined,
    { timeout: 10_000 },
  );
  await tracking.hover();
  await tracking.getByRole("button", { name: "Detach token", exact: true }).click();
  await page.waitForFunction(
    () => {
      const input = document.querySelector(
        '[data-design-inspector] [data-design-style-property="letter-spacing"] input',
      );
      return input && /^-1(px)?$/.test(input.value);
    },
    undefined,
    { timeout: 10_000 },
  );
  check(
    "a number field bound to a token detaches to the length it resolves to",
    (await tracking.getByRole("button", { name: "Detach token", exact: true }).count()) === 0 &&
      (await tracking.locator("[data-design-style-token]").count()) === 0,
    await tracking.locator("input").first().inputValue(),
  );
}
