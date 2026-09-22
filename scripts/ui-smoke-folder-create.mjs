import { expect } from "@playwright/test";

const folder = "/fixture/To-do app";
const snapshot = async (page) =>
  JSON.parse(await page.locator("[data-folder-state]").textContent());
const confirmFolderSetup = async (page) => {
  const dialog = page.getByRole("dialog", {
    name: "Create a workspace ?",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Initialize git and create", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
};
const openFixture = async (page, query, confirm = true) => {
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-folder-workspace.html?${query}`,
  );
  await page
    .getByRole("button", {
      name:
        query.includes("create") || query.includes("automatic")
          ? "Open folder fixture"
          : "Restore saved folder",
      exact: true,
    })
    .click();
  if (confirm && (query.includes("create") || query.includes("automatic"))) {
    await confirmFolderSetup(page);
  }
};

export async function runFolderCreateSmoke({ page, check }) {
  await openFixture(page, "create");
  const before = await snapshot(page);
  await page.getByRole("button", { name: "Show Create", exact: true }).click();
  const create = page
    .locator("section")
    .getByRole("button", { name: "Create", exact: true });
  await expect(create).toBeEnabled();
  const model = await page.locator("[data-model-pill-label]").textContent();
  await create.click();
  await expect
    .poll(async () => (await snapshot(page)).chats.length)
    .toBe(before.chats.length + 1);
  const empty = await snapshot(page);
  const emptyChat = empty.fullChats.find(
    (chat) => chat.id === empty.activeChatId,
  );
  expect(emptyChat.folder).toMatch(
    /^\/fixture\/zeros\/workspaces\/to-do-app\/ws_fixture_/,
  );
  expect(emptyChat.folder).not.toBe(before.activeFolder);
  expect(emptyChat.agentId).toBe("claude");
  expect(emptyChat.model).toBeTruthy();
  expect(emptyChat.effort).toBeTruthy();
  expect(empty.page).toBe("workspace");
  expect(empty.pendingAutoSend).toEqual({});
  expect(empty.drafts[emptyChat.id]).toBeUndefined();
  check(
    "Create with no prompt opens a new worktree with the selected chat model",
    true,
  );

  await page.getByRole("button", { name: "Show Create", exact: true }).click();
  await expect(page.getByRole("button", { name: /Create from/ })).toBeVisible();
  await expect(page.locator("[data-dispatcher-mode-switcher]")).toBeVisible();
  await expect(page.locator("[data-model-pill-label]")).toHaveText(model);
  await page
    .locator('[contenteditable="true"]')
    .fill("Create a todo list in this folder");
  await create.click();
  await expect
    .poll(async () => (await snapshot(page)).chats.length)
    .toBe(empty.chats.length + 1);
  const sent = await snapshot(page);
  const sentChat = sent.fullChats.find((chat) => chat.id === sent.activeChatId);
  expect(sentChat.id).not.toBe(emptyChat.id);
  expect(sentChat).toMatchObject({
    agentId: emptyChat.agentId,
    model: emptyChat.model,
    effort: emptyChat.effort,
  });
  expect(sent.drafts[sentChat.id].text).toBe(
    "Create a todo list in this folder",
  );
  expect(Object.keys(sent.pendingAutoSend)).toEqual([sentChat.id]);
  expect(sentChat.folder).not.toBe(emptyChat.folder);
  expect(sentChat.folder).toMatch(
    /^\/fixture\/zeros\/workspaces\/to-do-app\/ws_fixture_/,
  );
  const ops = await page.evaluate(() =>
    window.folderWorkspaceRequests.map((request) => request.op),
  );
  expect(ops.filter((op) => op === "workspace.create")).toHaveLength(3);
  expect(ops.filter((op) => op === "git.initInPlace")).toHaveLength(1);
  check(
    "Create preserves model, effort and prompt in a new worktree and initializes Git only once",
    true,
  );
}

export async function runFolderDesignSetupSmoke({ page, check }) {
  await openFixture(page, "workbench");
  const chats = await page.locator("[data-folder-state]").textContent();
  await page.getByRole("tab", { name: "Design", exact: true }).click();
  const empty = page.locator("[data-design-tab-empty]");
  await expect(empty.locator("svg.lucide-folder")).toBeVisible();
  await expect(
    empty.getByText("Initialize Git to create a workspace for Design.", {
      exact: true,
    }),
  ).toBeVisible();
  const initialize = empty.getByRole("button", {
    name: "Initialize Git",
    exact: true,
  });
  await expect(initialize).toBeVisible();
  await expect(
    empty.getByRole("button", { name: "Publish to GitHub" }),
  ).toHaveCount(0);
  const beforeOps = await page.evaluate(() =>
    window.folderWorkspaceRequests.map((r) => r.op),
  );
  expect(beforeOps).not.toContain("git.initInPlace");
  expect(beforeOps).not.toContain("design.initialize");
  await page.evaluate(() => window.failFolderInitialization(true));
  await initialize.click();
  await expect(empty.getByRole("alert")).toContainText(
    "Git initialization failed",
  );
  await expect(initialize).toBeEnabled();
  await page.evaluate(() => window.failFolderInitialization(false));
  await initialize.click();
  await expect(initialize).toHaveCount(0);
  await expect(page.locator("[data-folder-state]")).toHaveText(chats);
  const initRequests = await page.evaluate(() =>
    window.folderWorkspaceRequests.filter((r) => r.op === "git.initInPlace"),
  );
  expect(initRequests).toHaveLength(2);
  expect(initRequests[1].params.repoRoot).toBe(folder);
  await expect(
    page.locator('[data-workspace-id="local:to-do-app"]'),
  ).toHaveCount(1);
  check(
    "Design offers local Git initialization with a folder icon, retries failure and preserves open chats",
    true,
  );
}

export async function runFolderAutoSetupSmoke({ page, check }) {
  await openFixture(page, "automatic", false);
  const ops = () =>
    page.evaluate(() => window.folderWorkspaceRequests.map((r) => r.op));
  const dialog = page.getByRole("dialog", {
    name: "Create a workspace ?",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Set up Git to create a workspace for this folder.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog.getByText(folder, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("switch")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toHaveCount(0);
  expect(await ops()).not.toContain("git.initInPlace");
  expect(await ops()).not.toContain("project.upsert");
  expect(await ops()).not.toContain("workspace.prepareCreate");
  expect((await snapshot(page)).chats).toHaveLength(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await ops()).not.toContain("git.initInPlace");
  expect((await snapshot(page)).chats).toHaveLength(0);
  const open = page.getByRole("button", {
    name: "Open folder fixture",
    exact: true,
  });
  await open.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await ops()).not.toContain("git.initInPlace");
  check(
    "Opening a plain folder asks before setup; closing or Escape leaves the folder untouched",
    true,
  );
  await open.click();
  await confirmFolderSetup(page);
  await expect
    .poll(async () => (await snapshot(page)).activeFolder)
    .toBe("/fixture/zeros/workspaces/to-do-app/ws_fixture_1");
  await expect(
    page.getByRole("dialog", { name: "Choose how to start" }),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-workspace-id="local:to-do-app"]'),
  ).toHaveCount(0);
  expect((await ops()).filter((op) => op === "git.initInPlace")).toHaveLength(
    1,
  );
  expect((await snapshot(page)).chats).toHaveLength(1);
  await page
    .getByRole("button", { name: "Open folder fixture", exact: true })
    .click();
  await expect
    .poll(
      async () => (await ops()).filter((op) => op === "workspace.list").length,
    )
    .toBeGreaterThan(0);
  expect((await ops()).filter((op) => op === "workspace.create")).toHaveLength(
    1,
  );
  expect((await snapshot(page)).chats).toHaveLength(1);
  check(
    "Confirming setup initializes local Git and opens one worktree; reopening reuses it without another prompt",
    true,
  );

  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await page.evaluate(() => {
    window.pauseFolderInitialization();
  });
  await open.click();
  await confirmFolderSetup(page);
  await expect
    .poll(
      async () => (await ops()).filter((op) => op === "git.initInPlace").length,
    )
    .toBe(1);
  await open.click();
  expect((await ops()).filter((op) => op === "workspace.create")).toHaveLength(
    0,
  );
  await page.evaluate(() => window.resumeFolderInitialization());
  await expect
    .poll(
      async () =>
        (await ops()).filter((op) => op === "workspace.create").length,
    )
    .toBe(1);
  expect((await ops()).filter((op) => op === "git.initInPlace")).toHaveLength(
    1,
  );
  check(
    "Repeated opens share pending setup and create only one worktree",
    true,
  );

  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await page.evaluate(() => window.failFolderInitialization(true));
  await open.click();
  await confirmFolderSetup(page);
  await expect(
    page.getByText("Git initialization failed", { exact: true }),
  ).toBeVisible();
  expect((await snapshot(page)).chats).toHaveLength(0);
  expect(
    (await ops()).filter((op) => op === "workspace.prepareCreate"),
  ).toHaveLength(0);
  await page.evaluate(() => window.failFolderInitialization(false));
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect
    .poll(async () => (await snapshot(page)).activeFolder)
    .toBe("/fixture/zeros/workspaces/to-do-app/ws_fixture_1");
  check(
    "Failed Git setup has a retry and never starts a chat in the original folder",
    true,
  );

  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await page.evaluate(() =>
    window.setFolderInspection(true, null, false, false),
  );
  await open.click();
  await expect
    .poll(async () => (await snapshot(page)).activeFolder)
    .toBe("/fixture/zeros/workspaces/to-do-app/ws_fixture_1");
  expect((await ops()).filter((op) => op === "git.initInPlace")).toHaveLength(
    1,
  );
  check(
    "A Git repository with no commits gets an initial commit before its first worktree",
    true,
  );

  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await page.evaluate(() => window.setFolderPreparationFails(true));
  await open.click();
  await confirmFolderSetup(page);
  await expect(
    page.getByText(/Couldn't create workspace: Workspace preparation failed/),
  ).toBeVisible();
  expect((await snapshot(page)).chats).toHaveLength(0);
  expect((await snapshot(page)).page).toBe("repo");
  expect((await ops()).filter((op) => op === "workspace.create")).toHaveLength(
    0,
  );
  await page.evaluate(() => window.setFolderPreparationFails(false));
  await open.click();
  await expect
    .poll(async () => (await snapshot(page)).activeFolder)
    .toBe("/fixture/zeros/workspaces/to-do-app/ws_fixture_1");
  expect((await ops()).filter((op) => op === "git.initInPlace")).toHaveLength(
    1,
  );
  check(
    "Worktree preparation failure keeps the repository available and retries without reinitializing Git",
    true,
  );
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await page.evaluate(() => window.setFolderCreationFails(true));
  await open.click();
  await confirmFolderSetup(page);
  await expect(
    page.getByText(/Couldn't create workspace: Workspace creation failed/),
  ).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).chats.length).toBe(0);
  await expect(
    page.locator('[data-workspace-id="local:to-do-app"]'),
  ).toHaveCount(0);
  await expect.poll(async () => (await snapshot(page)).page).toBe("repo");
  check(
    "Failed worktree creation removes its provisional chat without falling back to the original folder",
    true,
  );

  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await page.evaluate(() => window.setFolderInspection(false, null, true));
  await open.click();
  await expect(
    page.getByText("Folder temporarily unavailable", { exact: true }),
  ).toBeVisible();
  expect((await ops()).filter((op) => op === "git.initInPlace")).toHaveLength(
    0,
  );
  expect((await snapshot(page)).chats).toHaveLength(0);
  check(
    "Inspection errors never initialize Git or create a workspace on a guess",
    true,
  );
}

export async function runStartFromScratchSmoke({ page, check }) {
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(`${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-folder-workspace.html?scratch`);
  const start = page.getByRole("button", { name: "Start from scratch Start a fresh repo", exact: true });
  await expect(start.locator("svg.lucide-plus")).toBeVisible();
  await start.click();
  const dialog = page.getByRole("dialog", { name: "Create project", exact: true });
  await expect(dialog.getByText("Template", { exact: true })).toHaveCount(0);
  await expect(dialog.locator("kbd")).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "Project name", exact: true }).fill("To-do app");
  await dialog.getByRole("textbox", { name: "Parent folder", exact: true }).fill("/fixture");
  await dialog.getByRole("switch").click();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).activeFolder).toBe("/fixture/zeros/workspaces/to-do-app/ws_fixture_1");
  await expect(page.getByRole("dialog", { name: "Create a workspace ?", exact: true })).toHaveCount(0);
  const requests = await page.evaluate(() => window.folderWorkspaceRequests);
  expect(requests.filter(r => r.op === "workspace_init_repo")).toHaveLength(1);
  expect(requests.find(r => r.op === "workspace_init_repo").params).toMatchObject({ name: "To-do app", parentFolder: "/fixture", template: "empty" });
  expect(requests.filter(r => r.op === "git.initInPlace")).toHaveLength(0);
  expect(requests.filter(r => r.op === "workspace.create")).toHaveLength(1);
  check("Start from scratch uses a plus icon and simplified dialog, initializes Git and opens a workspace without another confirmation", true);
}
