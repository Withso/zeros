import {
  designLayoutMenuRows,
  designLayoutMenuState,
  openLayersDrawer,
} from "./ui-smoke-design-helpers.mjs";
// Container controls exercise the real inspector and runtime against an
// in-memory document. No engine-owned Design files are edited by this fixture.
export async function runDesignLayoutChildrenSmoke({ page, waitFor, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );
  await openLayersDrawer(page);
  const layers = page.locator("[data-design-sidebar-panel]");
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
  const position = page.locator("[data-design-position-section]");
  const menu = layout.getByRole("button", { name: "More layout actions" });
  const menuItem = (name) => page.getByRole("menuitem", { name, exact: true });
  const menuRows = () => designLayoutMenuRows(page);
  const menuState = (name) => designLayoutMenuState(page, name);
  check(
    "the layout menu exposes child alignment, distribution and resize commands",
    await waitFor(
      async () =>
        (await menuRows()).map(([text]) => text).join("|") ===
      [
        "Align children left",
        "Align children horizontal centers",
        "Align children right",
        "Align children top",
        "Align children vertical centers",
        "Align children bottom",
        "Distribute vertically",
        "Distribute horizontally",
        "Resize to fit",
        "Resize to fill",
      ].join("|"),
      "children-menu-rows",
    ),
  );
  await menu.click();
  await page.getByRole("menu").waitFor();
  await page.keyboard.press("Escape");
  // Radix restores trigger focus on the task after the menu unmounts, so an
  // immediate activeElement sample races that handoff.
  check(
    "Escape closes the layout menu and restores its trigger focus",
    await waitFor(
      () =>
        menu.evaluate(
          (button) =>
            document.activeElement === button &&
            button.getAttribute("aria-expanded") === "false",
        ),
      "children-menu-escape-focus",
    ),
  );
  const choose = async (name) => {
    await menu.click();
    await commit(() => menuItem(name).click());
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
  // Constraints belong to the layers they pin: selecting the children
  // together sets them all at once.
  await layers.locator('[data-design-layer-id="home-heading"]').click();
  for (const id of ["home-copy", "home-action"]) {
    await layers
      .locator(`[data-design-layer-id="${id}"]`)
      .click({ modifiers: ["Shift"] });
  }
  const horizontal = position.getByRole("combobox", {
    name: "Horizontal constraint",
  });
  await hero.evaluate((element) =>
    element.children[0].style.setProperty("--zeros-layout-x", "end"),
  );
  check(
    "different pins across the selected children appear as Mixed",
    await waitFor(
      async () => (await horizontal.textContent()).includes("Mixed"),
      "children-mixed-pins",
    ),
  );
  await horizontal.click();
  await commit(() =>
    page.getByRole("option", { name: "Right", exact: true }).click(),
  );
  check(
    "a constraint choice updates every selected child and the aggregate readback",
    await waitFor(
      async () =>
        (await hero.evaluate((element) =>
          [...element.children]
            .slice(0, 3)
            .every(
              (child) =>
                child.style.getPropertyValue("--zeros-layout-x") === "end",
            ),
        )) && (await horizontal.textContent()).trim() === "Right",
      "children-pin-readback",
    ),
  );
  await horizontal.click();
  await commit(() =>
    page.getByRole("option", { name: "Left and right", exact: true }).click(),
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
  await waitFor(
    async () => (await menuState("Distribute horizontally")) === "disabled",
    "children-distribute-minimum",
  );
  check(
    "one visible child retains alignment but cannot distribute",
    (await menuState("Align children right")) === "enabled",
  );
  await choose("Align children right");
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
    "all-hidden children keep their actions listed with the unavailable ones disabled",
    await waitFor(
      async () => (await menuState("Align children left")) === "disabled",
      "children-hidden-controls",
    ),
  );
  await hero.evaluate((element) => {
    element.__layoutChildren = [...element.children];
    element.replaceChildren();
  });
  check(
    "removing the last child takes the children's actions out of the menu without reselection",
    await waitFor(
      async () =>
        (await menuState("Align children left")) === "absent" &&
        (await menuState("Resize to fit")) === "absent",
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
    "adding children restores their actions without reselection",
    await waitFor(
      async () => (await menuState("Align children left")) === "enabled",
      "children-restored",
    ),
  );
  for (const width of [220, 280, 420]) {
    await page
      .locator("[data-design-canvas-area]")
      .evaluate((element, width) => {
        element.style.setProperty("--zeros-design-style-width", `${width}px`);
      }, width);
    check(
      `Position and Layout fit a ${width}px inspector`,
      (await layout.evaluate(
        (element, expectedWidth) =>
          element.scrollWidth <= element.clientWidth &&
          Math.abs(element.closest("[data-design-floating-panel]").getBoundingClientRect().width - expectedWidth) < 1,
        width,
      )) &&
        (await position.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        )),
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
