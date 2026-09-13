// Container controls exercise the real inspector and runtime against an
// in-memory document. No engine-owned Design files are edited by this fixture.
export async function runDesignLayoutChildrenSmoke({ page, waitFor, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );
  const layers = page.locator("#design-layers-panel");
  const layout = page.locator("[data-design-layout-section]");
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const hero = runtime.locator('[data-oid="home-hero"]');
  const selectHero = () =>
    layers.locator('[data-design-layer-id="home-hero"]').click();
  const commit = async (action) => {
    const before = await hero.evaluate(
      (element) => element.ownerDocument.defaultView.__zerosDesignSourceVersion,
    );
    await action();
    // A preview is deliberately painted before persistence. Subsequent direct
    // fixture edits must wait for the transaction, just as real editor writes
    // do in the workspace mutation lane.
    await waitFor(
      () =>
        hero.evaluate(
          (element, before) =>
            element.ownerDocument.defaultView.__zerosDesignSourceVersion !==
            before,
          before,
        ),
      "children-committed-generation",
    );
  };
  const reset = async () => {
    await hero.evaluate((element) => {
      element.parentElement.style.cssText =
        "position:relative;display:block;box-sizing:border-box;width:500px;height:600px;min-width:0;min-height:0;max-width:none;max-height:none;padding:0;border:0";
      element.style.cssText =
        "position:relative;display:block;box-sizing:border-box;width:400px;height:300px;padding:0;border:0";
      [...element.children].slice(0, 3).forEach((child, index) => {
        child.style.cssText = `position:absolute;left:${[10, 100, 300][index]}px;top:${[10, 100, 220][index]}px;width:${[40, 60, 80][index]}px;height:${[20, 40, 60][index]}px;min-width:0;min-height:0;max-width:none;max-height:none;box-sizing:border-box;display:block;padding:0;margin:0;border:0;font-size:10px`;
      });
    });
    await selectHero();
  };
  await reset();
  const menu = layout.getByRole("button", { name: "More layout actions" });
  await menu.click();
  check(
    "the child layout menu exposes distribution and resize commands",
    (await page.getByRole("menuitem").allTextContents())
      .map((text) => text.trim())
      .join("|") ===
      "Distribute vertically|Distribute horizontally|Resize to fill|Resize to fit",
  );
  await page.keyboard.press("Escape");
  check(
    "Escape closes the layout menu and restores its trigger focus",
    await menu.evaluate((button) => document.activeElement === button),
  );
  const choose = async (name) => {
    await menu.click();
    await commit(() =>
      page.getByRole("menuitem", { name, exact: true }).click(),
    );
  };
  await choose("Distribute horizontally");
  check(
    "horizontal distribution uses equal gaps and preserves the container",
    await waitFor(
      () =>
        hero.evaluate(
          (element) =>
            element.children[1].style.left === "145px" &&
            element.style.width === "400px",
        ),
      "children-distribute-x",
    ),
  );
  await choose("Distribute vertically");
  check(
    "vertical distribution preserves outer edges and child sizes",
    await waitFor(
      () =>
        hero.evaluate(
          (element) =>
            element.children[1].style.top === "105px" &&
            element.children[2].style.top === "220px" &&
            element.children[0].style.height === "20px",
        ),
      "children-distribute-y",
    ),
  );
  await hero.evaluate((element) =>
    element.children[0].style.setProperty("--zeros-layout-x", "end"),
  );
  check(
    "different child pins appear as Mixed on the selected container",
    await waitFor(
      async () =>
        (
          await layout
            .getByRole("combobox", { name: "Horizontal constraint" })
            .textContent()
        ).includes("Mixed"),
      "children-mixed-pins",
    ),
  );
  await layout.getByRole("combobox", { name: "Horizontal constraint" }).click();
  await commit(() =>
    page.getByRole("option", { name: "Right", exact: true }).click(),
  );
  check(
    "a constraint choice updates every direct child and the aggregate readback",
    await waitFor(
      async () =>
        (await hero.evaluate((element) =>
          [...element.children]
            .slice(0, 3)
            .every(
              (child) =>
                child.style.getPropertyValue("--zeros-layout-x") === "end",
            ),
        )) &&
        (
          await layout
            .getByRole("combobox", { name: "Horizontal constraint" })
            .textContent()
        ).trim() === "Right",
      "children-pin-readback",
    ),
  );
  await commit(() =>
    layout
      .getByRole("button", { name: "Pin left", exact: true })
      .click({ modifiers: ["Shift"] }),
  );
  await waitFor(
    () =>
      hero.evaluate((element) =>
        [...element.children]
          .slice(0, 3)
          .every(
            (child) =>
              child.style.getPropertyValue("--zeros-layout-x") === "stretch",
          ),
      ),
    "children-paired-pins",
  );
  await hero.evaluate((element) => {
    element.style.width = "500px";
  });
  check(
    "paired pins stretch all children with a parent resize",
    await waitFor(
      () =>
        hero.evaluate(
          (element) =>
            element.children[0].offsetWidth === 140 &&
            element.children[1].offsetWidth === 160 &&
            element.children[2].offsetWidth === 180,
        ),
      "children-stretch-resize",
    ),
  );
  await reset();
  await choose("Resize to fit");
  check(
    "Resize to fit wraps child extents without moving their untransformed positions",
    await waitFor(
      () =>
        hero.evaluate(
          (element) =>
            element.offsetWidth === 380 &&
            element.offsetHeight === 280 &&
            element.children[0].offsetLeft === 10 &&
            element.children[2].offsetLeft === 300,
        ),
      "children-fit",
    ),
  );
  await choose("Resize to fill");
  check(
    "Resize to fill makes a nested frame follow its containing frame",
    await waitFor(
      () =>
        hero.evaluate(
          (element) =>
            element.offsetWidth === 500 &&
            element.offsetHeight === 600 &&
            element.offsetLeft === 0 &&
            element.offsetTop === 0,
        ),
      "children-fill",
    ),
  );
  await hero.evaluate((element) => {
    element.parentElement.style.width = "620px";
  });
  check(
    "a filled frame remains responsive after its parent changes size",
    await waitFor(
      () => hero.evaluate((element) => element.offsetWidth === 620),
      "children-fill-responsive",
    ),
  );
  await reset();
  await hero.evaluate((element) => {
    element.children[1].style.display = "none";
    element.children[2].style.display = "none";
  });
  await waitFor(async () => {
    await menu.click();
    const disabled = await page
      .getByRole("menuitem", { name: "Distribute horizontally", exact: true })
      .getAttribute("aria-disabled");
    await page.keyboard.press("Escape");
    return disabled === "true";
  }, "children-distribute-minimum");
  check(
    "one visible child retains alignment and constraints but cannot distribute",
    await layout
      .getByRole("button", { name: "Align right", exact: true })
      .isEnabled(),
  );
  await commit(() =>
    layout.getByRole("button", { name: "Align right", exact: true }).click(),
  );
  check(
    "alignment leaves hidden children untouched",
    await waitFor(
      () =>
        hero.evaluate(
          (element) =>
            element.children[0].style.left === "360px" &&
            element.children[1].style.left === "100px" &&
            element.children[2].style.left === "300px",
        ),
      "children-hidden-untouched",
    ),
  );
  await hero.evaluate((element) => {
    element.children[0].style.display = "none";
  });
  check(
    "all-hidden children keep their controls visible with unavailable actions disabled",
    await waitFor(
      async () =>
        (await layout
          .getByRole("button", { name: "Pin right", exact: true })
          .count()) === 1 &&
        (await layout
          .getByRole("button", { name: "Align left", exact: true })
          .isDisabled()),
      "children-hidden-controls",
    ),
  );
  await hero.evaluate((element) => {
    element.__layoutChildren = [...element.children];
    element.replaceChildren();
  });
  check(
    "removing the last child hides both groups without reselection",
    await waitFor(
      async () =>
        (await layout
          .getByRole("group", { name: "Arrange children" })
          .count()) === 0 &&
        (await layout.locator("[data-design-layout-constraints]").count()) ===
          0,
      "children-removed",
    ),
  );
  await hero.evaluate((element) => {
    element.replaceChildren(...element.__layoutChildren);
    [...element.children].slice(0, 3).forEach((child) => {
      child.style.display = "block";
    });
  });
  check(
    "adding children restores both groups without reselection",
    await waitFor(
      async () =>
        (await layout
          .getByRole("button", { name: "Pin right", exact: true })
          .count()) === 1 &&
        (await layout
          .getByRole("button", { name: "Align left", exact: true })
          .isEnabled()),
      "children-restored",
    ),
  );
  for (const width of [220, 280, 420]) {
    await page.locator("[data-design-inspector]").evaluate((element, width) => {
      element.style.setProperty("--zeros-design-style-width", `${width}px`);
    }, width);
    check(
      `child controls fit a ${width}px inspector`,
      await layout.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    );
  }
  await page
    .locator('[data-design-frame="home.html"] [data-design-frame-label]')
    .click();
  await menu.click();
  check(
    "a top-level frame offers fit and disables fill into the infinite canvas",
    (await page
      .getByRole("menuitem", { name: "Resize to fit", exact: true })
      .isEnabled()) &&
      (await page
        .getByRole("menuitem", { name: "Resize to fill", exact: true })
        .getAttribute("aria-disabled")) === "true",
  );
  await page
    .getByRole("menuitem", { name: "Resize to fit", exact: true })
    .click();
  check(
    "fitting a canvas frame commits its viewport dimensions alongside its content",
    await waitFor(async () => {
      const size = await runtime
        .locator('[data-oid="home-main"]')
        .evaluate((element) => ({
          width: element.offsetWidth,
          height: element.offsetHeight,
        }));
      return (
        Number(await layout.getByLabel("W", { exact: true }).inputValue()) ===
          size.width &&
        Number(await layout.getByLabel("H", { exact: true }).inputValue()) ===
          size.height
      );
    }, "children-fit-viewport"),
  );
}
