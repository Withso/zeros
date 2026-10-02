/* global window */
import { chromium, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";

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
    await page
      .locator(`[data-gutter] [data-column-number="${line}"]`)
      .first()
      .click();
    await page
      .locator("[data-review-selection-toolbar]")
      .getByRole("button", { name: "Comment", exact: true })
      .click();
    await expect(input).toBeFocused();
  };
  const publicTarget = composer.getByRole("button", {
    name: "Post to PR",
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
