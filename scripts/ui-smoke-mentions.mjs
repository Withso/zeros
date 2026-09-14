import { expect } from "@playwright/test";

export async function runMentionsSmoke({ page, check }) {
  const url = new URL(page.url());
  await page.goto(
    `${url.origin}/apps/desktop/src/renderer/harnesses/harness-mentions.html`,
  );
  // ProseMirror's contenteditable carries the accessible label without an
  // explicit textbox role in some TipTap builds.
  const input = page.locator('.composer-pm[contenteditable="true"]');
  await input.waitFor({ state: "visible" });
  const typeQuery = async (query) => {
    await input.fill("");
    await input.pressSequentially(`@${query}`);
  };

  await typeQuery("rollout");
  await expect(
    page.getByRole("button", { name: /rollout.jsonl/ }),
  ).toBeVisible();
  await input.press("Enter");
  await expect(input.locator("[data-mention-pill]")).toHaveText(
    "rollout.jsonl",
  );
  await input.press("Enter");
  await expect(page.locator("[data-mention-sent]")).toContainText(
    ".context/attachments/rollout.jsonl",
  );
  check(
    "@ selects an ignored .context attachment and preserves its full path",
    true,
  );

  await typeQuery("Screenshot");
  await page.getByRole("button", { name: /Screenshot at 7.31 AM.png/ }).click();
  await expect(input.locator("[data-mention-pill]")).toHaveText(
    "Screenshot at 7.31 AM.png",
  );
  check("@ selects attachment filenames containing spaces", true);

  await typeQuery(".empty");
  await expect(
    page.getByRole("button", { name: /.empty\/.*Folder/ }),
  ).toBeVisible();
  await input.press("Tab");
  await expect(input.locator("[data-mention-pill]")).toHaveText(".empty/");
  check("@ mentions empty hidden folders using Tab", true);

  await typeQuery("new-attachment");
  await expect(page.getByText("No matches.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create attachment" }).click();
  await expect(
    page.getByRole("button", { name: /new-attachment.txt/ }),
  ).toBeVisible();
  check("new attachments refresh an already-open @ query", true);

  await page.getByRole("button", { name: "Switch workspace" }).click();
  await expect(
    page.getByRole("button", { name: /new-attachment.txt/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Switch workspace" }).click();
  await expect(
    page.getByRole("button", { name: /new-attachment.txt/ }),
  ).toBeVisible();
  check("@ results follow A → B → A workspace changes", true);

  // Hold the bridge response: a new query must show matching confirmed paths
  // without waiting for I/O. An unknown query must still be honestly loading.
  await page.evaluate(() => window.mentionHarness.pause());
  await typeQuery("roll");
  await expect(
    page.getByRole("button", { name: /rollout.jsonl/ }),
  ).toBeVisible();
  await page.waitForFunction(() => window.mentionHarness.pending() > 0);
  check(
    "a new @ query shows warm matches while its bridge read is paused",
    true,
  );
  await typeQuery("does-not-exist");
  await expect(page.locator('[aria-busy="true"]')).toBeVisible();
  await page.evaluate(() => window.mentionHarness.resume());
  await expect(page.getByText("No matches.", { exact: true })).toBeVisible();
  check(
    "an incomplete warm index cannot claim an authoritative empty result",
    true,
  );

  await typeQuery("");
  const rollout = page.getByRole("button", { name: /rollout.jsonl/ });
  await expect(rollout).toBeVisible();
  await input.press("ArrowDown");
  await expect(rollout).toHaveClass(/!bg-bg1-hover/);
  await page.evaluate(() => {
    window.mentionHarness.pause();
    window.mentionHarness.addPath("a.ts");
  });
  await page.waitForFunction(() => window.mentionHarness.pending() > 0);
  await expect(rollout).toHaveClass(/!bg-bg1-hover/);
  await page.evaluate(() => window.mentionHarness.resume());
  await expect(page.getByRole("button", { name: /^a.ts/ })).toBeVisible();
  await expect(rollout).toHaveClass(/!bg-bg1-hover/);
  await input.press("Enter");
  await expect(input.locator("[data-mention-pill]")).toHaveText(
    "rollout.jsonl",
  );
  check(
    "background refresh and reordered rows preserve the mention Enter accepts",
    true,
  );
}
