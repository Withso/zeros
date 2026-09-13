#!/usr/bin/env node
// Real Changes surface regression: choosing a first endpoint can select a
// different file. The scope menu and its range anchor must remain mounted.
// The model is deterministic; the toolbar, retained viewers and menu are real.
// Run with: node scripts/ui-smoke-changes.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url)).replace(
  /[\\/]$/,
  "",
);
const require = createRequire(`${root}/package.json`);
const { createServer } = await import(require.resolve("vite"));
const { chromium, expect } = require("@playwright/test");
const fixtureId = `${root}/changes-layout-preview.tsx`;
const fixture = `
import '/styles/zeros-tokens.css';
import '/styles/semantic-tokens.css';
import '/styles/globals.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createTwoFilesPatch } from 'diff';
import { TooltipProvider } from '/apps/desktop/src/renderer/shared/ui/primitives/tooltip';
import { ChangesSurface } from '/apps/desktop/src/renderer/shell/workbench/tabs/changes-surface';
import { DiffWorkerPoolProvider } from '/apps/desktop/src/renderer/shell/workbench/diff-worker-pool';
import { PrStatusRow } from '/apps/desktop/src/renderer/shell/pr/pr-status-row';
import { primeWorkspaceFileRead, primeWorkspaceFileDiff } from '/apps/desktop/src/renderer/shell/workspace-file-data-cache';
import { useWorkspaceStore, selectWorkbench } from '/apps/desktop/src/renderer/state/workspace-store';
import { ActionsCtx } from '/apps/desktop/src/renderer/features/agent/sessions-context';
const cwd = '/changes-layout-fixture';
const id = 'changes-layout-fixture';
const paths = ['.gitignore', 'src/renderer/changes-surface.tsx', 'package.json', ...Array.from({length: 36}, (_, i) => 'src/file-' + i + '.ts')];
const files = paths.map(path => {
  const before = path === '.gitignore'
    ? Array.from({length: 260}, (_, i) => 'line ' + (i + 1)).join('\\n') + '\\n'
    : 'node_modules\\n';
  const content = path === '.gitignore'
    ? before.replace('line 30\\n', 'changed line\\n').replace('line 230\\n', 'another change\\n')
    : path === 'package.json'
      ? Array.from({length: 120}, (_, i) => 'Long wrapped source line ' + i + ': ' + 'context '.repeat(35)).join('\\n') + '\\n'
      : 'node_modules\\n# Workspace metadata\\n/.cache/\\ndist/\\n';
  const patch = createTwoFilesPatch(path, path, before, content);
  const fullPatch = createTwoFilesPatch(path, path, before, content, undefined, undefined, {context:10000});
  primeWorkspaceFileRead({cwd, path}, {kind: 'text', path, content});
  for (const diffScope of ['all', 'uncommitted']) {
    const query = {workspaceId:id, path, diffScope, ...(diffScope === 'all' ? {baseBranch:'main'} : {})};
    primeWorkspaceFileDiff(query, patch);
    primeWorkspaceFileDiff({...query, fullContext:true}, fullPatch);
  }
  return {path, patch:path === 'src/renderer/changes-surface.tsx' ? '' : patch, fullPatch, status:'modified', additions:path === '.gitignore' ? 2 : path === 'package.json' ? 120 : 3, deletions:path === '.gitignore' ? 2 : path === 'package.json' ? 1 : 0, committed:false, hash:path, isNewFile:false};
});
const sections = [{kind:'committed', title:null, files}];
const counts = {all:files.length, uncommitted:files.length, staged:0, unstaged:files.length};
const noop = () => {};
window.__changesLayoutModel = () => {
  const [scope, setScope] = React.useState({kind:'all'});
  const [discardTarget, setDiscardTarget] = React.useState(null);
  const [turns, setTurns] = React.useState(() => Array.from({length:205},(_,i)=>({chatId:'chat',turnId:'turn-'+i,ord:205-i,summary:'Agent turn '+i,files:[{path:'a.txt',additions:i+1,deletions:i}],startedAt:205-i})));
  window.__addLatestTurn = () => setTurns(previous => [{...previous[0], turnId:'new-latest', ord:206, startedAt:206, summary:'A new agent turn'}, ...previous]);
  const changeScope = (next) => {
    for (const file of files) {
      const query = {workspaceId:id,path:file.path,diffScope:'history',diffHistory:next,...(next.kind === 'commits' ? {baseBranch:'main'} : {})};
      primeWorkspaceFileDiff(query,file.patch);
      primeWorkspaceFileDiff({...query,fullContext:true},file.fullPatch);
    }
    setScope(next);
  };
  window.__selectedHistory = scope;
  return {scope, setScope:changeScope, turnFilter:null, selectTurnFilter:noop, turns, commits:Array.from({length:75},(_,i)=>({sha:(i+1).toString(16).padStart(4,'0').repeat(10), abbreviatedSha:(i+1).toString(16).padStart(4,'0').repeat(10).slice(0,7),message:'Commit '+i,parents:[],authorName:'Test',authorEmail:'test@example.com',authorDate:0})), sections, effectiveSections:scope.kind === 'all' ? sections : [{...sections[0], files:files.slice(1,2)}], loading:false, error:null, busy:false, discardTarget, setDiscardTarget, runDiscard:noop, changeCounts:counts};
};
const tab = {id:'changes-fixture-tab',type:'changes',title:'Changes',filePath:paths[0],diff:true,diffScope:'all',discardable:true,changesView:'flat'};
useWorkspaceStore.setState({activeChatId:null, newAgentFolder:cwd, workbenchByScope:{[cwd]:{tabs:[tab],activeId:tab.id}}});
window.__ZEROS_NATIVE__ = {invoke: async (cmd) => cmd === 'git_has_changes' ? true : null, on: () => () => {}};
const workspace = {id, path:cwd, branch:'zeros/layout', baseBranch:'main', repoSlug:'fixture', repoRoot:cwd, state:'ready'};
function Fixture() {
 const current = useWorkspaceStore(s=>selectWorkbench(s).tabs[0]);
 const [active, setActive] = React.useState(true);
 const [generation, setGeneration] = React.useState(0);
 window.__setChangesActive = setActive;
 window.__remountChanges = () => setGeneration(value => value + 1);
 return <ActionsCtx.Provider value={{sendPrompt:async()=>{}}}><TooltipProvider><DiffWorkerPoolProvider><div data-zeros-root="" data-changes-active={active} style={{visibility:active?'visible':'hidden'}} className="bg-bg1 text-fg1 flex h-full flex-col"><PrStatusRow workspace={workspace} originUrl="https://github.com/example/fixture.git" active={false}/><ChangesSurface key={generation} tab={current} active={active} scope={cwd} cwd={cwd} workspaceId={id} baseBranch="main" folder={cwd} refreshKey={0} onChanged={noop}/></div></DiffWorkerPoolProvider></TooltipProvider></ActionsCtx.Provider>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 5201, strictPort: true },
  plugins: [
    {
      name: "changes-layout-preview",
      enforce: "pre",
      resolveId(id) {
        if (id === "/changes-layout-preview.tsx") return fixtureId;
      },
      load(id) {
        if (id === fixtureId) return fixture;
      },
      transform(code, id) {
        if (id.endsWith("/workbench/tabs/changes-surface.tsx"))
          return code
            .replace(
              "function ChangesSurface({",
              "export function ChangesSurface({",
            )
            .replace(
              "const model = useChangesModel({",
              "const model = window.__changesLayoutModel({",
            );
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/changes-layout-preview") return next();
          const html = await server.transformIndexHtml(
            req.url,
            '<!doctype html><html class="dark"><head><meta charset="utf-8"/></head><body style="margin:0"><div id="root" style="height:100vh;width:100vw"></div><script type="module" src="/changes-layout-preview.tsx"></script></body></html>',
          );
          res.setHeader("Content-Type", "text/html");
          res.end(html);
        });
      },
    },
  ],
});
await server.listen();
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 700 },
    deviceScaleFactor: 2,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:5201/changes-layout-preview");
  await expect(page.getByTestId("changes-diff-header").first()).toBeVisible();
  // Scrolling must expose the entire final file, including after folding has
  // changed the virtual layout. A visible sliver is not a reachable header.
  const diffScroller = page.locator('div[style*="overflow-anchor: none"]');
  async function reactivateChanges() {
    await page.evaluate(() => window.__setChangesActive(false));
    await expect(page.locator("[data-changes-active]")).toHaveAttribute(
      "data-changes-active",
      "false",
    );
    await page.evaluate(() => window.__setChangesActive(true));
    await expect(page.locator("[data-changes-active]")).toHaveAttribute(
      "data-changes-active",
      "true",
    );
  }
  async function expectPositionRetained() {
    const before = await diffScroller.evaluate((node) => node.scrollTop);
    expect(before).toBeGreaterThan(100);
    await reactivateChanges();
    await expect
      .poll(() => diffScroller.evaluate((node) => node.scrollTop))
      .toBeCloseTo(before, 0);
  }
  await diffScroller.evaluate((node) => {
    node.scrollTop = 1800;
  });
  await expectPositionRetained();
  const beforeRemount = await diffScroller.evaluate((node) => node.scrollTop);
  await page.evaluate(() => window.__remountChanges());
  await expect
    .poll(() => diffScroller.evaluate((node) => node.scrollTop))
    .toBeCloseTo(beforeRemount, 0);
  const finalHeader = page
    .getByTestId("changes-diff-header")
    .filter({ hasText: "src/file-35.ts" });
  async function scrollToBottom() {
    const bounds = await diffScroller.boundingBox();
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    // The scroll extent can grow as wrapped rows are measured by the worker.
    // Repeat the wheel gesture against the current extent, not its first estimate.
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, 100_000);
          return diffScroller.evaluate(
            (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
          );
        },
        { intervals: [100, 200, 500], timeout: 15_000 },
      )
      .toBeLessThanOrEqual(1);
  }
  async function expectFinalHeaderReachable(header = finalHeader) {
    await scrollToBottom();
    await expect(header).toBeVisible();
    // Inspect the actual final code and context control inside the shadow DOM.
    // The host's virtual height alone can pass while its children are clipped.
    await expect
      .poll(async () => {
        const viewport = await diffScroller.boundingBox();
        const bottom = await header.evaluate((node) => {
          const file = node.closest("diffs-container");
          const elements = [
            node,
            file,
            ...file.shadowRoot.querySelectorAll(
              "[data-line], [data-separator]",
            ),
          ];
          return Math.max(
            ...elements.map(
              (element) => element.getBoundingClientRect().bottom,
            ),
          );
        });
        return (
          Math.min(viewport.y + viewport.height, page.viewportSize().height) -
          bottom
        );
      })
      .toBeGreaterThanOrEqual(63);
    await expect(diffScroller).toHaveCSS("scrollbar-width", "none");
    expect(
      await diffScroller.evaluate(
        (node) => getComputedStyle(node, "::-webkit-scrollbar").display,
      ),
    ).toBe("none");
  }
  await expectFinalHeaderReachable();
  await page.getByRole("button", { name: "Collapse all diffs" }).click();
  await expectFinalHeaderReachable();
  await diffScroller.evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.getByRole("button", { name: "Expand .gitignore" }).click();
  await page.getByRole("button", { name: "Expand package.json" }).click();
  await expectFinalHeaderReachable();
  await page.setViewportSize({ width: 760, height: 500 });
  await expectFinalHeaderReachable();
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.getByRole("button", { name: "Collapse all diffs" }).click();
  await diffScroller.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect
    .poll(async () => {
      const headers = page.getByTestId("changes-diff-header");
      const first = await headers.nth(0).boundingBox();
      const second = await headers.nth(1).boundingBox();
      return second.y - first.y - first.height;
    })
    .toBe(0);
  await page.getByRole("button", { name: "Expand all diffs" }).click();
  await page.getByRole("button", { name: "Split diff" }).click();
  await expectFinalHeaderReachable();
  await page.getByRole("button", { name: "Unified diff" }).click();
  await diffScroller.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(
    page.getByRole("button", { name: "Diff", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Preview", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit", exact: true }),
  ).toHaveCount(0);
  const hiddenContext = page.getByText(/unmodified lines/).first();
  await expect(hiddenContext).toBeVisible();
  await expect(page.locator('[data-separator="line-info"]').first()).toHaveCSS(
    "height",
    "24px",
  );
  await expect(
    page.locator("[data-expand-button] [data-icon]").first(),
  ).toHaveCSS("width", "12px");
  const twoArrows = page.locator("[data-separator-multi-button]").first();
  await expect(twoArrows).toBeVisible();
  await expect(twoArrows).toHaveCSS("height", "24px");
  await expect(
    twoArrows.locator("[data-expand-up], [data-expand-down]"),
  ).toHaveCount(2);
  for (const arrow of await twoArrows.locator("[data-icon]").all()) {
    await expect(arrow).toHaveCSS("height", "12px");
  }
  const firstHeader = page.getByTestId("changes-diff-header").first();
  const copy = firstHeader.getByRole("button", { name: "Copy .gitignore" });
  const collapse = firstHeader.getByRole("button", {
    name: "Collapse .gitignore",
  });
  const chevron = collapse.locator("svg.lucide-chevron-down");
  const fileIcon = collapse.locator("span").first();
  await page.mouse.move(0, 0);
  await expect(copy).toHaveCSS("opacity", "0");
  await expect(chevron).toHaveCSS("opacity", "0");
  await expect(fileIcon).toHaveCSS("opacity", "1");
  await firstHeader.hover();
  await expect(copy).toHaveCSS("opacity", "1");
  await expect(chevron).toHaveCSS("opacity", "1");
  await expect(fileIcon).toHaveCSS("opacity", "0");
  await expect(copy.locator("svg")).toHaveCSS("width", "12px");
  await expect(copy.locator("svg")).toHaveCSS("height", "12px");
  const iconBounds = await fileIcon.boundingBox();
  const chevronBounds = await chevron.boundingBox();
  expect(Math.abs(iconBounds.x - chevronBounds.x)).toBeLessThan(1);
  expect(Math.abs(iconBounds.y - chevronBounds.y)).toBeLessThan(1);
  // Background stays on the app canvas even when the header is hovered.
  expect(
    await firstHeader.evaluate((node) => {
      const reference = document.createElement("div");
      reference.style.backgroundColor = "var(--bg1)";
      node.append(reference);
      const matches =
        getComputedStyle(node).backgroundColor ===
        getComputedStyle(reference).backgroundColor;
      reference.remove();
      return matches;
    }),
  ).toBe(true);
  if (process.env.UI_SMOKE_SCREENSHOT)
    await page.screenshot({ path: process.env.UI_SMOKE_SCREENSHOT });
  await hiddenContext.click();
  await expect(page.getByText("line 1", { exact: true }).first()).toBeVisible();
  await firstHeader.hover();
  await copy.click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("changed line");
  await page.mouse.move(0, 0);
  await expect(copy).toHaveCSS("opacity", "0");
  await page.keyboard.press("Shift+Tab");
  await expect(copy).toHaveCSS("opacity", "1");
  await expect(chevron).toHaveCSS("opacity", "1");
  const viewed = page.getByRole("checkbox", { name: "Viewed .gitignore" });
  await viewed.check({ force: true });
  await expect(viewed).toBeChecked();
  await page.getByRole("button", { name: "Collapse .gitignore" }).click();
  await expect(
    page.getByRole("button", { name: "Expand .gitignore" }),
  ).toBeVisible();
  await reactivateChanges();
  await expect(
    page.getByRole("button", { name: "Expand .gitignore" }),
  ).toBeVisible();
  // A real navigation request for the same selected path must still unfold it.
  await page
    .locator('[class~="group/change-row"]')
    .filter({ has: page.getByText(".gitignore", { exact: true }) })
    .click();
  await expect(
    page.getByRole("button", { name: "Collapse .gitignore" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Collapse all diffs" }).click();
  await expect(
    page.getByRole("button", { name: "Expand all diffs" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Expand all diffs" }).click();
  await page.getByRole("button", { name: "Show one file at a time" }).click();
  await expect(page.getByTestId("changes-diff-header")).toHaveCount(1);
  const singleHeader = page.getByTestId("changes-diff-header");
  await expectFinalHeaderReachable(singleHeader);
  await expectPositionRetained();
  await page
    .locator('[data-separator="line-info"] [data-expand-button]:visible')
    .last()
    .click();
  await expectFinalHeaderReachable(singleHeader);
  await expect(page.getByText("line 260", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Split diff" }).click();
  await expectFinalHeaderReachable(singleHeader);
  await page.getByRole("button", { name: "Unified diff" }).click();
  await page
    .locator('[class~="group/change-row"]')
    .filter({ has: page.getByText("package.json", { exact: true }) })
    .click();
  await expect(singleHeader).toContainText("package.json");
  await expectFinalHeaderReachable(singleHeader);
  await diffScroller.focus();
  await page.keyboard.press("Home");
  await expect
    .poll(() => diffScroller.evaluate((node) => node.scrollTop))
    .toBe(0);
  await page.keyboard.press("End");
  await expect
    .poll(() =>
      diffScroller.evaluate(
        (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(1);
  await expectFinalHeaderReachable(singleHeader);
  await page
    .locator('[class~="group/change-row"]')
    .filter({ has: page.getByText("changes-surface.tsx", { exact: true }) })
    .click();
  await expect(
    page
      .getByTestId("changes-diff-header")
      .getByText("src/renderer/changes-surface.tsx", { exact: true }),
  ).toBeVisible();
  // This row starts with metadata only, as large comparisons and restored
  // turns do. A successful fetch must create real code rows, not a loading card.
  await expect(
    page.locator("[data-line]").filter({ hasText: "Workspace metadata" }),
  ).toBeVisible();
  await expect(page.getByText("Loading diff…", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Show all file diffs" }).click();
  await expect
    .poll(() => page.getByTestId("changes-diff-header").count())
    .toBeGreaterThan(1);
  await page
    .getByRole("button", { name: "Changes scope: Branch", exact: true })
    .click();
  const latest = page.getByRole("menuitem", {
    name: "Latest agent turn",
    exact: true,
  });
  await expect(page.getByRole("menuitem").first()).toHaveText(
    "Latest agent turn",
  );
  await expect(
    page.getByRole("menuitem", { name: "Turns", exact: true }),
  ).toHaveCount(0);
  await expect(latest.locator("svg.lucide-git-compare")).toHaveCSS(
    "width",
    "14px",
  );
  await latest.hover();
  await expect(
    page.getByRole("menuitemcheckbox", { name: /^Latest agent turn / }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__selectedHistory)).toEqual({
    kind: "all",
  });
  await latest.click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(await page.evaluate(() => window.__selectedHistory)).toEqual({
    kind: "last-turn",
  });
  const latestScope = page.getByRole("button", {
    name: "Changes scope: Latest agent turn",
    exact: true,
  });
  await expect(latestScope.locator("svg.lucide-git-compare")).toHaveCSS(
    "width",
    "14px",
  );
  await latestScope.click();
  await expect(
    page
      .getByRole("menuitem", { name: "Commits", exact: true })
      .locator("svg.lucide-git-commit-vertical"),
  ).toHaveCSS("width", "14px");
  await page.getByRole("menuitem", { name: /^Branch/ }).click();
  await page
    .getByRole("button", { name: "Changes scope: Branch", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Commits", exact: true }).hover();
  await page
    .getByRole("menuitemcheckbox", { name: "Commit 0", exact: true })
    .click();
  await expect(
    page
      .getByTestId("changes-diff-header")
      .getByText("src/renderer/changes-surface.tsx", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Commit 2", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("menuitemcheckbox", { name: "Commit 2", exact: true })
    .click();
  expect(await page.evaluate(() => window.__selectedHistory)).toEqual({
    kind: "commit-range",
    from: "0003".repeat(10),
    to: "0001".repeat(10),
  });
  const toolbar = page.getByTestId("changes-toolbar");
  expect(
    await toolbar.evaluate((el) => getComputedStyle(el).borderBottomWidth),
  ).toBe("1px");
  expect(
    await page
      .getByRole("menu")
      .first()
      .evaluate((el) => getComputedStyle(el).borderRadius),
  ).toBe("16px");
  expect(
    await page
      .getByRole("menuitemcheckbox", { name: "Commit 0", exact: true })
      .evaluate((el) => getComputedStyle(el).fontSize),
  ).toBe("13px");
  await page
    .getByRole("menuitemcheckbox", { name: "All Commits", exact: true })
    .click();
  expect(await page.evaluate(() => window.__selectedHistory)).toEqual({
    kind: "commits",
  });
  await page.getByRole("menuitem", { name: "… 25 more", exact: true }).click();
  await expect(page.getByRole("menuitemcheckbox")).toHaveCount(76);
  await page
    .getByRole("menuitemcheckbox", { name: "Commit 60", exact: true })
    .click();
  await page
    .getByRole("menuitemcheckbox", { name: "Commit 65", exact: true })
    .click();
  expect(
    await page
      .locator('[role="menuitemcheckbox"][aria-checked="true"]')
      .count(),
  ).toBe(6);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(
    page
      .getByRole("button", { name: /^Changes scope:/ })
      .locator("svg.lucide-git-commit-vertical"),
  ).toHaveCSS("width", "14px");
  await page.getByRole("button", { name: /^Changes scope:/ }).click();
  await latest.hover();
  await page
    .getByRole("menuitemcheckbox", { name: "All Turns", exact: true })
    .click();
  expect(await page.evaluate(() => window.__selectedHistory)).toEqual({
    kind: "turns",
  });
  while (await page.getByRole("menuitem", { name: /… \d+ more/ }).count())
    await page.getByRole("menuitem", { name: /… \d+ more/ }).click();
  await expect(page.getByRole("menuitemcheckbox")).toHaveCount(206);
  const first = page.getByRole("menuitemcheckbox", {
    name: /^Agent turn 201 /,
  });
  const last = page.getByRole("menuitemcheckbox", { name: /^Agent turn 204 / });
  await first.click();
  await last.click();
  expect(await page.evaluate(() => window.__selectedHistory)).toEqual({
    kind: "turn-range",
    from: { chatId: "chat", turnId: "turn-204" },
    to: { chatId: "chat", turnId: "turn-201" },
  });
  const spacing = await last.evaluate((el) => {
    const spans = el.querySelectorAll(":scope > span");
    return {
      box: spans[0].getBoundingClientRect().left,
      stat: spans[spans.length - 1].getBoundingClientRect().right,
    };
  });
  expect(spacing.stat).toBeLessThan(spacing.box);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(
    page
      .getByRole("button", { name: /^Changes scope:/ })
      .locator("svg.lucide-git-compare"),
  ).toHaveCSS("width", "14px");
  await page.getByRole("button", { name: /^Changes scope:/ }).focus();
  await page.keyboard.press("Enter");
  await latest.focus();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => window.__selectedHistory)).toEqual({
    kind: "last-turn",
  });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(latestScope).toBeFocused();
  await latestScope.press("Enter");
  await expect(latest).toBeFocused();
  await latest.press("ArrowRight");
  const newestTurn = page.getByRole("menuitemcheckbox", {
    name: /^Latest agent turn /,
  });
  await expect(newestTurn).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemcheckbox", { name: /^Agent turn 1 / }).click();
  expect(await page.evaluate(() => window.__selectedHistory)).toEqual({
    kind: "turn-range",
    from: { chatId: "chat", turnId: "turn-1" },
    to: { chatId: "chat", turnId: "turn-1" },
  });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", {
      name: "Changes scope: Agent turn 1",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Changes scope:/ }).click();
  await latest.hover();
  await newestTurn.click();
  expect(await page.evaluate(() => window.__selectedHistory)).toEqual({
    kind: "last-turn",
  });
  await page.getByRole("menuitemcheckbox", { name: /^Agent turn 2 / }).click();
  expect(await page.evaluate(() => window.__selectedHistory)).toEqual({
    kind: "turn-range",
    from: { chatId: "chat", turnId: "turn-2" },
    to: { chatId: "chat", turnId: "turn-0" },
  });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Changes scope:/ }).click();
  await latest.focus();
  await latest.press("Space");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.evaluate(() => window.__addLatestTurn());
  await expect(latestScope).toBeVisible();
  await latestScope.click();
  await latest.hover();
  await expect(newestTurn).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("menuitemcheckbox", { name: /^Agent turn 0 / }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(
    page.getByRole("menuitemcheckbox", { name: /^A new agent turn/ }),
  ).toHaveCount(0);
  console.log(
    "Changes smoke passed: all-file and focused diff modes, wheel/keyboard scrolling to final lines with end spacing and hidden scrollbars, per-file copy/viewed/folding, native context expansion, inclusive history ranges, and toolbar/menu geometry.",
  );
} finally {
  await browser.close();
  await server.close();
}
