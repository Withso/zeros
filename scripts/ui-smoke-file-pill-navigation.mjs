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
    // A previewed Markdown file opens the exact file each link names, resolved
    // from its own folder, in its own tab; a link to a file that does not read
    // opens nothing, and an external link stays a link.
    const link = (name) =>
      source.locator(".zeros-md-filepath", { hasText: name });
    for (const owner of ["personal", "organization", "cloud", "nested"]) {
      await fixture.goto(
        owner === "nested"
          ? `${url}?owner=personal&nested`
          : `${url}?owner=${owner}`,
      );
      await fixture.evaluate(() =>
        window.__filePillFixture.open("docs/README.md"),
      );
      await expect(opened).toHaveText("docs/README.md");
      await expect(link("the guide")).toHaveAttribute(
        "data-file-path",
        "docs/guide.md",
      );
      await expect(link("the rules")).toHaveAttribute(
        "data-file-path",
        "RULES.md",
      );
      await expect(
        source.getByRole("link", { name: "the site" }),
      ).toHaveAttribute("href", "https://example.com");
      // The preview reads like the chat: 15px prose, fences as the chat's
      // code cards, and a file link drawn as the chat's 15px sans reference.
      const look = await source.evaluate((element) => {
        const chip = element.querySelector(".zeros-md-filepath");
        return {
          prose: getComputedStyle(element.querySelector(".zeros-md-prose p")).fontSize,
          codeCards: element.querySelectorAll(".zeros-md-codeblock").length,
          plainPre: element.querySelectorAll(".zeros-md-prose pre").length,
          link: getComputedStyle(chip).fontSize,
          mono: getComputedStyle(chip).fontFamily.toLowerCase().includes("mono"),
        };
      });
      expect(look).toEqual({
        prose: "15px",
        codeCards: 1,
        plainPre: 0,
        link: "15px",
        mono: false,
      });
      await link("a missing page").click();
      await link("the guide").click();
      await expect(opened).toHaveText("docs/guide.md");
      await expect(source).toContainText(
        /Saved source for (packages\/app\/)?docs\/guide\.md/,
      );
      await fixture
        .getByRole("button", { name: "README.md", exact: true })
        .click();
      await expect(opened).toHaveText("docs/README.md");
      await link("the rules").focus();
      await fixture.keyboard.press("Enter");
      await expect(opened).toHaveText("RULES.md");
      const files = await fixture.evaluate(() =>
        window.__filePillFixture
          .state()
          .tabs.filter((tab) => tab.type === "files" && tab.filePath)
          .map((tab) => tab.filePath),
      );
      expect(files).toEqual(["docs/README.md", "docs/guide.md", "RULES.md"]);
      check(
        `${owner}: Markdown preview links open the exact file in its own Files tab; a missing file opens nothing`,
        true,
      );
    }
    expect(errors).toEqual([]);
  } finally {
    await fixture.close();
  }
  await runFileEditorSmoke({ page, check });
}
