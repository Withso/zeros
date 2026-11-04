// Shadow-root layers and the Advanced style section, driven with real pointer
// and keyboard input on the production Design workspace renderer (fixture I/O).
// The fixture frame renders its visible content from a declarative shadow
// root, as markup serialized from a web component does, and authors a class
// rule beside a universal reset.

async function waitForScroll(input) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await input.evaluate((element) => element.scrollLeft)) > 0) return true;
    await input.page().waitForTimeout(50);
  }
  return false;
}

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
  const classes = advanced.locator("[data-design-advanced-classes]");
  const classValue = classes.getByLabel("class");
  check(
    "Advanced names the layer's classes in a read-only field",
    (await classValue.inputValue()).includes("card") && (await classValue.getAttribute("readonly")) !== null,
  );
  const restingFill = await classes.evaluate((element) => getComputedStyle(element).backgroundColor);
  await classes.hover();
  check(
    "The read-only class field does not react to the pointer",
    (await classes.evaluate((element) => getComputedStyle(element).backgroundColor)) === restingFill,
  );
  // A long class list stays whole: the field scrolls instead of truncating.
  await page.mouse.wheel(400, 0);
  check(
    "The read-only class field scrolls to reveal its whole value",
    await classValue.evaluate(
      (input) => input.scrollWidth > input.clientWidth,
    ) &&
      (await waitForScroll(classValue)),
  );

  await advanced.getByRole("button", { name: "Add property" }).click();
  const name = advanced.getByLabel("Property name");
  await name.fill("color: red");
  check(
    "Advanced refuses a property name that is not a CSS property",
    await advanced.getByRole("button", { name: "Add declaration" }).isDisabled(),
  );
  await name.fill("colr");
  await advanced.getByLabel("Property value").fill("red");
  check(
    "Advanced refuses a property the browser does not implement",
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
