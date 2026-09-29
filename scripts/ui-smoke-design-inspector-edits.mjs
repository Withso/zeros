import { expect } from "@playwright/test";

async function openHeading(page) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );
  await page
    .locator('#design-layers-panel [data-design-layer-id="home-heading"]')
    .click();
}

const writes = (page) =>
  page.evaluate(
    () =>
      (window.__zerosHarnessDesignShortcutOperations ?? []).filter(
        (op) => op === "style:end",
      ).length,
  );

async function savedStyle(page, property) {
  return page.evaluate(async (property) => {
    const { designFrame } =
      await import("/apps/desktop/src/renderer/platform/git.ts");
    const { source } = await designFrame("ws_design_harness", "home.html");
    return new DOMParser()
      .parseFromString(source, "text/html")
      .querySelector('[data-oid="home-heading"]')
      .style.getPropertyValue(property);
  }, property);
}

export async function runDesignTransformCommitSmoke({ page, check }) {
  await openHeading(page);
  await page
    .getByRole("button", { name: "Edit transform", exact: true })
    .click();
  const x = page.getByRole("textbox", { name: "Translate X", exact: true });
  await x.focus();
  await x.press("ArrowUp");
  await x.press("Enter");
  await expect.poll(() => writes(page)).toBe(1);
  await expect
    .poll(() => savedStyle(page, "transform"))
    .toBe("translate(1px, 0px)");
  const scrub = await page
    .getByRole("button", { name: "Scrub Translate X", exact: true })
    .boundingBox();
  await x.focus();
  await page.mouse.move(scrub.x + scrub.width / 2, scrub.y + scrub.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    scrub.x + scrub.width / 2 + 40,
    scrub.y + scrub.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
  await x.press("Tab");
  await expect.poll(() => writes(page)).toBe(2);
  await expect
    .poll(() => savedStyle(page, "transform"))
    .toBe("translate(21px, 0px)");
  await x.focus();
  await x.press("ArrowUp");
  await x.press("Escape");
  await expect(x).toHaveValue("21");
  await expect
    .poll(() => savedStyle(page, "transform"))
    .toBe("translate(21px, 0px)");
  expect(await writes(page)).toBe(2);
  check(
    "transform scrubs and arrow steps save once; Escape restores the committed value",
    true,
  );
}

export async function runDesignColorInputRacesSmoke({ page, check }) {
  await openHeading(page);
  await page.evaluate(() => {
    window.__zerosHarnessStyleDelay = 1200;
  });
  const hex = page.getByRole("textbox", { name: "Fill", exact: true });
  const alpha = page.getByRole("textbox", {
    name: "Fill opacity",
    exact: true,
  });
  await hex.fill("FF0000");
  await hex.press("Enter");
  await alpha.fill("50");
  await alpha.press("Enter");
  await expect.poll(() => writes(page), { timeout: 8000 }).toBe(2);
  await expect
    .poll(() => savedStyle(page, "color"))
    .toMatch(/^rgba\(255, 0, 0, 0\.5[0-9]*\)$/);
  await expect(hex).toHaveValue("FF0000");
  await expect(alpha).toHaveValue("50");
  await alpha.fill("25");
  await alpha.press("Enter");
  await hex.fill("00FF00");
  await hex.press("Enter");
  await expect.poll(() => writes(page), { timeout: 8000 }).toBe(4);
  await expect
    .poll(() => savedStyle(page, "color"))
    .toMatch(/^rgba\(0, 255, 0, 0\.25[0-9]*\)$/);
  await hex.focus();
  await page.evaluate(async () => {
    const { designWorkspaceSnapshotCache, updateDesignNodeStylesCached } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const workspaceId = "ws_design_harness";
    const frame = designWorkspaceSnapshotCache
      .peekSnapshot(workspaceId)
      .data.frames.find((item) => item.file === "home.html");
    await updateDesignNodeStylesCached(workspaceId, {
      frame: frame.file,
      sourceVersion: frame.sourceVersion,
      nodeId: "home-heading",
      styles: { color: "blue" },
    });
  });
  await expect(alpha).toHaveValue("100");
  await hex.press("Tab");
  await expect(hex).toHaveValue("0000FF");
  expect(await writes(page)).toBe(5);
  expect(await savedStyle(page, "color")).toBe("blue");
  check(
    "successive hex and opacity edits preserve both channels while saves are pending",
    true,
  );
}

export async function runDesignInspectorEditsSmoke(context) {
  await runDesignTransformCommitSmoke(context);
  await runDesignColorInputRacesSmoke(context);
  await runDesignPaintRemovalSmoke(context);
}

export async function runDesignPaintRemovalSmoke({ page, check }) {
  await openHeading(page);
  await page.evaluate(async () => {
    const { designWorkspaceSnapshotCache, updateDesignNodeStylesCached } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const workspaceId = "ws_design_harness";
    const frame = designWorkspaceSnapshotCache
      .peekSnapshot(workspaceId)
      .data.frames.find((item) => item.file === "home.html");
    await updateDesignNodeStylesCached(workspaceId, {
      frame: frame.file,
      sourceVersion: frame.sourceVersion,
      nodeId: "home-hero",
      styles: { border: "2px solid red", background: "blue" },
    });
  });
  await page
    .locator('#design-layers-panel [data-design-layer-id="home-hero"]')
    .click();
  await page
    .getByRole("combobox", { name: "Stroke position", exact: true })
    .click();
  await page.getByRole("option", { name: "Outside", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Remove stroke", exact: true }),
  ).toHaveCount(0);
  const removeOutline = page.getByRole("button", {
    name: "Remove outline",
    exact: true,
  });
  await expect(removeOutline).toBeVisible();
  await removeOutline.click();
  await expect(removeOutline).toHaveCount(0);
  const removeFill = page.getByRole("button", {
    name: "Remove fill",
    exact: true,
  });
  await removeFill.click();
  await expect(removeFill).toHaveCount(0);
  check(
    "moving and removing shorthand paint clears its original stroke and fill rows",
    true,
  );
}
