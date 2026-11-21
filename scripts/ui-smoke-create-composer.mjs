import { expect } from "@playwright/test";
import { runCreateDraftsSmoke, runCreateDraftIndicatorSmoke, runCreateLinkedDirectoriesSmoke } from "./ui-smoke-create-drafts.mjs";
import { runCreateReferenceSafetySmoke } from "./ui-smoke-composer-suggestions.mjs";

const unbuiltComputer = () => ({ repositories: null });
const workspaceFixture = (overrides = {}) => ({
  id: "88888888-8888-4888-8888-888888888888",
  organizationId: "11111111-1111-4111-8111-111111111111",
  creatorUserId: "11111111-1111-4111-8111-111111111111",
  name: "Existing cloud workspace",
  repository: "example/project", branch: "workspace/topic", baseBranch: "main",
  state: "stopped", errorCode: null, version: 2,
  createdAt: "2026-10-21T10:00:00Z", updatedAt: "2026-10-21T10:00:00Z",
  capabilities: { design: false, browser: false, simulators: false,
    terminal: true, files: true, git: true, agents: ["codex", "claude", "cursor"] },
  ...overrides,
});

async function expectContextControlsInOneRow(page) {
  const [context, project, source] = await Promise.all([
    page.locator("[data-dispatcher-context]").boundingBox(),
    page
      .getByRole("button", { name: "Choose project", exact: true })
      .boundingBox(),
    page.locator("[data-create-source-trigger]").boundingBox(),
  ]);
  for (const control of [project, source]) {
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
  await expect(page.locator("[data-dispatcher-mode-switcher]")).toHaveCount(0);
}

/** Real Create page, menus, editor and create requests; only transport is fake. */
export async function runCreateComposerSmoke({ page, check, harnessBase }) {
  // Organization Create depends on its Cloud Computer, not a Local checkout.
  // Mock the read at the transport boundary; production validates its schema.
  await page.route(/^https:\/\/api\.example\.test\/v1\/cloud-v2\/organizations\/[^/]+\/computer\/repositories(?:\?|$)/, route => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ json: unbuiltComputer() });
  });
  await page.goto(`${harnessBase}/harness-folder-workspace.html?create&cloud-enabled&feature-off=unified-workspaces`);
  await page
    .getByRole("button", { name: "Open folder fixture", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Initialize git and create", exact: true })
    .click();
  await page.getByRole("button", { name: "Show Create", exact: true }).click();
  // A cloud-only repository in another organization must never become a
  // Local branch-picker input, even though the global runtime catalog knows it.
  await page.evaluate(async workspace => {
    const { acceptCloudWorkspaceDocument } = await import("/apps/desktop/src/renderer/state/cloud-workspace-catalog.ts");
    const { cloudV2Document } = await import("/apps/desktop/src/renderer/platform/cloud-v2.ts");
    const { notifyProjectsChanged } = await import("/apps/desktop/src/renderer/state/use-projects.ts");
    acceptCloudWorkspaceDocument(cloudV2Document(workspace));
    notifyProjectsChanged();
  }, workspaceFixture({ id: "77777777-7777-4777-8777-777777777777",
    organizationId: "33333333-3333-4333-8333-333333333333", name: "Cloud only",
    repository: "example/organization-only" }));
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
  await editor.fill("Keep my draft when switching organizations");
  await page.evaluate(() => window.setCreateOrganization("organization"));
  await expect(location).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  const buildRequired = page.getByRole("status").filter({ hasText: "Build your Cloud Computer first." });
  await expect(buildRequired).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Cloud Computer settings", exact: true })).toBeVisible();
  await page.screenshot({ path: ".context/cloud-create-ui.png" });
  await page.evaluate(() => window.setCreateOrganization("other"));
  await expect(location).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await expect(buildRequired).toBeVisible();
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
  await dialog.evaluate(node => {
    window.sourceReadAlerts = [];
    window.sourceReadObserver = new MutationObserver(records => {
      for (const record of records) for (const added of record.addedNodes) {
        if (added instanceof Element && (added.matches('[role="alert"]') || added.querySelector('[role="alert"]')))
          window.sourceReadAlerts.push(added.textContent);
      }
    });
    window.sourceReadObserver.observe(node, { childList: true, subtree: true });
  });
  await page.evaluate(() =>
    window.releaseFolderPrRead("GitHub is temporarily unavailable"),
  );
  await expect(dialog.getByRole("button", { name: /#42 · Improve the project picker/ })).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => {
    window.sourceReadObserver.disconnect();
    return window.sourceReadAlerts;
  })).toEqual([]);
  check("a transient GitHub source read retries without an error flash or manual retry", true);
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
    "project and branch/PR share one row at normal and narrow window widths without a Code/Design toggle",
    true,
  );
  await runCloudCreateOwnerSmoke({ page, check, harnessBase });
  await runCreateDraftsSmoke({ page, check, harnessBase });
  await runCreateReferenceSafetySmoke({ page, check, harnessBase });
  await runCreateDraftIndicatorSmoke({ page, check, harnessBase });
  await runCreateLinkedDirectoriesSmoke({ page, check, harnessBase });
  await runCreatePlacementSmoke({ page, check, harnessBase });
}

/** unified-workspaces (on in dev): the This Mac / Cloud control, not the
 * selected owner, decides placement; a blocked cloud side speaks in the tray. */
export async function runCreatePlacementSmoke({ page, check, harnessBase }) {
  const computer = /^https:\/\/api\.example\.test\/v1\/cloud-v2\/organizations\/[^/]+\/computer\/repositories(?:\?|$)/;
  await page.route(computer, route => route.fulfill({ json: unbuiltComputer() }));
  await page.goto(`${harnessBase}/harness-folder-workspace.html?create&cloud-enabled`);
  await page.getByRole("button", { name: "Open folder fixture", exact: true }).click();
  await page.getByRole("button", { name: "Initialize git and create", exact: true }).click();
  await page.getByRole("button", { name: "Show Create", exact: true }).click();
  await page.evaluate(() => window.setCreateOrganization("personal"));
  const card = page.locator("[data-dispatcher-composer]");
  const editor = card.locator(".composer-pm");
  const create = card.getByRole("button", { name: "Create", exact: true });
  const placement = page.getByRole("tablist", { name: "Where the workspace runs", exact: true });
  const mac = placement.getByRole("tab", { name: "This Mac", exact: true });
  const cloudTab = placement.getByRole("tab", { name: "Cloud", exact: true });
  const draft = "Keep my draft when switching organizations";
  await mac.click();
  await expect(mac).toHaveAttribute("aria-selected", "true");
  await editor.fill(draft);
  await page.evaluate(() => window.setCreateOrganization("organization"));
  await expect(mac).toHaveAttribute("aria-selected", "true");
  await expect(mac).toHaveAttribute("data-state", "active");
  await expect(create).toBeEnabled();
  await expect(editor).toHaveText(draft);
  // The tray grows downward only: neither the control nor the card moves.
  const placementBefore = await placement.boundingBox();
  const cardBefore = await card.boundingBox();
  await cloudTab.click();
  await expect(page.locator("[data-composer-tray]")).toBeVisible();
  expect(await placement.boundingBox()).toEqual(placementBefore);
  expect(await card.boundingBox()).toEqual(cardBefore);
  await expect(cloudTab).toHaveAttribute("data-state", "active");
  await expect(cloudTab).toHaveAttribute("aria-selected", "true");
  await expect(create).toBeDisabled();
  const tray = page.locator("[data-composer-tray]");
  await expect(tray.getByRole("status").filter({ hasText: "Build your Cloud Computer first." })).toBeVisible();
  await expect(tray.getByRole("button", { name: "Open Cloud Computer settings", exact: true })).toBeVisible();
  await expect(editor).toHaveText(draft);
  const context = await page.locator("[data-dispatcher-context]").boundingBox();
  const trayBox = await tray.boundingBox();
  expect(context.y + context.height).toBeLessThan(trayBox.y);
  await page.screenshot({ path: ".context/cloud-create-ui.png" });
  await mac.click();
  await expect(create).toBeEnabled();
  await expect(editor).toHaveText(draft);
  await expect(tray).toHaveCount(0);
  // A This Mac draft belongs to the device, so the sidebar's Create shows it under an organization.
  const sidebar = page.locator("[data-app-sidebar]");
  const sidebarCreate = sidebar.getByRole("button", { name: "Create workspace", exact: true });
  await sidebar.getByRole("button", { name: "Home", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(sidebarCreate.locator("[data-composer-draft]")).toBeVisible();
  await sidebarCreate.click();
  // Earlier sections registered more projects; return to the draft's own.
  await page.getByRole("button", { name: "Choose project", exact: true }).click();
  await page.getByRole("menuitem", { name: "To-do app", exact: true }).click();
  await expect(editor).toHaveText(draft);
  for (const owner of ["other", "sign-out", "personal"]) {
    await page.evaluate(next => window.setCreateOrganization(next), owner);
    await expect(mac).toHaveAttribute("aria-selected", "true");
    await expect(create).toBeEnabled();
    await expect(editor).toHaveText(draft);
  }
  await editor.fill("");
  await page.unroute(computer);
  check("Create keeps its This Mac / Cloud choice across owners, explains a blocked cloud side in the tray, and drafts follow the flip", true);
}

/** A delayed real create response must not retarget the newly selected owner. */
export async function runCloudCreateOwnerSmoke({ page, check, harnessBase }) {
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const existing = workspaceFixture();
  const created = workspaceFixture({ id: "44444444-4444-4444-8444-444444444444",
    name: "Created in Organization 1", state: "running" });
  let releaseCreate;
  const createGate = new Promise(resolve => { releaseCreate = resolve; });
  const creates = [];
  await page.route("https://api.example.test/**", async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === `/v1/cloud-v2/organizations/${organizationId}/computer/repositories` && request.method() === "GET") {
      await route.fulfill({ json: { repositories: [{ repository: "example/project", defaultBranch: "master" }] } });
    } else if (pathname === "/v1/cloud-v2/workspaces" && request.method() === "GET") {
      const owner = new URL(request.url()).searchParams.get("organizationId");
      await route.fulfill({ json: { workspaces: owner === organizationId ? [existing] : [] } });
    } else if (pathname === `/v1/cloud-v2/workspaces/${existing.id}` && request.method() === "GET") {
      await route.fulfill({ json: { workspace: existing } });
    } else if (pathname === `/v1/cloud-v2/workspaces/${created.id}` && request.method() === "GET") {
      await route.fulfill({ json: { workspace: created } });
    } else if (pathname === "/v1/cloud-v2/workspaces" && request.method() === "POST") {
      creates.push({ pathname, body: request.postDataJSON(), idempotencyKey: request.headers()["idempotency-key"] });
      await createGate;
      await route.fulfill({ status: 201, json: { workspace: created } });
    } else {
      await route.fulfill({ status: 503, json: { error: { code: "fixture_unavailable", message: "Fixture unavailable" } } });
    }
  });
  try {
    await page.setViewportSize({ width: 1100, height: 780 });
    await page.goto(`${harnessBase}/harness-folder-workspace.html?create&cloud-enabled&feature-off=unified-workspaces`);
    await page.getByRole("button", { name: "Open folder fixture", exact: true }).click();
    await page.getByRole("button", { name: "Initialize git and create", exact: true }).click();
    await page.getByRole("button", { name: "Show Create", exact: true }).click();
    await page.evaluate(async workspace => {
      const { acceptCloudWorkspaceDocument } = await import("/apps/desktop/src/renderer/state/cloud-workspace-catalog.ts");
      const { cloudV2Document } = await import("/apps/desktop/src/renderer/platform/cloud-v2.ts");
      const { notifyProjectsChanged } = await import("/apps/desktop/src/renderer/state/use-projects.ts");
      acceptCloudWorkspaceDocument(cloudV2Document(workspace));
      notifyProjectsChanged();
      window.setFolderGitState(true, "https://github.com/example/project.git");
      window.setCreateOrganization("organization");
    }, existing);
    const card = page.locator("[data-dispatcher-composer]");
    const editor = card.locator(".composer-pm");
    const location = page.getByRole("button", { name: "Workspace location", exact: true });
    await expect(location).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
    await expect(page.locator("[data-create-source-trigger]")).toHaveText("master");
    await editor.fill("Preserve this prompt while creation finishes");
    await card.getByRole("button", { name: "Create", exact: true }).click();
    await expect.poll(() => creates.length).toBe(1);
    expect(creates[0].pathname).toBe("/v1/cloud-v2/workspaces");
    expect(creates[0].body).toMatchObject({ organizationId, repository: "example/project" });
    expect(creates[0].body).not.toHaveProperty("baseBranch");
    expect(creates[0].idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
    await page.evaluate(() => window.setCreateOrganization("personal"));
    releaseCreate();
    await expect(card.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
    await expect(location).toHaveCount(0);
    await expect(editor).toBeEmpty();
    await expect(page.getByText("Cloud workspace created in Organization 1", { exact: true })).toBeVisible();
    await page.evaluate(() => window.setCreateOrganization("organization"));
    await expect(editor).toHaveText("Preserve this prompt while creation finishes");
    check("A late Cloud creation stays in its original organization and preserves that organization's Create draft", true);
  } finally {
    releaseCreate();
    await page.unrouteAll({ behavior: "wait" });
  }
}
