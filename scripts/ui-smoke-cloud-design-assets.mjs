import { expect } from "@playwright/test";

export async function runCloudDesignAssetsSmoke({ page, check, harnessBase }) {
  await page.goto(`${harnessBase}/harness-cloud-design-assets.html?local=1`, {
    waitUntil: "networkidle",
  });
  await expect(
    page.getByRole("button", { name: "Upload image", exact: true }),
  ).toHaveCount(0);
  check("Local canvas has no cloud upload control", true);
  await page.goto(`${harnessBase}/harness-cloud-design-assets.html`, {
    waitUntil: "networkidle",
  });
  const upload = page.getByRole("button", {
    name: "Upload image",
    exact: true,
  });
  await page.getByRole("button", { name: "Prompter", exact: true }).click();
  await expect(upload).toBeDisabled();
  await page.getByRole("button", { name: "Developer", exact: true }).click();
  const data = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const file = {
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(data, "base64"),
  };
  const choose = async (value = file) => {
    const pending = page.waitForEvent("filechooser");
    await upload.click();
    await (await pending).setFiles(value);
  };
  const count = () =>
    page.evaluate(() => window.cloudAssetFixture.requests.length);
  await choose();
  await expect.poll(count).toBe(1);
  const request = await page.evaluate(
    () => window.cloudAssetFixture.requests[0],
  );
  expect(request).toEqual({
    op: "design.asset.upload",
    workspaceId: expect.stringMatching(/^cloud:/),
    directoryId: "design_fixture",
    frame: "page-1/home.html",
    mimeType: "image/png",
  });
  check(
    "developer image selection targets the captured cloud workspace, directory and frame",
    true,
  );
  await choose({
    name: "script.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from("<svg></svg>"),
  });
  await expect(page.getByText(/Choose a PNG, JPEG/)).toBeVisible();
  expect(await count()).toBe(1);
  check("unsupported image input writes nothing", true);
  for (const change of ["Other workspace", "Prompter"]) {
    await page.evaluate(() => window.cloudAssetFixture.hold());
    await choose();
    await expect
      .poll(() => page.evaluate(() => window.cloudAssetFixture.pending))
      .toBe(true);
    await page.getByRole("button", { name: change, exact: true }).click();
    await page.evaluate(() => window.cloudAssetFixture.release());
    await expect
      .poll(() => page.evaluate(() => window.cloudAssetFixture.pending))
      .toBe(false);
    await page.getByRole("button", { name: "Developer", exact: true }).click();
    await expect(upload).toBeEnabled();
    expect(await count()).toBe(1);
  }
  check("workspace changes and role demotion retire a pending file read", true);
  await page.evaluate(() => window.cloudAssetFixture.fail());
  await choose();
  await expect(
    page.getByText("WebSocket closed before response"),
  ).toBeVisible();
  expect(await count()).toBe(2);
  await expect(upload).toBeEnabled();
  check("an uncertain upload reports its failure without replay", true);
}
