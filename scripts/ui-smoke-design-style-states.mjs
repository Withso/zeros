import { expect } from "@playwright/test";

import { openLayersDrawer } from "./ui-smoke-design-helpers.mjs";

// States belong to components, as variants (the Options smoke covers them):
// a plain layer has no State control, even one whose rules name states.
export async function runDesignStyleStatesSmoke({ page, check }) {
  // The origins smoke before this one leaves the page clock paused.
  await page.clock.resume().catch(() => {});
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?styleOrigins&layoutGestures`,
    { waitUntil: "networkidle" },
  );
  await openLayersDrawer(page);
  const inspector = page.locator("[data-design-inspector]");
  const layer = (id) => page.locator(`[data-design-layer-id="${id}"]`);
  // home-submit's rules name :hover, :focus-visible, :active and :disabled.
  await layer("home-submit").click();
  await expect(layer("home-submit")).toHaveAttribute("aria-selected", "true");
  await inspector.locator('[data-design-style-property="border-radius"]').first().waitFor();
  check(
    "a plain layer whose rules name states has no State control or state note",
    (await inspector.getByRole("button", { name: "Layer state" }).count()) === 0 &&
      (await inspector.locator("[data-design-state-note], [data-design-state-variant]").count()) === 0,
  );
}
