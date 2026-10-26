import { expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

/** Exercises the installed Pierre editor and the ordinary file-write route,
 * including full-document saves, retained drafts and transport races. */
export async function runFileEditorSmoke({ page, check = () => {} }) {
  const fixture = await page
    .context()
    .browser()
    .newPage({ viewport: { width: 1180, height: 850 } });
  await fixture.addInitScript(() => {
    if (new URL(location.href).searchParams.has("reset")) localStorage.clear();
  });
  const errors = [];
  fixture.on("pageerror", (error) => errors.push(error.message));
  const url = `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-file-editor.html`;
  const options = () =>
    fixture.getByRole("button", { name: "File options", exact: true });
  const menu = () => fixture.getByRole("dialog", { name: "File options" });
  const source = () =>
    fixture.locator(".cm-content[contenteditable=true]:visible");
  const diff = () =>
    fixture.locator("[data-editable-diff] [contenteditable=true]:visible");
  const dirty = () => fixture.getByLabel("Unsaved changes", { exact: true });
  const disk = () => fixture.evaluate(() => window.__fileEditor.disk());
  const prepend = async (editor, text) => {
    await editor.click();
    await editor.press("ControlOrMeta+Home");
    await fixture.keyboard.insertText(text);
  };
  const toggle = async (name) => {
    await options().click();
    await menu().getByRole("switch", { name }).click();
    await fixture.keyboard.press("Escape");
  };
  const act = async (name) => {
    await options().click();
    await menu()
      .getByRole("button", {
        name: name === "Save file" ? /^Save file/ : name,
        exact: true,
      })
      .click();
  };
  await mkdir(".context/files-editor", { recursive: true });
  try {
    for (const owner of ["personal", "organization", "cloud"]) {
      await fixture.goto(`${url}?owner=${owner}&reset`);
      await expect(source()).toBeVisible();
      const original = await disk();
      await options().click();
      await expect(
        menu().getByRole("switch", { name: "Auto save" }),
      ).toBeChecked();
      await expect(
        menu().getByRole("switch", { name: "Diff view" }),
      ).not.toBeChecked();
      await fixture.keyboard.press("Escape");
      await prepend(source(), "// automatic\n");
      await expect.poll(disk).toBe("// automatic\n" + original);
      await expect(dirty()).toHaveCount(0);
      await expect(
        fixture.getByRole("button", { name: "Save", exact: true }),
      ).toHaveCount(0);

      await toggle("Auto save");
      await prepend(source(), "// draft\n");
      await expect(dirty()).toHaveCount(1);
      await fixture.waitForTimeout(650); // beyond the autosave debounce, which is disabled
      expect(await disk()).toBe("// automatic\n" + original);
      await act("Discard changes");
      await expect(dirty()).toHaveCount(0);
      await expect(source()).not.toContainText("// draft");
      await toggle("Diff view");
      await expect(diff()).toBeVisible();
      await expect(
        fixture.getByRole("button", { name: "Split view", exact: true }),
      ).toHaveCount(0);
      await expect(
        fixture.locator("[data-diffs-type=split]:visible"),
      ).toHaveCount(0);
      await prepend(diff(), "// diff draft\n");
      await expect(dirty()).toHaveCount(1);
      await diff().press("ControlOrMeta+z");
      await expect(dirty()).toHaveCount(0);
      await diff().press("ControlOrMeta+Shift+z");
      await expect(dirty()).toHaveCount(1);
      await diff().press("ControlOrMeta+s");
      const saved = "// diff draft\n// automatic\n" + original;
      await expect.poll(disk).toBe(saved);
      await expect(dirty()).toHaveCount(0);
      expect(
        await fixture.evaluate(() =>
          window.__fileEditor
            .requests()
            .some(
              (request) =>
                request.op === "git.diff" &&
                request.params?.fullContext === true,
            ),
        ),
      ).toBe(true);

      await prepend(diff(), "// retained\n");
      await toggle("Diff view");
      await expect(source()).toContainText("// retained");
      await toggle("Diff view");
      await expect(diff()).toContainText("// retained");
      await act("Save file");
      await expect.poll(disk).toBe("// retained\n" + saved);

      // A held write plus further typing must result in two ordered saves.
      await fixture.evaluate(() => window.__fileEditor.hold());
      await toggle("Auto save");
      await prepend(diff(), "// first save\n");
      await expect
        .poll(() => fixture.evaluate(() => window.__fileEditor.pending()))
        .toBe(1);
      await prepend(diff(), "// typed while saving\n");
      await fixture.evaluate(() => window.__fileEditor.release());
      await expect
        .poll(disk)
        .toBe("// typed while saving\n// first save\n// retained\n" + saved);
      await expect(dirty()).toHaveCount(0);

      await fixture.evaluate(() => window.__fileEditor.fail());
      await prepend(diff(), "// retry me\n");
      await expect(
        fixture.getByText("Fixture write failed", { exact: true }),
      ).toBeVisible();
      await expect(dirty()).toHaveCount(1);
      const attempts = await fixture.evaluate(
        () => window.__fileEditor.writes().length,
      );
      await fixture.waitForTimeout(650);
      expect(
        await fixture.evaluate(() => window.__fileEditor.writes().length),
      ).toBe(attempts);
      await act("Save file");
      await expect.poll(disk).toContain("// retry me\n");
      await expect(dirty()).toHaveCount(0);

      await toggle("Auto save");
      const row = fixture.locator('[data-item-path="sample.ts"]');
      await expect(row.locator('[data-item-section="decoration"]')).toHaveText(
        "M",
      );
      await expect(
        fixture
          .getByRole("tab", { name: "sample.ts", exact: true })
          .getByTitle("Modified"),
      ).toHaveText("M");
      for (const theme of ["dark", "light"]) {
        await fixture.evaluate(
          (value) => window.__fileEditor.theme(value),
          theme,
        );
        const colors = await row.evaluate((element) => {
          const content = element.querySelector(
            '[data-item-section="content"]',
          );
          const letter = element.querySelector(
            '[data-item-section="decoration"] span',
          );
          return {
            row: getComputedStyle(element).color,
            content: getComputedStyle(content).color,
            letter: getComputedStyle(letter).color,
          };
        });
        expect(colors.content).toBe(colors.row);
        expect(colors.letter).not.toBe(colors.content);
        if (owner === "personal") {
          await options().click();
          await expect(menu()).toHaveCSS("opacity", "1");
          await fixture.screenshot({
            path: `.context/files-editor/options-${theme}.png`,
          });
          await fixture.keyboard.press("Escape");
        }
      }
      // Persisted off remains off after remount; Diff view remains selected.
      await fixture.goto(`${url}?owner=${owner}`);
      await expect(diff()).toBeVisible();
      await options().click();
      await expect(
        menu().getByRole("switch", { name: "Auto save" }),
      ).not.toBeChecked();
      await expect(
        menu().getByRole("switch", { name: "Diff view" }),
      ).toBeChecked();
      await fixture.keyboard.press("Escape");
      await fixture.evaluate(() => window.__fileEditor.open("empty.txt"));
      await expect(diff()).toBeVisible();
      await prepend(diff(), "first line");
      await diff().press("ControlOrMeta+s");
      await expect
        .poll(() =>
          fixture.evaluate(() => window.__fileEditor.disk("empty.txt")),
        )
        .toBe("first line");
      await fixture.evaluate(() => window.__fileEditor.open("crlf.ts"));
      await expect(diff()).toBeVisible();
      await diff().click();
      await diff().press("ControlOrMeta+End");
      await fixture.keyboard.insertText(" last");
      await diff().press("ControlOrMeta+s");
      await expect
        .poll(() => fixture.evaluate(() => window.__fileEditor.disk("crlf.ts")))
        .toBe("first\r\nsecond\r\nthird last");
      // A staged re-add may already match the All comparison's base. Its
      // porcelain label must not invent an all-additions diff.
      await fixture.evaluate(() => window.__fileEditor.open("restored.ts"));
      await expect(diff()).toBeVisible();
      await expect(
        fixture.locator(
          '[data-editable-diff] [data-line-type="change-addition"]:visible',
        ),
      ).toHaveCount(0);
      // A clean tracked file still has editable rows, and clearing the entire
      // writable side saves an empty file without deleting its Git baseline.
      await fixture.evaluate(() => window.__fileEditor.open("clean.ts"));
      await expect(diff()).toBeVisible();
      await diff().click();
      await diff().press("ControlOrMeta+a");
      await diff().press("Backspace");
      await diff().press("ControlOrMeta+s");
      await expect
        .poll(() =>
          fixture.evaluate(() => window.__fileEditor.disk("clean.ts")),
        )
        .toBe("");
      await prepend(diff(), "replacement\n");
      await diff().press("ControlOrMeta+s");
      await expect
        .poll(() =>
          fixture.evaluate(() => window.__fileEditor.disk("clean.ts")),
        )
        .toBe("replacement\n");
      await fixture.evaluate(() => window.__fileEditor.open("notes.md"));
      await fixture.getByRole("button", { name: "edit", exact: true }).click();
      await expect(diff()).toBeVisible();
      await prepend(diff(), "Draft notes\n");
      await fixture
        .getByRole("button", { name: "preview", exact: true })
        .click();
      await expect(diff()).toHaveCount(0);
      await fixture.getByRole("button", { name: "edit", exact: true }).click();
      await expect(diff()).toContainText("Draft notes");
      await toggle("Diff view");
      await expect(source()).toContainText("Draft notes");
      await toggle("Diff view");
      await expect(diff()).toContainText("Draft notes");
      await fixture
        .getByRole("tab", { name: "sample.ts", exact: true })
        .click();
      await expect(diff()).not.toContainText("Draft notes");
      await expect(dirty()).toHaveCount(1);
      await fixture.getByRole("tab", { name: "notes.md", exact: true }).click();
      await expect(diff()).toContainText("Draft notes");
      await act("Discard changes");
      await expect(dirty()).toHaveCount(0);
      // Undo in Files never modifies the immutable old side, and a genuine
      // external update replaces only this exact file's editor session.
      await fixture.evaluate(() =>
        window.__fileEditor.external("notes.md", "# External update\n"),
      );
      await expect(diff()).toContainText("External update");
      await expect(diff()).not.toContainText("Draft notes");
      await fixture.evaluate(() => window.__fileEditor.switchOwner());
      await expect(diff()).not.toContainText("External update");
      await expect(
        fixture.getByRole("tab", { name: "sample.ts", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await fixture.evaluate(() => window.__fileEditor.switchOwner());
      await expect(diff()).toContainText("External update");
      // A write may finish after its File tab is explicitly closed. Its result
      // must never recreate a dirty tab or modify the newly selected editor.
      await fixture.evaluate(() => window.__fileEditor.hold());
      await prepend(diff(), "Held save\n");
      await diff().press("ControlOrMeta+s");
      await expect
        .poll(() => fixture.evaluate(() => window.__fileEditor.pending()))
        .toBe(1);
      await fixture
        .getByRole("button", { name: "Close notes.md", exact: true })
        .click({ force: true });
      await fixture.evaluate(() => window.__fileEditor.release());
      await expect
        .poll(() =>
          fixture.evaluate(() => window.__fileEditor.disk("notes.md")),
        )
        .toBe("Held save\n# External update\n");
      await expect(dirty()).toHaveCount(0);
      await expect(
        fixture.getByRole("tab", { name: "notes.md", exact: true }),
      ).toHaveCount(0);
      check(
        `${owner}: Preview/source/diff and tab switches retain unsaved drafts; external writes and owner switches stay isolated`,
        true,
      );
      check(
        `${owner}: native editable diff, autosave/manual save, undo, full-context and CRLF writes, status letters and preferences`,
        true,
      );
      expect(errors).toEqual([]);
    }
    await fixture.goto(`${url}?owner=plain`);
    await expect(source()).toBeVisible();
    await expect(diff()).toHaveCount(0);
    await options().click();
    await expect(
      menu().getByRole("switch", { name: "Diff view" }),
    ).toBeDisabled();
    await fixture.keyboard.press("Escape");
    await prepend(source(), "// plain folder\n");
    await source().press("ControlOrMeta+s");
    await expect.poll(disk).toContain("// plain folder\n");
    check(
      "Plain folders retain source editing when the saved Diff view preference is on",
      true,
    );
    expect(errors).toEqual([]);
  } finally {
    await fixture.close();
  }
}
