import { expect } from "@playwright/test";

/** Production row, hooks and cache; only the native OS boundary is a fixture. */
export async function runFullDiskAccessSmoke({ page, harnessBase, check }) {
  const base = new URL(harnessBase).origin;
  const url = `${base}/apps/desktop/src/renderer/harnesses/harness-full-disk-access.html`;
  const reads = () =>
    page.evaluate(
      () =>
        window.__fullDiskAccessFixture
          .calls()
          .filter(({ command }) => command === "full_disk_access_status")
          .length,
    );
  await page.goto(url);
  const status = page.getByRole("status", { name: "Full Disk Access status" });
  await expect(status).toHaveText("Not enabled");
  expect(await reads()).toBe(1);
  await expect(
    page.getByText(/Enable Zeros Local — example in System Settings/),
  ).toBeVisible();
  await expect(
    page.getByText(/Agent approval settings still apply/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open System Settings" }).click();
  await page.getByRole("button", { name: "Show App in Finder" }).click();
  const actions = await page.evaluate(() =>
    window.__fullDiskAccessFixture
      .calls()
      .filter(({ command }) => command !== "full_disk_access_status"),
  );
  expect(actions).toEqual([
    { command: "full_disk_access_open_settings", args: undefined },
    { command: "full_disk_access_reveal_app", args: undefined },
  ]);
  check(
    "Full Disk Access uses fixed native actions and identifies the running app",
    true,
  );

  await page.evaluate(() => {
    const f = window.__fullDiskAccessFixture;
    f.status("available");
    f.hold();
  });
  await page.getByRole("button", { name: "Check again" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__fullDiskAccessFixture.pending()))
    .toBe(true);
  await expect(status).toHaveText("Not enabled");
  await expect(
    page.getByRole("button", { name: "Check again" }),
  ).toBeDisabled();
  await page.evaluate(() => window.__fullDiskAccessFixture.release());
  await expect(status).toHaveText("Available");
  await page.evaluate(() => {
    window.__fullDiskAccessFixture.status("denied");
    window.dispatchEvent(new Event("focus"));
  });
  await expect(status).toHaveText("Not enabled");
  check(
    "Full Disk Access retains confirmed state and refreshes grant/revocation on focus",
    true,
  );

  await page.evaluate(() => {
    const f = window.__fullDiskAccessFixture;
    f.status("available");
    f.hold();
    window.dispatchEvent(new Event("focus"));
  });
  await expect
    .poll(() => page.evaluate(() => window.__fullDiskAccessFixture.pending()))
    .toBe(true);
  const beforeHide = await reads();
  await page.evaluate(() => window.__fullDiskAccessFixture.active(false));
  await expect(status).toBeHidden();
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.__fullDiskAccessFixture.release();
    window.__fullDiskAccessFixture.status("denied");
  });
  // Reveal must schedule a new check; a held response from the old panel is stale.
  await page.evaluate(() => window.__fullDiskAccessFixture.active(true));
  await expect.poll(reads).toBe(beforeHide + 1);
  await expect(status).toHaveText("Not enabled");
  check(
    "retained Settings panels fence old permission replies across owner/navigation switches",
    true,
  );

  await page.evaluate(() =>
    window.__fullDiskAccessFixture.visibility("hidden"),
  );
  const hiddenReads = await reads();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(await reads()).toBe(hiddenReads);
  await page.evaluate(() =>
    window.__fullDiskAccessFixture.visibility("visible"),
  );
  await expect.poll(reads).toBe(hiddenReads + 1);
  check("hidden windows do no permission reads and revalidate on return", true);

  await page.goto(`${url}?unsupported`);
  await expect.poll(reads).toBe(1);
  await expect(
    page.getByRole("button", { name: "Open System Settings" }),
  ).toHaveCount(0);
  await page.goto(`${url}?browser`);
  await expect(
    page.getByRole("button", { name: "Open System Settings" }),
  ).toHaveCount(0);
  expect(await reads()).toBe(0);
  check(
    "non-macOS hosts and browser previews expose no Mac permission controls",
    true,
  );
}
