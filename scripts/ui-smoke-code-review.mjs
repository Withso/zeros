import { chromium, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";

/** Real Pierre/CodeMirror selection and discussion controls, with deterministic
 * transport fixtures. Cache, authority and persistence have adjacent unit tests. */
export async function runCodeReviewSmoke({
  page,
  check = () => {},
  harnessBase,
}) {
  const base =
    harnessBase ??
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses`;
  const open = async () => {
    await page.goto(`${base}/harness-code-review.html`);
    await expect(page.getByTestId("code-review-harness")).toBeVisible();
    await expect(
      page.locator('[data-review-thread="workspace:local"]'),
    ).toBeVisible();
  };
  const thread = (id) => page.locator(`[data-review-thread="${id}"]`);
  const composer = () => page.locator("[data-review-composer]");
  const input = () => composer().locator("textarea");
  const toolbar = () => page.locator("[data-review-selection-toolbar]");
  const last = () => page.getByTestId("review-last-action");
  const line = (number, side) =>
    page
      .locator(
        `${side ? `[data-${side}] ` : ""}[data-gutter] [data-column-number="${number}"]`,
      )
      .first();
  const commentOnRange = async (start, end = start, side) => {
    await line(start, side).click();
    if (end !== start) await line(end, side).click({ modifiers: ["Shift"] });
    await toolbar()
      .getByRole("button", { name: "Comment", exact: true })
      .click();
    await expect(input()).toBeFocused();
  };

  await open();
  await expect(thread("workspace:local").locator("strong")).toHaveText(
    "exact workspace key",
  );
  await expect(thread("workspace:local").locator("pre")).toContainText(
    "readSnapshot",
  );
  await expect(
    thread("check:check").getByRole("button", { name: "Reply", exact: true }),
  ).toHaveCount(0);
  await expect(thread("check:check").locator("time")).toHaveCount(0);
  await expect(thread("workspace:stale")).toHaveAttribute(
    "data-review-anchor-state",
    "outdated",
  );
  check(
    "Review Markdown, human/bot/agent attribution and read-only check annotations render inline",
    true,
  );

  await commentOnRange(2, 3);
  await expect(composer()).toHaveAccessibleName("Comment on lines 2–3");
  await input().fill("Range feedback survives a failed submission.");
  await page.getByTestId("review-fail-next").click();
  await input().press("Control+Enter");
  await expect(composer().getByRole("alert")).toContainText("draft is kept");
  await expect(input()).toHaveValue(
    "Range feedback survives a failed submission.",
  );
  await input().press("Control+Enter");
  await expect(last()).toHaveText("workspace create file 2–3");
  await expect(composer()).toHaveCount(0);
  check(
    "Native Files range selection creates an exact range comment and preserves failed drafts",
    true,
  );

  await thread("workspace:local")
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await input().fill("Confirmed in this workspace.");
  await input().press("Control+Enter");
  await expect(thread("workspace:local")).toContainText(
    "Confirmed in this workspace.",
  );
  await thread("workspace:local")
    .getByRole("button", { name: "Resolve", exact: true })
    .click();
  await expect(
    thread("workspace:local").getByRole("button", {
      name: "Expand resolved discussion",
    }),
  ).toBeVisible();
  await expect(
    thread("workspace:local").locator("[data-review-comment-body]"),
  ).toHaveCount(0);
  await thread("workspace:local")
    .getByRole("button", { name: "Reopen", exact: true })
    .click();
  await expect(thread("workspace:local")).toContainText(
    "Confirmed in this workspace.",
  );
  check(
    "Replies survive resolve and reopen, with resolved threads collapsed",
    true,
  );

  await open();
  await page.getByTestId("review-empty-local-page").click();
  const moreDiscussions = page.getByRole("button", {
    name: "Load more discussions",
    exact: true,
  });
  await expect(moreDiscussions).toBeVisible();
  await page.getByTestId("review-fail-next").click();
  await moreDiscussions.click();
  await expect(page.getByRole("alert")).toContainText(
    "Fixture submission failed",
  );
  await expect(moreDiscussions).toBeEnabled();
  await moreDiscussions.click();
  await expect(
    thread("workspace:history").locator("[data-review-comment-body]"),
  ).toHaveCount(64);
  check(
    "Empty partial review pages remain loadable and failed pagination can be retried",
    true,
  );

  await open();
  await page.getByTestId("review-paginate-local").click();
  const history = thread("workspace:history");
  const historyComments = history.locator("[data-review-comment-body]");
  await expect(historyComments).toHaveCount(64);
  await moreDiscussions.click();
  await expect(historyComments).toHaveCount(128);
  await page.getByTestId("review-history-preview").click();
  await expect(historyComments).toHaveCount(129);
  const moreReplies = history.getByRole("button", {
    name: "Load more replies",
    exact: true,
  });
  await page.getByTestId("review-fail-next").click();
  await moreReplies.click();
  await expect(history.getByRole("alert")).toContainText(
    "Fixture submission failed",
  );
  await expect(historyComments).toHaveCount(129);
  await moreReplies.click();
  await expect(historyComments).toHaveCount(193);
  await moreReplies.click();
  await expect(historyComments).toHaveCount(200);
  await expect(moreReplies).toHaveCount(0);
  await expect(historyComments).toHaveText(
    Array.from(
      { length: 200 },
      (_, index) => `Workspace history ${index + 1}.`,
    ),
  );
  check(
    "Thread pagination reaches every reply in order while preserving mutation-preview gaps",
    true,
  );

  await open();
  await commentOnRange(1);
  await input().fill("Pending review text.");
  await page.getByTestId("review-hold-submissions").click();
  await input().press("Control+Enter");
  await expect(composer()).toHaveAttribute("aria-busy", "true");
  await input().fill("A second thought while posting.");
  await page.getByTestId("review-toggle-hidden").click();
  await expect(input()).toBeHidden();
  await expect(
    page.getByTestId("review-viewer").locator("[inert]").first(),
  ).toHaveCount(1);
  await page.getByTestId("review-release-submissions").click();
  await page.getByTestId("review-toggle-hidden").click();
  await expect(input()).toHaveValue("A second thought while posting.");
  await expect(composer()).not.toHaveAttribute("aria-busy", "true");
  await input().press("Escape");
  await expect(composer()).toHaveCount(0);
  check(
    "Hidden retained review surfaces are inert and preserve text typed during a pending post",
    true,
  );

  await open();
  await page.getByTestId("review-change-code").click();
  await expect(thread("workspace:local")).toHaveAttribute(
    "data-review-anchor-state",
    "outdated",
  );
  await expect(thread("workspace:local")).toContainText("Original code");
  await page.getByTestId("review-toggle-error").click();
  await expect(page.getByRole("alert")).toContainText(
    "Last confirmed comments are retained",
  );
  await expect(thread("github:remote-new")).toContainText("Review bot");
  check(
    "Source changes expose outdated anchors and failed refreshes retain confirmed discussions",
    true,
  );

  await open();
  await page.getByTestId("review-mode-diff").click();
  await page.getByTestId("review-toggle-split").click();
  await expect(thread("github:remote-old")).toHaveAttribute(
    "data-review-anchor-state",
    "current",
  );
  await expect(thread("github:remote-new")).toHaveAttribute(
    "data-review-anchor-state",
    "current",
  );
  await commentOnRange(9, 11, "deletions");
  await expect(composer()).toHaveAccessibleName("Comment on Old lines 9–11");
  await expect(
    composer().getByRole("button", { name: "Post to PR", exact: true }),
  ).toHaveCount(0);
  await input().fill("Review the original range.");
  await input().press("Control+Enter");
  await expect(last()).toHaveText("workspace create old 9–11");
  await page.getByTestId("review-toggle-confirmed").click();
  await commentOnRange(11, 11, "additions");
  await composer()
    .getByRole("button", { name: "Post to PR", exact: true })
    .click();
  await input().fill("Publish this exact added line.");
  await input().press("Control+Enter");
  await expect(last()).toHaveText("github create new 11–11");
  check(
    "Split diff selections preserve old/new sides and only confirmed PR diffs offer public posting",
    true,
  );

  for (const change of ["review-change-pr-base", "review-change-pr"]) {
    await open();
    await page.getByTestId("review-mode-diff").click();
    await page.getByTestId("review-toggle-split").click();
    await page.getByTestId("review-toggle-confirmed").click();
    await commentOnRange(11, 11, "deletions");
    await composer()
      .getByRole("button", { name: "Post to PR", exact: true })
      .click();
    await input().fill("Keep this draft on its original PR revision.");
    await page.getByTestId(change).click();
    await input().press("Control+Enter");
    await expect(composer().getByRole("alert")).toContainText("changed");
    await expect(input()).toHaveValue(
      "Keep this draft on its original PR revision.",
    );
    await expect(last()).toHaveText("Ready");
  }
  check(
    "Open public drafts cannot move to another base or PR with the same head",
    true,
  );

  await open();
  await page.getByTestId("review-mode-edit").click();
  await page
    .getByRole("button", { name: "Comment on line 2", exact: true })
    .click();
  await expect(input()).toBeFocused();
  await input().fill("Comment from the source editor.");
  await input().press("Control+Enter");
  await expect(last()).toHaveText("workspace create file 2–2");
  const editor = page.locator(".cm-content[contenteditable=true]");
  await editor.focus();
  await editor.press("Control+Home");
  await editor.press("Control+Shift+M");
  await expect(input()).toBeFocused();
  await input().fill("Keyboard review.");
  await input().press("Escape");
  await expect(composer()).toHaveCount(0);
  check(
    "Files edit supports native gutter comments and keyboard-only creation/cancellation",
    true,
  );

  await open();
  await page.getByTestId("review-mode-diff").click();
  await page.getByTestId("review-toggle-hunks").click();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(last()).toHaveText("accepted hunk");
  await expect(
    page.getByRole("button", { name: "Accepted", exact: true }),
  ).toBeVisible();
  check("Hunk review controls are embedded in the live diff", true);

  await page.getByTestId("review-mode-conflict").click();
  const conflictEditor = page.locator(".cm-content[contenteditable=true]");
  await conflictEditor.focus();
  await conflictEditor.press("Control+Home");
  await conflictEditor.pressSequentially("// manual unsaved edit");
  await conflictEditor.press("Enter");
  // A preview based on disk must never replace unrelated unsaved editor text.
  const currentChoice = page.getByRole("button", {
    name: "Current",
    exact: true,
  });
  await expect
    .poll(
      async () =>
        (await currentChoice.count()) === 0 ||
        (await currentChoice.isDisabled()),
    )
    .toBe(true);
  await expect(conflictEditor).toContainText("// manual unsaved edit");
  await expect(last()).not.toHaveText("save resolution");
  check("Conflict controls preserve a separate unsaved source draft", true);

  await open();
  await page.getByTestId("review-mode-conflict").click();
  const saveResolution = page.getByRole("button", {
    name: "Save resolution",
    exact: true,
  });
  await expect(saveResolution).toBeDisabled();
  await page.getByRole("button", { name: "Both", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("'workspace'");
  await expect(page.locator(".cm-content")).toContainText("'shared'");
  await expect(page.locator(".cm-content")).not.toContainText("<<<<<<<");
  await expect(saveResolution).toBeEnabled();
  const normalSave = page.getByRole("button", { name: "Save", exact: true });
  if (await normalSave.count()) await expect(normalSave).toBeDisabled();
  await page.getByTestId("review-hold-submissions").click();
  await saveResolution.click();
  await expect(page.getByTestId("review-release-submissions")).toBeEnabled();
  await expect(
    page.getByRole("button", {
      name: "Discard resolution preview",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(page.locator(".cm-content")).toHaveAttribute(
    "contenteditable",
    "false",
  );
  await page.getByTestId("review-release-submissions").click();
  await expect(last()).toHaveText("save resolution");
  check(
    "Conflict choices preview in the real editor and save through the guarded resolution action",
    true,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const origin = process.argv[2];
  if (!origin) throw new Error("Pass a running Vite server origin.");
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage({
      viewport: { width: 1180, height: 900 },
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await runCodeReviewSmoke({
      page,
      harnessBase: `${origin}/apps/desktop/src/renderer/harnesses`,
      check: (name) => console.log(`ok: ${name}`),
    });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}
