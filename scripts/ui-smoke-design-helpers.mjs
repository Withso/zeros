export async function designFrameElementBox(iframe, element) {
  // Playwright's cross-frame boundingBox applies iframe CSS zoom twice. Map
  // the authored viewport into the actual outer rectangle, including the
  // canvas transform and the document's inverse density transform.
  const local = await element.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    };
  });
  const outer = await iframe.evaluate((node) =>
    node.getBoundingClientRect().toJSON(),
  );
  if (
    !local.viewportWidth ||
    !local.viewportHeight ||
    !outer.width ||
    !outer.height
  )
    throw new Error("The Design document has no painted viewport.");
  return {
    x: outer.x + local.x * outer.width / local.viewportWidth,
    y: outer.y + local.y * outer.height / local.viewportHeight,
    width: local.width * outer.width / local.viewportWidth,
    height: local.height * outer.height / local.viewportHeight,
  };
}

// Canvas coordinates must exclude floating chrome even though it shares the
// viewport's rectangle. Never fall back to a point that hits a control.
export async function designCanvasPoint(
  page,
  { selector, empty = false } = {},
) {
  const point = await page.evaluate(
    ({ selector, empty }) => {
      const canvas = document.querySelector("[data-design-canvas-viewport]");
      const bounds = canvas.getBoundingClientRect();
      const targetBounds = selector
        ? document.querySelector(selector)?.getBoundingClientRect()
        : bounds;
      if (!targetBounds) return null;
      const left = Math.max(bounds.left, targetBounds.left) + 12;
      const right = Math.min(bounds.right, targetBounds.right) - 12;
      const top = Math.max(bounds.top, targetBounds.top) + 12;
      const bottom = Math.min(bounds.bottom, targetBounds.bottom) - 12;
      if (right <= left || bottom <= top) return null;
      for (const fy of [0.5, 1, 0, 0.25, 0.75]) {
        for (const fx of [0.5, 0, 1, 0.25, 0.75]) {
          const x = left + (right - left) * fx;
          const y = top + (bottom - top) * fy;
          const hit = document.elementFromPoint(x, y);
          if (
            hit &&
            canvas.contains(hit) &&
            !hit.closest(
              "[data-design-controls], [data-design-motion-timeline]",
            ) &&
            (!empty || !hit.closest("[data-design-frame]")) &&
            (!selector || hit.closest(selector))
          )
            return { x, y };
        }
      }
      return null;
    },
    { selector, empty },
  );
  if (!point)
    throw new Error(
      `No unobscured ${empty ? "empty " : ""}canvas point${selector ? ` in ${selector}` : ""}`,
    );
  return point;
}

export async function designCanvasSafeRect(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("[data-design-canvas-viewport]");
    const surface = canvas.closest("[data-design-workspace-surface]");
    const bounds = canvas.getBoundingClientRect();
    const visible = (selector) => {
      const element = surface.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      return rect?.width && rect.height ? rect : null;
    };
    return {
      left: visible('[aria-label="Canvas tools"]')?.right ?? bounds.left,
      top: visible("[data-design-directory-header]")?.bottom ?? bounds.top,
      right: visible("[data-design-floating-panel]")?.left ?? bounds.right,
      bottom: visible("[data-design-motion-timeline]")?.top ?? bounds.bottom,
    };
  });
}

/** Adds a Style section's first value. An empty section is one row with its
 * own plus (Stroke, Shadow, Blur, Transition, Motion, More styles), which
 * runs the section's add: Shadow adds a drop shadow, Blur a layer blur.
 * Typography on a non-text layer and Transform draw nothing while unused and
 * are added from the Add property menu (Transform opens its editor). */
export async function addDesignSection(page, title) {
  if (title === "Typography" || title === "Transform") {
    await page
      .locator("[data-design-add-property]")
      .getByRole("button", { name: "Add property", exact: true })
      .click();
    await page.getByRole("menuitem", { name: title, exact: true }).click();
    return;
  }
  const section = page
    .locator("[data-design-inspector] section.zd-section")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await section
    .locator(".zd-section-header")
    .getByRole("button", { name: /^Add / })
    .click();
}

/** The Layers tree is a drawer at the foot of the Style panel, closed by
 * default. Opens it (when it is not open already) and waits for the tree.
 * The click is dispatched on the element so neither the pointer nor focus
 * moves: smokes that open the drawer as setup still assert on both. */
export async function openLayersDrawer(page) {
  const fold = page.locator("[data-design-layers-fold]:visible").first();
  await fold.waitFor({ state: "visible", timeout: 15_000 });
  if ((await fold.getAttribute("aria-expanded")) !== "true") {
    await fold.evaluate((element) => element.click());
  }
  await page
    .locator('[data-design-sidebar-panel] [role="tree"]:visible')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
}

/** One snapshot of Layout's More layout actions menu as [text, disabled]
 * rows, or [] when the layer has no such menu. The rows follow fresh runtime
 * details, so separate reads of one row could straddle a re-render. */
export async function designLayoutMenuRows(page) {
  const trigger = page
    .locator("[data-design-layout-section]")
    .getByRole("button", { name: "More layout actions" });
  if ((await trigger.count()) === 0) return [];
  await trigger.click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  const rows = await menu.evaluate((element) =>
    [...element.querySelectorAll('[role="menuitem"]')].map((item) => [
      item.textContent.trim(),
      item.getAttribute("aria-disabled") === "true",
    ]),
  );
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  return rows;
}

/** "enabled", "disabled" or "absent" for one More layout actions row. */
export async function designLayoutMenuState(page, name) {
  const row = (await designLayoutMenuRows(page)).find(([text]) => text === name);
  return !row ? "absent" : row[1] ? "disabled" : "enabled";
}
