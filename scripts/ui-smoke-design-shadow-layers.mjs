// Shadow-root layers and the Advanced style section, driven with real pointer
// and keyboard input on the production Design workspace renderer (fixture I/O).
// The fixture frame renders its visible content from a declarative shadow
// root, as markup serialized from a web component does, and authors a class
// rule beside a universal reset.

export async function runDesignShadowLayersSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?shadowContent`,
    { waitUntil: "networkidle" },
  );
  const layers = page.locator("[data-design-sidebar-panel]");
  const frameRow = layers.locator('[data-design-frame-row="home.html"]');
  await frameRow.waitFor({ state: "visible", timeout: 20_000 });
  if ((await frameRow.getAttribute("aria-expanded")) !== "true")
    await frameRow.locator("[data-layer-disclosure]").first().click();
  for (const oid of ["home-card", "home-diff", "home-diff-pre"]) {
    const row = layers.locator(`[data-design-layer-row="${oid}"]`);
    await row.waitFor({ state: "visible", timeout: 15_000 });
    await row.locator("[data-layer-disclosure]").first().click();
  }
  const line = layers.locator('[data-design-layer-row="home-diff-line"]');
  await line.waitFor({ state: "visible", timeout: 15_000 });
  check(
    "Layers list the content a declarative shadow root renders",
    (await line.textContent())?.includes("const value = 1;") === true,
  );

  const inspector = page.locator("[data-design-inspector]");
  await layers.locator('[data-design-layer-row="home-diff-pre"]').click();
  const fill = inspector
    .locator("section", { has: page.locator("h3", { hasText: /^Fill$/ }) })
    .first()
    .locator("input")
    .first();
  await fill.waitFor({ state: "visible", timeout: 15_000 });
  check(
    "the inspector reads a shadow layer's own text fill",
    (await fill.inputValue()) === "DCDCDC",
  );

  await layers.locator('[data-design-layer-row="home-card"]').click();
  const advanced = inspector.locator("[data-design-advanced-section]");
  await advanced
    .locator('[data-design-advanced-property="cursor"]')
    .waitFor({ state: "visible", timeout: 15_000 });
  const rows = await advanced
    .locator("[data-design-advanced-property]")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-design-advanced-property")),
    );
  check(
    "Advanced lists authored properties without dedicated controls and hides shared resets",
    JSON.stringify(rows) === JSON.stringify(["cursor", "user-select", "--card-gap"]),
  );
  check(
    "Advanced names the layer's classes",
    (await advanced.locator("[data-design-advanced-classes]").textContent())?.includes("card") === true,
  );

  await advanced.getByRole("button", { name: "Add property" }).click();
  const name = advanced.getByLabel("Property name");
  await name.fill("color: red");
  check(
    "Advanced refuses a property name that is not a CSS property",
    await advanced.getByRole("button", { name: "Add declaration" }).isDisabled(),
  );
  await name.fill("z-index");
  await advanced.getByLabel("Property value").fill("3");
  check(
    "Advanced enables a named property with a value",
    !(await advanced.getByRole("button", { name: "Add declaration" }).isDisabled()),
  );
  await name.press("Escape");
  check(
    "Escape discards the new property row",
    (await advanced.getByLabel("Property name").count()) === 0,
  );
}
