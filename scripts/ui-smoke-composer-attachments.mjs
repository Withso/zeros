import { expect } from "@playwright/test";

export async function runComposerAttachmentsSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  const url = `${origin}/apps/desktop/src/renderer/harnesses/harness-composer-attachments.html`;
  await page.goto(url);
  await page
    .getByRole("button", { name: "Attach transcript", exact: true })
    .click();
  await page.waitForFunction(
    () => window.composerAttachmentsHarness.records().length === 2,
  );
  const saved = await page.evaluate(() =>
    window.composerAttachmentsHarness.records(),
  );
  const pill = page.locator("[data-attachment-pill]");
  await pill.hover();
  const preview = page.locator('[data-slot="hover-card-content"]');
  await expect(preview).toBeVisible();
  check(
    "the opened staged preview contains the selected transcript",
    await expect(preview)
      .toContainText("The staged transcript body must remain visible.")
      .then(
        () => true,
        () => false,
      ),
  );
  const beforeRemove = await page.evaluate(
    () => window.composerAttachmentsHarness.operations().length,
  );
  await page
    .getByRole("button", { name: "Remove transcript.txt", exact: true })
    .click();
  await expect(pill).toHaveCount(0);
  expect(
    await page.evaluate(() => window.composerAttachmentsHarness.records()),
  ).toEqual(saved);
  expect(
    await page.evaluate(
      (count) =>
        window.composerAttachmentsHarness
          .operations()
          .slice(count)
          .filter(
            (op) => !["workspace.list", "file.tree", "file.read"].includes(op),
          ),
      beforeRemove,
    ),
  ).toEqual([]);
  check("removing a composer pill retains its completed context record", true);

  await page
    .getByRole("button", { name: "Restore transcript", exact: true })
    .click();
  await pill.hover();
  await expect(preview).toBeVisible();
  check(
    "a restored transcript previews the file after its scope moved",
    await expect(preview)
      .toContainText("Restored transcript from its saved shared file.")
      .then(
        () => true,
        () => false,
      ),
  );
  await page.mouse.move(750, 500);
  await expect(preview).toBeHidden();
  await page
    .getByRole("button", { name: "Clear composer", exact: true })
    .click();
  await expect(pill).toHaveCount(0);
  expect(
    await page.evaluate(() => window.composerAttachmentsHarness.records()),
  ).toHaveLength(3);
  check("clearing the composer leaves saved context files intact", true);

  await page.goto(`${url}?edit`);
  const remove = page.getByRole("button", {
    name: "Remove notes.txt",
    exact: true,
  });
  await expect(remove).toBeEnabled();
  await page
    .getByRole("button", { name: "Resend edited prompt", exact: true })
    .click();
  await expect(
    page.locator('.composer-pm[contenteditable="false"]'),
  ).toBeVisible();
  check(
    "an edit submission disables attachment removal",
    await remove.isDisabled(),
  );
  // A queued click must also respect the live editor gate before React repaints.
  await remove.dispatchEvent("click");
  check(
    "an edit submission ignores attachment removal events",
    (await page.locator("[data-attachment-pill]").count()) === 1,
  );
  const lockedCut = await page.locator(".composer-pm").evaluate((element) => {
    const editor = element.editor;
    editor.commands.selectAll();
    const before = editor.getJSON();
    const clipboardData = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("cut", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
    return {
      before,
      after: editor.getJSON(),
      copied: clipboardData.getData("text/plain"),
    };
  });
  expect(lockedCut.copied).toContain("Inspect the attached file");
  expect(lockedCut.copied).toContain("/att-original/notes.txt");
  check(
    "cut copies the selection without deleting a submitting edit",
    JSON.stringify(lockedCut.after) === JSON.stringify(lockedCut.before),
  );
  await page.evaluate(() => window.composerAttachmentsHarness.failEdit());
  await expect(
    page.locator('.composer-pm[contenteditable="true"]'),
  ).toBeVisible();
  check(
    "a failed submission retains the full draft after a cut attempt",
    JSON.stringify(
      await page.locator(".composer-pm").evaluate((element) =>
        element.editor.getJSON(),
      ),
    ) === JSON.stringify(lockedCut.before),
  );
  if (await remove.count()) {
    await expect(remove).toBeEnabled();
    await remove.click();
    await expect(page.locator("[data-attachment-pill]")).toHaveCount(0);
    expect(
      await page.evaluate(() => window.composerAttachmentsHarness.records()),
    ).toHaveLength(1);
    check(
      "failed resubmission restores removal without deleting the saved file",
      true,
    );
  }
  const cutAfterFailure = await page.locator(".composer-pm").evaluate(
    (element) => {
      element.editor.commands.selectAll();
      const clipboardData = new DataTransfer();
      element.dispatchEvent(
        new ClipboardEvent("cut", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
      return {
        empty: element.editor.isEmpty,
        copied: clipboardData.getData("text/plain"),
      };
    },
  );
  check(
    "cut deletes the selection again after a failed submission unlocks the editor",
    cutAfterFailure.empty &&
      cutAfterFailure.copied.includes("Inspect the attached file"),
  );
}
