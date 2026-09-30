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
  // A cloud-only repository in another organization must never become a
  // Local branch-picker input, even though the global runtime catalog knows it.
  await page.evaluate(async () => {
    const { acceptCloudWorkspaceDocument } = await import("/apps/desktop/src/renderer/state/cloud-workspace-catalog.ts");
    const { notifyProjectsChanged } = await import("/apps/desktop/src/renderer/state/use-projects.ts");
    const organizationId="33333333-3333-4333-8333-333333333333",now="2026-09-27T00:00:00Z";
    acceptCloudWorkspaceDocument({id:"77777777-7777-4777-8777-777777777777",organizationId,teamId:organizationId,createdBy:organizationId,name:"Cloud only",placement:"cloud",status:"stopped",version:1,error:null,createdAt:now,updatedAt:now,deletedAt:null,
      capabilities:{canWrite:true,canManage:true,canStart:true,startUnavailableReason:null},repository:{forge:"github.com",owner:"example",name:"organization-only",revision:"refs/heads/main"},
      generation:{number:1,architecture:"linux/amd64",resources:{cpuMillicores:2000,memoryMiB:4096,storageMiB:20480},observedState:"stopped",lastObservedAt:null}});
    notifyProjectsChanged();
  });
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
  const location = page.getByRole("button", { name: "Workspace location", exact: true });
  await expect(location).toHaveCount(0);
  expect(await page.evaluate(() => window.folderWorkspaceRequests.filter(row => row.op === "cloud_workspace_capability").length)).toBe(0);
  await editor.fill("Keep my draft when switching organizations");
  await page.evaluate(() => window.setCreateOrganization("organization"));
  await expect(location).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: "Choose a project first." })).toBeVisible();
  await page.screenshot({ path: ".context/cloud-create-ui.png" });
  await page.evaluate(() => window.setCreateOrganization("other"));
  await expect(location).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await page.evaluate(() => window.setCreateOrganization("personal"));
  await expect(page.getByRole("status").filter({ hasText: "Cloud" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
  await expect(editor).toHaveText("Keep my draft when switching organizations");
  await page.evaluate(() => window.setCreateOrganization("organization"));
  await expect(card.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await page.evaluate(() => window.setCreateOrganization("sign-out"));
  await expect(card.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
  await expect(editor).toHaveText("Keep my draft when switching organizations");
  await page.evaluate(() => window.setCreateOrganization("organization"));
  await expect(card.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await page.evaluate(() => window.setCreateOrganization("personal"));
  await editor.fill("");
  await page.locator("[data-folder-workspace-surface]").screenshot({ path: ".context/personal-create-ui.png" });
  check("Personal stays local, organizations require Cloud without a Local fallback, and composer drafts survive", true);
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
  await expect(page.getByRole("menuitem",{name:"organization-only",exact:true})).toHaveCount(0);
  await expect(page.getByText("Open a local checkout of this repository to create a Local workspace.",{exact:true})).toHaveCount(0);
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
  // Dismiss only once the popover owns focus; an earlier key can reach the
  // page before its dismissable layer is listening.
  await expect(dialog.getByRole("searchbox", { name: "Search sources" })).toBeFocused();
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
  await runCloudCreateOwnerSmoke({ page, check, harnessBase });
}

/** A delayed real create response must not retarget the newly selected owner. */
export async function runCloudCreateOwnerSmoke({ page, check, harnessBase }) {
  const organizationId = "11111111-1111-4111-8111-111111111111";
  let releaseCreate;
  const createGate = new Promise(resolve => { releaseCreate = resolve; });
  const creates = [];
  await page.route("https://api.example.test/**", async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/create-options")) {
      await route.fulfill({ json: { configured: true, repository:{owner:"example",name:"project",defaultBranch:"main"}, installations: [{
        id: "33333333-3333-4333-8333-333333333333", accountLogin: "example",
      }] } });
    } else if (pathname.endsWith("/cloud-workspaces") && request.method() === "POST") {
      creates.push({ pathname, body: request.postDataJSON() });
      await createGate;
      await route.fulfill({ status: 201, json: { workspace: {
        id: "44444444-4444-4444-8444-444444444444",
        organizationId, teamId: organizationId, createdBy: organizationId,
        name: "Created in Organization 1", placement: "cloud", status: "ready",
        version: 1, error: null, deletedAt: null,
        createdAt: "2026-09-26T10:00:00Z", updatedAt: "2026-09-26T10:00:00Z",
        capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
        repository: { forge: "github.com", owner: "example", name: "project", revision: "refs/heads/main" },
        generation: { number: 1, architecture: "x86_64", observedState: "running", lastObservedAt: null,
          resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 } },
      } } });
    } else {
      await route.fulfill({ status: 503, json: { error: { code: "fixture_unavailable", message: "Fixture unavailable" } } });
    }
  });
  try {
    await page.setViewportSize({ width: 1100, height: 780 });
    await page.goto(`${harnessBase}/harness-folder-workspace.html?create&cloud-enabled`);
    await page.getByRole("button", { name: "Open folder fixture", exact: true }).click();
    await page.getByRole("button", { name: "Initialize git and create", exact: true }).click();
    await page.getByRole("button", { name: "Show Create", exact: true }).click();
    await page.evaluate(async () => {
      const {acceptCloudWorkspaceDocument}=await import("/apps/desktop/src/renderer/state/cloud-workspace-catalog.ts");
      const {notifyProjectsChanged}=await import("/apps/desktop/src/renderer/state/use-projects.ts");
      const organizationId="11111111-1111-4111-8111-111111111111",now="2026-09-27T00:00:00Z";
      acceptCloudWorkspaceDocument({id:"88888888-8888-4888-8888-888888888888",organizationId,teamId:organizationId,createdBy:organizationId,name:"Existing cloud workspace",placement:"cloud",status:"stopped",version:1,error:null,createdAt:now,updatedAt:now,deletedAt:null,
        capabilities:{canWrite:true,canManage:true,canStart:true,startUnavailableReason:null},repository:{forge:"github.com",owner:"example",name:"project",revision:"refs/heads/main"},generation:{number:1,architecture:"linux/amd64",resources:{cpuMillicores:2000,memoryMiB:4096,storageMiB:20480},observedState:"stopped",lastObservedAt:null}});
      notifyProjectsChanged();
      window.setFolderGitState(true, "https://github.com/example/project.git");
      window.setCreateOrganization("organization");
    });
    const card = page.locator("[data-dispatcher-composer]");
    const editor = card.locator(".composer-pm");
    const location = page.getByRole("button", { name: "Workspace location", exact: true });
    await expect(location).toHaveCount(0);
    await editor.fill("Preserve this prompt while creation finishes");
    await card.getByRole("button", { name: "Create", exact: true }).click();
    await expect.poll(() => creates.length).toBe(1);
    expect(creates[0].pathname).toBe(`/v1/organizations/${organizationId}/cloud-workspaces`);
    await page.evaluate(() => window.setCreateOrganization("personal"));
    releaseCreate();
    await expect(card.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
    await expect(location).toHaveCount(0);
    await expect(editor).toHaveText("Preserve this prompt while creation finishes");
    await expect(page.getByText("Cloud workspace created in Organization 1", { exact: true })).toBeVisible();
    check("A late Cloud creation stays in its original organization while Personal and the draft stay selected", true);
  } finally {
    releaseCreate();
    await page.unrouteAll({ behavior: "wait" });
  }
}
