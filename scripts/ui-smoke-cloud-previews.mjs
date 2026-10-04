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
      body: '<!doctype html><title>Native preview fixture</title><p>Owned application</p><a href="/linked?from=page#section">Application link</a><a href="https://external.example.test/guide">External link</a>',
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

  for (const kind of ["human", "agent", "run"]) {
    await page.goto(
      `${harnessBase}/harness-cloud-previews.html?missing-capabilities${kind === "agent" ? "" : `&${kind}`}`,
    );
    await page.getByRole("button", { name: "Toggle active" }).click();
    await page.clock.fastForward(60_000);
    expect(await count()).toBe(0);
    await page.evaluate(() =>
      window.cloudPreviewFixture.setEditAccess(
        true,
        "33333333-3333-4333-8333-333333333333",
      ),
    );
    await page.clock.fastForward(60_000);
    expect(await count()).toBe(0);
    if (kind === "run")
      await expect(
        page.getByRole("button", { name: "Open Fixture in Browser" }),
      ).toHaveCount(0);
    await page.evaluate(() => window.cloudPreviewFixture.setEditAccess(true));
    if (kind === "run")
      await page
        .getByRole("button", { name: "Open Fixture in Browser" })
        .click();
    await expect.poll(count).toBe(1);
    for (const denied of [false, undefined, null]) {
      const revokesBefore = await page.evaluate(
        () =>
          window.cloudPreviewFixture.calls.filter(
            (call) => call.command === "browser:revoke-preview-origin",
          ).length,
      );
      await page.evaluate(
        (value) => window.cloudPreviewFixture.setEditAccess(value),
        denied,
      );
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              window.cloudPreviewFixture.calls.filter(
                (call) => call.command === "browser:revoke-preview-origin",
              ).length,
          ),
        )
        .toBeGreaterThan(revokesBefore);
      await page.clock.fastForward(60_000);
      expect(await count()).toBe(1);
      if (kind === "run")
        await expect(
          page.getByRole("button", { name: "Open Fixture in Browser" }),
        ).toHaveCount(0);
      await page.evaluate(() => window.cloudPreviewFixture.setEditAccess(true));
      await expect.poll(count).toBe(2);
      await page.reload();
      await page.getByRole("button", { name: "Toggle active" }).click();
      await page.evaluate(() => window.cloudPreviewFixture.setEditAccess(true));
      if (kind === "run")
        await page
          .getByRole("button", { name: "Open Fixture in Browser" })
          .click();
      await expect.poll(count).toBe(1);
    }
    check(
      `${kind} previews require exact-workspace editing capabilities and retire without retries when denied`,
      true,
    );
  }

  const loopbackRequests = [];
  const recordLoopback = (request) => {
    if (
      /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):517[345]\//.test(
        request.url(),
      )
    )
      loopbackRequests.push(request.url());
  };
  page.on("request", recordLoopback);
  await page.route("http://localhost:*/**", (route) =>
    route.fulfill({ body: "Local loopback must never be requested" }),
  );
  await page.goto(`${harnessBase}/harness-cloud-previews.html?human`);
  await page.getByRole("button", { name: "Toggle active" }).click();
  await expect.poll(count).toBe(1);
  await page.evaluate(() => {
    window.cloudPreviewFixture.hold = true;
  });
  await page
    .getByRole("textbox", { name: "Browser URL" })
    .fill("http://localhost:5174/next?version=3");
  await page.getByRole("textbox", { name: "Browser URL" }).press("Enter");
  await expect.poll(count).toBe(2);
  expect(loopbackRequests).toEqual([]);
  await expect.poll(frameUrl).toMatch(/0001\.preview\.example\.test/);
  await page.evaluate(() => {
    window.cloudPreviewFixture.hold = false;
    window.cloudPreviewFixture.release();
  });
  await expect
    .poll(frameUrl)
    .toMatch(/0002\.preview\.example\.test\/next\?version=3$/);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect.poll(count).toBe(3);
  await expect
    .poll(frameUrl)
    .toMatch(/0003\.preview\.example\.test\/assets\?version=2$/);
  await page.getByRole("button", { name: "Forward", exact: true }).click();
  await expect.poll(count).toBe(4);
  await expect
    .poll(frameUrl)
    .toMatch(/0004\.preview\.example\.test\/next\?version=3$/);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect.poll(count).toBe(5);
  await expect.poll(frameUrl).toMatch(/0005\.preview\.example\.test\/next\?version=3$/);
  expect(loopbackRequests).toEqual([]);
  check(
    "cloud address entry and history admit logical URLs before navigating, with zero local loopback requests",
    true,
  );

  await page.route("https://external.example.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>External page</title>External guide" }),
  );
  for (const kind of ["human", "agent"]) {
    await page.goto(`${harnessBase}/harness-cloud-previews.html${kind === "human" ? "?human" : ""}`);
    await page.getByRole("button", { name: "Toggle active" }).click();
    await expect.poll(count).toBe(1);
    await expect.poll(frameUrl).toMatch(/\/assets\?version=2$/);
    const source = await page.evaluate(() => window.cloudPreviewFixture.tab().previewSource);
    const ownedFrame = () => page.frames().find((frame) => frame.name().startsWith("zeros-browser-"));
    const observe = async (inPage = false) => {
      const url = frameUrl();
      await page.evaluate(({ url, inPage }) => window.cloudPreviewFixture.emitNavigation(url, inPage), { url, inPage });
    };
    // Electron reports these cross-origin observations through its trusted
    // frame-navigation channel; the harness supplies the corresponding event.
    await observe();
    await ownedFrame().evaluate(() => history.pushState({}, "", "/next?from=spa#view"));
    await observe(true);
    await expect(page.getByRole("textbox", { name: "Browser URL" })).toHaveValue("http://localhost:5173/next?from=spa#view");
    await expect(page.getByRole("button", { name: "Back", exact: true })).toBeEnabled();
    expect(await count()).toBe(1);
    expect(await page.evaluate(() => window.cloudPreviewFixture.tab().previewSource)).toEqual(source);
    await ownedFrame().getByRole("link", { name: "Application link", exact: true }).click();
    await expect.poll(frameUrl).toMatch(/\/linked\?from=page#section$/);
    await observe();
    await expect(page.getByRole("textbox", { name: "Browser URL" })).toHaveValue("http://localhost:5173/linked?from=page#section");
    expect(await count()).toBe(1);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect.poll(count).toBe(2);
    await expect.poll(frameUrl).toMatch(/\/next\?from=spa#view$/);
    await observe();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect.poll(count).toBe(3);
    await expect.poll(frameUrl).toMatch(/\/assets\?version=2$/);
    await observe();
    await expect(page.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Forward", exact: true }).click();
    await expect.poll(count).toBe(4);
    await expect.poll(frameUrl).toMatch(/\/next\?from=spa#view$/);
    await observe();
    expect(await page.evaluate(() => window.cloudPreviewFixture.tab().previewSource)).toEqual(source);
    if (source)
      expect(await page.evaluate(() => window.cloudPreviewFixture.calls.filter((call) => call.command === "browser:open-cloud-preview").map((call) => call.args.target))).toEqual(Array(4).fill({ executionId: "execution-native", portId: "A".repeat(32) }));
    check(`${kind} SPA and page links enter logical history without reloading or losing preview ownership`, true);

    await ownedFrame().getByRole("link", { name: "External link", exact: true }).click();
    await expect.poll(frameUrl).toBe("https://external.example.test/guide");
    await observe();
    await expect(page.getByRole("textbox", { name: "Browser URL" })).toHaveValue("https://external.example.test/guide");
    expect(await page.evaluate(() => window.cloudPreviewFixture.tab().url)).toBe("https://external.example.test/guide");
    expect(await page.evaluate(() => window.cloudPreviewFixture.tab().previewSource)).toBeUndefined();
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.cloudPreviewFixture.calls.some((call) => call.command === "browser:control-iframe" && call.args.action === "reload"))).toBe(true);
    await page.clock.fastForward(26 * 60_000);
    expect(await count()).toBe(4);
    expect(frameUrl()).toBe("https://external.example.test/guide");
    expect(loopbackRequests).toEqual([]);
    check(`${kind} external page navigation persists its URL and reloads without reminting preview authority`, true);
  }

  await page.goto(`${harnessBase}/harness-cloud-previews.html?empty`);
  await page.getByRole("button", { name: "Toggle active" }).click();
  expect(await count()).toBe(0);
  await page
    .getByRole("textbox", { name: "Browser URL" })
    .fill("http://localhost:5175/empty-entry");
  await page.getByRole("textbox", { name: "Browser URL" }).press("Enter");
  await expect.poll(count).toBe(1);
  await expect.poll(frameUrl).toMatch(/\.preview\.example\.test\/empty-entry$/);
  expect(loopbackRequests).toEqual([]);
  page.off("request", recordLoopback);
  check(
    "empty cloud Browser tabs admit their first logical address without contacting local loopback",
    true,
  );
}
