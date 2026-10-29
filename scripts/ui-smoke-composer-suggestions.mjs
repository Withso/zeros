import { expect } from "@playwright/test";

export async function runCreateReferenceSafetySmoke({ page, check, harnessBase }) {
  await page.goto(`${harnessBase}/harness-folder-workspace.html?create&cloud-enabled&composer-suggestions`);
  await expect(page.getByRole("button", { name: "Show Create", exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.setFolderGitState(true, "https://github.com/example/project.git");
    window.setFolderFiles(["src/App.tsx", "docs/guide.md"]);
  });
  await page.getByRole("button", { name: "Show Create", exact: true }).click();
  const card = page.locator("[data-dispatcher-composer]");
  const editor = card.locator(".composer-pm");
  await editor.fill("Read @App");
  const mentions = page.locator('[data-composer-suggestions="@"]');
  await expect(mentions).toHaveAttribute("data-side", "bottom");
  await expect.poll(async () => {
    const trigger = await editor.locator(".suggestion").boundingBox();
    const popup = await mentions.boundingBox();
    return !!trigger && !!popup && Math.abs(popup.x - trigger.x) < 2 && Math.abs(popup.y - trigger.y - trigger.height - 6) < 3;
  }).toBe(true);
  await page.getByRole("button").filter({ hasText: /^App\.tsx/ }).click();
  const mention = card.locator("[data-mention-pill]");
  await expect(mention).toBeVisible();
  const before = await page.evaluate(() => window.folderWorkspaceRequests.length);
  // A nested control or programmatic form event is not Create intent. Editor
  // Enter already has its own explicit submission path.
  await card.locator("form").evaluate(form => form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true })));
  expect(await page.evaluate(index => window.folderWorkspaceRequests.slice(index).filter(({ op }) => /prepare|create|startSession/i.test(op)).map(({ op }) => op), before)).toEqual([]);
  await mention.getByRole("button", { name: "Open App.tsx", exact: true }).click({ force: true });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const mutations = await page.evaluate(index => window.folderWorkspaceRequests.slice(index).filter(({ op }) => /prepare|create|startSession|file\.read|read_file/i.test(op)), before);
  expect(mutations).toEqual([]);
  await expect(card).toBeVisible();
  await expect(mention.getByRole("button", { name: "Open App.tsx", exact: true })).toBeDisabled();
  await mention.getByRole("button", { name: "Remove App.tsx", exact: true }).click();
  await editor.press("ControlOrMeta+z");
  await expect(card.locator("[data-mention-pill]")).toBeVisible();
  check("Create mention clicks are inert without submission, navigation or source reads; removal stays undoable", true);

  await editor.fill("Please use /review-agent");
  const commands = page.locator('[data-composer-suggestions="/"]');
  await expect(commands).toHaveAttribute("data-side", "bottom");
  await expect.poll(async () => {
    const trigger = await editor.locator(".suggestion").boundingBox();
    const popup = await commands.boundingBox();
    return !!trigger && !!popup && Math.abs(popup.x - trigger.x) < 2 && Math.abs(popup.y - trigger.y - trigger.height - 6) < 3;
  }).toBe(true);
  await page.getByRole("button").filter({ hasText: /Review the source/ }).click();
  const skill = card.locator("[data-skill-pill]");
  await expect(skill).toBeVisible();
  const beforeSkill = await page.evaluate(() => window.folderWorkspaceRequests.length);
  await skill.getByRole("button", { name: "Open Review Agent", exact: true }).evaluate(button => button.click());
  expect(await page.evaluate(index => window.folderWorkspaceRequests.slice(index).filter(({ op }) => /prepare|create|startSession|file\.read|read_file/i.test(op)), beforeSkill)).toEqual([]);
  await expect(skill.getByRole("button", { name: "Open Review Agent", exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("button", { name: "Show Create", exact: true })).toBeVisible();
  await page.evaluate(() => window.setFolderGitState(true, "https://github.com/example/project.git"));
  await page.getByRole("button", { name: "Show Create", exact: true }).click();
  await expect(card.locator("[data-skill-pill]")).toBeVisible();
  await expect(card.getByRole("button", { name: "Open Review Agent", exact: true })).toBeDisabled();
  check("Create skills remain inert source references after persisted draft restoration", true);

  await card.locator('input[type="file"]').setInputFiles({ name: "guide.md", mimeType: "text/markdown", buffer: Buffer.from("# Markdown guide\n\nSource and preview.") });
  await card.getByRole("button", { name: "Open guide.md", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Attachment preview" });
  const tabs = panel.getByRole("tablist", { name: "Markdown view" });
  await expect(tabs.getByRole("tab", { name: "Preview", exact: true })).toHaveAttribute("aria-selected", "true");
  await tabs.getByRole("tab", { name: "Code", exact: true }).click();
  await expect(panel.locator("pre")).toContainText("# Markdown guide");
  await expect(tabs.getByRole("tab", { name: "Preview", exact: true })).toBeVisible();
  await tabs.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Markdown guide" })).toBeVisible();
  check("Markdown attachments expose persistent Preview and Code segments", true);
  for (const theme of ["dark", "light"]) {
    await page.evaluate(async mode => {
      const { setPrefs } = await import("/apps/desktop/src/renderer/shared/theme/store.ts"); setPrefs({ mode });
    }, theme);
    await page.locator("[data-folder-workspace-surface]").screenshot({ path: `.context/composer-markdown-${theme}.png`, animations: "disabled" });
  }
}

export async function runComposerSuggestionsSmoke({ page, check, harnessBase }) {
  const owners = [
    ["Local", "/personal/composer-suggestions"],
    ["organization-local", "/organization/composer-suggestions"],
    ["cloud", "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222"],
  ];
  for (const [label, cwd] of owners) {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(`${harnessBase}/harness-composer-editor.html?suggestions&workspace=${encodeURIComponent(cwd)}`);
    await page.waitForFunction(() => window.__composerHarness?.editor);
    const editor = page.locator(".composer-pm");
    const host = page.getByTestId("composer-host");
    // Give the fixture the room a workspace's bottom composer normally has.
    await host.evaluate(element => { element.style.marginTop = "320px"; });
    const menu = page.locator('[data-composer-suggestions="/"]');
    const activeTab = () => page.evaluate(owner => {
      const scope = window.__composerWorkbench()[owner];
      return scope?.tabs.find(tab => tab.id === scope.activeId);
    }, cwd);
    await editor.fill("Please run /ini");
    const init = page.getByRole("button").filter({ hasText: /Generate a CLAUDE\.md/ });
    await expect(init).toBeVisible();
    await expect(menu).toHaveAttribute("data-side", "top");
    await expect.poll(async () => {
      const card = await host.boundingBox();
      const popup = await menu.boundingBox();
      return !!card && !!popup && Math.abs(popup.x - card.x) < 2 && Math.abs(popup.width - card.width) < 3 && Math.abs(popup.y + popup.height + 6 - card.y) < 3;
    }).toBe(true);
    // IME candidate confirmation must reach the input method, not accept a
    // suggestion or submit the draft underneath the menu.
    await editor.evaluate(element => {
      element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 229, isComposing: true }));
      element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    await expect(editor).toHaveText("Please run /ini");
    await expect(menu).toBeVisible();
    expect(await page.evaluate(() => window.__composerActionCalls.includes("submit"))).toBe(false);
    await page.keyboard.press("Enter");
    await expect(editor).toHaveText("Please run /init ");
    await expect(editor.locator("[data-slash-command]")).toHaveText("/init");
    expect(await page.evaluate(() => window.__composerActionCalls.includes("submit"))).toBe(false);
    check(`${label}: mid-message slash menu opens above the composer at its width, accents commands, respects IME and consumes Enter`, true);

    await editor.fill("Read @App");
    const mentions = page.locator('[data-composer-suggestions="@"]');
    await expect(mentions.getByRole("button").filter({ hasText: /^App\.tsx/ })).toBeVisible();
    await expect(mentions).toHaveAttribute("data-side", "top");
    await expect.poll(async () => {
      const card = await host.boundingBox(), popup = await mentions.boundingBox();
      return !!card && !!popup && Math.abs(popup.x - card.x) < 2 && Math.abs(popup.width - card.width) < 3 && Math.abs(popup.y + popup.height + 6 - card.y) < 3;
    }).toBe(true);
    await editor.press("Escape");
    check(`${label}: file mentions share the above-composer placement`, true);

    await editor.fill("Please use /review-agent");
    await page.getByRole("button").filter({ hasText: /Review the source/ }).click();
    const skill = editor.locator("[data-skill-pill]");
    await expect(skill).toBeVisible();
    const serialized = await page.evaluate(() => window.__composerHarness.serialize());
    expect(serialized.displayText).toBe("Please use /review-agent ");
    expect(serialized.attachments).toEqual([]);
    await skill.getByRole("button", { name: /^Open / }).click();
    expect((await activeTab())?.filePath).toBe("skills/review-agent/SKILL.md");
    const viewer = page.getByTestId("composer-source-viewer");
    await expect(viewer.getByRole("heading", { name: "Review source", exact: true })).toBeVisible();
    const firstId = (await activeTab()).id;
    await skill.getByRole("button", { name: /^Open / }).click();
    expect((await activeTab()).id).toBe(firstId);
    check(`${label}: skills are source references, retain their invocation and reopen the same source tab`, true);

    await editor.fill("Use /library-review");
    await page.getByRole("button").filter({ hasText: /Review from the provider library/ }).click();
    await skill.getByRole("button", { name: /^Open / }).click();
    expect((await activeTab()).skillSource).toMatchObject({ agentId: "claude", path: "/home/fixture/.claude/skills/library-review/SKILL.md" });
    await expect(viewer.getByRole("heading", { name: "Library source", exact: true })).toBeVisible();
    await viewer.getByRole("button", { name: "Code", exact: true }).click();
    await expect(viewer).toContainText("# Library source");
    expect(await page.evaluate(() => window.__composerActionCalls.filter(op => op === "skills_list" || op === "skills.list")))
      .toEqual([label === "cloud" ? "skills.list" : "skills_list"]);
    check(`${label}: provider library source opens through its own runtime and reuses cached discovery`, true);

    await editor.fill("Use /model");
    await page.getByRole("button").filter({ hasText: /A skill sharing a built-in name/ }).click();
    await expect(skill).toBeVisible();
    expect(await page.evaluate(() => window.__composerActionCalls.includes("model-action"))).toBe(false);
    await expect(skill.getByRole("button", { name: /^Open / })).toBeDisabled();
    check(`${label}: a same-name skill cannot run a command action or invent a missing source`, true);

    await page.evaluate(() => window.__composerHarness.insertFiles([new File(["# Chat attachment\n\nRead me."], "notes.md", { type: "text/markdown" })]));
    const attachment = editor.locator('[data-attachment-pill]');
    await expect(attachment.getByRole("button", { name: "Open notes.md", exact: true })).toBeEnabled();
    await attachment.getByRole("button", { name: "Open notes.md", exact: true }).click();
    await expect(viewer.getByRole("heading", { name: "Chat attachment", exact: true })).toBeVisible();
    await viewer.getByRole("button", { name: "Code", exact: true }).click();
    await expect(viewer.locator(".cm-content")).toContainText("# Chat attachment");
    await viewer.getByRole("button", { name: /^preview$/i }).click();
    await expect(viewer.getByRole("heading", { name: "Chat attachment", exact: true })).toBeVisible();
    check(`${label}: composer Markdown attachments retain Preview and Code in their file tab`, true);
  }

  const editor = page.locator(".composer-pm");
  const menu = page.locator('[data-composer-suggestions="/"]');
  for (const text of ["Read https://example.test/init", "Read src/init", "Read /init/config"]) {
    await editor.fill(text);
    await expect(menu).toHaveCount(0);
  }
  await editor.fill("Next line");
  await editor.press("Shift+Enter");
  await editor.pressSequentially("/ini");
  await expect(menu).toBeVisible();
  await editor.press("Tab");
  await expect(editor.locator("[data-slash-command]")).toHaveText("/init");
  await editor.pressSequentially(" /review-agent");
  await page.getByRole("button").filter({ hasText: /Review the source/ }).click();
  await editor.pressSequentially(" /ini");
  await expect(menu).toBeVisible();
  await editor.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(editor).toBeFocused();
  check("Slash boundaries exclude URLs/paths, accept newlines and text after pills, and preserve focus on Escape", true);

  await editor.fill("Please run /ini");
  await expect(menu).toBeVisible();
  await page.evaluate(() => window.__setComposerActive(false));
  await expect(menu).toHaveCount(0);
  await page.evaluate(() => window.__setComposerActive(true));
  await expect(menu).toHaveCount(0);
  check("A hidden composer releases its suggestion portal and does not restore a stale menu", true);

  await editor.fill("Please review /review");
  await expect(menu).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const theme of ["dark", "light"]) {
    await page.evaluate(async mode => {
      const { setPrefs } = await import("/apps/desktop/src/renderer/shared/theme/store.ts"); setPrefs({ mode });
    }, theme);
    await page.screenshot({ path: `.context/composer-suggestions-${theme}.png`, animations: "disabled" });
  }
  await page.setViewportSize({ width: 430, height: 280 });
  await page.getByTestId("composer-host").evaluate(element => { element.style.marginTop = "0px"; });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => {
    const box = await menu.boundingBox();
    return !!box && box.x >= 7 && box.y >= 7 && box.x + box.width <= 423 && box.y + box.height <= 273;
  }).toBe(true);
  await page.screenshot({ path: ".context/composer-suggestions-narrow.png", animations: "disabled" });
  check("Workspace menus stay inside narrow windows and remain readable in both themes", true);
  await runLateSkillSourceSmoke({ page, check, harnessBase });
  await runStoppedCloudSkillsSmoke({ page, check, harnessBase });
  await page.goto(`${harnessBase}/harness-composer-editor.html?suggestions`);
  await page.waitForFunction(() => window.__composerHarness?.editor);
  await page.evaluate(() => window.__setComposerAgent("cursor"));
  await page.locator(".composer-pm").fill("/comp");
  await page.getByRole("button").filter({ hasText: "Summarize the conversation to free up context" }).click();
  const compactActions = await page.evaluate(() => window.__composerActionCalls
    .filter(action => action === "compact-action" || action === "submit"));
  expect(compactActions).toEqual(["compact-action"]);
  await expect(page.locator(".composer-pm")).toHaveText("");
  check("Cursor /compact uses the existing inline command action without submitting a prompt", true);
}

export async function runLateSkillSourceSmoke({ page, check, harnessBase }) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`${harnessBase}/harness-composer-editor.html?suggestions&late-skills&workspace=/personal/late-skills`);
  await page.waitForFunction(() => window.__composerHarness?.editor);
  const editor = page.locator(".composer-pm");
  await editor.fill("Use /review-agent");
  await page.getByRole("button").filter({ hasText: /Review the source/ }).click();
  const open = editor.locator("[data-skill-pill]").getByRole("button", { name: /^Open / });
  await expect(open).toBeDisabled();
  const text = await editor.innerText();
  await page.evaluate(() => window.__setComposerAgent("codex"));
  await page.evaluate(() => window.__releaseComposerSkills());
  await page.waitForFunction(async () => {
    const { skillCatalog, skillCatalogKey } = await import("/apps/desktop/src/renderer/platform/skill-catalog.ts");
    return skillCatalog.getSnapshot(skillCatalogKey("/personal/late-skills", "codex")).data?.length > 0;
  });
  await expect(open).toBeDisabled();
  await page.evaluate(() => window.__setComposerAgent("claude"));
  await expect(open).toBeEnabled();
  expect(await editor.innerText()).toBe(text);
  await open.click();
  await expect(page.getByTestId("composer-source-viewer").getByRole("heading", { name: "Review source", exact: true })).toBeVisible();
  check("Late skill discovery resolves only for its selected provider without changing the draft or submitting", true);
}

async function runStoppedCloudSkillsSmoke({ page, check, harnessBase }) {
  const cwd = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  await page.goto(`${harnessBase}/harness-composer-editor.html?suggestions&stopped&workspace=${encodeURIComponent(cwd)}`);
  await page.waitForFunction(() => window.__composerHarness?.editor);
  const editor = page.locator(".composer-pm");
  await editor.fill("Use /review-agent");
  await page.getByRole("button").filter({ hasText: /Review the source/ }).click();
  const open = editor.locator("[data-skill-pill]").getByRole("button", { name: /^Open / });
  await expect(open).toBeDisabled();
  expect(await page.evaluate(() => window.__composerActionCalls)).toEqual([]);
  // The existing lifecycle owns wake. Publishing its running snapshot should
  // resume discovery without remounting the editor or changing the draft.
  await page.evaluate(async owner => {
    const { parseCloudWorkspaceKey } = await import("/apps/desktop/src/renderer/platform/bridge/cloud-workspace-key.ts");
    const { cloudWorkspaceDocument, acceptCloudWorkspaceDocument } = await import("/apps/desktop/src/renderer/state/cloud-workspace-catalog.ts");
    const doc = cloudWorkspaceDocument(parseCloudWorkspaceKey(owner));
    acceptCloudWorkspaceDocument({ ...doc, version: doc.version + 1, status: "ready", generation: { ...doc.generation, observedState: "running" } });
  }, cwd);
  await expect(open).toBeEnabled();
  expect(await page.evaluate(() => window.__composerHarness.serialize().displayText)).toBe("Use /review-agent ");
  expect(await page.evaluate(() => window.__composerActionCalls)).toEqual(["skills.list"]);
  check("Stopped cloud composers defer discovery and resolve their skill source when the workspace wakes", true);
}
