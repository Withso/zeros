// Browser → real renderer model/bridge → WorkspaceService → real Git/SQLite.
// Run: TMPDIR=/private/tmp node --import tsx scripts/ui-smoke-changes-history.mts
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceService } from "../apps/desktop/src/engine/workspace/service";
import {
  closeState,
  createWorkspace,
  setStateRootForTesting,
} from "../apps/desktop/src/engine/git";
import { finishTurn, startTurn } from "../apps/desktop/src/engine/db/turns";
import {
  snapshotRef,
  snapshotWorkingTree,
} from "../apps/desktop/src/engine/git/turns-git";

const project = fileURLToPath(new URL("../", import.meta.url)).replace(
  /\/$/,
  "",
);
const temp = await mkdtemp(path.join(tmpdir(), "zeros-history-ui-"));
const exec = promisify(execFile);
let cwd = path.join(temp, "repo");
const git = async (...args: string[]) =>
  (await exec("git", args, { cwd })).stdout.trim();
const write = (name: string, body: string) =>
  writeFile(path.join(cwd, name), body);
const commit = async (message: string) => {
  await git("add", ".");
  await git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
};
await mkdir(cwd);
setStateRootForTesting(path.join(temp, "state"));
await git("init", "-q", "-b", "main");
await git("config", "user.email", "test@example.com");
await git("config", "user.name", "Test");
await git("remote", "add", "origin", "https://example.com/history.git");
await write("alpha.txt", "original alpha\n");
await write("beta.txt", "original beta\n");
await commit("Initial");
const repoRoot = cwd;
const workspace = await createWorkspace({ repoRoot });
cwd = workspace.path;
const workspaceId = workspace.workspaceId;
const service = new WorkspaceService(repoRoot);
const record = async (
  id: string,
  startedAt: number,
  file: string,
  body: string,
) => {
  const preSnapshot = await snapshotWorkingTree(
    cwd,
    snapshotRef("chat", id, "pre"),
  );
  await write(file, body);
  const postSnapshot = await snapshotWorkingTree(
    cwd,
    snapshotRef("chat", id, "post"),
  );
  startTurn({
    chatId: "chat",
    turnId: id,
    workspaceId,
    folder: cwd,
    agentId: null,
    summary: id,
    startedAt,
    preSnapshot,
  });
  finishTurn("chat", id, {
    endedAt: startedAt + 1,
    status: "completed",
    stopReason: "end_turn",
    postSnapshot,
    files: [{ path: file, status: "modified", additions: 1, deletions: 1 }],
  });
};
await record("Alpha turn", 1, "alpha.txt", "agent alpha\n");
const firstCommit = await commit("Alpha commit");
await git("branch", "after-alpha");
await record("Beta turn", 2, "beta.txt", "agent beta\n");
const lastCommit = await commit("Beta commit");
await write("alpha.txt", "staged alpha\n");
await git("add", "alpha.txt");
await write("alpha.txt", "working alpha\n");
let failDiff = false;
let failMenus = false;
const requests: Array<{ op: string; params: Record<string, unknown> }> = [];
const fixtureId = `${project}/changes-history-fixture.tsx`;
const fixture = `
import '/styles/zeros-tokens.css';
import '/styles/semantic-tokens.css';
import '/styles/globals.css';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChangesSurface} from '/apps/desktop/src/renderer/shell/workbench/tabs/changes-surface';
import {TooltipProvider} from '/apps/desktop/src/renderer/shared/ui/primitives/tooltip';
import {ActionsCtx} from '/apps/desktop/src/renderer/features/agent/sessions-context';
import {useWorkspaceStore,selectWorkbench} from '/apps/desktop/src/renderer/state/workspace-store';
import {setActiveBridge} from '/apps/desktop/src/renderer/platform/bridge/active-bridge';
import {useGitRefreshKey,triggerGitRefresh} from '/apps/desktop/src/renderer/shell/use-git-refresh-key';
import {getChangesFilter} from '/apps/desktop/src/renderer/shell/workbench/tabs/changes-filter-store';
import {setChangesSidebarVisible} from '/apps/desktop/src/renderer/shell/workbench/tabs/changes-sidebar-visible';
const cwd=${JSON.stringify(cwd)}, workspaceId=${JSON.stringify(workspaceId)};
setChangesSidebarVisible(false);
setActiveBridge({request:async(message)=>fetch('/history-rpc',{method:'POST',body:JSON.stringify(message)}).then(r=>r.json()),on:()=>()=>{},onStatusChange:()=>()=>{},status:'connected'});
const tab={id:'changes-history',type:'changes',title:'Changes'};
useWorkspaceStore.setState({activeChatId:null,newAgentFolder:cwd,workbenchByScope:{[cwd]:{tabs:[tab],activeId:tab.id}}});
window.__historyScope=()=>getChangesFilter(workspaceId).scope;
window.__refreshHistory=()=>triggerGitRefresh(cwd);
function Fixture(){
  const tab=useWorkspaceStore(s=>selectWorkbench(s).tabs[0]);
  const [baseBranch,setBaseBranch]=React.useState('main');
  window.__setHistoryBase=setBaseBranch;
  const refreshKey=useGitRefreshKey(cwd,workspaceId,true);
  return <ActionsCtx.Provider value={{sendPrompt:async()=>{}}}><TooltipProvider><div className="bg-bg1 text-fg1 h-full"><ChangesSurface tab={tab} active scope={cwd} cwd={cwd} workspaceId={workspaceId} baseBranch={baseBranch} folder={cwd} refreshKey={refreshKey} onChanged={()=>triggerGitRefresh(cwd)}/></div></TooltipProvider></ActionsCtx.Provider>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const server = await createServer({
  root: project,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "changes-real-history-fixture",
      enforce: "pre",
      resolveId(id) {
        if (id === "/changes-history-fixture.tsx") return fixtureId;
      },
      load(id) {
        if (id === fixtureId) return fixture;
      },
      transform(code, id) {
        if (id.endsWith("/tabs/changes-surface.tsx"))
          return code.replace(
            "function ChangesSurface({",
            "export function ChangesSurface({",
          );
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url === "/history-rpc") {
            try {
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              const { op, params } = JSON.parse(
                Buffer.concat(chunks).toString(),
              );
              requests.push({ op, params });
              if (failDiff && op === "git.diff")
                throw new Error("History fixture temporarily unavailable");
              if (failMenus && (op === "git.log" || op === "turns.list"))
                throw new Error("History menu temporarily unavailable");
              const result = await service.handle(op, params);
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({ type: "WORKSPACE_RESPONSE", op, result }),
              );
            } catch (error) {
              res.end(
                JSON.stringify({
                  type: "WORKSPACE_ERROR",
                  code: "GIT_COMMAND_FAILED",
                  message: String(error),
                }),
              );
            }
            return;
          }
          if (req.url !== "/history-fixture") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<!doctype html><html class="dark"><head><meta charset="utf-8"></head><body style="margin:0"><div id="root" style="height:100vh"></div><script type="module" src="/changes-history-fixture.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 720 },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${server.resolvedUrls!.local[0]}history-fixture`);
  const trigger = page.getByRole("button", { name: /^Changes scope:/ });
  const hasDiff = async (expected: string) => {
    // Playwright pierces @pierre/diffs' open shadow roots for visible content.
    await expect(
      page.getByText(expected, { exact: true }).last(),
    ).toBeVisible();
  };
  const choose = async (name: string) => {
    await trigger.click();
    await page
      .getByRole("menuitem", { name: new RegExp(`^${name}(?:\\s|$)`) })
      .click();
  };
  const selectFile = async (name: string) => {
    await page.getByRole("button", { name: "Show changes list" }).click();
    await page
      .locator('[class~="group/change-row"]')
      .filter({ has: page.getByText(name, { exact: true }) })
      .click();
    await page.getByRole("button", { name: "Hide changes list" }).click();
  };
  await expect(trigger).toHaveAccessibleName("Changes scope: Branch");
  await hasDiff("working alpha");
  await choose("Latest agent turn");
  await hasDiff("agent beta");
  expect(
    requests.some(
      (r) =>
        r.op === "git.diff" &&
        (r.params.history as { kind?: string })?.kind === "last-turn",
    ),
  ).toBe(true);
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Latest agent turn", exact: true })
    .hover();
  await page.getByRole("menuitemcheckbox", { name: /^Alpha turn/ }).click();
  await hasDiff("agent alpha");
  await page
    .getByRole("menuitemcheckbox", { name: /^Latest agent turn / })
    .click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => window.__historyScope())).toEqual({
    kind: "turn-range",
    from: { chatId: "chat", turnId: "Alpha turn" },
    to: { chatId: "chat", turnId: "Beta turn" },
  });
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Latest agent turn", exact: true })
    .hover();
  await page
    .getByRole("menuitemcheckbox", { name: "All Turns", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await hasDiff("agent alpha");
  await trigger.click();
  await page.getByRole("menuitem", { name: "Commits", exact: true }).hover();
  await page
    .getByRole("menuitemcheckbox", { name: "Beta commit", exact: true })
    .click();
  await hasDiff("agent beta");
  await page
    .getByRole("menuitemcheckbox", { name: "Alpha commit", exact: true })
    .click();
  expect(await page.evaluate(() => window.__historyScope())).toEqual({
    kind: "commit-range",
    from: firstCommit,
    to: lastCommit,
  });
  await page
    .getByRole("menuitemcheckbox", { name: "All Commits", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await selectFile("alpha.txt");
  await hasDiff("agent alpha");
  await page.evaluate(() => window.__setHistoryBase("after-alpha"));
  await hasDiff("agent beta");
  await page.evaluate(() => window.__setHistoryBase("main"));
  await choose("Branch");
  await selectFile("alpha.txt");
  await hasDiff("original alpha");
  await page.evaluate(() => window.__setHistoryBase("after-alpha"));
  await hasDiff("agent alpha");
  await expect(
    page.getByText("original alpha", { exact: true }).filter({ visible: true }),
  ).toHaveCount(0);
  await page.evaluate(() => window.__setHistoryBase("main"));
  for (const [scope, content] of [
    ["Staged", "staged alpha"],
    ["Unstaged", "working alpha"],
    ["Uncommitted", "working alpha"],
  ]) {
    await choose(scope);
    await hasDiff(content);
  }
  await choose("Latest agent turn");
  await hasDiff("agent beta");
  await record("New turn", 3, "beta.txt", "newest agent beta\n");
  await page.evaluate(() => window.__refreshHistory());
  await hasDiff("newest agent beta");
  failMenus = true;
  await page.evaluate(() => window.__refreshHistory());
  await trigger.click();
  await page.getByRole("menuitem", { name: "Commits", exact: true }).hover();
  await expect(page.getByRole("alert")).toContainText(
    "History menu temporarily unavailable",
  );
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Alpha commit", exact: true }),
  ).toBeVisible();
  failMenus = false;
  await page.getByRole("button", { name: "Retry commit history" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  failDiff = true;
  await page.evaluate(() => window.__refreshHistory());
  await expect(page.getByRole("alert")).toContainText(
    "temporarily unavailable",
  );
  await hasDiff("newest agent beta");
  failDiff = false;
  await page.getByRole("button", { name: "Retry changes" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await git("reset", "--hard", "HEAD");
  await choose("Staged");
  await page.evaluate(() => window.__refreshHistory());
  await expect(
    page.getByText("No staged changes", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    "PASS real Changes model, bridge, history ranges, index scopes, live latest turn, error recovery and empty state",
  );
} finally {
  await browser.close();
  await server.close();
  closeState();
  setStateRootForTesting(null);
  await rm(temp, { recursive: true, force: true });
}
