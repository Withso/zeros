import { designCanvasSafeRect } from "./ui-smoke-design-helpers.mjs";
// Camera safeguards: a canvas never opens onto empty space while it has
// frames, and selecting a frame the user cannot see brings it into view.
// Camera setup uses the UI store only; the document is the harness fixture.
export async function runDesignCameraSmoke({ page, waitFor, check }) {
  const origin = new URL(page.url()).origin;
  const url = `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: "networkidle" });
  const viewport = page.locator("[data-design-canvas-viewport]");
  const world = page.locator("[data-design-canvas-world]");

  const setCamera = (camera) =>
    page.evaluate(async (next) => {
      const { useDesignWorkspaceUiStore } =
        await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
      useDesignWorkspaceUiStore
        .getState()
        .setViewport("ws_design_harness", next);
    }, camera);
  // Frames with at least a 4px overlap in canvas space clear of floating chrome.
  const visibleFrames = async () =>
    page.evaluate(
      (canvas) => {
        return [
          ...document.querySelectorAll(
            "[data-design-canvas-world] [data-design-frame]",
          ),
        ]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            const width =
              Math.min(rect.right, canvas.right) -
              Math.max(rect.left, canvas.left);
            const height =
              Math.min(rect.bottom, canvas.bottom) -
              Math.max(rect.top, canvas.top);
            return width >= 4 && height >= 4;
          })
          .map((element) => element.getAttribute("data-design-frame"));
      },
      await designCanvasSafeRect(page),
    );
  const transform = () =>
    world.evaluate((element) => getComputedStyle(element).transform);

  await viewport.waitFor({ timeout: 10_000 });
  // A camera parked far from every frame (as after zooming around a very tall
  // frame that was later deleted) must not reopen onto empty space.
  await setCamera({ zoom: 0.05, panX: -40_000, panY: -30_000 });
  await page.waitForTimeout(600);
  await page.reload({ waitUntil: "networkidle" });
  await viewport.waitFor({ timeout: 10_000 });
  const fitted = await waitFor(
    async () => (await visibleFrames()).length >= 2,
    "frames fitted on open",
    5_000,
  );
  check(
    "a canvas that opens onto empty space fits its frames",
    fitted,
    JSON.stringify(await visibleFrames()),
  );

  // After opening, the camera belongs to the user.
  await setCamera({ zoom: 0.5, panX: -8_000, panY: 0 });
  await page.waitForTimeout(300);
  check(
    "the open fit runs once; a later empty view is left alone",
    (await visibleFrames()).length === 0,
    JSON.stringify(await visibleFrames()),
  );

  await page.locator('[data-design-frame-row="pricing.html"]').click();
  const revealed = await waitFor(
    async () => (await visibleFrames()).includes("pricing.html"),
    "selected frame revealed",
    3_000,
  );
  check(
    "selecting an off-screen frame in Layers brings it into view",
    revealed,
    JSON.stringify(await visibleFrames()),
  );

  // A frame with any visible part is never moved under the user.
  const before = await transform();
  const partlyVisible = (await visibleFrames()).includes("home.html");
  await page.locator('[data-design-frame-row="home.html"]').click();
  await page.waitForTimeout(300);
  check(
    "selecting a frame already on screen leaves the camera alone",
    !partlyVisible || (await transform()) === before,
    `home visible=${partlyVisible}`,
  );

  // Pricing is inside the full viewport but completely behind the right
  // panel. That overlap must not qualify as a visible frame.
  const safe = await designCanvasSafeRect(page);
  await setCamera({ zoom: 0.1, panX: safe.right + 8 - 156, panY: 96 });
  const pricing = await page
    .locator('[data-design-frame="pricing.html"]')
    .boundingBox();
  const obscured =
    !(await visibleFrames()).includes("pricing.html") &&
    pricing.x >= safe.right &&
    pricing.x + pricing.width < 1440;
  await page.locator('[data-design-frame-row="pricing.html"]').click();
  check(
    "selecting a frame covered by the floating panel reveals it in usable canvas",
    obscured &&
      (await waitFor(
        async () => (await visibleFrames()).includes("pricing.html"),
        "covered frame revealed",
      )),
  );
}
