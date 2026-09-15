import { expect } from "@playwright/test";

export async function runOverlayPositioningSmoke({ page, check, harnessBase }) {
  await page.goto(`${harnessBase}/harness-overlay-positioning.html`, {
    waitUntil: "networkidle",
  });
  await page.setViewportSize({ width: 1000, height: 750 });
  const host = page.getByTestId("moving-host");
  const errors = [];
  const onError = (error) => errors.push(error.message);
  page.on("pageerror", onError);
  const close = async () => {
    const overlays = page.locator('[role="menu"], [role="dialog"], [role="listbox"]');
    // A submenu consumes its own Escape, and exit animations retain its DOM.
    // Wait for each layer's actual lifecycle before closing the next one.
    for (let level = 0; level < 3; level += 1) {
      const count = await overlays.count();
      if (count === 0) return;
      await overlays.evaluateAll((nodes) => Promise.all(nodes.flatMap((node) =>
        node.getAnimations().map((animation) => animation.finished.catch(() => {})),
      )));
      await page.keyboard.press("Escape");
      await expect.poll(() => overlays.count()).toBeLessThan(count);
    }
    await expect(overlays).toHaveCount(0);
  };
  const moveHost = (x, y) =>
    host.evaluate(
      (node, point) => {
        node.style.left = `${320 + point.x}px`;
        node.style.top = `${128 + point.y}px`;
      },
      { x, y },
    );
  const box = (locator) => locator.boundingBox();
  const insideViewport = async (locator) => {
    const rect = await box(locator);
    const viewport = page.viewportSize();
    return (
      rect != null &&
      rect.x >= 7 &&
      rect.y >= 7 &&
      rect.x + rect.width <= viewport.width - 7 &&
      rect.y + rect.height <= viewport.height - 7
    );
  };
  const failures = [];
  // Keep independent cases running after a failure so the audit identifies
  // every primitive with the same defect, not just the first menu.
  const verify = async (name, run) => {
    try {
      await run();
      check(name, true);
    } catch (error) {
      failures.push(name);
      check(name, false, String(error));
    } finally {
      await close();
      await moveHost(0, 0);
      await page.setViewportSize({ width: 1000, height: 750 });
    }
  };

  await verify(
    "Files context menu stays inside the window at its right edge",
    async () => {
      await moveHost(370, 0);
      const row = page.locator('[data-item-path="file-00.ts"]');
      const rowBox = await box(row);
      await row.click({
        button: "right",
        position: { x: rowBox.width - 5, y: 12 },
      });
      const menu = page.getByText("Copy path", { exact: true }).locator("..");
      await expect.poll(() => insideViewport(menu)).toBe(true);
    },
  );

  await verify(
    "Files context menu follows its row through pane movement",
    async () => {
      await page
        .locator('[data-item-path="file-00.ts"]')
        .click({ button: "right", position: { x: 30, y: 12 } });
      const menu = page.getByText("Copy path", { exact: true }).locator("..");
      await expect(menu).toBeVisible();
      await menu.evaluate((node) =>
        Promise.all(
          node.getAnimations().map((animation) => animation.finished),
        ),
      );
      const before = await box(menu);
      await moveHost(-150, 40);
      await expect
        .poll(async () => Math.round((await box(menu)).x - before.x))
        .toBe(-150);
      await expect
        .poll(async () => Math.round((await box(menu)).y - before.y))
        .toBe(40);
      await page.getByText("Copy path", { exact: true }).click();
      await expect(page.getByTestId("result")).toHaveText("copy:file-00.ts");
    },
  );

  for (const kind of ["context", "dropdown", "popover", "select"]) {
    await verify(
      `${kind} follows a moving anchor and fits after a window resize`,
      async () => {
        await page
          .getByTestId(`${kind}-trigger`)
          .click({ button: kind === "context" ? "right" : "left" });
        const content = page.getByTestId(`${kind}-content`);
        await expect(content).toBeVisible();
        // Wait out the entry animation before comparing screen geometry.
        await content.evaluate((node) =>
          Promise.all(
            node.getAnimations().map((animation) => animation.finished),
          ),
        );
        const before = await box(content);
        await moveHost(-130, 50);
        await expect
          .poll(async () => Math.round((await box(content)).x - before.x))
          .toBe(-130);
        await expect
          .poll(async () => Math.round((await box(content)).y - before.y))
          .toBe(50);
        await page.setViewportSize({ width: 450, height: 360 });
        // Radix Select deliberately dismisses on window resize; an open list
        // must either remain attached or dismiss, never stay at stale pixels.
        if (kind === "select") await expect(content).toHaveCount(0);
        else await expect.poll(() => insideViewport(content)).toBe(true);
        await close();
      },
    );
  }

  await page.getByRole("button", { name: "Toggle large menus" }).click();
  for (const kind of ["context", "dropdown"]) {
    await verify(
      `${kind} constrains oversized content and keeps every item reachable`,
      async () => {
        await page
          .getByTestId(`${kind}-trigger`)
          .click({ button: kind === "context" ? "right" : "left" });
        const content = page.getByTestId(`${kind}-content`);
        await expect.poll(() => insideViewport(content)).toBe(true);
        await page.keyboard.press("End");
        const lastItem = content.getByRole("menuitem").last();
        await expect(lastItem).toBeFocused();
        await expect.poll(() => insideViewport(lastItem)).toBe(true);
      },
    );
  }
  for (const kind of ["popover", "select"]) {
    await verify(
      `${kind} constrains oversized content to the window`,
      async () => {
        await page.getByTestId(`${kind}-trigger`).click();
        await expect
          .poll(() => insideViewport(page.getByTestId(`${kind}-content`)))
          .toBe(true);
      },
    );
  }
  await page.getByRole("button", { name: "Toggle large menus" }).click();
  for (const kind of ["context", "dropdown"]) {
    await verify(
      `${kind} submenu escapes the parent surface clipping`,
      async () => {
        await page
          .getByTestId(`${kind}-trigger`)
          .click({ button: kind === "context" ? "right" : "left" });
        await page
          .getByTestId(`${kind}-content`)
          .getByText(`${kind === "context" ? "Context" : "Dropdown"} submenu`, {
            exact: true,
          })
          .hover();
        const submenu = page.getByTestId(`${kind}-submenu`);
        await expect(submenu).toBeVisible();
        await expect.poll(() => insideViewport(submenu)).toBe(true);
        await submenu.getByRole("menuitem").click();
      },
    );
  }
  await verify(
    "A retained inactive file tree dismisses its portaled menu",
    async () => {
      await page
        .locator('[data-item-path="file-00.ts"]')
        .click({ button: "right" });
      await expect(page.getByText("Copy path", { exact: true })).toBeVisible();
      await page
        .getByRole("button", { name: "Toggle owner", includeHidden: true })
        .evaluate((button) => button.click());
      await expect(page.getByText("Copy path", { exact: true })).toHaveCount(0);
      await page
        .getByRole("button", { name: "Toggle owner", includeHidden: true })
        .evaluate((button) => button.click());
    },
  );
  await verify(
    "Context-menu keyboard navigation, submenus and focus restoration work",
    async () => {
      const trigger = page.getByTestId("context-trigger");
      await trigger.focus();
      await page.keyboard.press("Shift+F10");
      await expect(
        page.getByRole("menuitem", { name: "Context action", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(
        page.getByRole("menuitem", { name: "Context submenu", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(
        page.getByTestId("context-submenu").getByRole("menuitem"),
      ).toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await expect(
        page.getByRole("menuitem", { name: "Context submenu", exact: true }),
      ).toBeFocused();
      await close();
      await expect(trigger).toBeFocused();
    },
  );
  await verify(
    "Files menu keyboard selection operates on the right-clicked file",
    async () => {
      await page
        .locator('[data-item-path="file-01.ts"]')
        .click({ button: "right" });
      await expect(page.getByRole("menu", { name: "File actions" })).toBeFocused();
      await page.keyboard.press("End");
      await expect(
        page.getByRole("menuitem", { name: "Copy path", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("result")).toHaveText("copy:file-01.ts");
    },
  );
  await runDesignContextMenuPositioningSmoke({ page, check, harnessBase });
  page.off("pageerror", onError);
  check(
    "Overlay geometry interactions have no browser exceptions",
    errors.length === 0,
    errors.join("; "),
  );
  return failures;
}

export async function runDesignContextMenuPositioningSmoke({
  page,
  check,
  harnessBase,
}) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${harnessBase}/harness-design-workspace.html`, {
    waitUntil: "networkidle",
  });
  const frame = page.locator('[data-design-frame="pricing.html"]');
  await frame.click({ button: "right", position: { x: 250, y: 90 } });
  const menu = page.getByRole("menu", { name: "Layers under pointer" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await menu.evaluate((node) =>
    Promise.all(node.getAnimations().map((animation) => animation.finished)),
  );
  const before = await menu.boundingBox();
  const frameBefore = await frame.boundingBox();
  await frame.evaluate((node) => {
    node.style.translate = "-120px 40px";
  });
  const frameAfter = await frame.boundingBox();
  try {
    await expect
      .poll(async () => Math.round((await menu.boundingBox()).x - before.x))
      .toBe(Math.round(frameAfter.x - frameBefore.x));
    await expect
      .poll(async () => Math.round((await menu.boundingBox()).y - before.y))
      .toBe(Math.round(frameAfter.y - frameBefore.y));
    check(
      "Design hit-stack menu follows its frame when the canvas moves",
      true,
    );
  } catch (error) {
    check(
      "Design hit-stack menu follows its frame when the canvas moves",
      false,
      String(error),
    );
  }
  await page.setViewportSize({ width: 1000, height: 650 });
  try {
    await expect
      .poll(async () => {
        const rect = await menu.boundingBox();
        return (
          rect &&
          rect.x >= 7 &&
          rect.y >= 7 &&
          rect.x + rect.width <= 993 &&
          rect.y + rect.height <= 643
        );
      })
      .toBe(true);
    check("Design hit-stack menu stays inside the resized window", true);
  } catch (error) {
    check(
      "Design hit-stack menu stays inside the resized window",
      false,
      String(error),
    );
  }
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
}
