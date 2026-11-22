// The native check's named checks, in order. Each may prepare fixtures before the app starts (prepare) and then
// runs against the real window (run), returning { result, fact }: what it measured, never only "ok".
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { FIXTURE, WORKSPACES } from "./control-plane.mjs";
import { descendants, processTable, processVariable } from "./processes.mjs";

const exec = promisify(execFile);
const fail = (fact) => ({ result: "fail", fact });
const na = (fact) => ({ result: "n/a", fact });
const under = (child, parent) => { const relative = path.relative(parent, child); return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative); };
const PERSONAL = "local-personal";
const cloudKey = (organizationId, workspaceId) => `cloud://${organizationId}/${workspaceId}`;

/** Git as the engine runs it: the run's own global config, no system config. */
async function git(context, cwd, ...args) {
  return (await exec("git", args, { cwd, env: { PATH: context.env.PATH, HOME: context.env.HOME, GIT_CONFIG_GLOBAL: context.gitconfig,
    GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Native Check", GIT_AUTHOR_EMAIL: FIXTURE.email, GIT_COMMITTER_NAME: "Native Check",
    GIT_COMMITTER_EMAIL: FIXTURE.email } })).stdout.trim();
}
const renderer = (page, fn, arg) => page.evaluate(fn, arg);
/** The owner as a person picks it: the sidebar's "Switch organization" menu. Throws when it did not become active. */
async function selectOwner(page, id) {
  const personal = id === PERSONAL;
  const trigger = page.getByRole("button", { name: "Switch organization", exact: true }).first();
  const label = async () => (await trigger.innerText().catch(() => "")).trim();
  const wanted = personal ? /^(Fixture|Personal)$/ : /^Native Org$/;
  if (wanted.test(await label())) return;
  await trigger.click();
  await page.getByRole("menuitem", { name: wanted }).first().click();
  await page.waitForFunction(([pattern]) => new RegExp(pattern).test(document.querySelector("[aria-label='Switch organization']")?.textContent?.trim() ?? ""),
    [wanted.source], { timeout: 10_000 });
  await page.waitForTimeout(600);
}
/** A fresh renderer, as after quitting and opening the app: its HTTP cache cleared first, because a reload that
 * revalidates every Vite dev module at once runs Chromium out of request slots (ERR_INSUFFICIENT_RESOURCES). */
async function reload(context) {
  const { app, page } = context;
  await app.evaluate(({ session }) => session.defaultSession.clearCache());
  await page.reload();
  await page.getByRole("button", { name: "Switch organization", exact: true }).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1000);
}
async function openSettings(page) {
  if (await page.locator("[aria-label=\"Settings sections\"]").first().isVisible().catch(() => false)) return;
  await page.getByRole("button", { name: /settings/i }).last().click();
  await page.locator("[aria-label=\"Settings sections\"]").first().waitFor();
}
async function closeSettings(page) {
  const back = page.getByRole("button", { name: "Back", exact: true });
  if (await back.isVisible().catch(() => false)) await back.click();
  await page.waitForTimeout(300);
}
/** The rail as the person sees it: each group's heading and its entries. */
async function settingsRail(page) {
  return page.locator("[aria-label=\"Settings sections\"]").first().evaluate(nav => {
    const groups = [];
    for (const node of nav.querySelectorAll("*")) {
      if (node.children.length) continue;
      const text = node.textContent?.trim();
      if (!text) continue;
      const button = node.closest("button, a, [role=tab], [role=link]");
      if (!button) groups.push({ heading: text, items: [] });
      else if (groups.length && !groups.at(-1).items.includes(text)) groups.at(-1).items.push(text);
    }
    return groups;
  });
}
const shot = (context, name) => context.page.screenshot({ path: path.join(context.dirs.shots, `${name}.png`) }).catch(() => undefined);
const retentionInSource = (context) => existsSync(path.join(context.repo, "apps/desktop/src/renderer/state/cloud-retention.ts"));

// ── N1 ─────────────────────────────────────────────────────────────────────────
const settingsRailCheck = {
  id: "N1 settings rail",
  async run(context) {
    const { page } = context;
    await selectOwner(page, PERSONAL);
    await openSettings(page);
    const personal = await settingsRail(page);
    await shot(context, "N1-settings-personal");
    await closeSettings(page);
    await selectOwner(page, FIXTURE.organization);
    await openSettings(page);
    const organization = await settingsRail(page);
    await shot(context, "N1-settings-organization");
    await closeSettings(page);
    const find = (groups, heading) => groups.find(group => group.heading === heading)?.items ?? [];
    const personalItems = find(personal, "Personal"), orgItems = find(organization, "Native Org");
    const ok = ["General", "GitHub", "Cloud Computer"].every(item => personalItems.includes(item)) && orgItems.includes("General");
    return { result: ok ? "pass" : "fail", fact: `Personal: [${personalItems.join(", ")}]; Native Org: [${orgItems.join(", ")}]` };
  },
};

// ── N2 ─────────────────────────────────────────────────────────────────────────
const projectsCheck = {
  id: "N2 projects page",
  async run(context) {
    const { page } = context;
    await selectOwner(page, FIXTURE.organization);
    await openSettings(page);
    const rail = page.locator("[aria-label=\"Settings sections\"]").first();
    await rail.getByText("Native", { exact: true }).first().click();
    await page.getByText("fixture/web", { exact: true }).first().waitFor();
    const repositories = await page.locator("[data-cloud-project] [aria-label='Repositories']").innerText().catch(() => "");
    await page.getByRole("button", { name: "fixture/app settings", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "Fetch fixture/app's submodules" });
    await toggle.waitFor();
    const checked = await toggle.getAttribute("aria-checked");
    await shot(context, "N2-project-repository-sheet");
    await page.keyboard.press("Escape");
    await closeSettings(page);
    const listed = ["fixture/app", "fixture/web"].filter(name => repositories.includes(name));
    return { result: listed.length === 2 && checked === "true" ? "pass" : "fail",
      fact: `project "Native" lists [${listed.join(", ")}]; fixture/app's sheet: "Fetch submodules" switch aria-checked=${checked}` };
  },
};

// ── N3 ─────────────────────────────────────────────────────────────────────────
async function createTray(page, side) {
  await page.getByRole("button", { name: "Create workspace", exact: true }).first().click();
  const placement = page.getByRole("tablist", { name: "Where the workspace runs", exact: true });
  await placement.waitFor();
  await placement.getByRole("tab", { name: side === "Local" ? "This Mac" : side, exact: true }).click();
  await page.waitForTimeout(1200);
  const project = await page.getByRole("button", { name: "Choose project", exact: true }).innerText().catch(() => "");
  const create = page.getByRole("button", { name: "Create", exact: true }).last();
  return { project: project.trim(), createEnabled: await create.isEnabled().catch(() => null) };
}
const createCheck = {
  id: "N3 create local and cloud",
  budgetMs: 90_000,
  async run(context) {
    const { page, state } = context;
    await selectOwner(page, FIXTURE.organization);
    const local = await createTray(page, "Local");
    const cloud = await createTray(page, "Cloud");
    await shot(context, "N3-create-cloud-project");
    // No project in the organization: the tray says so.
    state.noProjects = true;
    await reload(context);
    await selectOwner(page, FIXTURE.organization);
    await createTray(page, "Cloud");
    const body1 = await page.locator("body").innerText();
    await shot(context, "N3-create-no-project");
    state.noProjects = false;
    // Personal without Pro: the tray says Pro.
    state.personalSeat = "free";
    await reload(context);
    await selectOwner(page, PERSONAL);
    const withoutPro = await createTray(page, "Cloud");
    const body2 = await page.locator("body").innerText();
    await shot(context, "N3-create-personal-without-pro");
    state.personalSeat = "pro";
    await reload(context);
    const sawNoProject = body1.includes("Create a project to start a cloud workspace.");
    const sawPro = body2.includes("Creating a cloud workspace requires Pro.");
    const ok = /Native/.test(cloud.project) && cloud.createEnabled !== false && sawNoProject && sawPro;
    return { result: ok ? "pass" : "fail",
      fact: `Local: project button "${local.project}"; Cloud: project "${cloud.project}", Create enabled=${cloud.createEnabled}; `
        + `no project: "Create a project to start a cloud workspace." ${sawNoProject ? "shown" : "MISSING"}; `
        + `Personal without Pro: "Creating a cloud workspace requires Pro." ${sawPro ? "shown" : "MISSING"} (Create enabled=${withoutPro.createEnabled})` };
  },
};

// ── N4 ─────────────────────────────────────────────────────────────────────────
const submodules = {
  id: "N4 local fetch submodules",
  budgetMs: 120_000,
  async prepare(context) {
    const base = path.join(context.dirs.fixtures, "git");
    await fs.mkdir(base, { recursive: true });
    const bare = async (name) => {
      const origin = path.join(base, `${name}.git`), seed = path.join(base, `${name}-seed`);
      await git(context, base, "init", "-q", "--bare", "-b", "main", origin);
      await git(context, base, "init", "-q", "-b", "main", seed);
      await fs.writeFile(path.join(seed, `${name}.txt`), `${name}\n`);
      await git(context, seed, "add", "-A");
      await git(context, seed, "commit", "-q", "-m", name);
      await git(context, seed, "push", "-q", origin, "main");
      return { origin, commit: await git(context, seed, "rev-parse", "HEAD") };
    };
    const lib = await bare("lib"), sshlib = await bare("sshlib");
    // github.com, for this run only, is these local repositories (with and without .git, and the SSH spelling the
    // engine follows as written; the longest prefix wins). Nothing reaches github.com over HTTPS or SSH.
    await fs.appendFile(context.gitconfig, `[url "file://${lib.origin}"]\n\tinsteadOf = https://github.com/fixture/lib.git\n\tinsteadOf = https://github.com/fixture/lib\n`
      + `[url "file://${sshlib.origin}"]\n\tinsteadOf = https://github.com/fixture/sshlib.git\n\tinsteadOf = https://github.com/fixture/sshlib\n\tinsteadOf = git@github.com:fixture/sshlib.git\n`);
    const app = path.join(base, "app");
    await git(context, base, "init", "-q", "-b", "main", app);
    await fs.writeFile(path.join(app, "README.md"), "native check\n");
    await fs.writeFile(path.join(app, ".gitmodules"), [
      '[submodule "lib"]', "\tpath = lib", "\turl = https://github.com/fixture/lib",
      '[submodule "sshlib"]', "\tpath = sshlib", "\turl = git@github.com:fixture/sshlib.git",
      // Hostile: a path that leaves the checkout.
      '[submodule "escape"]', "\tpath = ../escape", "\turl = https://github.com/fixture/lib", ""].join("\n"));
    await git(context, app, "add", "-A");
    await git(context, app, "update-index", "--add", "--cacheinfo", `160000,${lib.commit},lib`);
    await git(context, app, "update-index", "--add", "--cacheinfo", `160000,${sshlib.commit},sshlib`);
    await git(context, app, "commit", "-q", "-m", "app with submodules");
    context.n4 = { app, lib, sshlib, base };
  },
  async run(context) {
    const { page, n4 } = context;
    await selectOwner(page, PERSONAL);
    const created = await renderer(page, async (repoRoot) => {
      const { upsertProject } = await import("/apps/desktop/src/renderer/state/projects-store.ts");
      const { notifyProjectsChanged } = await import("/apps/desktop/src/renderer/state/use-projects.ts");
      const { workspaceCreate } = await import("/apps/desktop/src/renderer/platform/git.ts");
      const { getActiveBridge } = await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts");
      const { bridgeSettingsWrite } = await import("/apps/desktop/src/renderer/platform/bridge/workspace-bridge.ts");
      const project = upsertProject({ repoRoot, repoSlug: "native-check-app", isGitRepository: true });
      notifyProjectsChanged();
      // "Fetch submodules" on, as the repository settings switch saves it (the engine's repo-local layer).
      const saved = await bridgeSettingsWrite(getActiveBridge(), "repo-local", { git: { fetch_submodules: true } }, repoRoot);
      const workspace = await workspaceCreate({ repoRoot, repoSlug: project.repoSlug, organizationId: null, placement: "local", kind: "code" });
      return { ...workspace, settingsPath: saved.path };
    }, n4.app);
    const worktree = created.worktreePath ?? created.path;
    if (!worktree) return fail(`the engine's create returned no worktree path (${Object.keys(created).join(",")})`);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !(existsSync(path.join(worktree, "lib", ".git")) && existsSync(path.join(worktree, "sshlib", ".git")))) await page.waitForTimeout(500);
    // What the engine said about them: its note, shown in the workspace's Setup tab.
    await renderer(page, async (folder) => {
      const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
      useWorkspaceStore.getState().dispatch({ type: "OPEN_WORKSPACE", folder, repoRoot: folder, chatId: null });
    }, worktree);
    await page.getByRole("tab", { name: "Setup", exact: true }).first().click().catch(() => undefined);
    await page.waitForTimeout(1000);
    const lines = (await page.locator("body").innerText()).split("\n");
    const at = lines.findIndex(line => /^Submodules:/.test(line.trim()));
    const note = at < 0 ? "" : lines.slice(at, at + 12).map(line => line.trim()).filter(Boolean).join(" / ");
    await shot(context, "N4-setup-note");
    const head = async (name) => existsSync(path.join(worktree, name, ".git")) ? git(context, path.join(worktree, name), "rev-parse", "HEAD").catch(() => "") : "";
    const libHead = await head("lib"), sshHead = await head("sshlib");
    const gitfile = await fs.readFile(path.join(worktree, "lib", ".git"), "utf8").catch(() => "");
    const escaped = [path.join(path.dirname(worktree), "escape"), path.join(n4.base, "escape")].filter(existsSync);
    const sshOrigin = sshHead ? await git(context, path.join(worktree, "sshlib"), "config", "--get", "remote.origin.url").catch(() => "") : "";
    const ok = libHead === n4.lib.commit && sshHead === n4.sshlib.commit && /^gitdir: .*modules\//.test(gitfile) && !escaped.length && /Submodules: 2 fetched, 1 skipped, 0 failed/.test(note);
    return { result: ok ? "pass" : "fail", fact: `lib HEAD=${libHead.slice(0, 8) || "missing"} (gitlink ${n4.lib.commit.slice(0, 8)}); `
      + `sshlib (written git@github.com:…) HEAD=${sshHead.slice(0, 8) || "missing"}, origin ${sshOrigin || "none"} (as written; fetched through the run's insteadOf); `
      + `lib .git → ${gitfile.includes("/modules/") ? `…${gitfile.trim().slice(gitfile.indexOf("/modules/"))}` : "not a gitdir file"}; `
      + `../escape: ${escaped.length ? "CREATED outside the checkout" : "nothing outside the checkout"}; setting saved to ${path.relative(n4.app, created.settingsPath ?? "") || created.settingsPath}; engine's note: ${note || "none"}` };
  },
};

// ── N5 ─────────────────────────────────────────────────────────────────────────
const severalCheck = {
  id: "N5 several repositories",
  async run(context) {
    const { page } = context;
    await selectOwner(page, FIXTURE.organization);
    await renderer(page, async (folder) => {
      const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
      useWorkspaceStore.getState().dispatch({ type: "OPEN_WORKSPACE", folder, repoRoot: folder, chatId: null });
    }, cloudKey(FIXTURE.organization, WORKSPACES.several));
    // The switcher sits in the pull request row, which Changes shows.
    await page.getByRole("tab", { name: "Changes", exact: true }).first().click();
    const switcher = page.getByRole("button", { name: /^Repository:/ }).first();
    await switcher.waitFor({ timeout: 20_000 });
    await switcher.click();
    const options = (await page.getByRole("menuitemradio").allInnerTexts()).map(text => text.split("\n")[0]?.trim());
    await shot(context, "N5-repository-switcher");
    await page.keyboard.press("Escape");
    const tabs = (await page.getByRole("tab").allInnerTexts()).map(text => text.split("\n")[0]?.trim()).filter(Boolean);
    const ok = options.some(text => /app/.test(text)) && options.some(text => /web/.test(text)) && tabs.some(tab => /^Changes/.test(tab)) && tabs.some(tab => /^Files/.test(tab));
    return { result: ok ? "pass" : "fail", fact: `switcher lists [${options.join(", ")}]; tabs [${tabs.slice(0, 8).join(", ")}] (no worker: Changes and Files show their unavailable state)` };
  },
};

// ── N6 ─────────────────────────────────────────────────────────────────────────
async function personalSurface(context) {
  const { page } = context;
  await selectOwner(page, PERSONAL);
  await openSettings(page);
  const rail = await settingsRail(page);
  await closeSettings(page);
  const row = await page.getByText("Personal cloud", { exact: true }).first().isVisible().catch(() => false);
  return { cloudComputer: (rail.find(group => group.heading === "Personal")?.items ?? []).includes("Cloud Computer"), row };
}
const personalCheck = {
  id: "N6 personal with and without cloud",
  budgetMs: 60_000,
  async run(context) {
    const { page, state } = context;
    const withCloud = await personalSurface(context);
    await shot(context, "N6-personal-with-cloud");
    state.personalCloud = false;
    await reload(context);
    const without = await personalSurface(context);
    await shot(context, "N6-personal-without-cloud");
    state.personalCloud = true;
    await reload(context);
    const ok = withCloud.cloudComputer && withCloud.row && !without.cloudComputer && !without.row;
    return { result: ok ? "pass" : "fail", fact: `with its cloud: Cloud Computer=${withCloud.cloudComputer}, cloud workspace row=${withCloud.row}; `
      + `without: Cloud Computer=${without.cloudComputer}, cloud workspace row=${without.row}` };
  },
};

// ── N7 ─────────────────────────────────────────────────────────────────────────
const deepLinkCheck = {
  id: "N7 deep link under Personal",
  async run(context) {
    const { page, app } = context;
    await selectOwner(page, FIXTURE.organization);
    const url = await renderer(page, async ([organizationId, workspaceId]) =>
      (await import("/packages/protocol/src/cloud-workspace-link.ts")).formatCloudWorkspaceLink("zeros-dev", { organizationId, workspaceId }),
    [FIXTURE.personal, WORKSPACES.personal]);
    await app.evaluate(({ app }, link) => { app.emit("open-url", { preventDefault() {} }, link); }, url);
    const folder = cloudKey(FIXTURE.personal, WORKSPACES.personal);
    await page.waitForFunction(async (expected) => {
      const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
      return useWorkspaceStore.getState().lastWorkspaceFolder === expected;
    }, folder, { timeout: 15_000 });
    // The owner as the person sees it: the switcher's label (Personal shows the account's name), once it has re-rendered.
    await page.waitForFunction(() => /^(Fixture|Personal)$/.test(document.querySelector("[aria-label='Switch organization']")?.textContent?.trim() ?? ""),
      undefined, { timeout: 10_000 }).catch(() => undefined);
    const owner = (await page.getByRole("button", { name: "Switch organization", exact: true }).first().innerText().catch(() => "")).trim();
    const personalOwner = /^(Fixture|Personal)$/.test(owner);
    const title = await page.getByText("Personal cloud", { exact: true }).first().isVisible().catch(() => false);
    await shot(context, "N7-deep-link");
    return { result: personalOwner && title ? "pass" : "fail",
      fact: `${url.replace(/[0-9a-f-]{36}/g, "<id>")} from Native Org → switcher shows "${owner}"${personalOwner ? " (Personal)" : ""}, open workspace = Personal's cloud workspace, its title shown=${title}` };
  },
};

// ── N8 ─────────────────────────────────────────────────────────────────────────
const preloadCheck = {
  id: "N8 preload and IPC",
  async run(context) {
    const { page, repo } = context;
    const source = await fs.readFile(path.join(repo, "apps/desktop/electron/preload.ts"), "utf8");
    const exposed = await renderer(page, () => Object.keys(window.__ZEROS_NATIVE__ ?? {}).sort());
    const refusal = await renderer(page, () => window.__ZEROS_NATIVE__.invoke("native_check_not_a_command").then(() => "allowed", error => String(error?.message ?? error)));
    // A read-only command the unified surfaces use, through the real preload and main.
    const user = await renderer(page, () => window.__ZEROS_NATIVE__.invoke("auth_get_session_user"));
    const missing = exposed.filter(name => !source.includes(name));
    const ok = exposed.length > 0 && refusal !== "allowed" && !missing.length && user?.email === FIXTURE.email;
    return { result: ok ? "pass" : "fail", fact: `${exposed.length} names on window.__ZEROS_NATIVE__, all declared in preload.ts${missing.length ? ` except ${missing.join(",")}` : ""}; `
      + `an unknown command is refused ("${refusal.slice(0, 80)}"); auth_get_session_user → ${user?.email === FIXTURE.email ? "the fixture user" : "something else"}` };
  },
};

// ── N9-N11 (C2.3) ───────────────────────────────────────────────────────────────
async function menuOf(page, title) {
  await page.getByText(title, { exact: true }).first().click({ button: "right" });
  await page.getByRole("menu").first().waitFor();
  const items = (await page.getByRole("menuitem").allInnerTexts()).map(text => text.trim());
  const keepChecked = await page.getByRole("menuitem", { name: /^Keep/ }).locator("[aria-label='On']").count().catch(() => 0);
  return { items, keepChecked: keepChecked > 0 };
}
const keepCheck = {
  id: "N9 keep in the native menu",
  budgetMs: 60_000,
  async run(context) {
    if (!retentionInSource(context)) return na("Keep (C2.3) is not in this checkout");
    const { page, state } = context;
    await selectOwner(page, FIXTURE.organization);
    const off = await menuOf(page, "Live");
    await page.getByRole("menuitem", { name: /^Keep/ }).click();
    await page.waitForTimeout(800);
    const puts = state.requests.filter(request => request.method === "PUT" && request.path.endsWith("/keep")).length;
    const on = await menuOf(page, "Live");
    await shot(context, "N9-menu-keep-on");
    await page.keyboard.press("Escape");
    state.retention = false;
    await reload(context);
    await selectOwner(page, FIXTURE.organization);
    const disabled = await menuOf(page, "Live");
    await page.keyboard.press("Escape");
    state.retention = true;
    await reload(context);
    const ok = off.items.includes("Keep") && !off.keepChecked && puts === 1 && on.keepChecked && !disabled.items.includes("Keep");
    return { result: ok ? "pass" : "fail", fact: `menu [${off.items.join(", ")}] Keep checked=${off.keepChecked}; click → PUT /keep ×${puts}; then checked=${on.keepChecked}; `
      + `retention off: [${disabled.items.join(", ")}]` };
  },
};
const archivedCheck = {
  id: "N10 archived list",
  async run(context) {
    if (!retentionInSource(context)) return na("the archived line (C2.3) is not in this checkout");
    const { page } = context;
    await selectOwner(page, FIXTURE.organization);
    await page.evaluate(() => localStorage.setItem("zeros:dashboard-show-archived", "1"));
    await reload(context);
    await selectOwner(page, FIXTURE.organization);
    await page.getByRole("button", { name: "Home", exact: true }).first().click();
    await page.getByText("Archived after 30 days without activity.", { exact: false }).first().waitFor();
    const body = await page.locator("body").innerText();
    await shot(context, "N10-archived-list");
    const expected = ["Archived after 30 days without activity.", "Archived when its creator left the organization.", "Unarchiving it restores everything.",
      "Unarchiving it rebuilds it from GitHub. Work that was never pushed is gone.", "Backup kept until", "Its machine was removed on"];
    const seen = expected.filter(text => body.includes(text));
    return { result: seen.length === expected.length ? "pass" : "fail", fact: `seen ${seen.length}/${expected.length}: ${expected.map(text => `${seen.includes(text) ? "+" : "-"}"${text.slice(0, 32)}"`).join(" ")}` };
  },
};
const ruleCheck = {
  id: "N11 general rule",
  async run(context) {
    if (!retentionInSource(context)) return na("the rule on General (C2.3) is not in this checkout");
    const { page } = context;
    const read = async (owner, section) => {
      await selectOwner(page, owner);
      await openSettings(page);
      await page.locator("[aria-label=\"Settings sections\"]").first().getByText("General", { exact: true }).nth(section).click();
      await page.waitForTimeout(600);
      const text = await page.locator("body").innerText();
      await closeSettings(page);
      return text.includes("A cloud workspace nobody uses for 30 days is archived.");
    };
    const organization = await read(FIXTURE.organization, 1), personal = await read(PERSONAL, 0);
    return { result: organization && personal ? "pass" : "fail", fact: `the rule on General: organization=${organization}, Personal=${personal}` };
  },
};

// ── N13 ────────────────────────────────────────────────────────────────────────
const isolation = {
  id: "N13 isolation",
  async run({ app, root, gitconfig, env }) {
    const facts = await app.evaluate(({ app }) => ({ userData: app.getPath("userData"), home: process.env.HOME,
      mockKeychain: app.commandLine.hasSwitch("use-mock-keychain"),
      secrets: Object.keys(process.env).filter(name => /TOKEN|SECRET|PASSWORD|API_?KEY|_PAT$|CREDENTIAL|SSH_AUTH_SOCK|CONDUCTOR/i.test(name)),
      mainPid: process.pid }));
    // The PATH each of the app's processes really has (main, the engine, helpers): where its git and gh come from.
    const paths = new Map();
    for (const row of descendants(await processTable(), [facts.mainPid])) {
      const value = await processVariable(row.pid, "PATH");
      if (value !== null) paths.set(value, [...(paths.get(value) ?? []), path.basename(row.command.split(" ")[0] ?? "?")]);
    }
    // Git as the engine runs it: the run's git, with every GIT_* variable removed first (git-exec.ts gitChildEnv).
    const runBin = path.join(root, "bin");
    const engineEnv = { PATH: env.PATH, HOME: env.HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME };
    const config = async (...args) => (await exec(path.join(runBin, "git"), ["config", ...args], { cwd: root, env: engineEnv }).catch(() => ({ stdout: "" }))).stdout.trim();
    const email = await config("--get", "user.email");
    const helpers = await config("--get-all", "credential.helper");
    const hooksPath = await config("--get", "core.hooksPath");
    const excludes = await config("--get", "core.excludesFile");
    const files = [...new Set((await config("--show-origin", "--list")).split("\n").map(line => line.split("\t")[0]?.replace(/^file:/, "")).filter(Boolean))];
    const resolve = async (tool) => (await exec("/bin/sh", ["-c", `command -v ${tool} || true`], { env: { PATH: env.PATH } })).stdout.trim();
    const [gitPath, ghPath, securityPath] = [await resolve("git"), await resolve("gh"), await resolve("security")];
    const log = (await fs.readFile(path.join(root, "tool-calls.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);
    const hookLog = await fs.readFile(env.ZEROS_NATIVE_CHECK_HOOK_LOG, "utf8").catch(() => "");
    const refused = hookLog.split("\n").filter(line => line.includes("protocol-client-refused")).length;
    const strayPaths = [...paths].filter(([value]) => value.split(path.delimiter)[0] !== runBin);
    const ok = !strayPaths.length && paths.size > 0 && files.length === 1 && files[0] === gitconfig && under(facts.userData, root) && under(facts.home, root) && email === FIXTURE.email && hookLog.includes("invoke-wrapped") && facts.secrets.length === 0
      && helpers === "" && hooksPath === "" && excludes === "" && path.dirname(gitPath) === runBin && path.dirname(ghPath) === runBin
      && (securityPath === "" || path.dirname(securityPath) === runBin) && (process.platform !== "darwin" || facts.mockKeychain);
    return { result: ok ? "pass" : "fail", fact: `userData=${facts.userData} home=${facts.home}; config files the engine's Git reads: [${files.join(", ")}]; git: user.email=${email === FIXTURE.email ? "fixture" : "NOT the fixture (withheld)"}, `
      + `credential.helper=${JSON.stringify(helpers)}, core.hooksPath=${JSON.stringify(hooksPath)}, core.excludesFile=${JSON.stringify(excludes)}; `
      + `app processes' PATH: ${paths.size} distinct, ${strayPaths.length ? `NOT starting at ${runBin}: ${strayPaths.map(([value, names]) => `${[...new Set(names)].join("/")} → ${value.split(path.delimiter).slice(0, 3).join(path.delimiter)}…`).join("; ")}` : `all start at ${runBin}`}; `
      + `on the app's PATH: git=${gitPath}, gh=${ghPath}, security=${securityPath || "absent"}; `
      + `tools run: ${log.filter(line => line.startsWith("git")).length}× ${runBin}/git, ${log.filter(line => line.startsWith("gh")).length}× ${runBin}/gh (stub); `
      + `mock keychain=${facts.mockKeychain}${process.platform === "darwin" ? "" : " (Linux: basic password store)"}; protocol registrations refused=${refused}; `
      + `credential-like variables in main=${facts.secrets.length ? facts.secrets.join(",") : "none"}` };
  },
};

export const CHECKS = [settingsRailCheck, projectsCheck, createCheck, submodules, severalCheck, personalCheck, deepLinkCheck, preloadCheck,
  keepCheck, archivedCheck, ruleCheck, isolation];
