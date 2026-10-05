import { expect } from "@playwright/test";

const orgA = "11111111-1111-4111-8111-111111111111";
const orgB = "33333333-3333-4333-8333-333333333333";
const installation = "22222222-2222-4222-8222-222222222222";
const adminUser = "44444444-4444-4444-8444-444444444444";
const now = "2026-10-04T10:00:00.000Z";
const base = () => ({
  state: "not_built",
  revision: 0,
  draft: {
    configId: null,
    repositories: [],
    installScript: "",
    timeoutSeconds: 900,
    environment: [],
  },
  active: null,
  activeRepositories: [],
  previous: null,
  latestBuild: null,
  unbuiltChanges: false,
  history: { builds: [], nextCursor: null },
  canManage: true,
});
const build = (version, overrides = {}) => ({
  id: `77777777-7777-4777-8777-${String(version).padStart(12, "0")}`,
  version,
  configId: `88888888-8888-4888-8888-${String(version).padStart(12, "0")}`,
  acceptedRevision: version,
  state: "succeeded",
  stage: "done",
  errorCode: null,
  rebuiltFromBuildId: null,
  templateState: "ready",
  createdAt: now,
  startedAt: now,
  completedAt: now,
  cancelRequestedAt: null,
  ...overrides,
});
const pending = (row) => row && ["queued", "running"].includes(row.state);
export const cloudComputerV2ReviewRegressions = [
  "role-loss",
  "discard-typing",
  "discard-clean-typing",
  "terminal-log",
  "history-retirement",
  "history-conflict",
  "history-hidden-conflict",
  "external-first-build",
  "admin-flow",
  "create-from-computer-repos",
];

// Real settings, dispatcher and dialog. Only the authenticated API is mocked;
// every state read/mutation passes through the renderer's production schemas.
export async function runCloudComputerV2Smoke({
  page,
  check,
  harnessBase,
  regression = null,
}) {
  page.setDefaultTimeout(15_000);
  await page.clock.install();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const states = new Map([
    [orgA, base()],
    [orgB, base()],
  ]);
  const activeDrafts = new Map();
  const logRows = new Map();
  const olderPages = new Map();
  const incompleteLogs = new Set();
  const requests = [];
  const adminWorkspaces = new Map(), adminReceipts = new Map();
  let heldAdmin = null, holdNextAdmin = false, failNextAdmin = false;
  let createOptionsDrift = false, holdNextCreateConflict = false, heldCreateConflict = null;
  let conflictNextSave = false,
    heldState = null,
    holdNextState = false,
    heldDiscard = null,
    holdNextDiscard = false,
    heldBuild = null,
    holdNextBuild = false,
    heldConflict = null,
    holdNextConflict = false;
  const logCount = () =>
    requests.filter((row) => row.path.endsWith("/log")).length;
  const writes = (path) =>
    requests.filter((row) => row.path.endsWith(path) && row.method === "POST");
  const applyDraft = (computer, input) => {
    if (!input) return;
    const environment = new Map(
      computer.draft.environment.map((row) => [row.name, row]),
    );
    for (const operation of input.environment ?? []) {
      if (operation.op === "remove") environment.delete(operation.name);
      else if (operation.op === "set")
        environment.set(operation.name, { name: operation.name, set: true });
    }
    computer.draft = {
      configId: crypto.randomUUID(),
      repositories: input.repositories,
      installScript: input.installScript,
      timeoutSeconds: input.timeoutSeconds,
      environment: [...environment.values()],
    };
  };
  await page.route("https://api.example.test/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      method = request.method();
    const input = request.postDataJSON();
    requests.push({ path, method, input, query: url.searchParams, idempotencyKey: request.headers()["idempotency-key"] });
    const org = path.match(/\/organizations\/([^/]+)/)?.[1] ?? orgA;
    const computer = states.get(org) ?? base();
    const root = `/v1/organizations/${org}/cloud-computer/v2`;
    let result = { credentials: [], connections: [] };
    const reply = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path.endsWith("/create-options")) {
      if (createOptionsDrift)
        return reply({ error: { code: "cloud_computer_changed", message: "Raw server drift text" } }, 409);
      result = {
        configured: true,
        repository: {
          owner: url.searchParams.get("owner") ?? "example",
          name: url.searchParams.get("repository") ?? "project",
          defaultBranch: "main",
        },
        installations: [{ id: installation, accountLogin: "example" }],
      };
    } else if (path.endsWith("/cloud-workspaces") && method === "POST") {
      if (holdNextCreateConflict) {
        holdNextCreateConflict = false;
        heldCreateConflict = route;
        return;
      }
      if (computer.active && !computer.activeRepositories.some(repo =>
        repo.owner === input.repository.owner && repo.name === input.repository.name && repo.installationId === input.repository.githubInstallationId))
        return reply({ error: { code: "cloud_computer_repository_not_configured", message: "Choose a repository from the active Cloud Computer." } }, 409);
      result = { workspace: {
        id: crypto.randomUUID(), organizationId: org, teamId: org, name: "Repository workspace", createdBy: adminUser,
        placement: "cloud", status: "provisioning", repository: { forge: input.repository.forge, owner: input.repository.owner, name: input.repository.name, revision: input.repository.revision },
        generation: { number: 1, architecture: "x86_64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "provisioning", lastObservedAt: null },
        capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
        version: 1, error: null, createdAt: now, updatedAt: now, deletedAt: null,
      } };
    }
    else if (path.endsWith("/cloud-computer"))
      result = {
        revision: 0,
        draftVersion: 0,
        activeVersion: null,
        document: { repositories: [], installScript: "", timeoutSeconds: 900 },
        canManage: true,
        configured: true,
        imageBuilds: true,
        history: [],
        resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 },
      };
    else if (path === root) {
      if (holdNextState) {
        holdNextState = false;
        heldState = route;
        return;
      }
      const cursor = url.searchParams.get("cursor");
      result = cursor
        ? { ...computer, history: olderPages.get(cursor) }
        : computer;
      if (url.searchParams.get("activeRepositories") !== "true") {
        const { activeRepositories: _activeRepositories, ...legacy } = result;
        result = legacy;
      }
    } else if (path === `${root}/admin-workspaces`) {
      if (input.expectedActiveVersion !== computer.active?.version)
        return reply({ error: { code: "cloud_computer_changed", message: "Review the active version." } }, 409);
      const key = JSON.stringify([org, input.expectedActiveVersion]);
      const existing = adminWorkspaces.get(key);
      const workspace = existing ?? {
        id: `99999999-9999-4999-8999-${String(input.expectedActiveVersion).padStart(12, "0")}`,
        organizationId: org, teamId: org, name: "Private configuration", createdBy: adminUser, ownerUserId: adminUser,
        adminWorkspace: { creatorUserId: adminUser }, placement: "cloud", status: "provisioning",
        capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
        repository: { forge: "github.com", owner: "example", name: "project", revision: "refs/heads/main" },
        generation: { number: 1, architecture: "x86_64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "provisioning", lastObservedAt: null },
        version: 1, error: null, createdAt: now, updatedAt: now, deletedAt: null,
      };
      adminWorkspaces.set(key, workspace);
      result = adminReceipts.get(input.operationId) ?? { workspace, reused: Boolean(existing), replayed: false };
      adminReceipts.set(input.operationId, result);
      if (holdNextAdmin) {
        holdNextAdmin = false;
        heldAdmin = { route, result: structuredClone(result) };
        return;
      }
      if (failNextAdmin) {
        failNextAdmin = false;
        return route.abort("failed");
      }
    } else if (path.startsWith(`${root}/`)) {
      const rowId = path.match(/\/builds\/([^/]+)/)?.[1];
      const history = [
        ...computer.history.builds,
        ...[...olderPages.values()].flatMap((page) => page.builds),
      ];
      const row = history.find((item) => item.id === rowId);
      if (method === "GET" && path.endsWith("/log")) {
        const after = Number(url.searchParams.get("after") ?? 0);
        const rows = logRows.get(rowId) ?? [
          {
            seq: 1,
            text: `Version ${row?.version} output\n`,
            stream: "system",
            stage: row?.stage ?? "done",
            createdAt: now,
          },
        ];
        const entries = rows.filter((entry) => entry.seq > after).slice(0, 100);
        result = {
          entries,
          firstSeq: rows[0]?.seq ?? null,
          lastSeq: rows.at(-1)?.seq ?? null,
          nextAfter: entries.at(-1)?.seq ?? after,
          truncated: rows[0]?.seq > 1,
          complete: !pending(row) && !incompleteLogs.has(rowId),
        };
      } else if (method === "GET" && row) {
        if (holdNextBuild) {
          holdNextBuild = false;
          heldBuild = { route, result: structuredClone(row) };
          return;
        }
        result = row;
      }
      else if (method !== "GET") {
        if (
          input.expectedRevision !== computer.revision ||
          (conflictNextSave && path.endsWith("/draft"))
        ) {
          conflictNextSave = false;
          computer.revision++;
          computer.draft = {
            ...computer.draft,
            configId: crypto.randomUUID(),
            installScript: "echo saved elsewhere",
          };
          return reply(
            {
              error: {
                code: "cloud_computer_revision_changed",
                message: "Review the current draft.",
              },
            },
            409,
          );
        }
        if (path.endsWith("/draft")) {
          applyDraft(computer, input);
          computer.revision++;
          computer.unbuiltChanges = true;
          result = {
            revision: computer.revision,
            configId: computer.draft.configId,
            unbuiltChanges: true,
          };
        } else if (path.endsWith("/discard")) {
          computer.draft = structuredClone(
            activeDrafts.get(org) ?? base().draft,
          );
          computer.draft.configId = crypto.randomUUID();
          computer.revision++;
          computer.unbuiltChanges = false;
          result = {
            revision: computer.revision,
            configId: computer.draft.configId,
            unbuiltChanges: false,
          };
        } else if (path.endsWith("/builds") || path.endsWith("/rebuild")) {
          applyDraft(computer, input.draft);
          const version =
            Math.max(
              0,
              ...computer.history.builds.map((item) => item.version),
            ) + 1;
          const next = build(version, {
            state: "running",
            stage: "install",
            templateState: "pending",
            completedAt: null,
            configId: computer.draft.configId ?? crypto.randomUUID(),
          });
          computer.revision++;
          computer.state = "building";
          computer.latestBuild = next;
          computer.history.builds.unshift(next);
          result = {
            revision: computer.revision,
            build: next,
            replayed: false,
          };
        } else if (path.endsWith("/cancel")) {
          Object.assign(row, {
            state: "cancelled",
            cancelRequestedAt: now,
            completedAt: now,
          });
          computer.revision++;
          computer.state = computer.active ? "active" : "failed";
          result = {
            revision: computer.revision,
            build: row,
            cancelled: true,
            cancelRequested: false,
            alreadyCompleted: false,
          };
        } else if (path.endsWith("/activate")) {
          const version = Number(path.match(/\/versions\/([^/]+)/)[1]);
          const selected = history.find((item) => item.version === version);
          if (selected?.templateState === "retired") {
            const result = {
              error: {
                code: "cloud_computer_template_retired",
                message: "Rebuild this version.",
              },
            };
            if (holdNextConflict) {
              holdNextConflict = false;
              heldConflict = { route, result };
              return;
            }
            return reply(result, 409);
          }
          computer.previous = computer.active;
          computer.active = selected;
          computer.revision++;
          computer.state = "active";
          result = {
            revision: computer.revision,
            activeBuildId: computer.active.id,
            activated: true,
            replayed: false,
          };
        }
      }
    }
    if (holdNextDiscard && path.endsWith("/discard")) {
      holdNextDiscard = false;
      heldDiscard = { route, result };
      return;
    }
    return reply(result);
  });

  if (
    regression === "discard-typing" ||
    regression === "discard-clean-typing"
  ) {
    const first = build(1);
    const computer = states.get(orgA);
    Object.assign(computer, {
      state: "active",
      revision: 1,
      active: first,
      latestBuild: first,
      unbuiltChanges: true,
      history: { builds: [first], nextCursor: null },
      draft: {
        ...base().draft,
        configId: first.configId,
        installScript: "echo saved draft",
        timeoutSeconds: 600,
      },
    });
    activeDrafts.set(orgA, base().draft);
  }
  if (regression === "terminal-log") {
    const first = build(1, {
      state: "running",
      stage: "install",
      templateState: "pending",
      completedAt: null,
    });
    Object.assign(states.get(orgA), {
      state: "building",
      revision: 1,
      latestBuild: first,
      history: { builds: [first], nextCursor: null },
    });
    incompleteLogs.add(first.id);
  }
  if (
    regression === "history-retirement" ||
    regression === "history-conflict" ||
    regression === "history-hidden-conflict"
  ) {
    const latest = build(31);
    Object.assign(states.get(orgA), {
      state: "active",
      revision: 31,
      active: latest,
      latestBuild: latest,
      history: { builds: [latest], nextCursor: "older-v1" },
    });
    olderPages.set("older-v1", { builds: [build(1)], nextCursor: null });
  }
  if (regression === "admin-flow") {
    const first = build(1);
    Object.assign(states.get(orgA), { state: "active", revision: 1, active: first, latestBuild: first, history: { builds: [first], nextCursor: null } });
  }

  const activeRepositories = [
    { id: "123", owner: "example", name: "project", installationId: installation },
    { id: "456", owner: "example", name: "another", installationId: orgB },
  ];
  if (regression === "create-from-computer-repos") {
    const first = build(1);
    Object.assign(states.get(orgA), { state: "active", revision: 1, active: first, activeRepositories, latestBuild: first,
      draft: { ...base().draft, repositories: [...activeRepositories.map(row => ({ ...row, requestedRef: null })), { ...activeRepositories[0], id: "789", name: "unbuilt" }] },
      unbuiltChanges: true, history: { builds: [first], nextCursor: null } });
    Object.assign(states.get(orgB), { state: "active", revision: 1, active: first, activeRepositories: [activeRepositories[0]], latestBuild: first, history: { builds: [first], nextCursor: null } });
  }
  await page.goto(`${harnessBase}/harness-cloud-settings.html?computer-v2${regression === "create-from-computer-repos" ? "&empty-projects" : ""}`);
  if (regression) {
    const button = (name) => page.getByRole("button", { name, exact: true });
    const editor = page.getByRole("textbox", {
      name: "Cloud Computer install script",
      exact: true,
    });
    const stateReads = () =>
      requests.filter(
        (row) =>
          row.method === "GET" &&
          row.path.endsWith("/v2") &&
          !row.query.has("cursor"),
      ).length;
    const current = states.get(orgA);
    if (regression === "create-from-computer-repos") {
      const choose = () => button("Choose project");
      const create = () => button("Create");
      const source = () => page.locator("[data-create-source-trigger]");
      const message = page.locator('[contenteditable="true"][aria-label="Message"]');
      const optionsReads = () => requests.filter(row => row.path.endsWith("/create-options")).length;
      await button("Create section").click();
      await expect(choose()).toContainText("example/project");
      await expect(source()).toContainText("main");
      await expect(source()).toHaveAccessibleName("Create from GitHub branch: main");
      expect(requests.filter(row => row.path.endsWith("/v2")).every(row => row.query.get("activeRepositories") === "true")).toBe(true);
      await message.fill("Keep this prompt through metadata refresh");
      createOptionsDrift = true;
      const metadataStateReads = stateReads();
      await choose().click();
      const menu = page.getByRole("menu");
      await expect(menu.getByRole("menuitem")).toHaveCount(3);
      await expect(menu).toContainText("example/project");
      await expect(menu).toContainText("example/another");
      await expect(menu).not.toContainText(/unbuilt|Open project|Open GitHub project|Start from scratch|No projects yet/);
      await menu.getByRole("menuitem", { name: "example/another", exact: true }).hover();
      await menu.getByRole("menuitem", { name: "example/another", exact: true }).click();
      await expect(choose()).toContainText("example/another");
      await expect(page.getByText("Cloud Computer changed — refresh", { exact: true })).toBeVisible();
      await expect(page.getByText("Raw server drift text", { exact: true })).toHaveCount(0);
      await expect.poll(stateReads).toBeGreaterThan(metadataStateReads);
      await expect(message).toHaveText("Keep this prompt through metadata refresh");
      const settledMetadataReads = { state: stateReads(), options: optionsReads() };
      await page.clock.runFor(30_001);
      expect({ state: stateReads(), options: optionsReads() }).toEqual(settledMetadataReads);
      createOptionsDrift = false;
      await choose().hover();
      await expect(create()).toBeEnabled();
      await message.fill("");
      await source().hover();
      await expect.poll(() => page.evaluate(() => window.cloudComputerSourceFixture.reads.filter(row => row.op === "gh.prList").length)).toBeGreaterThan(0);
      await source().click();
      await expect(page.getByRole("tab", { name: "Local branches", exact: true })).toHaveCount(0);
      await expect(page.getByRole("tab", { name: "Branches", exact: true })).toBeVisible();
      await page.getByLabel("Search sources", { exact: true }).fill("feature");
      await page.getByRole("button", { name: "feature/topic", exact: true }).click();
      await expect(source()).toContainText("feature/topic");
      await source().click();
      await page.getByRole("tab", { name: "Pull requests", exact: true }).click();
      await page.getByLabel("Search sources", { exact: true }).fill("Remote change");
      await page.getByRole("button", { name: /#7 · Remote change/ }).click();
      await create().click();
      await expect.poll(() => writes("/cloud-workspaces").length).toBe(1);
      expect(writes("/cloud-workspaces")[0].input).toMatchObject({
        repository: { forge: "github.com", owner: "example", name: "another", revision: "refs/pull/7/head", githubInstallationId: orgB },
      });
      expect(writes("/cloud-workspaces")[0].input).not.toHaveProperty("cloudComputerBuild");
      await choose().click();
      await menu.getByRole("menuitem", { name: "Add repository", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Cloud Computer install script", exact: true })).toBeVisible();
      await button("Create section").click();
      await expect(choose()).toContainText("example/another");
      await expect(source()).toContainText("main");
      await button("Organization B").click();
      await expect(choose()).toContainText("example/project");
      await button("Organization A").click();
      await expect(choose()).toContainText("example/another");
      const before = stateReads();
      current.active = build(2);
      current.latestBuild = current.active;
      current.revision++;
      current.history.builds.unshift(current.active);
      current.activeRepositories = [activeRepositories[0]];
      await message.fill("Keep this prompt through repository refresh");
      await create().click();
      await expect.poll(() => writes("/cloud-workspaces").length).toBe(2);
      await expect.poll(stateReads).toBeGreaterThan(before);
      await expect(page.getByText("Cloud Computer changed — refresh", { exact: true })).toBeVisible();
      await expect(message).toHaveText("Keep this prompt through repository refresh");
      await expect(choose()).toContainText("example/project");
      await expect(create()).toBeEnabled();
      await create().click();
      await expect.poll(() => writes("/cloud-workspaces").length).toBe(3);
      expect(writes("/cloud-workspaces")[2].input).toMatchObject({ repository: { revision: "refs/heads/main", name: "project", githubInstallationId: installation } });
      expect(writes("/cloud-workspaces")[2].input).not.toHaveProperty("cloudComputerBuild");
      expect(writes("/cloud-workspaces")[2].idempotencyKey).not.toBe(writes("/cloud-workspaces")[1].idempotencyKey);
      await button("Design mode").click();
      await create().click();
      await expect.poll(() => writes("/cloud-workspaces").length).toBe(4);
      expect(writes("/cloud-workspaces")[3].input).not.toHaveProperty("cloudComputerBuild");
      // The Design intent is registered after the create response is accepted.
      await expect.poll(() => page.evaluate(() => window.cloudComputerSourceFixture.pendingDesign().length)).toBe(1);
      await button("Code mode").click();
      holdNextCreateConflict = true;
      await message.fill("Keep this prompt through hidden recovery");
      await create().click();
      await expect.poll(() => writes("/cloud-workspaces").length).toBe(5);
      await button("Toggle settings activity").click();
      const hiddenReads = { state: stateReads(), options: optionsReads() };
      await heldCreateConflict.fulfill({ status: 409, contentType: "application/json",
        body: JSON.stringify({ error: { code: "cloud_computer_template_unavailable", message: "Template changed" } }) });
      await expect(source()).toBeEnabled();
      await page.clock.runFor(5_000);
      expect({ state: stateReads(), options: optionsReads() }).toEqual(hiddenReads);
      await button("Toggle settings activity").click();
      await expect.poll(stateReads).toBeGreaterThan(hiddenReads.state);
      await expect.poll(optionsReads).toBeGreaterThan(hiddenReads.options);
      await expect(message).toHaveText("Keep this prompt through hidden recovery");
      await expect(create()).toBeEnabled();
      await button("Computer section").click();
      current.activeRepositories = [activeRepositories[0]];
      current.revision++;
      await page.clock.runFor(30_001);
      await button("Create section").click();
      await expect(choose()).toContainText("example/project");
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("zeros:cloud-computer-repository:v1"))
        .find(([owner]) => owner === JSON.stringify(["44444444-4444-4444-8444-444444444444", "11111111-1111-4111-8111-111111111111"]))[1])).toBe("123");
      await page.evaluate(() => { window.cloudComputerSourceFixture.unavailable = true; });
      await source().click();
      await page.getByRole("button", { name: "Refresh sources", exact: true }).click();
      await expect(page.getByText("Desktop GitHub access is unavailable", { exact: true })).toBeVisible();
      await expect(create()).toBeEnabled();
      await page.getByRole("tab", { name: "Pull requests", exact: true }).click();
      await page.getByRole("button", { name: "Refresh sources", exact: true }).click();
      await expect(page.getByText("Desktop GitHub access is unavailable", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await button("Disable computer v2").click();
      await choose().click();
      await expect(menu).toContainText("Open project");
      await expect(menu).toContainText("Open GitHub project");
      await expect(menu).toContainText("Start from scratch");
      await page.keyboard.press("Escape");
      check("Cloud Create uses built repositories without a project, restores/prunes per-org choices, creates Code/Design, bounds metadata recovery, and defers hidden conflicts without losing the prompt", true);
    } else if (regression === "role-loss") {

      await expect(
        page.getByText("Not built yet", { exact: true }),
      ).toBeVisible();
      await button("Organization admin").click();
      for (const hidden of [false, true]) {
        await page
          .getByLabel("Environment variable name", { exact: true })
          .fill("PENDING_NAME");
        await page
          .getByLabel("New environment value", { exact: true })
          .fill("synthetic pending operation");
        await button("Use value").click();
        await page
          .getByLabel("New environment value", { exact: true })
          .fill("synthetic password input");
        if (hidden) await button("Toggle settings activity").click();
        const reads = stateReads();
        await button("Organization member").click();
        await expect(
          page.getByLabel("New environment value", { exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("button", {
            name: "Build computer",
            exact: true,
            includeHidden: hidden,
          }),
        ).toBeDisabled();
        if (!hidden)
          await expect(editor).toHaveAttribute("contenteditable", "false");
        await expect(button("Save draft")).toHaveCount(0);
        await button("Organization admin").click();
        if (hidden) await button("Toggle settings activity").click();
        await expect(
          page.getByLabel("New environment value", { exact: true }),
        ).toHaveValue("");
        await expect(
          page.getByText("PENDING_NAME", { exact: true }),
        ).toHaveCount(0);
        expect(stateReads()).toBe(reads);
      }
      check(
        "Known organization demotion clears pending secrets and management, including while hidden with staff access and warm canManage",
        true,
      );
    } else if (
      regression === "discard-typing" ||
      regression === "discard-clean-typing"
    ) {
      await expect(editor).toHaveText("echo saved draft");
      await editor.fill("echo before discard");
      holdNextDiscard = true;
      await button("Discard").click();
      await expect.poll(() => Boolean(heldDiscard)).toBe(true);
      await editor.fill("echo typed during discard mutation");
      await page
        .getByLabel("Cloud Computer build timeout", { exact: true })
        .fill("111");
      holdNextState = true;
      await heldDiscard.route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(heldDiscard.result),
      });
      heldDiscard = null;
      await expect.poll(() => Boolean(heldState)).toBe(true);
      await expect(editor).toHaveText("echo typed during discard mutation");
      await editor.fill("echo typed during discard refresh");
      await page
        .getByLabel("Cloud Computer build timeout", { exact: true })
        .fill("222");
      const clean = regression === "discard-clean-typing";
      if (clean) {
        await editor.fill("echo saved draft");
        await page
          .getByLabel("Cloud Computer build timeout", { exact: true })
          .fill("600");
      }
      await heldState.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(current),
      });
      heldState = null;
      await expect(editor).toHaveText(
        clean ? "echo saved draft" : "echo typed during discard refresh",
      );
      await expect(
        page.getByLabel("Cloud Computer build timeout", { exact: true }),
      ).toHaveValue(clean ? "600" : "222");
      await expect(button("Save draft")).toBeEnabled();
      await expect(
        page.getByText("Unbuilt changes", { exact: true }),
      ).toHaveCount(0);
      check(
        clean
          ? "Discard preserves later typing that restores the old saved baseline during its replacement read"
          : "Discard preserves script and timeout typing across a held mutation and replacement read",
        true,
      );
    } else if (regression === "terminal-log") {
      const first = current.latestBuild;
      await expect(page.getByRole("log")).toContainText("Version 1 output");
      Object.assign(first, {
        state: "failed",
        errorCode: "install_failed",
        templateState: null,
        completedAt: now,
      });
      current.state = "failed";
      current.revision++;
      holdNextState = true;
      await page.clock.runFor(3200);
      await expect.poll(() => Boolean(heldState)).toBe(true);
      await heldState.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(current),
      });
      heldState = null;
      await expect(page.getByText(/Version 1 · failed/).first()).toBeVisible();
      await expect(page.getByRole("log")).toContainText("Version 1 output");
      logRows.set(
        first.id,
        Array.from({ length: 104 }, (_, i) => ({
          seq: i + 1,
          text: i === 0 ? "Version 1 output\n" : `Final line ${i}\n`,
          stream: "stdout",
          stage: "install",
          createdAt: now,
        })),
      );
      incompleteLogs.delete(first.id);
      await page.clock.runFor(15_000);
      await expect(page.getByRole("log")).toContainText("Final line 103");
      const drained = logCount();
      await page.clock.runFor(30_000);
      expect(logCount()).toBe(drained);
      await button("Close log").click();
      await expect(page.getByRole("log")).toHaveCount(0);
      check(
        "Automatically observed build logs survive terminal state, drain late cursor pages, stop, and close",
        true,
      );
    } else if (
      regression === "history-retirement" ||
      regression === "history-conflict" ||
      regression === "history-hidden-conflict"
    ) {
      await expect(page.getByText("Active v31", { exact: true })).toBeVisible();
      await button("Older versions").click();
      await expect(button("Activate")).toHaveCount(1);
      const old = olderPages.get("older-v1").builds[0];
      if (regression === "history-retirement") {
        old.templateState = "retired";
        await button("Refresh Cloud Computer").click();
        await expect(button("Rebuild")).toHaveCount(1);
        await expect(button("Activate")).toHaveCount(0);
        expect(
          requests.filter((row) => row.query.get("cursor") === "older-v1"),
        ).toHaveLength(2);
        old.templateState = "ready";
        await button("Refresh Cloud Computer").click();
        await expect(button("Activate")).toHaveCount(1);
      }
      if (regression === "history-conflict") {
        holdNextBuild = true;
        await button("View log for version 1").hover();
        await expect.poll(() => Boolean(heldBuild)).toBe(true);
      }
      old.templateState = "retired";
      const hiddenConflict = regression === "history-hidden-conflict";
      if (hiddenConflict) holdNextConflict = true;
      await button("Activate").click();
      if (hiddenConflict) {
        await expect.poll(() => Boolean(heldConflict)).toBe(true);
        await button("Toggle settings activity").click();
        const reads = requests.filter((row) => row.method === "GET").length;
        await heldConflict.route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify(heldConflict.result),
        });
        heldConflict = null;
        await page.clock.runFor(10_000);
        expect(requests.filter((row) => row.method === "GET")).toHaveLength(
          reads,
        );
        await button("Toggle settings activity").click();
      }
      await expect(
        page.getByText("Changed by someone else — Review", { exact: true }),
      ).toBeVisible();
      if (heldBuild) {
        await heldBuild.route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(heldBuild.result),
        });
        heldBuild = null;
      }
      await expect(button("Rebuild")).toHaveCount(1);
      if (hiddenConflict)
        expect(
          requests.filter((row) => row.query.get("cursor") === "older-v1"),
        ).toHaveLength(2);
      else
        expect(
          requests.some(
            (row) =>
              row.method === "GET" && row.path.endsWith(`/builds/${old.id}`),
          ),
        ).toBe(true);
      if (regression === "history-conflict")
        expect(
          requests.filter(
            (row) =>
              row.method === "GET" && row.path.endsWith(`/builds/${old.id}`),
          ),
        ).toHaveLength(2);
      await button("Review").click();
      await button("Keep my edits").click();
      await expect(button("Rebuild")).toBeEnabled();
      await expect(button("Activate")).toHaveCount(0);
      expect(current.revision).toBe(31);
      check(
        hiddenConflict
          ? "A retirement conflict received while hidden defers history recovery until return without hidden reads"
          : "Older same-revision history revalidates on Refresh and confirms the affected build after an action conflict",
        true,
      );
    } else if (regression === "admin-flow") {
      const configure = () => button("Configure with an agent");
      const destination = page.getByLabel("Opened admin workspace", { exact: true });
      await expect(configure()).toBeEnabled();
      await configure().hover();
      await configure().focus();
      expect(writes("/admin-workspaces")).toHaveLength(0);
      await configure().click();
      await expect(destination).toBeVisible();
      await expect(destination.getByText("Admin", { exact: true })).toBeVisible();
      const firstFolder = await destination.getAttribute("data-folder");
      const firstChat = await destination.getAttribute("data-chat-id");
      const published = await page.evaluate(() => window.cloudComputerDestinations.filter(row => row.page === "workspace"));
      expect(published).toEqual([{ page: "workspace", folder: firstFolder, chatId: firstChat }]);
      expect(writes("/admin-workspaces")[0].input).toMatchObject({ expectedActiveVersion: 1 });
      await button("Computer section").click();
      await configure().click();
      await expect(destination).toBeVisible();
      await expect(destination).toHaveAttribute("data-folder", firstFolder);
      expect(await destination.getAttribute("data-chat-id")).not.toBe(firstChat);
      expect(adminWorkspaces.size).toBe(1);
      const second = build(2);
      Object.assign(current, { revision: 2, active: second, latestBuild: second, history: { builds: [second, current.active], nextCursor: null } });
      await button("Computer section").click();
      await button("Refresh Cloud Computer").click();
      await expect(page.getByText("Active v2", { exact: true })).toBeVisible();
      await configure().click();
      await expect(destination).toBeVisible();
      expect(await destination.getAttribute("data-folder")).not.toBe(firstFolder);
      expect(writes("/admin-workspaces").at(-1).input.expectedActiveVersion).toBe(2);
      expect(adminWorkspaces.size).toBe(2);
      await expect(button("New admin workspace")).toHaveCount(0);

      await button("Computer section").click();
      holdNextAdmin = true;
      await configure().click();
      await expect.poll(() => Boolean(heldAdmin)).toBe(true);
      await button("Toggle settings activity").click();
      await button("Toggle settings activity").click();
      await heldAdmin.route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(heldAdmin.result) });
      heldAdmin = null;
      await expect(configure()).toBeEnabled();
      await expect(destination).toHaveCount(0);

      await button("Computer section").click();
      holdNextAdmin = true;
      await configure().click();
      await expect.poll(() => Boolean(heldAdmin)).toBe(true);
      await button("Toggle settings activity").click();
      await button("Organization member").click();
      const hiddenReads = requests.filter(row => row.method === "GET").length;
      await heldAdmin.route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(heldAdmin.result) });
      heldAdmin = null;
      await page.clock.runFor(5000);
      await expect(destination).toHaveCount(0);
      expect(requests.filter(row => row.method === "GET")).toHaveLength(hiddenReads);
      await button("Toggle settings activity").click();
      await expect(configure()).toBeDisabled();
      await button("Organization admin").click();
      await expect(configure()).toBeEnabled();

      holdNextAdmin = true;
      await configure().click();
      await expect.poll(() => Boolean(heldAdmin)).toBe(true);
      await button("Organization B").click();
      await expect(page.getByText("Not built yet", { exact: true })).toBeVisible();
      await heldAdmin.route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(heldAdmin.result) });
      heldAdmin = null;
      await page.clock.runFor(1000);
      await expect(destination).toHaveCount(0);
      await expect(configure()).toBeDisabled();
      await button("Organization A").click();
      await expect(configure()).toBeEnabled();
      failNextAdmin = true;
      await configure().click();
      await expect(page.getByRole("alert")).toContainText("Could not open the admin workspace");
      const lostOperation = writes("/admin-workspaces").at(-1).input.operationId;
      await configure().click();
      await expect(destination).toBeVisible();
      expect(writes("/admin-workspaces").at(-1).input.operationId).toBe(lostOperation);
      expect(adminWorkspaces.size).toBe(2);
      check("Configure shares creator reuse, follows a newly active version, publishes a fresh conversation atomically, and fences hidden/role/org races and lost replies", true);
    } else if (regression === "external-first-build") {
      await expect(
        page.getByText("Not built yet", { exact: true }),
      ).toBeVisible();
      await button("Create section").click();
      await expect(button("Create")).toBeDisabled();
      await expect(
        page.getByText("Build your Cloud Computer first.", { exact: true }),
      ).toBeVisible();
      const before = stateReads();
      const first = build(1, {
        state: "running",
        stage: "install",
        templateState: "pending",
      });
      Object.assign(current, {
        state: "building",
        revision: 1,
        latestBuild: first,
        history: { builds: [first], nextCursor: null },
      });
      await page.clock.runFor(31_000);
      await expect.poll(stateReads).toBeGreaterThan(before);
      Object.assign(first, {
        state: "succeeded",
        stage: "done",
        templateState: "ready",
      });
      current.state = "active";
      current.active = first;
      current.activeRepositories = [activeRepositories[0]];
      current.revision++;
      await page.clock.runFor(4000);
      await expect(button("Create")).toBeEnabled();
      const available = stateReads();
      await page.clock.runFor(120_000);
      expect(stateReads()).toBe(available);
      const failed = build(1, { state: "failed", templateState: null });
      const second = states.get(orgB);
      Object.assign(second, {
        state: "failed",
        revision: 1,
        latestBuild: failed,
        history: { builds: [failed], nextCursor: null },
      });
      await button("Organization B").click();
      await expect(button("Create")).toBeDisabled();
      await expect(
        page.getByText("Build your Cloud Computer first.", { exact: true }),
      ).toBeVisible();
      await button("Toggle settings activity").click();
      const hidden = stateReads();
      await page.clock.runFor(120_000);
      expect(stateReads()).toBe(hidden);
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await button("Toggle settings activity").click();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.clock.runFor(120_000);
      expect(stateReads()).toBe(hidden);
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expect(button("Create")).toBeDisabled();
      await button("Open GitHub create").click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("Repository URL")
        .fill("https://github.com/example/project");
      await expect(
        dialog.getByRole("button", { name: /^Create workspace/ }),
      ).toBeDisabled();
      const retry = build(2);
      Object.assign(second, {
        state: "active",
        revision: 2,
        active: retry,
        latestBuild: retry,
        history: { builds: [retry, failed], nextCursor: null },
      });
      await page.clock.runFor(121_000);
      await expect(
        dialog.getByRole("button", { name: /^Create workspace/ }),
      ).toBeEnabled();
      expect(logCount()).toBe(0);
      check(
        "Visible Create discovers external first builds and failed-build retries without pointer intent; hidden gates stay inert",
        true,
      );
    } else throw new Error(`Unknown computer review regression: ${regression}`);
    expect(errors).toEqual([]);
    return;
  }
  await expect(page.getByText("Not built yet", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Configure with an agent", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("Build computer before configuring it with an agent.", { exact: true })).toBeVisible();

  await page
    .getByRole("button", { name: "Open GitHub create", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Repository URL")
    .fill("https://github.com/example/project");
  await expect(
    dialog.getByText("Build your Cloud Computer first.", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /^Create workspace/ }),
  ).toBeDisabled();
  await dialog.getByLabel("Repository URL").press("Control+Enter");
  expect(writes("/cloud-workspaces")).toHaveLength(0);
  await dialog
    .getByRole("button", { name: "Open Cloud Computer settings", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);

  await page
    .getByRole("button", { name: "Create section", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Create", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Build your Cloud Computer first.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Design mode", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create", exact: true }),
  ).toBeDisabled();
  expect(writes("/cloud-workspaces")).toHaveLength(0);
  check(
    "Cloud Computer v2 blocks Code, Design and Open GitHub create before the first build, including the dialog shortcut",
    true,
  );

  await page
    .getByRole("button", { name: "Computer section", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Build computer", exact: true })
    .click();
  await expect(
    page.getByText(/Building v1 · Installing software/),
  ).toBeVisible();
  expect(writes("/builds")).toHaveLength(1);
  expect(writes("/builds")[0].input.draft).toEqual({
    repositories: [],
    installScript: "",
    timeoutSeconds: 900,
  });
  await expect(page.getByRole("log")).toContainText("Version 1 output");
  await page.clock.runFor(1100);
  await page
    .getByRole("button", { name: "Toggle settings activity", exact: true })
    .click();
  const hiddenReads = logCount();
  await page.clock.runFor(20_000);
  expect(logCount()).toBe(hiddenReads);
  await expect(
    page.getByRole("button", {
      name: "Cancel build",
      exact: true,
      includeHidden: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Toggle settings activity", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create section", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Create", exact: true }),
  ).toBeDisabled();
  const createLogReads = logCount();
  const current = states.get(orgA),
    first = current.latestBuild;
  Object.assign(first, {
    state: "succeeded",
    stage: "done",
    templateState: "ready",
    completedAt: now,
  });
  current.active = first;
  current.activeRepositories = [];
  current.state = "active";
  current.revision++;
  current.unbuiltChanges = false;
  activeDrafts.set(orgA, structuredClone(current.draft));
  await page.clock.runFor(3200);
  await expect(
    page.getByRole("button", { name: "Create", exact: true }),
  ).toBeDisabled();
  expect(logCount()).toBe(createLogReads);
  await page
    .getByRole("button", { name: "Computer section", exact: true })
    .click();
  await expect(page.getByText("Active v1", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Build computer", exact: true }),
  ).toBeEnabled();
  expect(writes("/activate")).toHaveLength(0);
  check(
    "First Build is atomic, live progress/logs stop while hidden, and success activates without an extra action",
    true,
  );

  await page
    .getByRole("button", { name: "Create section", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Create", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Computer section", exact: true })
    .click();
  const editor = page.getByRole("textbox", {
    name: "Cloud Computer install script",
    exact: true,
  });
  await editor.fill("echo local draft");
  await page
    .getByLabel("Environment variable name", { exact: true })
    .fill("EXAMPLE");
  await page
    .getByLabel("New environment value", { exact: true })
    .fill("synthetic replacement");
  await page.getByRole("button", { name: "Use value", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByText("Unbuilt changes", { exact: true }),
  ).toBeVisible();
  await expect(editor).toHaveText("echo local draft");
  await expect(
    page.getByLabel("New environment value", { exact: true }),
  ).toHaveValue("");
  expect(JSON.stringify(current)).not.toContain("synthetic replacement");
  await editor.fill("echo unsaved typing");
  holdNextState = true;
  await page
    .getByRole("button", { name: "Refresh Cloud Computer", exact: true })
    .click();
  await expect.poll(() => Boolean(heldState)).toBe(true);
  await expect(editor).toHaveText("echo unsaved typing");
  await heldState.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(current),
  });
  heldState = null;
  await expect(editor).toHaveText("echo unsaved typing");
  conflictNextSave = true;
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByText("Changed by someone else — Review", { exact: true }),
  ).toBeVisible();
  await expect(editor).toHaveText("echo unsaved typing");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(
    page.getByText("echo saved elsewhere", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Keep my edits", exact: true })
    .click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save draft", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByText("Unbuilt changes", { exact: true })).toHaveCount(
    0,
  );
  await expect(editor).toHaveText("");
  check(
    "Unbuilt drafts, secret replacement, slow refresh, 409 review and discard preserve the intended editor state",
    true,
  );

  const retained = build(2),
    retired = build(3, { templateState: "retired" });
  const failed = build(4, {
    state: "failed",
    stage: "install",
    errorCode: "install_failed",
    templateState: null,
  });
  current.history.builds = [
    build(6, { state: "superseded" }),
    build(5, { state: "cancelled" }),
    failed,
    retired,
    retained,
    first,
  ];
  current.latestBuild = failed;
  current.revision++;
  await page
    .getByRole("button", { name: "Refresh Cloud Computer", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Activate", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Rebuild", exact: true }),
  ).toHaveCount(1);
  await editor.fill("echo typing before activate");
  await page.getByRole("button", { name: "Activate", exact: true }).click();
  await expect(page.getByText("Active v2", { exact: true })).toBeVisible();
  expect(writes("/activate")[0].path).toContain("/versions/2/activate");
  await expect(editor).toHaveText("echo typing before activate");
  await expect(
    page.getByRole("button", { name: "Save draft", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText("Changed by someone else — Review", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Discard local edits", exact: true })
    .click();
  logRows.set(
    failed.id,
    Array.from({ length: 103 }, (_, i) => ({
      seq: i + 7,
      stream: "stdout",
      stage: "install",
      text: `Captured line ${i + 1}\n`,
      createdAt: now,
    })),
  );
  await page
    .getByRole("button", { name: "View log for version 4", exact: true })
    .click();
  await page.clock.runFor(1100);
  await expect(page.getByRole("log")).toContainText("Captured line 103");
  await expect(
    page.getByText("Earlier output was truncated.", { exact: true }),
  ).toBeVisible();
  const terminalReads = logCount();
  await page.clock.runFor(20_000);
  expect(logCount()).toBe(terminalReads);
  await page.getByRole("button", { name: "Rebuild", exact: true }).click();
  await expect(page.getByText(/Building v7/)).toBeVisible();
  await expect(
    page.getByRole("log", { name: "Build log for version 4", exact: true }),
  ).toContainText("Captured line 103");
  expect(writes("/rebuild")[0].path).toContain("/versions/3/rebuild");
  await editor.fill("echo typing before cancel");
  await page.getByRole("button", { name: "Cancel build", exact: true }).click();
  await expect(
    page.getByText("Version 7 · cancelled", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Active v2", { exact: true })).toBeVisible();
  await expect(editor).toHaveText("echo typing before cancel");
  await expect(
    page.getByRole("button", { name: "Save draft", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText("Changed by someone else — Review", { exact: true }),
  ).toHaveCount(0);
  check(
    "History offers only ready-success Activate and retired-success Rebuild; terminal logs drain cursors, mark truncation and stop polling",
    true,
  );

  await page
    .getByRole("button", { name: "Open GitHub create", exact: true })
    .click();
  await dialog
    .getByLabel("Repository URL")
    .fill("https://github.com/example/project");
  await expect(
    dialog.getByRole("button", { name: /^Create workspace/ }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Organization B", exact: true })
    .click();
  await expect(page.getByText("Not built yet", { exact: true })).toBeVisible();
  await expect(editor).toHaveText("");
  await page
    .getByRole("button", { name: "Organization A", exact: true })
    .click();
  await expect(page.getByText("Active v2", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Disable computer v2", exact: true })
    .click();
  await expect(
    page.getByText(/Each member must have their own GitHub access/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Configure with an agent", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Enable computer v2", exact: true })
    .click();
  await expect(page.getByText("Active v2", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Ordinary member", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Configure with an agent", exact: true }),
  ).toHaveCount(0);
  const revokedReads = requests.filter((row) =>
    row.path.includes("/cloud-computer/v2"),
  ).length;
  await page.clock.runFor(30_000);
  expect(
    requests.filter((row) => row.path.includes("/cloud-computer/v2")).length,
  ).toBe(revokedReads);
  await page
    .getByRole("button", { name: "Disable computer v2", exact: true })
    .click();
  expect(errors).toEqual([]);
  check(
    "Org switching restores exact-key state, successful builds release both Create paths, and flag/staff loss retires all v2 surfaces and polling",
    true,
  );
}
