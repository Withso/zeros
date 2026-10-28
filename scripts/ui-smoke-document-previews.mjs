import { expect } from "@playwright/test";
import { previewPdf, previewDocx } from "./document-preview-fixtures.mjs";

export async function runDocumentPreviewsSmoke({ page, check, screenshots }) {
  const originalViewport = page.viewportSize();
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-file-media.html`,
  );
  await page.waitForFunction(() => window.__zerosFileMediaHarness);
  const external = [];
  const record = (request) => {
    if (request.url().includes("preview-external.invalid"))
      external.push(request.url());
  };
  page.on("request", record);
  await page.evaluate(
    ([pdf, word]) => {
      const api = window.__zerosFileMediaHarness;
      api.document("report.pdf", pdf);
      api.document("report.docx", word);
    },
    [[...previewPdf()], [...previewDocx()]],
  );
  const open = async (owner, path, active = true) => {
    await page.evaluate(
      (args) => window.__zerosFileMediaHarness.render(...args),
      [owner, path, active],
    );
  };
  const island = page.locator("[data-document-controls]");
  const assertIsland = async (format) => {
    await expect(island).toBeVisible();
    const viewer = await page
      .locator(`[data-file-document-preview="${format}"]`)
      .boundingBox();
    const controls = await island.boundingBox();
    expect(
      Math.abs(viewer.y + viewer.height - controls.y - controls.height - 12),
    ).toBeLessThan(2);
    expect(
      Math.abs(viewer.x + viewer.width / 2 - controls.x - controls.width / 2),
    ).toBeLessThan(2);
    expect(controls.width).toBeLessThanOrEqual(viewer.width - 24);
    await expect(
      page.getByRole("button", { name: "Fit page", exact: true }),
    ).toHaveText(/^\d+%$/);
  };
  for (const owner of ["personal", "organization", "cloud"]) {
    await open(owner, "report.pdf");
    // The first PDF loads the viewer, local font/CMap URLs and worker through
    // Vite. Keep a cold-start budget distinct from the navigation assertions.
    await expect(
      page.getByRole("region", { name: "PDF page 1", exact: true }),
    ).toContainText("Document preview - page 1", { timeout: 15_000 });
    await assertIsland("pdf");
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "PDF page 2", exact: true }),
    ).toContainText("Document preview - page 2");
    await page.getByLabel("Page number", { exact: true }).fill("9999");
    await page.getByLabel("Page number", { exact: true }).press("Enter");
    await expect(page.getByLabel("Page number", { exact: true })).toHaveValue(
      "3",
    );
    await expect(
      page.getByRole("button", { name: "Next page", exact: true }),
    ).toBeDisabled();
    await open(owner, "report.pdf", false);
    await expect(
      page.locator('[data-file-document-preview="pdf"] canvas'),
    ).toHaveCount(0);
    await expect(island).toHaveCount(0);
    await open(owner, "report.pdf");
    await expect(
      page.getByRole("region", { name: "PDF page 3", exact: true }),
    ).toContainText("Document preview - page 3");
    check(
      `${owner}: PDF pages, bounded navigation and hidden-worker retirement`,
      true,
    );
    await open(owner, "report.docx");
    const word = page.frameLocator('iframe[title="Word document page 1"]');
    await expect(
      word.getByText("Word document preview", { exact: true }),
    ).toBeVisible();
    await expect(word.locator("table")).toContainText("Second cell");
    await expect
      .poll(() => word.locator("img").evaluate((img) => img.naturalWidth))
      .toBe(1);
    await expect(word.locator("a[href]")).toHaveCount(0);
    await expect(
      page.locator('iframe[title="Word document page 1"]'),
    ).toHaveAttribute("sandbox", "");
    await assertIsland("docx");
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(
      page
        .frameLocator('iframe[title="Word document page 2"]')
        .getByText("Second Word page", { exact: true }),
    ).toBeVisible();
    await open(owner, "report.docx", false);
    await expect(
      page.locator('[data-file-document-preview="docx"] iframe'),
    ).toHaveCount(0);
    await expect(island).toHaveCount(0);
    check(
      `${owner}: Word pages retain formatting and images without active links`,
      true,
    );
  }
  await page.setViewportSize({ width: 480, height: 650 });
  await open("personal", "report.pdf");
  const pdf = page.locator(".zeros-pdf-page > canvas");
  await expect(pdf).toBeVisible();
  await expect
    .poll(() => pdf.evaluate((canvas) => canvas.width))
    .toBeGreaterThan(0);
  const fitWidth = (await pdf.boundingBox()).width;
  await assertIsland("pdf");
  expect(
    (await pdf.boundingBox()).y + (await pdf.boundingBox()).height,
  ).toBeLessThan((await island.boundingBox()).y);
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect
    .poll(async () => (await pdf.boundingBox()).width)
    .toBeLessThan(fitWidth);
  check("Zooming out from Fit shrinks the page in a narrow Files pane", true);
  await page.getByRole("button", { name: "Fit page", exact: true }).click();
  await page.getByRole("button", { name: "Rotate page", exact: true }).click();
  await expect
    .poll(async () => {
      const bounds = await pdf.boundingBox();
      return bounds.width > bounds.height;
    })
    .toBe(true);
  if (originalViewport) await page.setViewportSize(originalViewport);
  await open("personal", "report.docx");
  await expect(
    page.locator('[data-file-document-preview="docx"] iframe'),
  ).toBeVisible();
  const fits = await page
    .locator('[data-file-document-preview="docx"] iframe')
    .evaluate(
      (frame) =>
        frame.getBoundingClientRect().height <=
        frame.parentElement.parentElement.clientHeight,
    );
  check("Word Fit page fits the page height as well as its width", fits);
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) => document.documentElement.setAttribute("data-theme", theme),
      theme,
    );
    await expect(
      page
        .frameLocator('iframe[title="Word document page 1"]')
        .getByText("Word document preview", { exact: true }),
    ).toBeVisible();
    await assertIsland("docx");
    if (screenshots)
      await page.screenshot({
        path: `${screenshots}/word-preview-${theme}.png`,
      });
    await open("personal", "report.pdf");
    await expect(
      page.getByRole("region", { name: "PDF page 1", exact: true }),
    ).toContainText("Document preview - page 1");
    await assertIsland("pdf");
    if (screenshots)
      await page.screenshot({
        path: `${screenshots}/pdf-preview-${theme}.png`,
      });
    await open("personal", "report.docx");
  }
  await page.setViewportSize({ width: 320, height: 520 });
  for (const format of ["pdf", "docx"]) {
    await open("organization", `report.${format}`);
    await assertIsland(format);
    await page.getByLabel("Page number", { exact: true }).fill("");
    await page.getByLabel("Page number", { exact: true }).press("Enter");
    await expect(page.getByLabel("Page number", { exact: true })).toHaveValue(
      "1",
    );
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await page.getByRole("button", { name: "Fit page", exact: true }).click();
    const content = page.locator(
      format === "pdf"
        ? ".zeros-pdf-page"
        : '[data-file-document-preview="docx"] iframe',
    );
    await expect
      .poll(async () => {
        const bounds = await content.boundingBox();
        return bounds.y + bounds.height < (await island.boundingBox()).y;
      })
      .toBe(true);
  }
  check(
    "Document controls float at the bottom in both themes and narrow panes, without covering the fitted page",
    true,
  );
  if (originalViewport) await page.setViewportSize(originalViewport);
  await page.evaluate(() => {
    window.__zerosFileMediaHarness.document("broken.pdf", [1, 2, 3]);
    window.__zerosFileMediaHarness.render("personal", "broken.pdf");
  });
  await expect(
    page.getByText("This document couldn't be loaded.", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.__zerosFileMediaHarness.document("broken.docx", [1, 2, 3]);
    window.__zerosFileMediaHarness.render("personal", "broken.docx");
  });
  await expect(
    page.getByText("This Word document can't be previewed.", { exact: true }),
  ).toBeVisible();
  check(
    "Malformed documents have a readable fallback and never render source bytes",
    true,
  );
  check(
    "Document previews never request external document resources",
    external.length === 0,
  );
  page.off("request", record);
}
