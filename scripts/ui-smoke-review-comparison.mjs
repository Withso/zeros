/* global window */
import { chromium, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";

/** An `Etc/GMT` zone whose local hour is `hour` right now. Its sign is
 * inverted: Etc/GMT+2 is two hours behind UTC. */
function zoneAtLocalHour(hour) {
  const offset = ((hour - new Date().getUTCHours() + 36) % 24) - 12;
  return offset === 0 ? "Etc/GMT" : `Etc/GMT${offset < 0 ? "+" : "-"}${Math.abs(offset)}`;
}

/** Real ReviewView must follow confirmed remote comparison changes without a
 * Git refresh-key bump, including changes during a shared pending diff read. */
export async function runReviewComparisonSmoke({
  page,
  check = () => {},
  harnessBase,
  scenario,
}) {
  const base =
    harnessBase ??
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses`;
  const errors = [];
  const onError = (error) => errors.push(error.message);
  page.on("pageerror", onError);
  const open = async (hold = false, cold = false, holdMetadata = false) => {
    const params = new URLSearchParams();
    if (hold) params.set("holdDiffs", "");
    if (cold) params.set("cold", "");
    if (holdMetadata) params.set("holdMetadata", "");
    await page.goto(`${base}/harness-review-comparison.html?${params}`);
    await expect(page.getByTestId("review-comparison-harness")).toBeVisible();
    const reads = expect.poll(() =>
      page.evaluate(() => window.reviewComparisonFixture.diffReads.length),
    );
    if (cold && !hold) await reads.toBeGreaterThanOrEqual(1);
    else await reads.toBe(1);
  };
  const marker = (baseSha, head = "a", pr = 42) =>
    page.getByRole("button", {
      name: new RegExp(`pr-${pr}-base-${baseSha}-head-${head}\\.ts`),
    });
  const composer = page.locator("[data-review-composer]");
  const input = composer.locator("textarea");
  const comment = async (line = 2) => {
    // A number click opens the composer straight away.
    await page
      .locator(`[data-gutter] [data-column-number="${line}"]`)
      .first()
      .click();
    await expect(input).toBeFocused();
  };
  // The composer's destination: the Pull request segment.
  const publicTarget = composer.getByRole("tab", {
    name: "Pull request",
    exact: true,
  });
  try {
    for (const mismatch of [false, true]) {
      const coldScenario = mismatch ? "cold-mismatch" : "cold";
      if (scenario && scenario !== coldScenario) continue;
      await open(true, true, true);
      // The published diff starts while BOTH metadata reads are still blocked.
      expect(
        await page.evaluate(() => window.reviewComparisonFixture.metadata()),
      ).toEqual({ pr: null, inline: null });
      const confirmedBase = mismatch ? "c" : "b";
      await page.evaluate(
        (baseSha) => window.reviewComparisonFixture.releaseMetadata(baseSha),
        confirmedBase,
      );
      await expect(
        page.getByRole("heading", { name: "Published comparison fixture" }),
      ).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => window.reviewComparisonFixture.metadata().inline?.baseSha,
          ),
        )
        .toBe(confirmedBase.repeat(40));
      await page.evaluate(() => window.reviewComparisonFixture.releaseDiff(1));
      if (mismatch) {
        await expect
          .poll(() =>
            page.evaluate(
              () => window.reviewComparisonFixture.diffReads.length,
            ),
          )
          .toBe(2);
        await expect(marker("b")).toHaveCount(0);
        expect(
          await page.evaluate(
            () => window.reviewComparisonFixture.diffReads[1],
          ),
        ).toMatchObject({ baseSha: "c".repeat(40) });
        await page.evaluate(() =>
          window.reviewComparisonFixture.releaseDiff(2),
        );
      }
      await expect
        .poll(
          async () => ({
            reads: await page.evaluate(
              () => window.reviewComparisonFixture.diffReads.length,
            ),
            visible: await marker(confirmedBase).isVisible(),
          }),
          {
            message:
              "The first matching cold response must render without another identical read",
          },
        )
        .toEqual({ reads: mismatch ? 2 : 1, visible: true });
      await comment();
      await expect(publicTarget).toBeVisible();
      await page.evaluate(() => window.reviewComparisonFixture.remount());
      await expect(marker(confirmedBase)).toBeVisible();
      expect(
        await page.evaluate(
          () => window.reviewComparisonFixture.diffReads.length,
        ),
      ).toBe(mismatch ? 2 : 1);
      check(
        mismatch
          ? "Cold ReviewView rejects a response that conflicts with newly known metadata and reads the current comparison"
          : "Cold ReviewView starts diff and metadata in parallel and publishes its first matching response once",
        true,
      );
    }

    if (!scenario || scenario === "cold-immediate") {
      // No resolved-promise awaits in the fixture's immediate metadata paths:
      // publication must survive a refinement after the transport has settled.
      await open(false, true);
      await expect
        .poll(async () => ({
          reads: await page.evaluate(
            () => window.reviewComparisonFixture.diffReads.length,
          ),
          visible: await marker("b").isVisible(),
        }))
        .toEqual({ reads: 1, visible: true });
      await comment();
      await expect(publicTarget).toBeVisible();
      expect(
        await page.evaluate(
          () => window.reviewComparisonFixture.diffReads.length,
        ),
      ).toBe(1);
      check(
        "Cold ReviewView with immediate metadata and diff responses makes one comparison read",
        true,
      );
    }

    if (!scenario || scenario === "base") {
      await open();
      await expect(marker("b")).toBeVisible();
      await comment();
      await publicTarget.click();
      await input.fill("Keep this draft attached to base B.");
      await page.evaluate(async () => {
        window.reviewComparisonFixture.holdDiffs();
        await window.reviewComparisonFixture.refreshReview("c");
      });
      await expect
        .poll(
          () =>
            page.evaluate(
              () => window.reviewComparisonFixture.diffReads.length,
            ),
          {
            message:
              "A confirmed same-head base change must request the new published comparison",
          },
        )
        .toBe(2);
      await expect(marker("b")).toBeVisible();
      await page.evaluate(() => window.reviewComparisonFixture.releaseDiff(2));
      await expect(marker("c")).toBeVisible();
      await expect(marker("b")).toHaveCount(0);
      await expect(input).toHaveValue("Keep this draft attached to base B.");
      await input.press("ControlOrMeta+Enter");
      await expect(composer.getByRole("alert")).toContainText("changed");
      expect(
        await page.evaluate(() => window.reviewComparisonFixture.posts),
      ).toEqual([]);
      await input.press("Escape");
      await comment(3);
      await publicTarget.click();
      await input.fill("Publish against the new base C.");
      await input.press("ControlOrMeta+Enter");
      await expect
        .poll(() =>
          page.evaluate(() => window.reviewComparisonFixture.posts.length),
        )
        .toBe(1);
      expect(
        await page.evaluate(() => window.reviewComparisonFixture.posts[0]),
      ).toMatchObject({
        prNumber: 42,
        baseSha: "c".repeat(40),
        commitSha: "a".repeat(40),
        body: "Publish against the new base C.",
      });
      check(
        "ReviewView refreshes a same-head base change, retains the old draft safely and restores current PR posting",
        true,
      );
    }

    if (!scenario || scenario === "race") {
      await open(true);
      await page.evaluate(() =>
        window.reviewComparisonFixture.refreshReview("c"),
      );
      await page.evaluate(() =>
        window.reviewComparisonFixture.refreshReview("d"),
      );
      await page.evaluate(() => window.reviewComparisonFixture.remount());
      expect(
        await page.evaluate(
          () => window.reviewComparisonFixture.diffReads.length,
        ),
      ).toBe(1);
      await page.evaluate(() => window.reviewComparisonFixture.releaseDiff(1));
      await expect
        .poll(
          () =>
            page.evaluate(
              () => window.reviewComparisonFixture.diffReads.length,
            ),
          {
            message:
              "The newest confirmed comparison must replace queued work after the old read settles",
          },
        )
        .toBe(2);
      expect(
        await page.evaluate(() => window.reviewComparisonFixture.diffReads[1]),
      ).toMatchObject({ baseSha: "d".repeat(40) });
      await expect(marker("b")).toHaveCount(0);
      await expect(marker("c")).toHaveCount(0);
      await page.evaluate(() => window.reviewComparisonFixture.releaseDiff(2));
      await expect(marker("d")).toBeVisible();
      await comment();
      await expect(publicTarget).toBeVisible();
      await page.evaluate(() => window.reviewComparisonFixture.remount());
      await expect(marker("d")).toBeVisible();
      expect(
        await page.evaluate(
          () => window.reviewComparisonFixture.diffReads.length,
        ),
      ).toBe(2);
      check(
        "ReviewView coalesces newer comparisons during a held read and remount without publishing the obsolete result",
        true,
      );
    }

    if (!scenario || scenario === "head") {
      await open();
      await expect(marker("b")).toBeVisible();
      await page.evaluate(() =>
        window.reviewComparisonFixture.refreshPrHead("e"),
      );
      await expect(marker("b", "e")).toBeVisible();
      await expect(marker("b")).toHaveCount(0);
      await comment();
      await expect(publicTarget).toBeVisible();
      expect(
        await page.evaluate(
          () => window.reviewComparisonFixture.diffReads.length,
        ),
      ).toBe(2);
      check(
        "ReviewView still follows a live PR head change and confirms the matching inline review",
        true,
      );
    }

    if (!scenario || scenario === "local-refresh") {
      await open();
      await expect(marker("b")).toBeVisible();
      const githubReads = () =>
        page.evaluate(() => ({
          diff: window.reviewComparisonFixture.diffReads.length,
          inline: window.reviewComparisonFixture.inlineReads.length,
        }));
      const before = await githubReads();
      // An agent writing files bumps the local refresh generation repeatedly.
      // Neither the published PR diff nor its inline review lives in the
      // worktree, so none of these reach GitHub.
      for (let bump = 0; bump < 4; bump += 1) {
        await page.evaluate(() =>
          window.reviewComparisonFixture.bumpLocalRefresh(),
        );
        await page.waitForTimeout(50);
      }
      await page.waitForTimeout(300);
      expect(await githubReads()).toEqual(before);
      await expect(marker("b")).toBeVisible();
      check(
        "ReviewView keeps the published PR diff and inline review through local refreshes",
        true,
      );
    }

    if (!scenario || scenario === "pr") {
      await open(true);
      await page.evaluate(() => window.reviewComparisonFixture.selectPr(43));
      await expect
        .poll(() =>
          page.evaluate(() => window.reviewComparisonFixture.diffReads.length),
        )
        .toBe(2);
      await page.evaluate(() => window.reviewComparisonFixture.releaseDiff(2));
      await expect(marker("b", "a", 43)).toBeVisible();
      await page.evaluate(() => window.reviewComparisonFixture.releaseDiff(1));
      await expect(marker("b")).toHaveCount(0);
      await comment();
      await publicTarget.click();
      await input.fill("This comment belongs to PR 43.");
      await input.press("ControlOrMeta+Enter");
      await expect
        .poll(() =>
          page.evaluate(() => window.reviewComparisonFixture.posts.length),
        )
        .toBe(1);
      expect(
        await page.evaluate(() => window.reviewComparisonFixture.posts[0]),
      ).toMatchObject({ prNumber: 43 });
      check(
        "ReviewView isolates an identical head/base pair by PR while the previous PR read is pending",
        true,
      );
    }

    // Overview (plans.md §1): the header in rows, five sub-tabs, Git status,
    // PR status holding the one Merge with only its blockers, Findings and
    // the rail — which folds into Details in a narrow pane.
    await page.goto(`${harnessBase}/harness-review-comparison.html?rich&sub=overview`, {
      waitUntil: "networkidle",
    });
    const prStatus = page.locator("[data-review-pr-status]");
    await expect(prStatus).toBeVisible();
    await expect(page.getByRole("tab")).toHaveText(["Overview", "Description", "Activity4", "Checks7", "Commits3"]);
    const overview = await page.evaluate(() => {
      const tab = document.querySelector('[role="tab"][data-state="active"]');
      const title = document.querySelector("[data-review-header] h2");
      const rails = [...document.querySelectorAll("[data-review-rail]")].filter((rail) => rail.getClientRects().length > 0);
      return {
        tab: tab ? { text: tab.textContent, height: tab.getBoundingClientRect().height } : null,
        title: title ? { text: title.textContent, size: getComputedStyle(title).fontSize, line: getComputedStyle(title).lineHeight } : null,
        blockers: [...document.querySelectorAll("[data-review-blocker]")].map((row) => row.textContent),
        findings: document.querySelectorAll("[data-review-finding]").length,
        visibleRails: rails.length,
        railBesideStatus:
          rails.length === 1 &&
          rails[0].getBoundingClientRect().left > document.querySelector("[data-review-pr-status]").getBoundingClientRect().right,
        headerMerge: document.querySelector("[data-review-header] [data-slot='split-button']") !== null,
      };
    });
    expect(overview).toMatchObject({
      tab: { text: "Overview", height: 28 },
      title: { text: "Fix login redirect loop", size: "18px", line: "28px" },
      blockers: ["test (ubuntu-latest) failedAdd to chat", "priya-shah requested changesAdd to chat"],
      findings: 2,
      visibleRails: 1,
      railBesideStatus: true,
      headerMerge: false,
    });
    // Merge waits while it is blocked: a quiet outline, not the green fill.
    const merge = prStatus.locator("[data-slot='split-button'] button").first();
    await expect(merge).toBeDisabled();
    expect(await merge.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    await page.setViewportSize({ width: 640, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const rails = [...document.querySelectorAll("[data-review-rail]")].filter((rail) => rail.getClientRects().length > 0);
          const details = document.querySelector('[aria-label="Details"]');
          return rails.length === 1 && !!details && details.contains(rails[0]);
        }),
      )
      .toBe(true);
    await page.setViewportSize({ width: 1180, height: 900 });
    check(
      "Review Overview reads in header rows with five sub-tabs, one Merge in PR status, Findings and a rail that folds into Details",
      true,
    );

    // A review App sits among the reviewers by name, with a Bot badge.
    const rail = page.locator("[data-review-rail]").filter({ visible: true });
    await expect(rail.getByText("coderabbitai", { exact: true })).toBeVisible();
    await expect(rail).not.toContainText("[bot]");
    await expect(rail.getByText("Bot", { exact: true })).toBeVisible();

    // The merge menu says what each method does to this PR's commits.
    await prStatus.getByRole("button", { name: "Choose merge method" }).click();
    const methods = page.getByRole("menuitemradio");
    await expect(methods).toHaveText([
      "Squash and mergeThe 3 commits land on main as one",
      "Create a merge commitAll 3 commits join main with a merge commit",
      "Rebase and mergeThe 3 commits replay onto main",
    ]);
    await expect(page.getByRole("menu").getByText("Merge method", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    check("The merge menu names the method and what it does to the commits", true);

    // Description, Activity, Checks and Commits sit in Overview's inset: a
    // section's left edge is the header title's.
    const alignedWithTitle = (label) =>
      page.evaluate((name) => {
        const section = document.querySelector(`section[aria-label="${name}"]`);
        const title = document.querySelector("[data-review-header] h2");
        return !!section && !!title && Math.round(section.getBoundingClientRect().left) === Math.round(title.getBoundingClientRect().left);
      }, label);

    await page.getByRole("tab", { name: "Description" }).click();
    await expect.poll(() => alignedWithTitle("Description")).toBe(true);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Pull request description" });
    await expect(editor).toHaveValue("Keeps `returnTo` through the OAuth state.\n\nFixes #31");
    await editor.fill("Keeps `returnTo` through the OAuth state.\n\nAlso covers SSO.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__descriptionWrites.at(-1))).toBe(
      "Keeps `returnTo` through the OAuth state.\n\nAlso covers SSO.",
    );
    await expect(editor).toHaveCount(0);
    await expect(page.locator('section[aria-label="Description"]')).toContainText("Also covers SSO.");
    check("Description sits in the inset, and Edit saves the body through the provider", true);

    await page.getByRole("tab", { name: /^Activity/ }).click();
    await expect.poll(() => alignedWithTitle("Activity")).toBe(true);
    await expect(page.getByRole("tablist", { name: "Show activity from" }).getByRole("tab")).toHaveText(["All", "People", "Bots1"]);
    const bot = page.locator("[data-review-bot-event]");
    await expect(bot).toHaveCount(1);
    await expect(bot).toContainText("coderabbitai");
    await expect(bot).toContainText("Bot");
    await bot.getByRole("button", { name: "Show" }).click();
    await expect(page.getByText("The session helpers now compare MACs in constant time.")).toBeVisible();
    await page.getByRole("button", { name: "Hide" }).click();
    await expect(bot).toHaveCount(1);
    await page.getByRole("tab", { name: "People" }).click();
    await expect(bot).toHaveCount(0);
    await expect(page.getByText("Please add a test for the SSO path.")).toBeVisible();
    await page.getByRole("tab", { name: /^Bots/ }).click();
    await expect(bot).toHaveCount(1);
    await expect(page.getByText("Please add a test for the SSO path.")).toHaveCount(0);
    await page.getByRole("tab", { name: "All" }).click();
    check("Activity filters All, People and Bots, and folds an App's review to one line until Show", true);

    await page.getByRole("tab", { name: /^Checks/ }).click();
    const summary = page.locator("[data-review-checks-summary]");
    await expect(summary).toBeVisible();
    await expect(summary.locator("[data-review-checks-count]")).toHaveText(["1failed", "1running", "5passed"]);
    await expect(summary.getByRole("button", { name: "Add failures to chat" })).toBeVisible();
    const deployment = page.locator('[data-review-deployment="Preview"]');
    await expect(deployment).toContainText("Ready");
    await expect(deployment.getByRole("link", { name: "Open" })).toHaveAttribute("href", "https://fixture-pr-42.preview.example.test");
    expect(
      await page.evaluate(() => {
        const card = document.querySelector("[data-review-checks-summary]");
        const title = document.querySelector("[data-review-header] h2");
        return Math.round(card.getBoundingClientRect().left) === Math.round(title.getBoundingClientRect().left);
      }),
    ).toBe(true);
    check("Checks open on a summary card with counts and Add failures to chat, and end with deployment cards", true);

    await page.getByRole("tab", { name: /^Commits/ }).click();
    await expect(page.locator("[data-review-commit]")).toHaveCount(3);
    await expect(page.locator('section[aria-label="Today"]')).toBeVisible();
    await expect(page.locator('section[aria-label="Yesterday"]')).toBeVisible();
    await expect(page.locator('[data-review-commit="a1b2c3d"]')).toContainText("Alex Morgan and Claude");
    check("Commits group by day with co-authors and the short SHA", true);

    // Just after local midnight, "2 hours ago" is already yesterday.
    const night = await page.context().browser().newContext({
      timezoneId: zoneAtLocalHour(1),
    });
    try {
      const nightPage = await night.newPage();
      nightPage.on("pageerror", onError);
      await nightPage.goto(`${base}/harness-review-comparison.html?rich&sub=commits`);
      await expect(nightPage.locator("[data-review-commit]")).toHaveCount(3);
      await expect(nightPage.locator('section[aria-label="Today"]')).toBeVisible();
      await expect(nightPage.locator('section[aria-label="Yesterday"]')).toBeVisible();
    } finally {
      await night.close();
    }
    check("Commits keep Today and Yesterday just after local midnight", true);
    expect(errors).toEqual([]);
  } finally {
    page.off("pageerror", onError);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const origin = process.argv[2];
  if (!origin) throw new Error("Pass a running Vite server origin.");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1180, height: 900 },
    });
    await runReviewComparisonSmoke({
      page,
      harnessBase: `${origin}/apps/desktop/src/renderer/harnesses`,
      check: (name) => console.log(`ok: ${name}`),
    });
  } finally {
    await browser.close();
  }
}
