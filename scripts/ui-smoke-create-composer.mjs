import { expect } from "@playwright/test";

async function expectContextControlsInOneRow(page) {
  const [context, project, source, mode] = await Promise.all([
    page.locator("[data-dispatcher-context]").boundingBox(),
    page
      .getByRole("button", { name: "Choose project", exact: true })
      .boundingBox(),
    page.locator("[data-create-source-trigger]").boundingBox(),
    page.locator("[data-dispatcher-mode-switcher]").boundingBox(),
  ]);
  for (const control of [project, source, mode]) {
    expect(control).not.toBeNull();
    expect(
      Math.abs(
        control.y + control.height / 2 - (project.y + project.height / 2),
      ),
    ).toBeLessThanOrEqual(1);
    expect(control.x).toBeGreaterThanOrEqual(context.x);
    expect(control.x + control.width).toBeLessThanOrEqual(
      context.x + context.width,
    );
  }
  expect(project.x + project.width).toBeLessThanOrEqual(source.x);
  expect(source.x + source.width).toBeLessThanOrEqual(mode.x);
  expect(context.x + context.width - (mode.x + mode.width)).toBeLessThanOrEqual(
    8,
  );
}

/** Real Create page, menus, editor and create requests; only transport is fake. */
export async function runCreateComposerSmoke({ page, check, harnessBase }) {
  await page.goto(`${harnessBase}/harness-folder-workspace.html?create`);
  await page
    .getByRole("button", { name: "Open folder fixture", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Initialize git and create", exact: true })
    .click();
  await page.getByRole("button", { name: "Show Create", exact: true }).click();
  const card = page.locator("[data-dispatcher-composer]");
  const source = page.locator("[data-create-source-trigger]");
  const editor = card.locator(".composer-pm");
  await expect(
    card.getByRole("button", { name: "Create", exact: true }),
  ).toBeEnabled();
  await expect(source).toHaveText("main");
  await expect(card).toHaveCSS("height", "106px");
  await expect(card).toHaveCSS("border-radius", "18px");
  const contextBox = await page
    .locator("[data-dispatcher-context]")
    .boundingBox();
  const cardBox = await card.boundingBox();
  expect(contextBox.y + contextBox.height).toBeLessThan(cardBox.y);
  await expectContextControlsInOneRow(page);
  await expect(
    card.getByRole("button", { name: "Choose project" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Choose project", exact: true })
    .click();
  for (const name of [
    "To-do app",
    "Open project",
    "Open GitHub project",
    "Start from scratch",
  ]) {
    await expect(
      page.getByRole("menuitem", { name, exact: true }),
    ).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  check(
    "Create puts project/source context above a 106px composer with 18px corners and one project menu",
    true,
  );

  await page.evaluate(() =>
    window.setFolderGitState(true, "https://github.com/example/project.git"),
  );
  await expect(source).toHaveAttribute(
    "aria-label",
    "Create from GitHub branch: main",
  );
  await source.click();
  const dialog = page.getByRole("dialog", {
    name: "Create from source",
    exact: true,
  });
  await expect(
    dialog.getByRole("tab", { name: "GitHub branches", exact: true }),
  ).toHaveAttribute("data-state", "active");
  await expect(
    dialog.getByRole("tab", { name: "Issues", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "main Default", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await dialog
    .getByRole("tab", { name: "Local branches", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "feature/local", exact: true })
    .click();
  await expect(source).toHaveAttribute(
    "aria-label",
    "Create from local branch: feature/local",
  );
  await expect(
    page.getByRole("button", { name: "Clear base", exact: true }),
  ).toHaveCount(0);
  await card.getByRole("button", { name: "Create", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.folderWorkspaceRequests
            .filter((r) => r.op === "workspace.create")
            .at(-1)?.params.baseBranch,
      ),
    )
    .toBe("refs/heads/feature/local");

  await page.getByRole("button", { name: "Show Create", exact: true }).click();
  await source.click();
  await dialog
    .getByRole("tab", { name: "GitHub branches", exact: true })
    .click();
  await dialog
    .getByRole("searchbox", { name: "Search sources" })
    .fill("REMOTE");
  await expect(
    dialog.getByRole("button", { name: "main Default", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "feature/remote origin", exact: true })
    .click();
  await expect(source).toHaveAttribute(
    "aria-label",
    "Create from GitHub branch: feature/remote",
  );
  await card.getByRole("button", { name: "Create", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.folderWorkspaceRequests
            .filter((r) => r.op === "workspace.create")
            .at(-1)?.params.baseBranch,
      ),
    )
    .toBe("refs/remotes/origin/feature/remote");
  check(
    "local and GitHub picks submit distinct full refs, and the selected branch has no clear icon",
    true,
  );

  await page.getByRole("button", { name: "Show Create", exact: true }).click();
  await source.click();
  await page.evaluate(() => window.pauseFolderPrRead());
  await dialog.getByRole("tab", { name: "Pull requests", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Loading sources…");
  await dialog
    .getByRole("tab", { name: "Local branches", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "feature/local", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("tab", { name: "Pull requests", exact: true }).click();
  await page.evaluate(() =>
    window.releaseFolderPrRead("GitHub is temporarily unavailable"),
  );
  await expect(dialog.getByRole("alert")).toContainText(
    "GitHub is temporarily unavailable",
  );
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await dialog
    .getByRole("button", { name: /#42 · Improve the project picker/ })
    .click();
  await expect(source).toHaveText("#42 · Improve the project picker");
  await page.setViewportSize({ width: 780, height: 600 });
  await expectContextControlsInOneRow(page);
  await page.setViewportSize({ width: 1100, height: 780 });
  await card.getByRole("button", { name: "Create", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.folderWorkspaceRequests
            .filter((r) => r.op === "workspace.create")
            .at(-1)?.params.baseBranch,
      ),
    )
    .toBe("refs/remotes/origin/feature/remote");
  await page.getByRole("button", { name: "Show Create", exact: true }).click();
  await source.click();
  await dialog
    .getByRole("tab", { name: "GitHub branches", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "main Default", exact: true })
    .click();
  await card.getByRole("button", { name: "Create", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.folderWorkspaceRequests
            .filter((r) => r.op === "workspace.create")
            .at(-1)?.params.baseBranch ?? null,
      ),
    )
    .toBeNull();
  check(
    "pull requests show their number/title, and reselecting the default restores fresh-default creation",
    true,
  );

  await page.getByRole("button", { name: "Show Create", exact: true }).click();
  await editor.fill(
    Array.from({ length: 30 }, (_, i) => `Line ${i}`).join("\n"),
  );
  expect(await editor.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(
    true,
  );
  await expect(editor).toHaveCSS("max-height", "200px");
  await expect(
    card.getByRole("button", { name: "Create", exact: true }),
  ).toBeVisible();
  await editor.fill("");
  await expect(card).toHaveCSS("height", "106px");
  await page.setViewportSize({ width: 780, height: 600 });
  await expectContextControlsInOneRow(page);
  await source.click();
  const popup = await dialog.boundingBox();
  expect(popup.x).toBeGreaterThanOrEqual(0);
  expect(popup.x + popup.width).toBeLessThanOrEqual(780);
  await page.keyboard.press("Escape");
  await expect(source).toBeFocused();
  check(
    "long drafts scroll, compact geometry restores after clearing, and keyboard dismissal returns focus",
    true,
  );
  check(
    "project, branch/PR and Code/Design controls share one row at normal and narrow window widths",
    true,
  );
}
