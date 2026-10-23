import { expect } from "@playwright/test";

export async function runWorkspaceHoverCards({ page, check, harnessBase, capture }) {
  await page.goto(`${harnessBase}/harness-app-sidebar.html?hover-cards`, { waitUntil: "networkidle" });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload({ waitUntil: "networkidle" });
  const row = id => page.locator(`[data-workspace-id="${id}"]`);
  const card = id => page.locator(`[data-workspace-preview="${id}"]`);
  const previews = page.locator("[data-workspace-preview]");
  const state = () => page.evaluate(() => window.appSidebarState());
  const requests = () => page.evaluate(() => window.appSidebarRequests);
  const open = async id => {
    await row(id).hover();
    await expect(card(id)).toBeVisible();
    return card(id);
  };
  const before = await state();
  const local = await open("ws-atlanta");
  await expect(local).toContainText("+2318");
  await expect(local).toContainText("−388");
  await expect(local).toContainText("Zeros");
  await expect(local).toContainText("Workspace overview and sidebar filters");
  await expect(local).toContainText("Added filters and verified workspace switching.");
  await expect(local.locator("time")).toContainText("ago");
  await expect(local.getByRole("button", { name: "Create PR", exact: true })).toBeEnabled();
  expect((await state()).folder).toBe(before.folder);
  expect((await requests()).some(request => request.op === "fixture.sendPrompt")).toBe(false);
  check("Hover shows the exact workspace details and diff totals without selecting or starting work", true);

  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await expect(local.getByRole("button", { name: "Create PR", exact: true })).toBeEnabled();
    const colors = await local.evaluate(node => {
      const panel = node.closest('[role="dialog"]');
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--bg1-highlight)";
      probe.style.border = "1px solid var(--border2)";
      panel.append(probe);
      const actual = getComputedStyle(panel);
      const expected = getComputedStyle(probe);
      const result = { background: actual.backgroundColor, border: actual.borderTopColor,
        expectedBackground: expected.backgroundColor, expectedBorder: expected.borderTopColor };
      probe.remove();
      return result;
    });
    expect(colors.background).toBe(colors.expectedBackground);
    expect(colors.border).toBe(colors.expectedBorder);
    if (capture) await capture(page, theme);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  check("Dark and Light cards use bg1-highlight and border2", true);

  await local.hover();
  await local.getByRole("button", { name: "More PR options" }).click();
  const draft = page.getByRole("menuitem", { name: "Create draft PR", exact: true });
  await draft.hover();
  // Exercise the documented pointer-leave grace while inside the portalled menu.
  await page.waitForTimeout(250);
  await expect(draft).toBeVisible();
  await expect(local).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(draft).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(previews).toHaveCount(0);
  check("The pointer can enter the card and its PR menu; Escape dismisses them", true);

  const trigger = row("ws-atlanta").getByRole("button", { name: /^Open workspace/ });
  await page.getByRole("button", { name: "Home", exact: true }).focus();
  await trigger.focus();
  await expect(local).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(local.getByRole("button", { name: "Create PR", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(local.getByRole("button", { name: "More PR options" })).toBeFocused();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(previews).toHaveCount(0);
  check("Keyboard focus opens the preview, Right enters its actions, and Escape restores focus", true);

  await open("ws-atlanta");
  await row("ws-atlanta").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Set status", exact: true })).toBeVisible();
  await expect(previews).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.mouse.move(1000, 700);

  await trigger.click();
  const commit = await open("ws-boston");
  await expect(commit.getByRole("link", { name: "Open PR #42" })).toHaveAttribute("href", "https://github.com/example/zeros/pull/42");
  await commit.getByRole("button", { name: "Commit and push" }).click();
  await expect.poll(async () => (await requests()).filter(request => request.op === "fixture.sendPrompt")).toEqual([
    { op: "fixture.sendPrompt", params: { chatId: "chat-ws-boston", text: "Commit and push all changes" } },
  ]);
  expect((await state()).folder).toBe("/fixture-workspaces/zeros/boston");
  check("Commit and push targets the hovered workspace while a different workspace was selected", true);

  const selected = (await state()).folder;
  const completed = await open("ws-seville");
  await completed.getByRole("button", { name: "Archive", exact: true }).click();
  await expect.poll(async () => (await requests()).some(request => request.op === "workspace.archive")).toBe(true);
  expect((await state()).folder).toBe(selected);
  await expect(previews).toHaveCount(0);
  check("Merged PR cards archive through the existing lifecycle without changing the selected workspace", true);

  await open("ws-atlanta");
  await page.evaluate(() => window.appSidebarNavigate("settings"));
  await expect(previews).toHaveCount(0);
  const hiddenReads = (await requests()).filter(request => request.op === "git.hasChanges" || request.op === "fixture.hydrateChat").length;
  await page.evaluate(() => window.appSidebarSetChangeLines("ws-atlanta", { additions: 99, deletions: 3 }));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect((await requests()).filter(request => request.op === "git.hasChanges" || request.op === "fixture.hydrateChat")).toHaveLength(hiddenReads);
  await page.evaluate(() => window.appSidebarNavigate("dashboard"));
  check("Hiding the retained sidebar dismisses the portal and stops preview reads", true);

  const cloud = await page.evaluate(() => window.appSidebarSeedCloud());
  const cloudCard = await open(cloud.keys[0]);
  await expect(cloudCard).toContainText("cloud-one activity");
  await expect(cloudCard).toContainText("Saved progress for cloud-one activity.");
  await expect(cloudCard).toContainText("22222222");
  await expect(cloudCard.getByRole("button", { name: "Open workspace" })).toBeVisible();
  await expect(cloudCard.getByRole("button", { name: "Create PR" })).toHaveCount(0);
  const readsBeforeSwitch = (await requests()).length;
  await page.evaluate(id => window.appSidebarSelectOwner(id), cloud.otherOrganizationId);
  await expect(card(cloud.keys[0])).toHaveCount(0);
  const other = await open(cloud.keys[2]);
  await expect(other).toContainText("Saved progress for cloud-other activity.");
  await expect(other).not.toContainText("cloud-one activity");
  await page.evaluate(id => window.appSidebarSelectOwner(id), cloud.organizationId);
  await expect(card(cloud.keys[2])).toHaveCount(0);
  await open(cloud.keys[0]);
  await expect(card(cloud.keys[0])).toContainText("Saved progress for cloud-one activity.");
  expect((await requests()).slice(readsBeforeSwitch).some(request => /wake|start|create|sendPrompt/i.test(request.op))).toBe(false);
  check("Sleeping cloud previews stay isolated across owner A → B → A without waking a VM", true);

  await page.setViewportSize({ width: 620, height: 420 });
  await expect(card(cloud.keys[0])).toBeVisible();
  const box = await card(cloud.keys[0]).locator("..").boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(620);
  expect(box.y + box.height).toBeLessThanOrEqual(420);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.keyboard.press("Escape");
  check("The preview remains inside a constrained viewport", true);
}
