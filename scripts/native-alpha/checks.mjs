// The Alpha check's named checks, in order, each driven through the app's UI as a person would and each leaving a
// screenshot. A check returns { result, fact }: what it measured, never only "ok". Every locator takes the visible
// match: the app keeps hidden copies of surfaces it may return to.
/* global document, window, crypto -- read inside page.evaluate, which runs in the renderer */
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ALPHA_API = "https://api-alpha.zeros.build";
const shot = (context, name) => context.page.screenshot({ path: path.join(context.dirs.shots, `${name}.png`) });
const visible = (locator) => locator.filter({ visible: true }).first();
const seconds = (since) => Math.round((Date.now() - since) / 1000);
const pass = (fact) => ({ result: "pass", fact });
const fail = (fact) => ({ result: "fail", fact });
const text = (page) => page.evaluate(() => document.body.innerText);
/** Waits for the file tree to show an entry: its rows are tree items named by the entry's full name (the tree
 * truncates and splits the visible text), inside an open shadow root. */
async function shows(page, name, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const found = await page.evaluate((wanted) => {
      const walk = (root) => [...root.querySelectorAll("[role=treeitem]")].some(item => item.getAttribute("aria-label") === wanted && item.getClientRects().length)
        || [...root.querySelectorAll("*")].some(element => element.shadowRoot && walk(element.shadowRoot));
      return walk(document);
    }, name);
    if (found) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

/** The project page's cloud build status: the line after the section's heading and its description. */
export function buildLabel(pageText) {
  const lines = String(pageText).split("\n").map(line => line.trim()).filter(Boolean);
  const at = lines.indexOf("Cloud build");
  const label = at < 0 ? "" : lines[at + 2] ?? "";
  return /^(Ready|Getting ready…|Updating…|Update failed|Not built yet|Preparing the Cloud Computer…|The Cloud Computer could not be prepared)$/.test(label)
    ? label.replace(/…$/, "") : "?";
}

/** Alpha's API with the app's own session, called inside the renderer so the token never leaves it. */
export function api(context, method, apiPath, body) {
  return context.page.evaluate(async ({ origin, method, apiPath, body }) => {
    const reply = await window.__ZEROS_NATIVE__.invoke("auth_get_access_token");
    const token = typeof reply === "string" ? reply : reply?.access_token;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    if (method !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
    const response = await fetch(`${origin}${apiPath}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { origin: ALPHA_API, method, apiPath, body });
}
/** The rehearsal's run state: what the check makes is recorded there first, so the rehearsal's clean-up removes it even
 * after a kill. */
function record(context, kind, id) {
  const file = path.join(os.homedir(), ".zeros-rehearsal", `${context.runId}.json`);
  const state = JSON.parse(readFileSync(file, "utf8"));
  if (!state.created[kind].includes(id)) state.created[kind].push(id);
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  context.created[kind].push(id);
}
const organizationId = async (context) => {
  if (context.organizationId) return context.organizationId;
  const me = await api(context, "GET", "/v1/me");
  const personal = (me.body?.organizations ?? []).find(org => (org.personal ?? org.isPersonal) && org.role === "owner");
  if (!personal) throw new Error(`no Personal organization owned by the account (http ${me.status})`);
  return (context.organizationId = personal.id ?? personal.organizationId);
};
const workspaces = async (context) => {
  const reply = await api(context, "GET", `/v1/cloud-v2/workspaces?organizationId=${await organizationId(context)}&includeArchived=true`);
  return (reply.body?.workspaces ?? []).filter(row => row.state !== "deleted");
};

async function openSettings(page) {
  const rail = page.locator("[aria-label='Settings sections']");
  if (!(await rail.filter({ visible: true }).count())) await visible(page.getByRole("button", { name: "Open settings", exact: true })).click();
  await visible(rail).waitFor();
  return visible(rail);
}
async function settingsSection(page, label) {
  for (let i = 0; i < 2; i++) await page.keyboard.press("Escape");
  const rail = await openSettings(page);
  await rail.getByText(label, { exact: true }).first().click();
  await page.waitForTimeout(1500);
}
/** A known screen before a check: menus and dialogs closed, Settings closed. */
export async function settle(page) {
  for (let i = 0; i < 2; i++) await page.keyboard.press("Escape");
  await closeSettings(page);
}
async function closeSettings(page) {
  const back = page.getByRole("button", { name: "Back", exact: true }).filter({ visible: true });
  if (await back.count()) await back.first().click();
  await page.waitForTimeout(800);
}
/** A cloud workspace from the composer: Cloud, the project, the prompt, Create. Resolves the new workspace's id. */
async function createFromComposer(context, projectName, prompt) {
  const { page } = context;
  const before = new Set((await workspaces(context)).map(row => row.id));
  await visible(page.getByRole("button", { name: "Create workspace", exact: true })).click();
  await page.waitForTimeout(1500);
  await visible(page.getByRole("tab", { name: "Cloud" })).click();
  // A project made moments ago joins the chooser once the app's project list refreshes: reopened until it is there.
  const item = page.getByRole("menuitem", { name: new RegExp(`^${projectName}`) }).first(), listed = Date.now();
  for (let i = 0; ; i++) {
    await visible(page.getByRole("button", { name: "Choose project", exact: true })).click();
    if (await item.isVisible({ timeout: 2000 }).catch(() => false)) break;
    if (Date.now() - listed > 120_000) throw new Error(`the composer's project chooser never listed ${projectName}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(5000);
  }
  context.report.chooserWaitSeconds = { ...(context.report.chooserWaitSeconds ?? {}), [projectName]: seconds(listed) };
  await item.click();
  await visible(page.locator("[contenteditable=true][aria-label='Message']")).click();
  await page.keyboard.type(prompt);
  // Enter creates, as the composer's Create ↵ shows (a name match would also find the sidebar's Create).
  await page.keyboard.press("Enter");
  for (let i = 0; i < 60; i++) {
    const made = (await workspaces(context)).find(row => !before.has(row.id));
    if (made) { record(context, "workspaces", made.id); return made.id; }
    await page.waitForTimeout(2000);
  }
  throw new Error("the create made no workspace within 2 minutes");
}
/** Waits for the agent's reply to a prompt: the word alone on its line after the prompt. */
async function answered(page, prompt, word, timeoutMs = 300_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const after = (await text(page)).split(prompt).slice(1).join("");
    if (new RegExp(`\\n\\s*${word}\\s*\\n`, "i").test(after)) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}
async function terminal(context, command, expect) {
  const { page } = context;
  await visible(page.getByRole("button", { name: "New File, Browser, or Terminal tab" })).click();
  await page.getByRole("option", { name: "Terminal", exact: true }).first().click();
  await page.waitForTimeout(6000);
  await page.keyboard.type(`${command}\n`);
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const rows = await page.evaluate(() => [...document.querySelectorAll(".xterm-rows")].map(element => [...element.children].map(row => row.textContent).join("\n")).join("\n"));
    if (rows.includes(expect)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}
async function openTab(page, name) {
  await visible(page.getByRole("tab", { name, exact: true }).or(page.getByText(name, { exact: true }))).click();
  await page.waitForTimeout(3000);
}
/** The header's workspace chip opens its details: status, and Stop or Start. */
async function detailsStatus(page) {
  const read = () => page.evaluate(() => [...document.querySelectorAll("[data-radix-popper-content-wrapper], [role=dialog]")].map(element => element.innerText).join("\n"));
  const chip = visible(page.getByText(/^w-\d+$/));
  await chip.hover();
  let popover = "";
  for (let i = 0; i < 6 && !/Status\n/.test(popover); i++) { await page.waitForTimeout(500); popover = await read(); }
  // The title's tooltip can win the hover: a click on the chip opens the same details.
  if (!/Status\n/.test(popover)) { await chip.click(); await page.waitForTimeout(1000); popover = await read(); }
  return /Status\n(\w+)/.exec(popover)?.[1] ?? "?";
}
async function untilStatus(page, wanted, timeoutMs, seen) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const status = await detailsStatus(page);
    if (seen.at(-1) !== status) seen.push(status);
    if (wanted.includes(status)) return status;
    await page.mouse.move(700, 600);
    await page.waitForTimeout(2000);
  }
  return null;
}
/** The workspace's card on Home, by its branch label (zeros/<folder>-<id8>), which the agent's renaming leaves alone. */
async function card(context, workspaceId) {
  const { page } = context;
  await visible(page.getByRole("button", { name: "Home", exact: true })).click();
  await page.waitForTimeout(2500);
  return visible(page.getByText(new RegExp(`-${workspaceId.slice(0, 8)}$`)));
}
async function cardMenu(context, workspaceId) {
  await (await card(context, workspaceId)).click({ button: "right" });
  await context.page.waitForTimeout(800);
}

export const CHECKS = [
  {
    id: "1 settings rail",
    run: async (context) => {
      const { page } = context;
      const rail = await openSettings(page);
      const read = () => rail.evaluate(element => [...element.querySelectorAll("*")].filter(node => node.children.length === 0 && node.textContent.trim()).map(node => node.textContent.trim()));
      // Cloud Computer joins the rail once the organization's cloud is read.
      let entries = await read();
      for (let i = 0; i < 20 && !entries.includes("Cloud Computer"); i++) { await page.waitForTimeout(1000); entries = await read(); }
      await settingsSection(page, "Cloud Computer");
      const body = await text(page);
      await shot(context, "01-settings-rail");
      const cloudOn = /\d+ projects? in Personal/.test(body) && body.includes("New project");
      const ok = entries.includes("Personal") && entries.includes("Cloud Computer") && cloudOn;
      return (ok ? pass : fail)(`rail: Personal group ${entries.includes("Personal") ? "shown" : "MISSING"}, Cloud Computer ${entries.includes("Cloud Computer") ? "shown" : "MISSING"}; `
        + `Personal's cloud ${cloudOn ? "on (Cloud Computer lists Personal's projects and offers New project)" : "NOT on"}; the account has no organization but Personal; Projects appears once one exists (check 2)`);
    },
  },
  {
    id: "9 retention rule",
    run: async (context) => {
      const { page } = context;
      await settingsSection(page, "General");
      const body = await text(page);
      await shot(context, "09-general-retention");
      const lines = ["After 30 days without use", "Once archived", "Keep"].filter(line => body.includes(line));
      return (lines.length === 3 ? pass : fail)(`General → Cloud workspaces shows ${lines.length} of 3 retention lines (${lines.join("; ")})`);
    },
  },
  {
    id: "2 cloud project",
    budgetMs: 40 * 60_000,
    run: async (context) => {
      const { page } = context;
      await settingsSection(page, "Cloud Computer");
      await visible(page.getByRole("button", { name: "New project", exact: true })).click();
      await page.waitForTimeout(2000);
      const dialog = await visible(page.getByRole("dialog")).innerText();
      await shot(context, "02a-new-project-dialog");
      const blocker = /Connect (a )?GitHub[^.]*first\./.exec(dialog)?.[0] ?? "(no message)";
      context.report.projectDialog = blocker;
      await visible(page.getByRole("button", { name: "Cancel", exact: true })).click();
      // Created through the API with the app's own session, as the rehearsal does (the dialog needs a GitHub App connection).
      const org = await organizationId(context), name = `${context.prefix}native-one`;
      const made = await api(context, "POST", `/v1/cloud-v2/organizations/${org}/cloud-projects`, { name, level: "personal", repositories: [{ repository: context.fixtureOne }] });
      if (made.status !== 201 || !made.body?.project?.id) return fail(`project create through the API: http ${made.status}`);
      record(context, "projects", made.body.project.id);
      context.projectOne = { id: made.body.project.id, name, label: context.fixtureOne.split("/")[1] };
      // Settings lists it, and its cloud build goes to Ready. A project made outside the app (the API) reaches an open
      // Settings only on a fresh read: Settings is closed and opened again, as a person coming back to it would.
      let rail = await openSettings(page), entry = null;
      const listedFrom = Date.now();
      for (let i = 0; i < 30 && !entry; i++) {
        await settingsSection(page, "Cloud Computer");
        for (const label of [name, context.projectOne.label]) if (await rail.getByText(label, { exact: true }).count()) entry = label;
        if (!entry) { await closeSettings(page); await page.waitForTimeout(2000); rail = await openSettings(page); }
      }
      const listedSeconds = seconds(listedFrom);
      if (!entry) return fail(`Settings never listed the project under Projects (dialog: ${blocker})`);
      await rail.getByText(entry, { exact: true }).first().click();
      // The page's own words for the cloud build, beside the API's state for the same copy: a page that never moves
      // while the copy is ready would be a stale view, not a slow build. The first project of a fresh account also waits
      // for the organization's base (the rehearsal allows 30 minutes for a copy).
      const states = [], until = Date.now() + 35 * 60_000, watched = Date.now();
      const copyPath = `/v1/cloud-v2/organizations/${org}/cloud-projects/${made.body.project.id}/ready-copy`;
      const uiState = async () => buildLabel(await text(page));
      let apiReadyAt = null, last = "", reopened = null, retried = null;
      while (Date.now() < until) {
        const ui = await uiState();
        const status = (await api(context, "GET", copyPath)).body?.status;
        const copy = status?.state ?? "?";
        // A failed build is retried once from the page (Retry now), as a person would and as the rehearsal does; its
        // reason is recorded either way.
        if (ui === "Update failed" && retried === null) {
          retried = status?.failure?.reason ?? "unknown";
          const retry = page.getByRole("button", { name: "Retry now", exact: true }).filter({ visible: true });
          if (await retry.count()) { await retry.first().click(); states.push(`${ui} (${retried}), Retry now at ${seconds(watched)} s`); last = ""; await page.waitForTimeout(5000); continue; }
        }
        if (copy === "ready") apiReadyAt ??= Date.now();
        const state = `${ui} (api ${copy})`;
        if (last !== state) { states.push(`${state} at ${seconds(watched)} s`); last = state; }
        if (ui === "Ready" || (ui === "Update failed" && retried !== null)) break;
        // A page still not Ready a minute after the API: reopened once, to tell a stale view from a slow one.
        if (apiReadyAt && Date.now() - apiReadyAt > 60_000) {
          await rail.getByText("General", { exact: true }).first().click(); await page.waitForTimeout(1000);
          // The rail may name it by its repository by now rather than the project name.
          await rail.getByText(name, { exact: true }).or(rail.getByText(context.projectOne.label, { exact: true })).first().click();
          await page.waitForTimeout(3000);
          reopened = await uiState();
          break;
        }
        await page.waitForTimeout(5000);
      }
      await shot(context, "02b-project-ready");
      await closeSettings(page);
      const stale = reopened !== null ? `; the page still said ${last.split(" (")[0]} a minute after the API's ready, and reopening it showed ${reopened}` : "";
      return (states.at(-1)?.startsWith("Ready") ? pass : fail)(`the dialog shows "${blocker}"; created through the API (app session); Settings lists it under Projects as "${entry}" (${listedSeconds} s, Settings reopened while waiting); `
        + `cloud build ${states.join(" → ")}${stale}`);
    },
  },
  {
    id: "3 create and turn",
    budgetMs: 10 * 60_000,
    run: async (context) => {
      if (!context.projectOne) return fail("no project from check 2");
      const { page } = context, started = Date.now();
      const prompt = `${context.prefix}native: reply with the single word ok and nothing else`;
      context.workspaceOne = await createFromComposer(context, context.projectOne.name, prompt);
      const ok = await answered(page, prompt, "ok");
      await shot(context, "03-created-and-answered");
      return (ok ? pass : fail)(`Create (Cloud, project ${context.projectOne.name}, a fixed prompt) made workspace ${context.workspaceOne.slice(0, 8)}; `
        + `${ok ? `it connected and the turn answered "ok" ${seconds(started)} s after Create` : "no answer within 5 minutes"}`);
    },
  },
  {
    id: "4 files changes terminal",
    budgetMs: 3 * 60_000,
    run: async (context) => {
      if (!context.workspaceOne) return fail("no workspace from check 3");
      const { page } = context;
      await openTab(page, "Files");
      const readme = await shows(page, "README.md");
      await shot(context, "04a-files");
      const ran = await terminal(context, "echo zr-native-$((6*7)) | tee native-check.txt", "zr-native-42");
      await shot(context, "04b-terminal");
      await openTab(page, "Changes");
      const body = await text(page);
      const changed = /1 File Changed/.test(body) && body.includes("native-check.txt");
      await shot(context, "04c-changes");
      return (readme && ran && changed ? pass : fail)(`Files ${readme ? "shows the checkout (README.md)" : "does NOT show README.md"}; `
        + `a terminal on the cloud machine ${ran ? "ran echo and printed zr-native-42" : "did NOT print the output"}; Changes ${changed ? "lists native-check.txt (1 file changed)" : "does NOT list the new file"}`);
    },
  },
  {
    id: "5 stop and start",
    budgetMs: 10 * 60_000,
    run: async (context) => {
      if (!context.workspaceOne) return fail("no workspace from check 3");
      const { page } = context, seen = [], started = Date.now();
      await detailsStatus(page);
      await visible(page.getByRole("button", { name: "Stop workspace" })).click();
      const stopped = await untilStatus(page, ["Sleeping", "Stopped"], 4 * 60_000, seen);
      const stopSeconds = seconds(started);
      await shot(context, "05a-stopped");
      if (!stopped) return fail(`Stop: ${seen.join(" → ")}, never stopped`);
      await detailsStatus(page);
      await visible(page.getByRole("button", { name: "Start workspace" })).click();
      const restarted = Date.now();
      const running = await untilStatus(page, ["Running"], 4 * 60_000, seen);
      await page.mouse.move(700, 600);
      const prompt = "reply with the single word two and nothing else";
      await visible(page.locator("[contenteditable=true][aria-label='Message']")).click();
      await page.keyboard.type(prompt);
      await page.keyboard.press("Enter");
      const ok = running && await answered(page, prompt, "two", 180_000);
      await shot(context, "05b-started");
      return (ok ? pass : fail)(`from the workspace details: ${seen.join(" → ")}; stopped in ${stopSeconds} s, running ${seconds(restarted)} s after Start; `
        + `${ok ? "connected: a follow-up answered" : "no answer after the start"}`);
    },
  },
  {
    id: "6 keep",
    run: async (context) => {
      if (!context.workspaceOne) return fail("no workspace from check 3");
      const { page } = context, states = [];
      const keepItem = async () => { await cardMenu(context, context.workspaceOne); const item = page.getByRole("menuitem", { name: /^Keep/ }).first(); return { item, on: (await item.locator("[aria-label=On]").count()) > 0 }; };
      let keep = await keepItem(); states.push(keep.on ? "on" : "off");
      await keep.item.click(); await page.waitForTimeout(3000);
      keep = await keepItem(); states.push(keep.on ? "on" : "off");
      await shot(context, "06-keep-on");
      await keep.item.click(); await page.waitForTimeout(3000);
      keep = await keepItem(); states.push(keep.on ? "on" : "off");
      await page.keyboard.press("Escape");
      const document = (await workspaces(context)).find(row => row.id === context.workspaceOne);
      return (states.join(",") === "off,on,off" && document?.keep === false ? pass : fail)(`the workspace menu's Keep read ${states.join(" → ")}; the API reads keep=${document?.keep}`);
    },
  },
  {
    id: "7 archive and unarchive",
    budgetMs: 8 * 60_000,
    run: async (context) => {
      if (!context.workspaceOne) return fail("no workspace from check 3");
      const { page } = context, started = Date.now();
      await cardMenu(context, context.workspaceOne);
      await page.getByRole("menuitem", { name: /^Archive/ }).first().click();
      // The archived list: the dashboard's archive filter shows archived workspaces with their line.
      const filter = visible(page.getByRole("button", { name: "Archive visibility" }));
      let line = null;
      const showArchive = async (label) => { await filter.click(); await page.getByRole("menuitemradio", { name: label, exact: true }).first().click(); await page.waitForTimeout(1000); };
      await showArchive("Only archived");
      for (let i = 0; i < 20 && !line; i++) {
        line = /Archived\. Unarchiving it restores everything\.[^\n]*/.exec(await text(page))?.[0] ?? null;
        if (!line) await page.waitForTimeout(2000);
      }
      await shot(context, "07a-archived");
      if (!line) return fail("the archived list never showed the workspace's archived line");
      await visible(page.getByRole("button", { name: "Unarchive", exact: true })).click();
      for (let i = 0; i < 30 && /Archived\. Unarchiving it restores everything/.test(await text(page)); i++) await page.waitForTimeout(2000);
      const unarchived = seconds(started);
      await showArchive("Hiding archived");
      await visible(page.getByRole("button", { name: /^Open workspace / })).click();
      await page.waitForTimeout(2000);
      const prompt = "reply with the single word three and nothing else";
      await visible(page.locator("[contenteditable=true][aria-label='Message']")).click();
      await page.keyboard.type(prompt);
      await page.keyboard.press("Enter");
      const ok = await answered(page, prompt, "three", 240_000);
      await shot(context, "07b-unarchived");
      return (ok ? pass : fail)(`Archive from the workspace menu; the archived list shows "${line.slice(0, 120)}"; Unarchive (${unarchived} s); `
        + `${ok ? `it opens and answers ${seconds(started)} s after Archive` : "it did not answer after unarchiving"}`);
    },
  },
  {
    id: "8 two repositories",
    budgetMs: 40 * 60_000,
    run: async (context) => {
      const { page } = context, org = await organizationId(context), name = `${context.prefix}native-two`, started = Date.now();
      const made = await api(context, "POST", `/v1/cloud-v2/organizations/${org}/cloud-projects`, { name, level: "personal",
        repositories: [{ repository: context.fixtureOne }, { repository: context.fixtureTwo }] });
      if (made.status !== 201 || !made.body?.project?.id) return fail(`two-repository project through the API: http ${made.status}`);
      record(context, "projects", made.body.project.id);
      let copy = "?";
      for (let i = 0; i < 180 && !["ready", "failed"].includes(copy); i++) {
        copy = (await api(context, "GET", `/v1/cloud-v2/organizations/${org}/cloud-projects/${made.body.project.id}/ready-copy`)).body?.status?.state ?? "?";
        if (!["ready", "failed"].includes(copy)) await page.waitForTimeout(5000);
      }
      if (copy !== "ready") return fail(`its ready copy ended ${copy}`);
      const prompt = `${context.prefix}native: reply with the single word ok and nothing else`;
      context.workspaceTwo = await createFromComposer(context, name, prompt);
      for (let i = 0; i < 60 && (await text(page)).includes("Files appear when the workspace is ready."); i++) await page.waitForTimeout(2000);
      await openTab(page, "Files");
      const repoTwo = context.fixtureTwo.split("/")[1], repoOne = context.fixtureOne.split("/")[1];
      const folders = await shows(page, repoTwo);
      const wrote = await terminal(context, `echo two > ${repoTwo}/native-two.txt && echo written-two`, "written-two");
      await openTab(page, "Changes");
      const pick = async (pattern) => {
        await visible(page.getByRole("button", { name: /^Repository: / })).click();
        await page.waitForTimeout(800);
        const items = await page.evaluate(() => [...document.querySelectorAll("[role=menuitem], [role=menuitemradio]")].filter(element => element.getClientRects().length).map(element => element.textContent.trim()));
        await page.getByRole("menuitem", { name: pattern }).or(page.getByRole("menuitemradio", { name: pattern })).first().click();
        await page.waitForTimeout(3000);
        const body = await text(page);
        return { items, changed: /(\d+) Files? Changed/.exec(body)?.[1] ?? "?", shows: (await page.getByText("native-two.txt").filter({ visible: true }).count()) > 0 };
      };
      const two = await pick(new RegExp(`^${repoTwo}`));
      await shot(context, "08-changes-repository-two");
      const one = await pick(new RegExp(`^${repoOne}$`));
      const both = two.items.some(item => item.startsWith(repoOne)) && two.items.some(item => item.startsWith(repoTwo));
      const follows = two.shows && two.changed === "1" && !one.shows && one.changed === "0";
      return (folders && wrote && both && follows ? pass : fail)(`project of ${repoOne} and ${repoTwo} (copy ready ${seconds(started)} s after create); Files shows ${folders ? "both folders" : "NOT the second folder"}; `
        + `the repository switcher lists ${two.items.join(", ")}; Changes follows it: ${repoTwo} ${two.changed} file changed${two.shows ? " (native-two.txt)" : ""}, ${repoOne} ${one.changed}`);
    },
  },
  {
    id: "10 clean-up",
    budgetMs: 5 * 60_000,
    run: async (context) => {
      const { page } = context, org = await organizationId(context), out = [];
      // The app offers no delete for a cloud workspace or project (only Archive, Hide and Delete saved snapshot), so the
      // check deletes through the API with the app's own session, as the rehearsal's clean-up does.
      for (const id of context.created.workspaces) out.push(`workspace ${id.slice(0, 8)} http ${(await api(context, "DELETE", `/v1/cloud-v2/workspaces/${id}`)).status}`);
      let left = [];
      for (let i = 0; i < 40; i++) { left = await workspaces(context); if (!left.length) break; await page.waitForTimeout(3000); }
      for (const id of context.created.projects) out.push(`project ${id.slice(0, 8)} http ${(await api(context, "DELETE", `/v1/cloud-v2/organizations/${org}/cloud-projects/${id}`)).status}`);
      const projects = (await api(context, "GET", `/v1/cloud-v2/organizations/${org}/cloud-projects`)).body?.projects ?? [];
      await visible(page.getByRole("button", { name: "Home", exact: true })).click();
      await page.waitForTimeout(3000);
      await shot(context, "10-clean");
      return (!left.length && !projects.length ? pass : fail)(`${out.join("; ")}; Personal now holds ${left.length} workspace(s) and ${projects.length} project(s); `
        + "the rehearsal's inventory below proves the rest");
    },
  },
  {
    id: "signout",
    run: async (context) => {
      const { page } = context;
      await settingsSection(page, "Profile");
      await visible(page.getByRole("button", { name: "Sign out", exact: true })).click();
      await page.getByRole("button", { name: "Sign in", exact: true }).first().waitFor({ timeout: 30_000 });
      await shot(context, "11-signed-out");
      return pass("Settings → Profile → Sign out (this device only); the app is back at its sign-in screen");
    },
  },
];
