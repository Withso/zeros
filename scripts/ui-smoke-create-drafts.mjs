import { expect } from "@playwright/test";

const organization = "11111111-1111-4111-8111-111111111111";
const repositories = [
  { repository: "example/project", defaultBranch: "main" },
  { repository: "example/recent", defaultBranch: "trunk" },
];
const notes = "# Attachment review\n\nThe draft and these files stay on this device until Create.\n\n- Read the notes\n- Check the image and recording\n\n```ts\nconst ready = true;\n```\n";
const markdown = { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from(notes) };

export async function runCreateLinkedDirectoriesSmoke({ page, check, harnessBase }) {
  await page.route("https://api.example.test/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (/\/computer\/repositories$/.test(path)) return route.fulfill({ json: { repositories } });
    if (path === "/v1/cloud-v2/workspaces") return route.fulfill({ json: { workspaces: [] } });
    return route.fulfill({ status: 503, json: { error: { code: "fixture_unavailable", message: "Fixture unavailable" } } });
  });
  try {
  await page.goto(`${harnessBase}/harness-folder-workspace.html?create&cloud-enabled`);
  await expect(page.getByRole("button", { name: "Show Create", exact: true })).toBeVisible();
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await expect(page.getByRole("button", { name: "Show Create", exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.setFolderGitState(true, "https://github.com/example/project.git");
    const invoke = window.__ZEROS_NATIVE__.invoke.bind(window.__ZEROS_NATIVE__);
    window.__ZEROS_NATIVE__.invoke = (op, args) => op === "dialog_pick_folder"
      ? Promise.resolve("/fixture/shared-library") : invoke(op, args);
  });
  await page.getByRole("button", { name: "Show Create", exact: true }).click();
  const card = page.locator("[data-dispatcher-composer]");
  const editor = card.locator(".composer-pm");
  const picker = page.getByRole("button", { name: "Choose project", exact: true });
  const linked = card.getByRole("button", { name: "Remove directory access: /fixture/shared-library", exact: true });
  await editor.fill("Keep the linked workspace with this draft");
  await card.getByRole("button", { name: "Add attachment or link a workspace", exact: true }).click();
  await page.getByRole("menuitem", { name: "Link workspaces", exact: true }).click();
  await page.getByRole("option", { name: "Browse…", exact: true }).click();
  await page.getByRole("dialog").press("Escape");
  await expect(linked).toBeVisible();
  await page.evaluate(async () => {
    const { upsertProject } = await import("/apps/desktop/src/renderer/state/projects-store.ts");
    const { notifyProjectsChanged } = await import("/apps/desktop/src/renderer/state/use-projects.ts");
    upsertProject({ repoRoot: "/fixture/linked-other", name: "Linked other", isGitRepository: true });
    notifyProjectsChanged();
  });
  await picker.click();
  await page.getByRole("menuitem", { name: "Linked other", exact: true }).click();
  await expect(linked).toHaveCount(0);
  await expect(editor).toBeEmpty();
  await picker.click();
  await page.getByRole("menuitem", { name: "To-do app", exact: true }).click();
  await expect(editor).toHaveText("Keep the linked workspace with this draft");
  await expect(linked).toBeVisible();
  await page.evaluate(() => window.setCreateOrganization("organization"));
  await expect(linked).toHaveCount(0);
  await expect(editor).toBeEmpty();
  await card.getByRole("button", { name: "Add attachment", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Add attachment", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Link workspaces", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.setCreateOrganization("personal"));
  await expect(linked).toBeVisible();
  await editor.fill("");
  await page.reload();
  await expect(linked).toBeVisible();
  await expect(editor).toBeEmpty();
  expect(await page.evaluate(async () => {
    const { createComposerDrafts } = await import("/apps/desktop/src/renderer/state/create-composer-drafts.ts");
    return createComposerDrafts.hasDraft("local");
  })).toBe(true);
  await linked.click();
  await page.reload();
  await expect(linked).toHaveCount(0);
  expect(await page.evaluate(async () => {
    const { createComposerDrafts } = await import("/apps/desktop/src/renderer/state/create-composer-drafts.ts");
    return createComposerDrafts.hasDraft("local");
  })).toBe(false);
  check("Create retains linked workspace pills across project switches and reload, including a directory-only draft", true);
  check("Cloud Create keeps attachments available without offering unsupported Local directory links", true);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
  }
}

export async function runCreateDraftIndicatorSmoke({ page, check, harnessBase }) {
  await page.route("https://api.example.test/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (/\/computer\/repositories$/.test(path)) return route.fulfill({ json: { repositories } });
    if (path === "/v1/cloud-v2/workspaces") return route.fulfill({ json: { workspaces: [] } });
    return route.fulfill({ status: 503, json: { error: { code: "fixture_unavailable", message: "Fixture unavailable" } } });
  });
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${harnessBase}/harness-folder-workspace.html?create&cloud-enabled&composer-suggestions`);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.reload();
    await page.getByRole("button", { name: "Open folder fixture", exact: true }).click();
    await page.getByRole("button", { name: "Initialize git and create", exact: true }).click();
    const sidebar = page.locator("[data-app-sidebar]");
    const create = sidebar.getByRole("button", { name: "Create workspace", exact: true });
    const home = sidebar.getByRole("button", { name: "Home", exact: true });
    const mark = create.locator("[data-composer-draft]");
    const card = page.locator("[data-dispatcher-composer]");
    const editor = card.locator(".composer-pm");
    const open = async () => { await create.click(); await expect(editor).toBeVisible(); };
    const leave = async () => { await home.click(); await expect(card).toHaveCount(0); };

    await open();
    await editor.fill("Keep this Create draft while I work elsewhere");
    await expect(mark).toHaveCount(0);
    await sidebar.locator("[data-workspace-tab]").first().click();
    await expect(mark).toBeVisible();
    await expect(create).toHaveAttribute("aria-description", "Unsent draft");
    await expect.poll(async () => {
      const box = await mark.locator("svg").boundingBox();
      return box && [box.width, box.height];
    }).toEqual([12, 12]);
    for (const theme of ["dark", "light"]) {
      await page.evaluate(async mode => {
        const { setPrefs } = await import("/apps/desktop/src/renderer/shared/theme/store.ts"); setPrefs({ mode });
      }, theme);
      await sidebar.screenshot({ path: `.context/create-draft-sidebar-${theme}.png`, animations: "disabled" });
    }
    await open();
    await expect(editor).toHaveText("Keep this Create draft while I work elsewhere");
    await expect(mark).toHaveCount(0);
    await editor.fill(" \n ");
    await leave();
    await expect(mark).toHaveCount(0);
    check("Create shows the shared 12px pencil after leaving for a workspace, hides it while open, and ignores whitespace", true);

    await open();
    await editor.fill("/review-agent");
    await page.getByRole("button").filter({ hasText: /Review the source/ }).click();
    const skill = editor.locator("[data-skill-pill]");
    await expect.poll(async () => {
      const box = await skill.locator(".lucide-book").boundingBox();
      return box && [box.width, box.height];
    }).toEqual([12, 12]);
    await leave();
    await expect(mark).toBeVisible();
    await open();
    await card.getByRole("button", { name: "Remove Review Agent", exact: true }).click();
    await leave();
    await expect(mark).toHaveCount(0);
    await open();
    await card.locator('input[type="file"]').setInputFiles(markdown);
    await leave();
    await expect(mark).toBeVisible();
    await page.reload();
    await expect(mark).toBeVisible();
    await open();
    await expect(editor.locator("[data-attachment-pill]")).toBeVisible();
    await card.getByRole("button", { name: "Remove notes.md", exact: true }).click();
    await leave();
    await expect(mark).toHaveCount(0);
    check("Skill-only and attachment-only Create drafts show a pencil, recover after reload, and clear on removal", true);

    await page.evaluate(() => window.setCreateOrganization("organization"));
    await expect(mark).toHaveCount(0);
    await open();
    const picker = page.getByRole("button", { name: "Choose project", exact: true });
    await expect(picker).toHaveText("example/project");
    await editor.fill("Cloud owner one");
    await picker.click();
    await page.getByRole("menuitem", { name: "example/recent", exact: true }).click();
    await expect(editor).toBeEmpty();
    await leave();
    await expect(mark).toBeVisible();
    await page.evaluate(() => window.setCreateOrganization("other"));
    await expect(mark).toHaveCount(0);
    await page.evaluate(() => window.setCreateOrganization("organization"));
    await expect(mark).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Show Create", exact: true })).toBeVisible();
    await page.evaluate(() => window.setCreateOrganization("organization"));
    await expect(mark).toBeVisible();
    await open();
    await expect(picker).toHaveText("example/recent");
    await expect(editor).toBeEmpty();
    await picker.click();
    await page.getByRole("menuitem", { name: "example/project", exact: true }).click();
    await expect(editor).toHaveText("Cloud owner one");
    await editor.fill("");
    await leave();
    await expect(mark).toHaveCount(0);
    check("Create draft presence spans an owner's projects, restores after reload and stays isolated through cloud owner A → B → A", true);

    await page.evaluate(() => window.setCreateOrganization("personal"));
    await open();
    await editor.fill("Keep a failed Create draft");
    await page.evaluate(() => window.setFolderCreationFails(true));
    await card.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByText("Couldn't create workspace: Workspace creation failed", { exact: true })).toBeVisible();
    await leave();
    await expect(mark).toBeVisible();
    await page.evaluate(() => window.setFolderCreationFails(false));
    await open();
    await card.getByRole("button", { name: "Create", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(mark).toHaveCount(0);
    check("Failed creation retains the pencil; successful draft handoff clears it", true);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
  }
}

/** Real IndexedDB, editor and viewers; fake only the native/cloud transports. */
export async function runCreateDraftsSmoke({ page, check, harnessBase }) {
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  let holdRepositories = false;
  let heldReads = 0;
  let releaseRepositories;
  let readGate;
  await page.route("https://api.example.test/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (/\/computer\/repositories$/.test(path)) {
      if (holdRepositories && path.includes(organization)) { heldReads++; await readGate; }
      return route.fulfill({ json: { repositories } });
    }
    if (path === "/v1/cloud-v2/workspaces") return route.fulfill({ json: { workspaces: [] } });
    return route.fulfill({ status: 503, json: { error: { code: "fixture_unavailable", message: "Fixture unavailable" } } });
  });
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${harnessBase}/harness-folder-workspace.html?create&cloud-enabled`);
    await expect(page.getByRole("button", { name: "Show Create", exact: true })).toBeVisible();
    await page.evaluate(() => window.setFolderGitState(true, "https://github.com/example/project.git"));
    await page.getByRole("button", { name: "Show Create", exact: true }).click();
    const recoveredSource = await page.evaluate(async () => {
      const { prepareAttachmentSource, releaseAttachmentSource } = await import("/apps/desktop/src/renderer/features/agent/attachment-sources.ts");
      const file = { id: "snapshot", name: "snapshot.txt", kind: "file", mimeType: "text/plain", size: 8, data: "", validation: { ok: true }, sourcePortable: true, sourceFile: new Blob(["original"]) };
      await prepareAttachmentSource(file);
      // A destination upload releases its memory entry while another draft
      // still retains the same source id. The original file can have changed.
      await releaseAttachmentSource(file.sourceRecoveryId);
      const read = await prepareAttachmentSource({ ...file, sourceFile: new Blob(["modified"]) });
      return read.blob.text();
    });
    expect(recoveredSource).toBe("original");
    const card = page.locator("[data-dispatcher-composer]");
    const editor = card.locator(".composer-pm");
    const input = card.locator('input[type="file"]');
    const picker = page.getByRole("button", { name: "Choose project", exact: true });
    const panel = page.getByRole("complementary", { name: "Attachment preview" });
    const open = async name => {
      await card.getByRole("button", { name: `Open ${name}`, exact: true }).click();
      await expect(panel).toBeVisible();
      await expect(panel.locator('[aria-busy="true"]')).toHaveCount(0);
    };
    const close = async () => {
      await panel.getByRole("button", { name: "Close attachment preview" }).click();
      await expect(panel).toHaveCount(0);
    };
    const localPrompt = "Review these attachments before creating the workspace.";
    await editor.fill(localPrompt);
    const recording = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 160; canvas.height = 90;
      const context = canvas.getContext("2d");
      const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
      const chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const finished = new Promise(resolve => { recorder.onstop = resolve; });
      recorder.start();
      for (let frame = 0; frame < 8; frame++) {
        context.fillStyle = `rgb(${frame * 30}, 120, 90)`; context.fillRect(0, 0, 160, 90);
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      recorder.stop();
      await finished;
      stream.getTracks().forEach(track => track.stop());
      return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
    });
    await input.setInputFiles([
      markdown,
      { name: "example.txt", mimeType: "text/plain", buffer: Buffer.from("Plain text <script>must stay text</script>\nSecond line") },
      { name: "image.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6s0sAAAAASUVORK5CYII=", "base64") },
      { name: "recording.webm", mimeType: "video/webm", buffer: Buffer.from(recording) },
      { name: "data.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 255, 1, 2]) },
    ]);
    await open("notes.md");
    await expect(panel.getByRole("heading", { name: "Attachment review" })).toBeVisible();
    await panel.getByRole("tab", { name: "Code", exact: true }).click();
    await expect(panel.locator("pre")).toHaveText(notes);
    await panel.getByRole("tab", { name: "Preview", exact: true }).click();
    await page.setViewportSize({ width: 780, height: 700 });
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const theme of ["dark", "light"]) {
      await page.evaluate(async mode => {
        const { setPrefs } = await import("/apps/desktop/src/renderer/shared/theme/store.ts"); setPrefs({ mode });
      }, theme);
      await page.locator("[data-folder-workspace-surface]").screenshot({ path: `.context/create-attachments-${theme}.png`, animations: "disabled" });
    }
    await page.evaluate(async () => {
      const { setPrefs } = await import("/apps/desktop/src/renderer/shared/theme/store.ts"); setPrefs({ mode: "dark" });
    });
    await panel.getByRole("button", { name: "Close attachment preview" }).focus();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(editor).toBeFocused();
    check("Create opens a side column with Markdown preview/source and Escape restores composer focus", true);

    // A reload drops every File object and JS promise. Only source ids and the
    // real IndexedDB bytes can supply these previews afterwards.
    await page.reload();
    await expect(editor).toContainText(localPrompt);
    await expect(card.getByRole("button", { name: "Open notes.md", exact: true })).toBeVisible();
    await page.evaluate(size => {
      const read = Blob.prototype.arrayBuffer;
      const gate = new Promise(resolve => { window.releasePreviewRead = resolve; });
      Blob.prototype.arrayBuffer = function () {
        if (this.size !== size) return read.call(this);
        Blob.prototype.arrayBuffer = read;
        window.previewReadHeld = true;
        return gate.then(() => read.call(this));
      };
    }, markdown.buffer.length);
    await card.getByRole("button", { name: "Open notes.md", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.previewReadHeld)).toBe(true);
    await open("example.txt");
    await page.evaluate(async () => {
      window.releasePreviewRead();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await expect(panel.locator("pre")).toHaveText("Plain text <script>must stay text</script>\nSecond line");
    await expect(panel.getByRole("heading", { name: "Attachment review" })).toHaveCount(0);
    await expect(panel.locator("script")).toHaveCount(0);
    await open("image.png");
    await expect.poll(() => panel.locator("img").evaluate(image => image.naturalWidth)).toBe(1);
    await open("recording.webm");
    const video = panel.locator("video");
    await expect.poll(() => video.evaluate(media => media.readyState)).toBeGreaterThanOrEqual(1);
    await video.evaluate(media => { media.loop = true; return media.play(); });
    await expect.poll(() => video.evaluate(media => media.paused)).toBe(false);
    const mediaUrl = await video.getAttribute("src");
    await close();
    await expect(page.locator("video")).toHaveCount(0);
    expect(await page.evaluate(async url => { try { await fetch(url); return true; } catch { return false; } }, mediaUrl)).toBe(false);
    await open("data.bin");
    await expect(panel.getByText("Download this attachment to view it.", { exact: false })).toBeVisible();
    await expect(panel.getByRole("link", { name: "Download attachment" })).toHaveAttribute("download", "data.bin");
    await close();
    expect(await page.evaluate(() => window.folderWorkspaceRequests.filter(({ op }) => /attachmentUpload|contextGraph\.(put|create)/.test(op)))).toEqual([]);
    check("Create recovers text/image/video bytes after reload without a workspace, revokes media URLs on close and offers binary downloads", true);

    await open("notes.md");
    await card.getByRole("button", { name: "Remove notes.md", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+z");
    await open("notes.md");
    await expect(panel.getByRole("heading", { name: "Attachment review" })).toBeVisible();
    await close();
    check("Removing an open attachment closes its preview and Undo restores the readable source", true);

    const unsolicitedReads = [];
    await page.route("https://attachment-preview.example.test/**", route => { unsolicitedReads.push(route.request().url()); return route.abort(); });
    await input.setInputFiles({ name: "untrusted.md", mimeType: "text/markdown", buffer: Buffer.from('# Readable text\n\n<img src="https://attachment-preview.example.test/pixel" onerror="window.previewExecuted = true"><style>body { display: none }</style><div class="fixed inset-0" style="background-image: url(https://attachment-preview.example.test/css)">Safe content</div><script>window.previewExecuted = true</script><iframe src="https://attachment-preview.example.test/frame"></iframe>') });
    await open("untrusted.md");
    await expect(panel.getByRole("heading", { name: "Readable text" })).toBeVisible();
    await expect(panel.locator(".zeros-md-prose").locator("script, style, img, iframe, [style], [class]")).toHaveCount(0);
    expect(await page.evaluate(() => window.previewExecuted ?? false)).toBe(false);
    expect(unsolicitedReads).toEqual([]);
    await card.getByRole("button", { name: "Remove untrusted.md", exact: true }).click();
    await expect(panel).toHaveCount(0);
    check("A stale read cannot replace another file, and Markdown cannot execute scripts, load trackers or style the app", true);

    await page.evaluate(() => window.setCreateOrganization("organization"));
    await expect(picker).toHaveText("example/project");
    await expect(editor).toBeEmpty();
    await editor.fill("Organization one, first repository");
    await picker.click();
    await page.getByRole("menuitem", { name: "example/recent", exact: true }).click();
    await expect(editor).toBeEmpty();
    await editor.fill("Organization one, recent repository");
    await input.setInputFiles(markdown);
    await open("notes.md");
    await page.evaluate(() => window.setCreateOrganization("other"));
    await expect(panel).toHaveCount(0);
    await expect(editor).toBeEmpty();
    await editor.fill("Organization two");
    await page.evaluate(() => window.setCreateOrganization("organization"));
    await expect(picker).toHaveText("example/recent");
    await expect(editor).toContainText("Organization one, recent repository");
    await page.evaluate(() => window.setCreateOrganization("personal"));
    await expect(editor).toContainText(localPrompt);
    await page.evaluate(() => window.setCreateOrganization("organization"));
    check("Local, cloud organizations and cloud repositories restore independent drafts and attachment lists", true);

    holdRepositories = true;
    readGate = new Promise(resolve => { releaseRepositories = resolve; });
    await page.reload();
    await expect(page.getByRole("button", { name: "Show Create", exact: true })).toBeVisible();
    await page.evaluate(() => window.setCreateOrganization("organization"));
    await expect.poll(() => heldReads).toBeGreaterThan(0);
    await expect(picker).toHaveText("example/recent");
    await expect(editor).toContainText("Organization one, recent repository");
    await expect(page.getByText(/Checking (Cloud|cloud)/)).toHaveCount(0);
    await expect(page.getByText("Add project", { exact: true })).toHaveCount(0);
    await expect(page.locator("[data-dispatcher-mode-switcher]")).toHaveCount(0);
    await open("notes.md");
    await expect(panel.getByRole("heading", { name: "Attachment review" })).toBeVisible();
    await page.locator("[data-folder-workspace-surface]").screenshot({ path: ".context/create-cloud-cached.png" });
    holdRepositories = false;
    releaseRepositories();
    await close();
    check("A held cloud refresh preserves the cached repository and draft after restart without checking rows or Local picker flashes", true);

    // Remove one real recovery record and clear its in-memory cache, then
    // restore it to exercise the viewer's retry against the same draft.
    const removedSource = await page.evaluate(async () => {
      const { createComposerDrafts } = await import("/apps/desktop/src/renderer/state/create-composer-drafts.ts");
      const { releaseAttachmentSource } = await import("/apps/desktop/src/renderer/features/agent/attachment-sources.ts");
      const sourceId = createComposerDrafts.drafts().find(d => d.text.includes("recent repository")).attachments[0].sourceRecoveryId;
      await releaseAttachmentSource(sourceId);
      const record = await new Promise((resolve, reject) => {
        const request = indexedDB.open("zeros:attachment-sources:v1", 1);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("sources", "readwrite");
          const store = tx.objectStore("sources"), get = store.get(sourceId);
          get.onsuccess = () => { store.delete(sourceId); };
          tx.oncomplete = () => { db.close(); resolve(get.result); };
          tx.onabort = () => reject(tx.error);
        };
      });
      return { id: sourceId, type: record.blob.type, bytes: [...new Uint8Array(await record.blob.arrayBuffer())] };
    });
    // Drop the editor's recovered Blob as well as the preparation cache.
    await page.reload();
    await expect(page.getByRole("button", { name: "Show Create", exact: true })).toBeVisible();
    await page.evaluate(() => window.setCreateOrganization("organization"));
    await open("notes.md");
    await expect(panel.getByRole("status")).toContainText("couldn't be opened");
    await page.evaluate(async source => {
      await new Promise(resolve => {
        const request = indexedDB.open("zeros:attachment-sources:v1", 1);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction("sources", "readwrite");
          tx.objectStore("sources").put({ version: 1, blob: new Blob([new Uint8Array(source.bytes)], { type: source.type }), touchedAt: Date.now() }, source.id);
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    }, removedSource);
    await panel.getByRole("button", { name: "Retry loading this file", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Attachment review" })).toBeVisible();
    check("Unavailable recovery bytes show a retryable preview error without losing the draft or file pill", true);
    await close();
    await runCreateLocalOwnerSmoke({ page, check });
    await runCreateModelSelectionSmoke({ page, check });
  } finally {
    releaseRepositories?.();
    await page.unrouteAll({ behavior: "wait" });
  }
}

async function runCreateModelSelectionSmoke({ page, check }) {
  const card = page.locator("[data-dispatcher-composer]");
  const editor = card.locator(".composer-pm");
  const model = card.locator("[data-model-pill-label]");
  const picker = page.getByRole("button", { name: "Choose project", exact: true });
  await model.click();
  await page.getByPlaceholder("Search models…").fill("Haiku");
  await page.getByRole("option").filter({ hasText: "Haiku 4.5" }).click();
  await expect(model).toContainText("Haiku 4.5");
  const chosen = await model.innerText();
  await page.evaluate(async () => {
    const { upsertProject } = await import("/apps/desktop/src/renderer/state/projects-store.ts");
    const { notifyProjectsChanged } = await import("/apps/desktop/src/renderer/state/use-projects.ts");
    upsertProject({ repoRoot: "/fixture/second", name: "Second project", isGitRepository: true });
    notifyProjectsChanged();
  });
  await picker.click();
  await page.getByRole("menuitem", { name: "Second project", exact: true }).click();
  await expect(editor).toBeEmpty();
  await expect(model).toHaveText(chosen);
  await picker.click();
  await page.getByRole("menuitem", { name: "To-do app", exact: true }).click();
  await expect(editor).toHaveText("Newer typing while the submitted workspace finishes");
  await expect(model).toHaveText(chosen);
  await page.evaluate(() => window.setCreateOrganization("organization"));
  await expect(editor).toContainText("Organization one, recent repository");
  await expect(model).toHaveText(chosen);
  await page.evaluate(() => window.setCreateOrganization("personal"));
  await expect(model).toHaveText(chosen);
  check("Changing projects or owners restores scoped drafts while preserving the selected Create model", true);
}

async function holdWorkspaceOperation(page, operation) {
  await page.evaluate(async op => {
    const { getActiveBridge } = await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts");
    const bridge = getActiveBridge(), original = bridge.request.bind(bridge);
    const gate = new Promise(resolve => { window.releaseCreateOperation = resolve; });
    bridge.request = async (...args) => {
      if (args[0].op !== op) return original(...args);
      window.heldCreateOperation = op;
      await gate;
      bridge.request = original;
      return original(...args);
    };
  }, operation);
}

export async function runCreateLocalOwnerSmoke({ page, check }) {
  const card = page.locator("[data-dispatcher-composer]");
  const editor = card.locator(".composer-pm");
  await page.evaluate(() => { window.setCreateOrganization("personal"); window.setFolderInspection(true); });
  await editor.fill("Local prompt while preparation is pending");
  await holdWorkspaceOperation(page, "workspace.prepareCreate");
  await card.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.heldCreateOperation)).toBe("workspace.prepareCreate");
  await page.evaluate(() => window.setCreateOrganization("organization"));
  await expect(editor).toContainText("Organization one, recent repository");
  await page.evaluate(() => window.releaseCreateOperation());
  await expect.poll(() => page.evaluate(() => window.folderWorkspaceRequests.filter(r => r.op === "workspace.create").length)).toBe(1);
  await expect(editor).toContainText("Organization one, recent repository");
  await page.evaluate(() => window.setCreateOrganization("personal"));
  await expect(editor).toContainText("Local prompt while preparation is pending");
  check("A delayed Local preparation completes in Local without navigating away from another owner or consuming its source draft", true);

  await holdWorkspaceOperation(page, "workspace.create");
  await card.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.heldCreateOperation)).toBe("workspace.create");
  await page.getByRole("button", { name: "Show Create", exact: true }).click();
  await editor.fill("Newer typing while the submitted workspace finishes");
  await page.evaluate(() => window.releaseCreateOperation());
  await expect.poll(() => page.evaluate(() => window.folderWorkspaceRequests.filter(r => r.op === "workspace.create").length)).toBe(2);
  await expect(editor).toHaveText("Newer typing while the submitted workspace finishes");
  await page.reload();
  await expect(editor).toHaveText("Newer typing while the submitted workspace finishes");
  check("A successful delayed Create consumes only its submitted revision, including after a reload", true);

  await page.evaluate(() => { window.setFolderInspection(true); window.setFolderCreationFails(true); });
  await card.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText("Couldn't create workspace: Workspace creation failed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show Create", exact: true }).click();
  await expect(editor).toHaveText("Newer typing while the submitted workspace finishes");
  await page.reload();
  await expect(editor).toHaveText("Newer typing while the submitted workspace finishes");
  check("A failed creation retains its source draft through navigation and restart", true);
}
