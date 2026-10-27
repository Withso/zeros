import { expect } from "@playwright/test";
import { runFileEditorSmoke } from "./ui-smoke-file-editor.mjs";

export async function runFilePillNavigationSmoke({ page, check }) {
  const fixture = await page
    .context()
    .browser()
    .newPage({ viewport: page.viewportSize() });
  await fixture.addInitScript(() => localStorage.clear());
  const errors = [];
  fixture.on("pageerror", (error) => errors.push(error.message));
  const url = `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-file-pill-navigation.html`;
  const pill = (kind, path) =>
    fixture.locator(
      `[data-pill-kind="${kind}"][data-pill-path="${path}"] [data-file-path]`,
    );
  const opened = fixture.locator("[data-open-file]");
  const source = fixture.locator("[data-file-viewer]");
  try {
    for (const owner of ["personal", "organization", "cloud"]) {
      await fixture.goto(`${url}?owner=${owner}&hold`);
      await pill("edit", ".context/task/notes.ts").click();
      await expect(opened).toHaveAttribute("data-open-type", "changes");
      await expect
        .poll(() => fixture.evaluate(() => window.__filePillFixture.pending()))
        .toBeGreaterThan(0);
      await fixture.evaluate(() => window.__filePillFixture.release());
      await expect(opened).toHaveAttribute("data-open-type", "changes");
      await expect(opened).toHaveText(".context/task/notes.ts");
      await expect(fixture.getByText("No current changes for .context/task/notes.ts", { exact: true })).toBeVisible();
      await fixture
        .getByRole("button", { name: "Changes", exact: true })
        .click();
      await expect(opened).toHaveAttribute("data-open-type", "changes");
      await expect(opened).toHaveText(".context/task/notes.ts");
      await pill("edit", "src/before.ts").click();
      await expect(opened).toHaveAttribute("data-open-type", "changes");
      await expect(opened).toHaveText("src/renamed.ts");
      await pill("edit", "src/unchanged.ts").focus();
      await fixture.keyboard.press("Enter");
      await expect(opened).toHaveAttribute("data-open-type", "changes");
      await expect(fixture.getByText("No current changes for src/unchanged.ts", { exact: true })).toBeVisible();
      await pill("edit", "src/changed.ts").click();
      await expect(opened).toHaveAttribute("data-open-type", "changes");
      await expect(opened).toHaveText("src/changed.ts");
      await pill("read", ".context/Shot ü #1.svg").click();
      await expect(opened).toHaveAttribute("data-open-type", "files");
      await expect(source.locator("img")).toBeVisible();
      await pill("read", ".context/task/notes.ts").click();
      await expect(source).toContainText(
        "Saved source for .context/task/notes.ts",
      );
      await expect(source).not.toContainText("Invalid input");
      const state = await fixture.evaluate(() =>
        window.__filePillFixture.state(),
      );
      expect(
        state.tabs.filter(
          (tab) =>
            tab.type === "files" && tab.filePath === ".context/task/notes.ts",
        ),
      ).toHaveLength(1);
      check(
        `${owner}: all diff pills open Changes; read-only tool references open Files`,
        true,
      );
    }
    await fixture.screenshot({
      path: ".context/file-pill-fix/cloud-files.png",
    });
    for (const owner of ["personal", "cloud"]) {
      await fixture.goto(`${url}?owner=${owner}&nested&hold`);
      await pill("edit", ".context/task/notes.ts").click();
      await expect(opened).toHaveText("packages/app/.context/task/notes.ts");
      await expect
        .poll(() => fixture.evaluate(() => window.__filePillFixture.pending()))
        .toBeGreaterThan(0);
      await fixture.evaluate(() => window.__filePillFixture.release());
      await expect(opened).toHaveAttribute("data-open-type", "changes");
      await expect(opened).toHaveText("packages/app/.context/task/notes.ts");
      await expect(fixture.getByText("No current changes for packages/app/.context/task/notes.ts", { exact: true })).toBeVisible();
      check(
        `${owner}: cold Changes navigation keeps the Git-relative path for a nested chat folder`,
        true,
      );
    }
    await fixture.goto(`${url}?owner=cloud&hold`);
    await pill("edit", ".context/task/notes.ts").click();
    await expect
      .poll(() => fixture.evaluate(() => window.__filePillFixture.pending()))
      .toBeGreaterThan(0);
    await pill("read", ".context/Shot ü #1.svg").click();
    await fixture.evaluate(() => window.__filePillFixture.release());
    await expect
      .poll(() => fixture.evaluate(() => window.__filePillFixture.settled()))
      .toBeGreaterThan(0);
    await expect(source.locator("img")).toBeVisible();
    await expect(opened).toHaveText(".context/Shot ü #1.svg");
    check("A held Changes result preserves a newer file selection", true);
    for (const owner of ["personal", "cloud"]) {
      await fixture.goto(`${url}?owner=${owner}&hold`);
      await pill("edit", "src/before.ts").click();
      await expect
        .poll(() => fixture.evaluate(() => window.__filePillFixture.pending()))
        .toBeGreaterThan(0);
      await fixture.evaluate(() => window.__filePillFixture.release());
      await expect(opened).toHaveAttribute("data-open-type", "changes");
      await expect(opened).toHaveText("src/renamed.ts");
      check(`${owner}: a cold old-path request opens its rename diff`, true);
      await fixture.goto(`${url}?owner=${owner}&fail`);
      await pill("edit", ".context/task/notes.ts").click();
      await expect
        .poll(() => fixture.evaluate(() => window.__filePillFixture.failures()))
        .toBeGreaterThan(0);
      await expect(opened).toHaveAttribute("data-open-type", "changes");
      await expect(opened).toHaveText(".context/task/notes.ts");
      check(
        `${owner}: a failed Git read is not mistaken for an empty comparison`,
        true,
      );
    }
    await fixture.goto(`${url}?owner=personal&plain`);
    await pill("edit", ".context/task/notes.ts").click();
    await expect(opened).toHaveAttribute("data-open-type", "changes");
    await expect(opened).toHaveText(".context/task/notes.ts");
    check("Diff pills keep the Changes destination even without a Git target", true);
    expect(errors).toEqual([]);
  } finally {
    await fixture.close();
  }
  await runFileEditorSmoke({ page, check });
}
