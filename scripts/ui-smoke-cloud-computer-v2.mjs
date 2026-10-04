import { expect } from "@playwright/test";

const orgA = "11111111-1111-4111-8111-111111111111";
const orgB = "33333333-3333-4333-8333-333333333333";
const installation = "22222222-2222-4222-8222-222222222222";
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
    requests.push({ path, method, input, query: url.searchParams });
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
    if (path.endsWith("/create-options"))
      result = {
        configured: true,
        repository: {
          owner: "example",
          name: "project",
          defaultBranch: "main",
        },
        installations: [{ id: installation, accountLogin: "example" }],
      };
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

  await page.goto(`${harnessBase}/harness-cloud-settings.html?computer-v2`);
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
    if (regression === "role-loss") {
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
  await expect(page.getByText("Coming soon", { exact: true })).toBeVisible();

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
  current.state = "active";
  current.revision++;
  current.unbuiltChanges = false;
  activeDrafts.set(orgA, structuredClone(current.draft));
  await page.clock.runFor(3200);
  await expect(
    page.getByRole("button", { name: "Create", exact: true }),
  ).toBeEnabled();
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
  ).toBeEnabled();
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
