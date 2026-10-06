import { expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const types = ["files", "changes", "review", "design", "browser", "terminal"];
const copy = {
  files: ["Files", "files", "Retry to load files."],
  changes: ["Changes", "changes", "Choose another comparison or retry."],
  review: ["The review", "the review", "Retry to load the review."],
  design: ["Design", "Design", "Retry to load Design."],
  browser: ["The preview", "the preview", "Retry to load the preview."],
  terminal: [
    "The terminal",
    "the terminal",
    "Terminal reconnects automatically.",
  ],
};

export async function runWorkbenchStatusSmoke({ page, check, harnessBase }) {
  const screenshotDirectory = process.env.ZEROS_UI_SMOKE_SCREENSHOT_DIR;
  if (screenshotDirectory)
    await mkdir(screenshotDirectory, { recursive: true });
  const screenshot = async (type, state, theme = "dark") => {
    if (screenshotDirectory)
      await page.screenshot({
        path: join(screenshotDirectory, `${type}-${state}-${theme}.png`),
        animations: "disabled",
      });
  };
  const banner = () => page.locator("[data-workbench-banner]:visible");
  const empty = () => page.locator("[data-workbench-empty]:visible");
  const noToast = () =>
    expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await page.clock.install();
  for (const type of types) {
    await page.goto(`${harnessBase}/harness-workbench-status.html`);
    await page.waitForFunction(() => !!window.workbenchStatusFixture);
    await page.evaluate((type) => {
      const fixture = window.workbenchStatusFixture;
      fixture.state("setting_up");
      fixture.connection("disconnected");
      fixture.render(type, {
        target: `cold-${type}`,
        surface: "contract",
        active: true,
      });
    }, type);
    await expect(banner()).toHaveCount(1);
    await expect(banner()).toContainText(
      "This cloud workspace is still setting up.",
    );
    await expect(banner().getByRole("button")).toHaveCount(0);
    await expect(empty()).toHaveCount(1);
    await expect(empty()).toHaveText(copy[type][2]);
    await noToast();
    await screenshot(type, "setting-up");

    await page.evaluate(() => {
      const fixture = window.workbenchStatusFixture;
      fixture.state("ready");
      fixture.connection("connected");
    });
    await expect(banner()).toHaveCount(0);
    await expect(page.locator("[data-confirmed-content]:visible")).toHaveCount(
      1,
    );
    // A cold exact target under a lost connection exercises the quiet centre.
    await page.evaluate((type) => {
      const fixture = window.workbenchStatusFixture;
      fixture.connection("disconnected");
      fixture.render(type, { target: `reconnect-${type}` });
    }, type);
    await page.clock.fastForward(1_900);
    await expect(banner()).toHaveCount(0);
    await page.clock.fastForward(200);
    await expect(banner()).toHaveCount(1);
    await expect(banner()).toContainText("Reconnecting to the workspace…");
    await expect(empty()).toHaveCount(1);
    await screenshot(type, "reconnecting");
    await page.clock.fastForward(18_000);
    await expect(banner()).toContainText("Can't reach the workspace.");
    await noToast();
    await screenshot(type, "unreachable");

    const before = await banner().boundingBox();
    await banner().evaluate((element) => {
      window.fixtureBannerElement = element;
      window.fixtureBannerChanges = [];
      const observer = new MutationObserver(() =>
        window.fixtureBannerChanges.push(element.hidden),
      );
      observer.observe(element, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
      window.fixtureBannerObserver = observer;
    });
    await page.evaluate(() => window.workbenchStatusFixture.hold(true));
    const retry = banner().getByRole("button", {
      name: `Retry loading ${copy[type][1]}`,
      exact: true,
    });
    await retry.click();
    await expect(retry).toBeDisabled();
    await expect(retry).toHaveText("Retrying…");
    await page.evaluate(() =>
      window.fixtureBannerElement.querySelector("button").click(),
    );
    expect(
      await page.evaluate(
        () => window.workbenchStatusFixture.bridge.reconnects,
      ),
    ).toBe(1);
    expect(
      await banner().evaluate(
        (element) => element === window.fixtureBannerElement,
      ),
    ).toBe(true);
    expect(await banner().boundingBox()).toMatchObject({
      y: before.y,
      height: before.height,
    });
    expect(
      await page.evaluate(() => window.fixtureBannerChanges.includes(true)),
    ).toBe(false);
    await page.evaluate(() => window.workbenchStatusFixture.release());
    await expect(banner()).toHaveCount(0);
    await expect(empty()).toHaveCount(0);
    expect(
      await page
        .locator("[data-workbench-banner]")
        .evaluate((element) => element === window.fixtureBannerElement),
    ).toBe(true);
    await page.evaluate(() => window.fixtureBannerObserver.disconnect());

    await page.evaluate((type) => {
      const fixture = window.workbenchStatusFixture;
      fixture.fail("Error: Request timeout: engine disconnected");
      fixture.render(type, { target: `failure-${type}` });
    }, type);
    await expect(banner()).toHaveCount(1);
    await expect(banner()).toContainText(
      `${copy[type][0]} took too long to load.`,
    );
    await expect(empty()).toHaveText(copy[type][2]);
    await expect(empty().getByRole("button")).toHaveCount(0);
    await expect(banner().getByRole("button")).toHaveCount(1);
    await noToast();
    await screenshot(type, "load-failure");
    // Recovery comes from revalidation, without pressing Retry.
    await page.evaluate(() => window.workbenchStatusFixture.fail(null));
    await expect(banner()).toHaveCount(0);
    await page.evaluate(() =>
      window.workbenchStatusFixture.fail("Comments unavailable", true),
    );
    await expect(banner()).toContainText(`Couldn't load ${copy[type][1]}.`);
    await expect(page.locator("[data-confirmed-content]:visible")).toHaveCount(
      1,
    );
    await expect(empty()).toHaveCount(0);
    if (type === "changes") {
      await page.getByRole("button", { name: "Changes scope: Branch" }).click();
      await page
        .getByRole("menuitem", { name: "Commits", exact: true })
        .hover();
      await expect(
        page.getByRole("menuitemcheckbox", { name: "All Commits" }),
      ).toBeVisible();
      await expect(
        page.getByText("History is unavailable.", { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText("Comments unavailable", { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Retry commit history" }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    }
    await banner().getByRole("button").click();
    await expect(banner()).toHaveCount(0);
    await page.evaluate(() =>
      window.workbenchStatusFixture.fail("Comments unavailable", true),
    );
    await expect(banner()).toHaveCount(1);

    await page.evaluate((type) => {
      const fixture = window.workbenchStatusFixture;
      fixture.render(type, { active: false });
      fixture.connection("disconnected");
    }, type);
    const readsWhileHidden = await page.evaluate(
      () => window.workbenchStatusFixture.reads.length,
    );
    await page.clock.fastForward(25_000);
    expect(
      await page.evaluate(() => window.workbenchStatusFixture.reads.length),
    ).toBe(readsWhileHidden);
    await expect(
      page.locator("[data-workbench-banner] [role=status]"),
    ).toHaveAttribute("aria-live", "off");
    await page.evaluate(
      (type) => window.workbenchStatusFixture.render(type, { active: true }),
      type,
    );
    await expect(banner()).toContainText("Can't reach the workspace.");
    check(
      `${type}: one banner, quiet centre, grace/escalation, single-flight stable Retry, automatic recovery and hidden inertness`,
      true,
    );
  }

  await page.goto(`${harnessBase}/harness-workbench-status.html`);
  await page.waitForFunction(() => !!window.workbenchStatusFixture);
  await page.evaluate(() => {
    const fixture = window.workbenchStatusFixture;
    fixture.fail(
      "A long transport diagnostic with no user-facing bridge jargon",
    );
    fixture.render("files", { target: "shared", copies: 2 });
  });
  await expect(banner()).toHaveCount(2);
  await page.evaluate(() => {
    const fixture = window.workbenchStatusFixture;
    fixture.fail(null);
    fixture.hold(true);
  });
  await banner().first().getByRole("button").click();
  await expect(banner().last().getByRole("button")).toHaveText("Retrying…");
  await expect(banner().last().getByRole("button")).toBeDisabled();
  await page.evaluate(() => window.workbenchStatusFixture.release());
  await expect(banner()).toHaveCount(0);
  await page.evaluate(() => {
    const fixture = window.workbenchStatusFixture;
    fixture.fail("Old workspace error");
    fixture.render("files", { target: "old", copies: 1 });
  });
  await expect(banner()).toHaveCount(1);
  await page.evaluate(() => {
    const fixture = window.workbenchStatusFixture;
    fixture.hold(true);
    fixture.render("files", { workspace: "a", target: "late" });
  });
  await page.evaluate(() =>
    window.workbenchStatusFixture.render("files", {
      workspace: "b",
      target: "current",
    }),
  );
  await page.evaluate(() => window.workbenchStatusFixture.release());
  await expect(banner()).toHaveCount(0);
  await expect(page.locator("[data-confirmed-content]:visible")).toHaveCount(1);
  check(
    "Exact workspace/target switching isolates late failures; equivalent tabs share status and Retry",
    true,
  );

  await page.setViewportSize({ width: 240, height: 500 });
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "light");
    const fixture = window.workbenchStatusFixture;
    fixture.fail("Very long raw diagnostic ".repeat(30));
    fixture.render("files", { workspace: "b", target: "light-narrow" });
  });
  await expect(banner()).toHaveCount(1);
  const narrowRetry = banner().getByRole("button");
  await expect(narrowRetry).toBeVisible();
  const retryBox = await narrowRetry.boundingBox();
  expect(retryBox.x + retryBox.width).toBeLessThanOrEqual(240);
  await expect(banner().locator(".line-clamp-2")).toHaveCSS(
    "-webkit-line-clamp",
    "2",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => window.workbenchStatusFixture.state("setting_up"));
  await expect(banner().locator("svg")).toHaveCSS("animation-name", "none");
  await screenshot("files", "setting-up-narrow", "light");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  check(
    "Narrow Light layout keeps the action visible, clamps copy, and respects reduced motion",
    true,
  );

  // Exercise actual feature adapters, in addition to the exhaustive frame contract.
  await page.setViewportSize({ width: 460, height: 650 });
  for (const type of ["files", "design", "review"]) {
    await page.goto(`${harnessBase}/harness-workbench-status.html`);
    await page.waitForFunction(() => !!window.workbenchStatusFixture);
    await page.evaluate((type) => {
      const fixture = window.workbenchStatusFixture;
      fixture.fail("Request timeout: engine disconnected");
      fixture.render(type, { target: `real-${type}`, surface: "feature" });
    }, type);
    await expect(banner()).toHaveCount(1);
    await expect(empty()).toHaveCount(1);
    await expect(empty()).toHaveText(copy[type][2]);
    await expect(
      page.getByText("Choose a Design directory in repository settings.", {
        exact: true,
      }),
    ).not.toBeVisible();
    await noToast();
    await screenshot(type, "feature-load-failure");
    await page.evaluate(async () => {
      window.workbenchStatusFixture.fail(null);
      await window.workbenchStatusFixture.refreshFeature();
    });
    await expect(banner()).toHaveCount(0);
    if (type === "design")
      await expect(
        page.getByRole("button", {
          name: "Create design directory",
          exact: true,
        }),
      ).toBeVisible();
    else
      await expect(
        page.getByText(
          type === "files" ? "Confirmed file content" : "Confirmed description",
          { exact: true },
        ),
      ).toBeVisible();
    // Confirmed feature content is preserved on subsequent exact-key failure.
    if (type !== "design") {
      await page.evaluate(async () => {
        window.workbenchStatusFixture.fail("engine disconnected");
        await window.workbenchStatusFixture.refreshFeature();
      });
      await expect(banner()).toHaveCount(1);
      await expect(empty()).toHaveCount(0);
      await expect(
        page.getByText(
          type === "files" ? "Confirmed file content" : "Confirmed description",
          { exact: true },
        ),
      ).toBeVisible();
    }
    check(
      `${type}: real feature reads use the frame, recover truthfully, and retain confirmed content`,
      true,
    );
  }

  // The real iframe source owns content confirmation, rather than admission.
  await page.goto(`${harnessBase}/harness-workbench-status.html`);
  await page.waitForFunction(() => !!window.workbenchStatusFixture);
  let releasePreview;
  const heldPreview = new Promise((resolve) => {
    releasePreview = resolve;
  });
  await page.route("http://status-preview.invalid/**", async (route) => {
    await heldPreview;
    await route.fulfill({
      contentType: "text/html",
      body: "<p>Confirmed preview content</p>",
    });
  });
  await page.evaluate(() =>
    window.workbenchStatusFixture.render("browser", {
      surface: "feature",
      target: "real-browser",
    }),
  );
  await expect(page.locator("iframe")).toHaveAttribute(
    "src",
    "http://status-preview.invalid/real-browser",
  );
  await page.clock.fastForward(31_000);
  await expect(banner()).toContainText("The preview took too long to load.");
  await expect(empty()).toHaveText(copy.browser[2]);
  await noToast();
  await screenshot("browser", "feature-load-failure");
  const previewRetry = banner().getByRole("button", {
    name: "Retry loading the preview",
  });
  await previewRetry.click();
  await expect(previewRetry).toBeDisabled();
  releasePreview();
  await expect(banner()).toHaveCount(0);
  await expect(
    page.frameLocator("iframe").getByText("Confirmed preview content"),
  ).toBeVisible();
  await page.locator("iframe").dispatchEvent("error");
  await expect(banner()).toContainText("Couldn't load the preview.");
  await expect(empty()).toHaveCount(0);
  await expect(
    page.frameLocator("iframe").getByText("Confirmed preview content"),
  ).toBeVisible();
  await page.locator("iframe").dispatchEvent("load");
  await expect(banner()).toHaveCount(0);
  await noToast();
  await page.unroute("http://status-preview.invalid/**");
  check(
    "browser: real iframe timeout and retry recover, while warm failures retain the confirmed preview",
    true,
  );
}
