import { expect } from "@playwright/test";

export async function runWorkspaceRecoveryNavigationSmoke({ page, check }) {
  const harness = `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-folder-workspace.html`;
  const snapshot = () => page.evaluate(async () => {
    const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
    const state = useWorkspaceStore.getState();
    return {
      page: state.activePage,
      projectId: state.activeRepoId,
      filter: state.workspaceListFilter,
      folder: state.lastWorkspaceFolder,
      chatId: state.activeChatId,
      chats: state.chats.map(({ id, folder }) => ({ id, folder })),
      memory: state.lastWorkspaceByRepoRoot,
    };
  });
  const selectFilter = async (name) => {
    await page.getByRole("button", { name: "Filter workspaces", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  };

  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(`${harness}?automatic`);
  await page.getByRole("button", { name: "Open folder fixture", exact: true }).click();
  await page.getByRole("button", { name: "Initialize git and create", exact: true }).click();
  await expect.poll(async () => (await snapshot()).chats.length).toBe(1);
  const before = await snapshot();
  const fresh = await page.evaluate(async () => {
    const { upsertProject } = await import("/apps/desktop/src/renderer/state/projects-store.ts");
    const { notifyProjectsChanged } = await import("/apps/desktop/src/renderer/state/use-projects.ts");
    const project = upsertProject({ repoRoot: "/fixture/Empty repo", repoSlug: "empty-repo", isGitRepository: true });
    notifyProjectsChanged();
    return project;
  });
  await selectFilter("Empty repo");
  await expect.poll(async () => (await snapshot()).page).toBe("repo");
  const selected = await snapshot();
  expect(selected.projectId).toBe(fresh.id);
  expect(selected.filter).toBe(`repo:${fresh.id}`);
  expect(selected.chats).toEqual(before.chats);
  expect(selected.memory[fresh.repoRoot]).toBeUndefined();
  await expect(page.locator('[data-workspace-id="local:empty-repo"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.folderWorkspaceRequests.filter(({ op }) => op === "workspace.create").length)).toBe(1);
  check("Filtering a repository without saved workspaces opens its page without creating an original-folder chat", true);

  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(`${harness}?subdirectory`);
  await page.getByRole("button", { name: "Restore saved folder", exact: true }).click();
  const cwd = "/fixture/To-do app/packages/app";
  await expect.poll(async () => (await snapshot()).chats.length).toBe(1);
  const saved = await snapshot();
  expect(saved.folder).toBe(cwd);
  const tab = page.locator('[data-workspace-id="local:to-do-app"]');
  for (const name of ["Grouped", "Ungrouped", "Active", "To-do app"]) {
    await selectFilter(name);
    await expect(tab).toHaveCount(1);
  }
  await page.getByRole("button", { name: "Show dashboard", exact: true }).click();
  const row = page.locator("main").locator('div[role="button"]').filter({ hasText: "To-do app" });
  await expect(row).toHaveCount(1);
  await row.click();
  await expect.poll(async () => (await snapshot()).page).toBe("workspace");
  expect((await snapshot()).folder).toBe(cwd);
  expect((await snapshot()).chatId).toBe(saved.chatId);
  expect((await snapshot()).chats).toEqual(saved.chats);
  check("Saved subdirectory chats remain in every workspace filter and reopen from the dashboard at the exact cwd", true);

  const nested = await page.evaluate(async () => {
    const { upsertProject } = await import("/apps/desktop/src/renderer/state/projects-store.ts");
    const { notifyProjectsChanged } = await import("/apps/desktop/src/renderer/state/use-projects.ts");
    window.setFolderGitState(true);
    const project = upsertProject({ repoRoot: "/fixture/To-do app/packages", repoSlug: "nested", isGitRepository: true });
    notifyProjectsChanged();
    window.openFolderSettings("workspaces");
    return project;
  });
  await expect(page.getByText("No workspaces yet", { exact: true })).toBeVisible();
  await expect(tab).toHaveCount(0);
  await page.evaluate(async (projectId) => {
    const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
    useWorkspaceStore.getState().dispatch({ type: "OPEN_REPO_PAGE", projectId, view: "workspaces" });
  }, nested.id);
  const nestedRow = page.locator("main").locator('div[role="button"]').filter({ hasText: "main" });
  await expect(nestedRow).toHaveCount(1);
  await nestedRow.click();
  await expect.poll(async () => (await snapshot()).page).toBe("workspace");
  expect((await snapshot()).folder).toBe(cwd);
  expect((await snapshot()).chats).toEqual(saved.chats);
  check("Repository pages assign saved subdirectory chats to the nested owner without duplicating a parent workspace", true);
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
}

export async function runFolderWorkspaceSmoke({ page, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-folder-workspace.html`,
  );
  await page
    .getByRole("button", { name: "Restore saved folder", exact: true })
    .click();
  const tab = page.locator('[data-workspace-id="local:to-do-app"]');
  await expect(tab).toHaveCount(1);
  await expect(tab).toContainText("To-do app");
  await expect(tab.locator("svg.lucide-folder")).toHaveCount(1);
  await expect(
    page.getByRole("button", {
      name: "Show To-do app workspaces",
      exact: true,
    }),
  ).toHaveCount(0);
  for (const filter of ["Ungrouped", "Active", "To-do app", "Grouped"]) {
    await page
      .getByRole("button", { name: "Filter workspaces", exact: true })
      .click();
    await page.getByRole("menuitem", { name: filter, exact: true }).click();
    await expect(tab).toHaveCount(1);
    await expect(tab.locator("svg.lucide-folder")).toHaveCount(1);
    await expect(page.locator('[data-top-bar-flow-item="true"]')).toHaveCount(
      1,
    );
    await expect(page.locator("[data-top-bar-pinned-lead]")).toHaveCount(0);
  }
  await expect(
    tab.getByRole("button", { name: /Archive workspace/ }),
  ).toHaveCount(0);
  const state = () =>
    page
      .locator("[data-folder-state]")
      .evaluate((element) => JSON.parse(element.textContent));
  await expect
    .poll(async () => (await state()).activeFolder)
    .toBe("/fixture/To-do app");
  await expect.poll(async () => (await state()).chats.length).toBe(1);
  expect((await state()).chats[0].folder).toBe("/fixture/To-do app");
  check(
    "Restoring a saved folder preserves its named workspace and exact chat directory",
    true,
  );

  for (const surface of ["Show dashboard"]) {
    await page.getByRole("button", { name: surface, exact: true }).click();
    const row = page
      .locator("main")
      .locator('div[role="button"]')
      .filter({ hasText: "To-do app" });
    await expect(row).toHaveCount(1);
    await expect(row.locator("svg.lucide-folder")).not.toHaveCount(0);
    await expect(
      page.getByText("No workspaces yet", { exact: true }),
    ).toHaveCount(0);
    await row.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: /Archive|Set status/ }),
    ).toHaveCount(0);
    await row.click();
    await expect
      .poll(async () => (await state()).activeFolder)
      .toBe("/fixture/To-do app");
    expect((await state()).chats).toHaveLength(1);
  }
  check(
    "The dashboard folder row opens the same chat without worktree actions",
    true,
  );
  await page
    .getByRole("button", { name: "Show folder settings", exact: true })
    .click();
  const tabs = page.getByRole("tablist", {
    name: "Code repository settings",
    exact: true,
  });
  for (const hidden of ["Workspaces", "Git", "Files"]) {
    await expect(
      tabs.getByRole("tab", { name: hidden, exact: true }),
    ).toHaveCount(0);
  }
  await expect(
    tabs.getByRole("tab", { name: "Environment", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("textbox", { name: "Setup script", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Archive script", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "These secrets are passed to agents working in this folder",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Archived workspaces", exact: true }),
  ).toHaveCount(0);
  await tabs.getByRole("tab", { name: "Paths", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Workspaces path", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Remove folder", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "This folder's chats will be permanently deleted from Zeros.",
  );
  await expect(page.getByRole("dialog")).toContainText("will not be modified");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

  for (const view of ["workspaces", "git", "files"]) {
    await page.evaluate((view) => window.openFolderSettings(view), view);
    await expect(
      tabs.getByRole("tab", { name: "Environment", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  }
  check(
    "Plain folder settings hide Git/worktree controls and safely resolve saved tabs",
    true,
  );
  const mutationsBeforeReload = await page.evaluate(() =>
    window.folderWorkspaceRequests.filter(({ op }) =>
      /git.*init|workspace\.(create|archive|setStatus)/i.test(op),
    ),
  );
  expect(mutationsBeforeReload).toEqual([]);
  await page
    .getByRole("button", { name: "Restore saved folder", exact: true })
    .click();
  await expect
    .poll(async () => (await state()).activeFolder)
    .toBe("/fixture/To-do app");
  expect((await state()).chats).toHaveLength(1);
  await page
    .getByRole("button", { name: "Show folder settings", exact: true })
    .click();
  await page.reload();
  await expect(
    tabs.getByRole("tab", { name: "Environment", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(tab).toHaveCount(1);
  await expect(page.locator("svg.lucide-folder")).not.toHaveCount(0);
  const mutations = await page.evaluate(() =>
    window.folderWorkspaceRequests.filter(({ op }) =>
      /git.*init|workspace\.(create|archive|setStatus)/i.test(op),
    ),
  );
  expect(mutations).toEqual([]);
  check(
    "Folder workspace and Folder icons survive reload without initializing Git",
    true,
  );

  // This focused harness does not mount app-shell's chat persistence. Start a
  // new chat after reload, then verify Git capability changes retain it.
  await page.getByRole("button", { name: "Restore saved folder", exact: true }).click();
  await expect.poll(async () => (await state()).chats.length).toBe(1);
  const chatBeforeGit = (await state()).chats[0];
  await page.evaluate(() => window.openFolderSettings("files"));
  await page.evaluate(() => window.setFolderGitState(true));
  for (const restored of ["Workspaces", "Git", "Files"]) {
    await expect(
      tabs.getByRole("tab", { name: restored, exact: true }),
    ).toBeVisible();
  }
  await expect(
    tabs.getByRole("tab", { name: "Files", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await tabs.getByRole("tab", { name: "Environment", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Setup script", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Archive script", exact: true }),
  ).toBeVisible();
  await tabs.getByRole("tab", { name: "Paths", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Workspaces path", exact: true }),
  ).toBeVisible();
  await tabs.getByRole("tab", { name: "Files", exact: true }).click();
  await page.evaluate(() => window.setFolderGitState(false));
  await expect(
    tabs.getByRole("tab", { name: "Environment", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Files to copy", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("textbox", {
      name: "Setup script",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(0);
  expect((await state()).chats).toHaveLength(1);
  expect((await state()).chats[0]).toEqual(chatBeforeGit);
  check(
    "Local Git enables all settings without GitHub; losing Git evicts unavailable retained views and preserves chats",
    true,
  );
}
