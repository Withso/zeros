import { expect } from "@playwright/test";

export async function runNativeToolsSmoke({ page, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-native-tools.html`,
  );
  const transcript = page.locator("#transcript");
  const row = (name) => transcript.getByRole("button", { name, exact: true });
  await row("Used the browser").click();
  await expect(row("Find Chrome tabs").locator("img")).toHaveCount(1);
  await expect(row("Inspect website").locator("img")).toHaveCount(1);
  await expect(row("Inspect Calculator").locator("img")).toHaveCount(1);
  const chrome = await row("Find Chrome tabs")
    .locator("img")
    .getAttribute("src");
  const site = await row("Inspect website").locator("img").getAttribute("src");
  const calculator = await row("Inspect Calculator")
    .locator("img")
    .getAttribute("src");
  expect(new Set([chrome, site, calculator]).size).toBe(3);
  await expect.poll(() => page.locator("#collapsed img").count()).toBe(3);
  check(
    "Native calls and collapsed groups show app, website, and connector artwork",
    true,
  );

  await row("Inspect Calculator").click();
  await expect(transcript.getByAltText("tool output")).toHaveCount(1);
  await expect(transcript.getByAltText("tool output")).toHaveJSProperty(
    "naturalWidth",
    1,
  );
  await row("Click Calculator").click();
  await expect(
    transcript.getByText("Accessibility access was denied by the user."),
  ).toBeVisible();
  await expect(row("Click Calculator")).toHaveClass(/text-red-primary/);
  await expect(
    row("Click Calculator").getByText("Click Calculator", { exact: true }),
  ).toHaveClass(/text-red-primary/);
  check(
    "Native screenshots expand and actual tool failures remain visible",
    true,
  );

  await page.getByRole("button", { name: "Light theme", exact: true }).click();
  const connector = transcript
    .getByRole("button", { name: "WorkOS Query", exact: true })
    .locator("img");
  await expect(connector).toHaveCount(1);
  const light = await connector.getAttribute("src");
  await page.getByRole("button", { name: "Dark theme", exact: true }).click();
  await expect.poll(() => connector.getAttribute("src")).not.toBe(light);

  const requests = () =>
    page
      .locator("#requests")
      .evaluate((element) => JSON.parse(element.textContent || "[]"));

  await page
    .getByRole("button", { name: "Toggle active", exact: true })
    .click();
  await expect(transcript.locator("img")).toHaveCount(0);
  const before = await requests();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(100);
  expect(await requests()).toEqual(before);
  check(
    "Hidden transcripts release images and do not request artwork",
    true,
  );

  await page.reload();
  await expect(row("Inspect Calculator").locator("img")).toHaveCount(1);
  await page.getByRole("button", { name: "Switch host", exact: true }).click();
  await expect(row("Inspect Calculator").locator("img")).toHaveCount(0);
  check(
    "A different native host never borrows the previous host’s app icon",
    true,
  );
}
