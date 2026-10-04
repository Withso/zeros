import { expect } from "@playwright/test";

export async function runCloudPreviewSmoke({ page, check, harnessBase }) {
  const frameUrl = () =>
    page
      .frames()
      .find((frame) => frame.name().startsWith("zeros-browser-"))
      ?.url() ?? "";
  const count = () =>
    page.evaluate(
      () =>
        window.cloudPreviewFixture.calls.filter(
          (call) => call.command === "browser:open-cloud-preview",
        ).length,
    );
  await page.route("https://*.preview.example.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Native preview fixture</title><p>Owned application</p>",
    }),
  );
  await page.goto(`${harnessBase}/harness-cloud-previews.html`);
  await expect(page.locator("iframe")).toHaveAttribute("src", "about:blank");
  await page.evaluate(() => {
    window.previewOwnedFrame = document.querySelector("iframe");
  });
  expect(await count()).toBe(0);
  await page.getByRole("button", { name: "Toggle active" }).click();
  await expect.poll(count).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        () => window.previewOwnedFrame === document.querySelector("iframe"),
      ),
    )
    .toBe(true);
  await expect.poll(frameUrl).toMatch(/^https:.*\/assets\?version=2$/);
  const target = await page.evaluate(
    () =>
      window.cloudPreviewFixture.calls.find(
        (call) => call.command === "browser:open-cloud-preview",
      ).args.target,
  );
  expect(target).toEqual({
    executionId: "execution-native",
    portId: "A".repeat(32),
  });
  check(
    "native Browser admits opaque identity and retains the application path",
    true,
  );

  await page.getByRole("button", { name: "Toggle active" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.cloudPreviewFixture.calls.filter(
            (call) => call.command === "browser:revoke-preview-origin",
          ).length,
      ),
    )
    .toBeGreaterThan(0);
  await page.clock.install();
  await page.clock.fastForward(31 * 60_000);
  expect(await count()).toBe(1);
  await page.getByRole("button", { name: "Toggle active" }).click();
  await expect.poll(count).toBe(2);
  check("hidden previews retire access and re-admit after expiry", true);

  await page.evaluate(() => {
    window.cloudPreviewFixture.hold = true;
  });
  await page.getByRole("button", { name: "Toggle active" }).click();
  await page.getByRole("button", { name: "Toggle active" }).click();
  await expect.poll(count).toBe(3);
  await page.evaluate(() => {
    window.cloudPreviewFixture.hold = false;
  });
  await page.getByRole("button", { name: "Switch workspace" }).click();
  await expect.poll(count).toBe(4);
  await page.evaluate(() => window.cloudPreviewFixture.release());
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.cloudPreviewFixture.calls.some(
          (call) =>
            call.command === "cloud_workspace_access_revoke" &&
            call.args.accessId === "preview-3",
        ),
      ),
    )
    .toBe(true);
  await expect.poll(frameUrl).toMatch(/0004\.preview\.example\.test/);
  check(
    "late workspace admissions retire their exact grant without replacing the successor",
    true,
  );
  await page.evaluate(() => {
    window.cloudPreviewFixture.hold = true;
  });
  await page.getByRole("button", { name: "Toggle active" }).click();
  await page.getByRole("button", { name: "Toggle active" }).click();
  await expect.poll(count).toBe(5);
  await page.evaluate(() => {
    window.cloudPreviewFixture.hold = false;
  });
  await page.getByRole("button", { name: "Switch account" }).click();
  await expect.poll(count).toBe(6);
  await page.evaluate(() => window.cloudPreviewFixture.release());
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.cloudPreviewFixture.calls.some(
          (call) =>
            call.command === "cloud_workspace_access_revoke" &&
            call.args.accessId === "preview-5",
        ),
      ),
    )
    .toBe(true);
  await expect.poll(frameUrl).toMatch(/0006\.preview\.example\.test/);
  check(
    "same-gate account replacement rejects old admissions and re-admits with the new account",
    true,
  );
  await page.getByRole("button", { name: "Disable previews" }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  check("disabling the internal gate removes the runtime surface", true);

  await page.reload();
  await page.getByRole("button", { name: "Toggle active" }).click();
  await expect.poll(count).toBe(1);
  await page.evaluate(() => {
    window.previewOwnedFrame = document.querySelector("iframe");
  });
  await page.clock.fastForward(26 * 60_000);
  await expect.poll(count).toBe(2);
  await expect
    .poll(() =>
      page.evaluate(
        () => window.previewOwnedFrame === document.querySelector("iframe"),
      ),
    )
    .toBe(true);
  check(
    "visible renewal replaces history inside the original admitted frame",
    true,
  );

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(31 * 60_000);
  expect(await count()).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(count).toBe(3);
  check(
    "application visibility retires authority and keeps hidden frames inert",
    true,
  );

  await page.reload();
  await page.evaluate(() => {
    window.cloudPreviewFixture.legacy = true;
  });
  await page.getByRole("button", { name: "Toggle active" }).click();
  await expect(page.locator("iframe")).toHaveAttribute(
    "src",
    /^https:\/\/legacy\.preview\.example\.test\//,
  );
  expect(await count()).toBe(0);
  check(
    "legacy engine factories retain signed navigation without native target admission",
    true,
  );

  await page.goto(`${harnessBase}/harness-cloud-previews.html?legacy-source`);
  await page.getByRole("button", { name: "Toggle active" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.cloudPreviewFixture.calls.filter(
            (call) => call.command === "engine:open-preview",
          ).length,
      ),
    )
    .toBeGreaterThan(0);
  expect(await count()).toBe(0);
  await expect(page.locator("iframe")).toHaveAttribute("src", "about:blank");
  check(
    "native engine responses require exact stored identity and cannot fall back to a display port",
    true,
  );
  const sourceErrors = [];
  const collectSourceError = (error) => sourceErrors.push(error.message);
  page.on("pageerror", collectSourceError);
  await page.goto(`${harnessBase}/harness-cloud-previews.html?invalid-source`);
  await page.getByRole("button", { name: "Toggle active" }).click();
  await expect(page.locator("iframe")).toHaveCount(1);
  expect(await count()).toBe(0);
  expect(sourceErrors).toEqual([]);
  page.off("pageerror", collectSourceError);
  check(
    "malformed restored preview identity stays inert without crashing Browser",
    true,
  );
}
