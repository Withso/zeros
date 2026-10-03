/* global window */
import { expect } from "@playwright/test";

export async function runCodeReviewRetentionSmoke({
  page,
  check,
  harnessBase,
}) {
  const errors = [];
  const onError = (error) => errors.push(error.message);
  page.on("pageerror", onError);
  try {
    await page.goto(`${harnessBase}/harness-review-retention.html`);
    await page.waitForFunction(() => !!window.reviewRetentionFixture);
    for (const mode of ["source", "diff"]) {
      for (const [start, end] of [
        [0, 80],
        [80, 160],
      ]) {
        const retained = await page.evaluate(
          ({ start, end, mode }) => {
            const fixture = window.reviewRetentionFixture;
            for (let index = start; index < end; index++)
              fixture.show(`file-${index}.ts`, mode);
            return fixture.retainedSources();
          },
          { start, end, mode },
        );
        expect(retained.snapshots).toEqual([`file-${end - 1}.ts`]);
        expect(retained.prepared).toEqual([`file-${end - 1}.ts`]);
      }
      check(
        `Review ${mode} navigation retains only the displayed source after 160 same-owner files`,
        true,
      );
    }

    await page.evaluate(() => window.reviewRetentionFixture.show("file-0.ts"));
    const viewer = page.locator("[data-reviewed-code-view]");
    const draft = page.getByPlaceholder("Write a comment…");
    await viewer.focus();
    await page.keyboard.press("Control+Shift+M");
    await draft.fill("Keep the original file draft");
    await page.evaluate(() => window.reviewRetentionFixture.show("file-1.ts"));
    await viewer.focus();
    await page.keyboard.press("Control+Shift+M");
    await draft.fill("Comment on the current file");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.reviewRetentionFixture.posted.map(
            (entry) => entry.anchor.path,
          ),
        ),
      )
      .toEqual(["file-1.ts"]);
    await page.evaluate(() => window.reviewRetentionFixture.show("file-0.ts"));
    await viewer.focus();
    await page.keyboard.press("Control+Shift+M");
    await expect(draft).toHaveValue("Keep the original file draft");
    check(
      "File navigation preserves draft text and directs keyboard comments to the displayed source",
      true,
    );

    const multiple = await page.evaluate(() => {
      const fixture = window.reviewRetentionFixture;
      fixture.showMultiple(["old-a.ts", "old-b.ts", "kept.ts"]);
      const before = ["old-a.ts", "old-b.ts", "kept.ts"].every((path) =>
        fixture.hasSnapshot(path),
      );
      fixture.showMultiple(["kept.ts", "new-a.ts", "new-b.ts"]);
      return {
        before,
        current: ["kept.ts", "new-a.ts", "new-b.ts"].every((path) =>
          fixture.hasSnapshot(path),
        ),
        removed: ["old-a.ts", "old-b.ts"].some((path) =>
          fixture.hasSnapshot(path),
        ),
      };
    });
    expect(multiple).toEqual({ before: true, current: true, removed: false });
    check(
      "Multi-file review retains the whole displayed set and releases sources removed from it",
      true,
    );
    expect(errors).toEqual([]);
  } finally {
    page.off("pageerror", onError);
  }
}
