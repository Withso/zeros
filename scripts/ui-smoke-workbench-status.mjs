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
    "Retry to reconnect the terminal.",
  ],
};
const pendingCopy = {
  files: "Files appear when the workspace is ready.",
  changes: "Changes appear when the workspace is ready.",
  review: "The review appears when the workspace is ready.",
  design: "Design appears when the workspace is ready.",
  browser: "The preview appears when the workspace is ready.",
  terminal: "The terminal opens when the workspace is ready.",
};
const unavailableCopy = {
  files: "Files aren't available.",
  changes: "Changes aren't available.",
  review: "The review isn't available.",
  design: "Design isn't available.",
  browser: "The preview isn't available.",
  terminal: "The terminal isn't available.",
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
  // Freeze fake time across each 10 s connection threshold: with the clock
  // running, CI latency between steps crossed its 100 ms assertion margin.
  // pauseAt refuses past targets, so jump 1 s past the page's current time.
  const pauseClock = async () =>
    page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  // Every tab retains its exact-key pixels through short and prolonged gaps.
  // Observe the DOM during the interval too: a banner/icon that flashes and
  // clears before an assertion is still a regression.
  for (const type of types) {
    await page.goto(`${harnessBase}/harness-workbench-status.html`);
    await page.waitForFunction(() => !!window.workbenchStatusFixture);
    await page.evaluate((type) => window.workbenchStatusFixture.render(type, {
      target: `calm-${type}`, surface: "contract", active: true,
    }), type);
    const content = page.locator("[data-confirmed-content]:visible");
    await expect(content).toHaveCount(1);
    const originalBox = await content.boundingBox();
    await page.evaluate(() => {
      window.fixtureTransientMutations = [];
      window.fixtureTransientObserver = new MutationObserver(() => {
        const visibleBanner = [...document.querySelectorAll("[data-workbench-banner]")]
          .some((element) => !element.hidden);
        const empty = document.querySelector("[data-workbench-empty]");
        if (visibleBanner || empty) window.fixtureTransientMutations.push("status flash");
      });
      window.fixtureTransientObserver.observe(document.querySelector("main"), {
        subtree: true, attributes: true, childList: true,
      });
      window.workbenchStatusFixture.connection("disconnected");
    });
    await page.clock.fastForward(3_000);
    await expect(banner()).toHaveCount(0);
    await expect(empty()).toHaveCount(0);
    await expect(content).toHaveCount(1);
    expect(await content.boundingBox()).toEqual(originalBox);
    await screenshot(type, "3s-blip");
    await page.evaluate(() => window.workbenchStatusFixture.connection("connected"));
    expect(await page.evaluate(() => window.fixtureTransientMutations)).toEqual([]);
    await page.evaluate(() => window.fixtureTransientObserver.disconnect());
    // A read rejected by the same brief transport gap must not spend its
    // silent retry while offline, then flash a read banner during recovery.
    await page.evaluate(() => {
      const fixture = window.workbenchStatusFixture;
      window.fixtureGapReadCount = fixture.reads.length;
      fixture.hold(true);
      fixture.fail("Workspace transport disconnected");
    });
    await page.waitForFunction(() =>
      window.workbenchStatusFixture.reads.length > window.fixtureGapReadCount,
    );
    await page.evaluate(() => {
      const fixture = window.workbenchStatusFixture;
      fixture.connection("disconnected");
      fixture.release();
    });
    await page.clock.runFor(3_000);
    await expect(banner()).toHaveCount(0);
    await expect(content).toHaveCount(1);
    await page.evaluate(() => {
      const fixture = window.workbenchStatusFixture;
      fixture.hold(true);
      fixture.fail(null);
      fixture.connection("connected");
    });
    await expect(banner()).toHaveCount(0);
    await expect(empty()).toHaveCount(0);
    await expect(content).toHaveCount(1);
    await page.evaluate(() => window.workbenchStatusFixture.release());
    await expect(banner()).toHaveCount(0);
    await page.clock.runFor(1_600);
    await expect(banner()).toHaveCount(0);
    await page.evaluate(() => window.workbenchStatusFixture.connection("disconnected"));
    await page.clock.fastForward(15_000);
    await expect(banner()).toContainText("Reconnecting to the workspace…");
    await expect(content).toHaveCount(1);
    await expect(empty()).toHaveCount(0);
    await screenshot(type, "15s-gap");
    await page.evaluate(() => window.workbenchStatusFixture.connection("connected"));
    await expect(banner()).toHaveCount(0);
    await page.evaluate(() => window.workbenchStatusFixture.connection("disconnected"));
    await page.clock.fastForward(60_000);
    await expect(banner()).toContainText("Can't reach the workspace.");
    await expect(banner().getByRole("button")).toHaveText("Retry");
    await expect(content).toHaveCount(1);
    await expect(empty()).toHaveCount(0);
    await screenshot(type, "60s-gap");
    await page.evaluate(() => window.workbenchStatusFixture.connection("connected"));
    await expect(banner()).toHaveCount(0);

    await page.evaluate((type) => {
      const fixture = window.workbenchStatusFixture;
      fixture.failNextReads(1);
      fixture.render(type, { target: `once-${type}` });
    }, type);
    await expect(banner()).toHaveCount(0);
    await expect(empty()).toHaveCount(0);
    await page.clock.runFor(1_600);
    await expect(content).toHaveCount(1);
    await expect(banner()).toHaveCount(0);
    await expect(empty()).toHaveCount(0);
    await screenshot(type, "read-fails-once");
    await page.evaluate((type) => {
      const fixture = window.workbenchStatusFixture;
      fixture.failNextReads(2);
      fixture.render(type, { target: `twice-${type}` });
    }, type);
    await expect(banner()).toHaveCount(0);
    await expect(empty()).toHaveCount(0);
    await page.clock.runFor(1_600);
    await expect(banner()).toContainText(`Couldn't load ${copy[type][1]}.`);
    await expect(empty()).toHaveText(copy[type][2]);
    // The frame centres its fallback inside the remaining body, including
    // Design: no icon can be pushed against the bottom by retained children.
    const frameBox = await page.locator("[data-workbench-frame]").boundingBox();
    const bannerBox = await banner().boundingBox();
    const iconBox = await empty().locator("svg").boundingBox();
    expect(iconBox.y).toBeGreaterThan(bannerBox.y + bannerBox.height);
    expect(iconBox.y + iconBox.height).toBeLessThan(frameBox.y + frameBox.height - 40);
    await screenshot(type, "read-fails-twice");
    await noToast();
    check(`${type}: 3s quiet blip, 15s pending, 60s Retry, retained content, one silent read retry`, true);
  }
  for (const type of types) {
    await page.goto(`${harnessBase}/harness-workbench-status.html?cold=1`);
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
    await expect(empty()).toHaveText(pendingCopy[type]);
    await noToast();
    await screenshot(type, "setting-up");

    for (const [state, message] of [
      ["starting", "Starting the cloud workspace…"],
      ["stopping", "Stopping the cloud workspace…"],
      ["stopped", "Sleeping — resumes when you continue"],
      ["archived", "This cloud workspace is archived."],
    ]) {
      await page.evaluate(
        (state) => window.workbenchStatusFixture.state(state),
        state,
      );
      await expect(banner()).toContainText(message);
      await expect(banner().getByRole("button")).toHaveCount(0);
      await expect(empty()).toHaveText(
        state === "archived" ? unavailableCopy[type] : pendingCopy[type],
      );
      await noToast();
      await screenshot(type, state);
    }

    // Readiness starts a cold connection interval with no initial flash.
    await pauseClock();
    await page.evaluate(() => window.workbenchStatusFixture.state("ready"));
    await expect(banner()).toHaveCount(0);
    await page.clock.fastForward(9_900);
    await expect(banner()).toHaveCount(0);
    await page.clock.fastForward(200);
    await expect(banner()).toContainText("Connecting…");
    await expect(empty()).toHaveText(pendingCopy[type]);
    await noToast();
    await screenshot(type, "connecting");
    await page.clock.resume();

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
    await pauseClock();
    await page.evaluate((type) => {
      const fixture = window.workbenchStatusFixture;
      fixture.connection("disconnected");
      fixture.render(type, { target: `reconnect-${type}` });
    }, type);
    await page.clock.fastForward(9_900);
    await expect(banner()).toHaveCount(0);
    await page.clock.fastForward(200);
    await expect(banner()).toHaveCount(1);
    await expect(banner()).toContainText("Reconnecting to the workspace…");
    await expect(empty()).toHaveCount(1);
    await expect(empty()).toHaveText(
      type === "terminal"
        ? "Terminal reconnects automatically."
        : pendingCopy[type],
    );
    await screenshot(type, "reconnecting");
    await page.clock.resume();
    await page.clock.fastForward(35_000);
    await expect(banner()).toContainText("Can't reach the workspace.");
    await expect(empty()).toHaveText(copy[type][2]);
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
    // Even a read that never settles releases the flight within thirty seconds.
    await page.clock.fastForward(30_000);
    await expect(retry).toBeEnabled();
    await expect(retry).toHaveText("Retry");
    expect(
      await banner().evaluate(
        (element) => element === window.fixtureBannerElement,
      ),
    ).toBe(true);
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
    await page.clock.runFor(1_600);
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
    await page.clock.runFor(1_600);
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
    await page.clock.runFor(1_600);
    await expect(banner()).toHaveCount(1);

    await page.evaluate((type) => {
      const fixture = window.workbenchStatusFixture;
      fixture.render(type, { active: false });
      fixture.connection("disconnected");
    }, type);
    const readsWhileHidden = await page.evaluate(
      () => window.workbenchStatusFixture.reads.length,
    );
    await page.clock.fastForward(60_000);
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
  await page.clock.runFor(1_600);
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
  await page.clock.runFor(1_600);
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

  // Portal-owned Terminal/Setup sources must follow document visibility too.
  await page.goto(`${harnessBase}/harness-workbench-status.html`);
  await page.waitForFunction(() => !!window.workbenchStatusFixture);
  await page.evaluate(() => {
    const fixture = window.workbenchStatusFixture;
    fixture.fail("Read unavailable");
    fixture.render("terminal", { target: "hidden-document", copies: 1, surface: "contract" });
  });
  await page.clock.runFor(100);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("[data-workbench-banner] [role=status]")).toHaveAttribute("aria-live", "off");
  const hiddenReads = await page.evaluate(() => window.workbenchStatusFixture.reads.length);
  await page.clock.fastForward(5_000);
  expect(await page.evaluate(() => window.workbenchStatusFixture.reads.length)).toBe(hiddenReads);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(1_600);
  await expect(banner()).toContainText("Couldn't load the terminal.");
  check("Portal-owned Terminal/Setup sources stop silent retry timers while the document is hidden", true);

  await page.goto(`${harnessBase}/harness-workbench-status.html`);
  await page.waitForFunction(() => !!window.workbenchStatusFixture);
  await page.evaluate(() => {
    const fixture = window.workbenchStatusFixture;
    fixture.failNextReads(1);
    fixture.render("terminal", { target: "hidden-flight", surface: "contract" });
  });
  await page.clock.runFor(100);
  await page.evaluate(() => window.workbenchStatusFixture.hold(true));
  await page.clock.runFor(1_500);
  const inFlightReads = await page.evaluate(() => window.workbenchStatusFixture.reads.length);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(200);
  expect(await page.evaluate(() => window.workbenchStatusFixture.reads.length)).toBe(inFlightReads);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(banner()).toHaveCount(0);
  await expect(empty()).toHaveCount(0);
  await page.evaluate(() => window.workbenchStatusFixture.release());
  await expect(page.locator("[data-confirmed-content]:visible")).toHaveCount(1);
  await expect(banner()).toHaveCount(0);
  expect(await page.evaluate(() => window.workbenchStatusFixture.reads.length)).toBe(inFlightReads);
  check("An in-flight silent retry stays quiet across document hiding and reveal without a second request", true);

  for (const kind of ["connect", "open"]) {
    await page.goto(`${harnessBase}/harness-workbench-status.html`);
    await page.waitForFunction(() => !!window.workbenchStatusFixture);
    // A failed admission can coexist with a still-connected older peer.
    await page.evaluate(
      (kind) => window.workbenchStatusFixture.connectFailure(kind),
      kind,
    );
    await expect(banner()).toContainText("Can't reach the workspace.");
    await banner().getByRole("button").click();
    await expect(banner()).toHaveCount(0);
    expect(
      await page.evaluate(
        () => window.workbenchStatusFixture.bridge.reconnects,
      ),
    ).toBe(1);
    await page.evaluate((kind) => {
      const fixture = window.workbenchStatusFixture;
      fixture.connection("disconnected");
      fixture.connectFailure(kind);
    }, kind);
    await expect(banner()).toContainText("Can't reach the workspace.");
    await noToast();
    await page.evaluate(() =>
      window.workbenchStatusFixture.render("files", { active: false }),
    );
    await expect(banner()).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]")).toContainText(
      kind === "connect"
        ? "Couldn't connect to this cloud workspace"
        : "Couldn't open this cloud workspace",
    );
    await page.evaluate(() =>
      window.workbenchStatusFixture.render("files", { active: true }),
    );
    await page.clock.fastForward(1_000);
    await expect(banner()).toContainText("Can't reach the workspace.");
    await noToast();
    await page.evaluate(() =>
      window.workbenchStatusFixture.connection("connected"),
    );
    await expect(banner()).toHaveCount(0);
    await page.evaluate(() =>
      window.workbenchStatusFixture.render("files", { active: false }),
    );
    await noToast();
  }
  check(
    "Cloud connect/open failures hand off between the banner and original toast without doubling",
    true,
  );

  // Use the prior connected fixture for the narrow layout below.
  await page.evaluate(() =>
    window.workbenchStatusFixture.render("files", {
      active: true,
      workspace: "b",
    }),
  );

  await page.setViewportSize({ width: 240, height: 500 });
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "light");
    const fixture = window.workbenchStatusFixture;
    fixture.fail("Very long raw diagnostic ".repeat(30));
    fixture.render("files", { workspace: "b", target: "light-narrow" });
  });
  await page.clock.runFor(1_600);
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
    await page.clock.runFor(1_600);
    await expect(banner()).toHaveCount(1);
    await expect(empty()).toHaveCount(1);
    await expect(empty()).toHaveText(
      type === "files" ? "Retry to load this file." : copy[type][2],
    );
    await expect(banner()).toContainText(
      type === "files"
        ? "This file took too long to load."
        : `${copy[type][0]} took too long to load.`,
    );
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
    {
      await page.evaluate(async () => {
        window.workbenchStatusFixture.fail("engine disconnected");
        await window.workbenchStatusFixture.refreshFeature();
      });
      await page.clock.runFor(1_600);
      await expect(banner()).toHaveCount(1);
      await expect(empty()).toHaveCount(0);
      await expect(type === "design"
        ? page.getByRole("button", { name: "Create design directory", exact: true })
        : page.getByText(
          type === "files" ? "Confirmed file content" : "Confirmed description",
          { exact: true },
        )
      ).toBeVisible();
      await screenshot(type, "feature-retained-content");
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
  await expect(banner()).toHaveCount(0);
  await expect(empty()).toHaveCount(0);
  await page.clock.runFor(1_600);
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
  await expect(banner()).toHaveCount(0);
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
