import { expect } from "@playwright/test";

async function openZoomedOut(page) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures&pictures`,
    { waitUntil: "networkidle" },
  );
  // Earlier scenarios on a shared page can leave another directory bound in
  // the persisted Design view and boot snapshot. Clear both in this document
  // (an unloading page would write them back) and mount once more.
  await page.evaluate(async () => {
    const { resetDesignWorkspaceUiForTests } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    resetDesignWorkspaceUiForTests();
    localStorage.removeItem("zeros-design-workspace-snapshots-v1");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const { useDesignWorkspaceUiStore } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    // 1,440 px frames at 10%: 144 device pixels, inside one overview picture.
    useDesignWorkspaceUiStore.getState().setViewport("ws_design_harness", {
      zoom: 0.1,
      panX: 200,
      panY: 200,
    });
  });
  await expect(page.locator('[data-design-frame="pricing.html"]')).toBeVisible();
}

const previewRequests = (page, frame) =>
  page.evaluate(
    (file) => (window.__zerosHarnessPreviewRequests ?? []).filter((request) => request.frame === file).length,
    frame,
  );

/** Zoomed out, a frame that is not selected paints its saved picture and
 * stops running its document; a reload paints the stored picture again
 * without asking the capture host. */
export async function runDesignPicturesSmoke({ page, check }) {
  // Scenarios may share a page; start from an empty picture store.
  await openZoomedOut(page);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.deleteDatabase("zeros:design-previews:v1");
        request.onsuccess = request.onerror = request.onblocked = () => resolve(undefined);
      }),
  );
  await openZoomedOut(page);
  const pricing = page.locator('[data-design-frame="pricing.html"]');
  await expect(pricing.locator('img[data-design-frame-picture="current"]')).toHaveCount(1, { timeout: 15_000 });
  expect(await previewRequests(page, "pricing.html")).toBeGreaterThan(0);
  const [request] = await page.evaluate(() => window.__zerosHarnessPreviewRequests);
  expect(request).toMatchObject({ workspaceId: "ws_design_harness", maxDimension: 384 });
  await expect(pricing.locator("iframe")).toHaveCount(0, { timeout: 15_000 });
  check("a small frame on a zoomed-out canvas paints its saved picture instead of running its document", true);

  await page.reload({ waitUntil: "networkidle" });
  await openZoomedOut(page);
  await expect(pricing.locator('img[data-design-frame-picture="current"]')).toHaveCount(1, { timeout: 15_000 });
  expect(await previewRequests(page, "pricing.html")).toBe(0);
  check("a reopened canvas paints the stored picture without rendering it again", true);
}
