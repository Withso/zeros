import { chromium, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { runReviewComparisonSmoke } from "./ui-smoke-review-comparison.mjs";
import { runCodeReviewFocusSmoke } from "./ui-smoke-code-focus.mjs";

/** Drive the retained gutter anchor through real document input, including a
 * document edit while the pointer still owns a gutter drag. */
export async function runEditorReviewAnchorSmoke({
  page,
  check = () => {},
  harnessBase,
  duringDrag = false,
}) {
  const base =
    harnessBase ??
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses`;
  const errors = [];
  const onPageError = (error) => errors.push(error.message);
  const onConsole = (message) => {
    // CodeMirror may report a caught event-handler exception to the console.
    if (
      message.type() === "error" &&
      /Invalid line number/.test(message.text())
    )
      errors.push(message.text());
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  let pointerHeld = false;
  try {
    await page.goto(`${base}/harness-code-review.html`);
    await page.getByTestId("review-mode-edit").click();
    const editor = page.locator(".cm-content[contenteditable=true]");
    const composer = page.locator("[data-review-composer]");
    const toolbar = page.locator("[data-review-selection-toolbar]");
    // The comment + replaces the number of the line under the pointer.
    const line = (number) =>
      page.getByRole("button", {
        name: `Comment on line ${number}`,
        exact: true,
      });
    const hoverLine = (number) =>
      page.locator(".cm-line").nth(number - 1).hover();

    await hoverLine(4);
    if (duringDrag) {
      await line(4).hover();
      await page.mouse.down();
      pointerHeld = true;
    } else {
      await line(4).click();
      await expect(composer).toHaveAccessibleName("Comment on line 4");
      await composer
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
    }
    await editor.focus();
    await editor.press("ControlOrMeta+A");
    await page.keyboard.insertText("one line");
    await expect(editor.locator(".cm-line")).toHaveCount(1);
    await expect(editor.locator(".cm-line")).toHaveText("one line");

    if (duringDrag) {
      await page.locator(".cm-lineNumbers .cm-gutterElement").filter({ hasText: /^1$/ }).hover();
      await page.mouse.up();
      pointerHeld = false;
      expect(
        errors,
        "shortening the document must cancel the old gutter drag",
      ).toEqual([]);
      await expect(toolbar).toHaveCount(0);
      await expect(composer).toHaveCount(0);
    }
    await hoverLine(1);
    await line(1).click({ modifiers: ["Shift"] });
    expect(
      errors,
      "the retained gutter anchor must belong to the current document",
    ).toEqual([]);
    // A number click or Shift range opens the composer straight away.
    await expect(toolbar).toHaveCount(0);
    await expect(composer).toHaveAccessibleName("Comment on line 1");
    const input = composer.locator("textarea");
    await expect(input).toBeFocused();
    await input.fill("Comment after shortening the source document.");
    await input.press("ControlOrMeta+Enter");
    await expect(page.getByTestId("review-last-action")).toHaveText(
      "workspace create file 1–1",
    );
    expect(errors).toEqual([]);
    check(
      duringDrag
        ? "Files edit cancels a gutter drag when its document changes and permits a fresh range"
        : "Files edit bounds the retained Shift-click anchor after the document shrinks",
      true,
    );
  } finally {
    if (pointerHeld) await page.mouse.up();
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
  }
}

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
  // A number click opens the composer; Shift extends it to a range.
  const commentOnRange = async (start, end = start, side) => {
    await line(start, side).click();
    if (end !== start) await line(end, side).click({ modifiers: ["Shift"] });
    await expect(toolbar()).toHaveCount(0);
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
    composer().getByRole("tab", { name: "Pull request", exact: true }),
  ).toHaveCount(0);
  await input().fill("Review the original range.");
  await input().press("Control+Enter");
  await expect(last()).toHaveText("workspace create old 9–11");
  await page.getByTestId("review-toggle-confirmed").click();
  await commentOnRange(11, 11, "additions");
  await composer()
    .getByRole("tab", { name: "Pull request", exact: true })
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
      .getByRole("tab", { name: "Pull request", exact: true })
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
  const editorLine = (number) =>
    page.locator(".cm-line").nth(number - 1).hover();
  await editorLine(2);
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

  await editorLine(4);
  await page
    .getByRole("button", { name: "Comment on line 4", exact: true })
    .click();
  await composer().getByRole("button", { name: "Cancel", exact: true }).click();
  await editorLine(6);
  await page
    .getByRole("button", { name: "Comment on line 6", exact: true })
    .click({ modifiers: ["Shift"] });
  await expect(page.locator(".cm-selectionBackground").first()).toBeVisible();
  await expect(toolbar()).toHaveCount(0);
  await expect(composer()).toHaveAccessibleName("Comment on lines 4–6");
  await input().press("Escape");
  check(
    "Files edit preserves Shift-click ranges and native selection overlays",
    true,
  );

  for (const duringDrag of [false, true])
    await runEditorReviewAnchorSmoke({
      page,
      check,
      harnessBase: base,
      duringDrag,
    });

  await open();
  await page.getByTestId("review-mode-diff").click();
  await expect(page.locator("[data-gutter]").first()).toBeVisible();
  for (const name of ["Accept", "Reject", "Accepted", "Reject hunk"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  check("The live diff carries no hunk review controls", true);

  await page.getByTestId("review-mode-conflict").click();
  const conflictEditor = page.locator(".cm-content[contenteditable=true]");
  await conflictEditor.focus();
  await conflictEditor.press("Control+Home");
  await conflictEditor.pressSequentially("// manual unsaved edit");
  await conflictEditor.press("Enter");
  // An accept is an ordinary edit: it shares the draft and the undo history
  // with typed text, and nothing previews or saves separately.
  await expect(
    page.getByRole("button", { name: "Save resolution", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Accept both", exact: true })
    .click();
  await expect(conflictEditor).toContainText("'workspace'");
  await expect(conflictEditor).toContainText("'shared'");
  await expect(conflictEditor).not.toContainText("<<<<<<<");
  await expect(conflictEditor).toContainText("// manual unsaved edit");
  await conflictEditor.press("Control+z");
  await expect(conflictEditor).toContainText("<<<<<<<");
  await expect(conflictEditor).toContainText("// manual unsaved edit");
  check(
    "Conflict accepts and typed edits share one draft and undo history",
    true,
  );
  await runReviewComparisonSmoke({ page, check, harnessBase: base });
  await checkReviewAvailability({ page, check, harnessBase: base });
  await runCodeReviewFocusSmoke({ page, check, harnessBase: base });
}

async function checkReviewAvailability({ page, check, harnessBase }) {
  const screenshotDir = process.env.ZEROS_UI_SMOKE_SCREENSHOT_DIR;
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  await page.goto(`${harnessBase}/harness-code-review.html?loading`);
  await expect(page.getByTestId("code-review-harness")).toBeVisible();
  await page.getByTestId("review-mode-diff").click();
  await expect(page.locator("[data-gutter]").first()).toBeVisible();
  await expect(page.getByText("Loading comments…", { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-review-feedback]")).toHaveCount(0);
  check("A pending Changes comment read adds no text or padded feedback wrapper", true);

  await page.goto(`${harnessBase}/harness-code-review.html?cloud`);
  await expect(page.getByTestId("code-review-harness")).toBeVisible();
  for (const mode of ["preview", "diff", "edit"]) {
    await page.getByTestId(`review-mode-${mode}`).click();
    const editor = page.locator(".cm-content[contenteditable=true]");
    if (mode === "edit") {
      await expect(editor).toBeVisible();
      await expect(page.locator(".zeros-review-gutter")).toHaveCount(0);
      await editor.focus();
    } else {
      const line = page.locator('[data-gutter] [data-column-number]').first();
      await expect(line).toBeVisible();
      await line.click();
      await expect(page.locator('[data-gutter-utility]')).toHaveCount(0);
    }
    await page.keyboard.press("ControlOrMeta+Shift+m");
    await expect(page.locator("[data-review-composer]")).toHaveCount(0);
    await expect(page.locator("[data-review-selection-toolbar]")).toHaveCount(0);
  }
  await page.getByTestId("review-mode-diff").click();
  await expect(page.locator("[data-gutter]").first()).toBeVisible();
  for (const name of ["Accept", "Reject"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  check("Cloud Files, editor and Changes expose no comment creation or hunk review", true);
  for (const theme of ["dark", "light"]) {
    await page.evaluate(async theme => {
      const { setPrefs } = await import("/apps/desktop/src/renderer/shared/theme/store.ts");
      setPrefs({ mode: theme });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, theme);
    if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/cloud-changes-comments-${theme}.png`, animations: "disabled" });
  }
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
