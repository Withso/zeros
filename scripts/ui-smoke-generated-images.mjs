import { expect } from "@playwright/test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export async function runGeneratedImagesSmoke({ page, check, captureDirectory }) {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-generated-images.html`);
  if (captureDirectory) await mkdir(captureDirectory, { recursive: true });
  const roots = { Local: "/personal/project", Organization: "/organization/project", Cloud: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222" };
  for (const theme of ["dark", "light"]) {
    await page.evaluate((theme) => document.documentElement.setAttribute("data-theme", theme), theme);
    for (const owner of ["Local", "Organization", "Cloud", "Local"]) {
      await page.getByRole("button", { name: owner, exact: true }).click();
      const fixture = page.locator(`[data-image-owner="${owner}"]`);
      for (const kind of ["generation", "edit", "placeholder", "legacy"]) {
        const row = fixture.locator(`[data-generated-image-case="${kind}"]`);
        const toggle = row.getByRole("button", { name: /^Generate / });
        if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
        if (kind === "placeholder") {
          await expect(row.getByText("Image saved by Codex", { exact: true })).toBeVisible();
          await expect(row.locator("img")).toHaveCount(0);
        } else {
          await expect(row.locator("img")).toBeVisible();
          await expect.poll(() => row.locator("img").evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
          await expect(row.getByText("Image saved by Codex", { exact: true })).toHaveCount(0);
        }
        await expect(row.locator("[data-tool-detail]")).toHaveCSS("max-height", "320px");
        if (kind === "edit") {
          const sources = row.locator("[data-generated-image-sources]");
          await expect(sources).toContainText("Edited from");
          const source = sources.getByRole("button", { name: "Open beach.jpg", exact: true });
          await expect(source).not.toHaveAttribute("aria-disabled", "true");
          await source.click();
          await expect.poll(() => page.evaluate((cwd) => {
            const state = window.__generatedImages.workbenches()[cwd];
            return state?.tabs.find((tab) => tab.id === state.activeId)?.filePath;
          }, roots[owner])).toBe("beach.jpg");
          await expect(toggle).toHaveAccessibleName("Generate sunset-edit.png");
          await expect(row.getByText("sha256", { exact: false })).toHaveCount(0);
        } else await expect(row.getByText("Edited from", { exact: true })).toHaveCount(0);
        if (captureDirectory && ["Local", "Cloud"].includes(owner) && kind !== "legacy") {
          await page.mouse.move(0, 0);
          await page.evaluate(() => document.activeElement?.blur());
          await row.screenshot({ path: join(captureDirectory, `${owner.toLowerCase()}-${theme}-${kind}.png`), animations: "disabled" });
        }
      }
      check(`${owner}/${theme}: generated and legacy previews, source-pill navigation and missing-image status`, true);
    }
  }
  const broken = page.locator('[data-generated-image-case="broken"]');
  await broken.getByRole("button", { name: /^Generate / }).click();
  await expect(broken.getByText("Image saved by Codex", { exact: true })).toBeVisible();
  await expect(broken.locator("img")).toHaveCount(0);
  await page.getByRole("button", { name: "Repair preview", exact: true }).click();
  await expect.poll(() => broken.locator("img").evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(broken.getByText("Image saved by Codex", { exact: true })).toHaveCount(0);
  check("A failed decode shows no broken image and a replacement source recovers", true);

  await page.getByRole("button", { name: "Hide media", exact: true }).click();
  await expect(page.locator("[data-image-owner] img")).toHaveCount(0);
  const source = page.locator("[data-generated-image-sources]").getByRole("button", { name: "Open beach.jpg", exact: true });
  await expect(source).toHaveAttribute("aria-disabled", "true");
  const before = await page.evaluate(() => ({ requests: window.__generatedImages.requests().length, state: JSON.stringify(window.__generatedImages.workbenches()) }));
  await source.dispatchEvent("pointerenter");
  await source.focus();
  await source.dispatchEvent("click");
  expect(await page.evaluate(() => ({ requests: window.__generatedImages.requests().length, state: JSON.stringify(window.__generatedImages.workbenches()) }))).toEqual(before);
  check("Hidden retained image rows release media and disable source-pill reads and navigation", true);
  await page.getByRole("button", { name: "Show media", exact: true }).click();
}
