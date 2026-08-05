#!/usr/bin/env node
// ============================================================
// Composer + GitHub settings UI smoke — real-browser interaction contract
//
// Boots the Vite dev server, opens the ModelPill harness page
// (the colocated harness-model-menu HTML/TSX entry pair — the real
// ModelPill/AgentModelMenu tree with the agent-chat "always focused
// composer" guardian wired in), then the real GitHub settings section, and
// drives both with headless Chromium.
//
// This exists because the 2026-07-24 "model dropdown flashes open and
// instantly closes" regression was invisible to every other gate: the
// vitest suite only covers pure helpers (no DOM), and the visual
// harness only screenshots static routes. The failure was an event-
// timing interaction (document-capture click listener + microtask vs
// Radix's open/focus sequence) that only a real browser reproduces.
//
// Contract asserted here:
//   1. Clicking the pill OPENS the menu, and it STAYS open (no
//      guardian-induced instant dismiss).
//   2. Clicking a model row selects it (onChange fires) and closes
//      the menu.
//   3. The menu can be re-opened after closing (no toggle desync).
//   4. No uncaught page errors anywhere in the run.
//   5. The GitHub method overflow obeys click/Escape focus semantics.
//   6. Its disconnect dialog itemizes consequences, initially focuses Cancel,
//      closes with Escape, and returns focus to the originating trigger.
//   7. A confirmed-empty GitHub App inventory exposes a recovery CTA whose IPC
//      request explicitly forces the installation URL.
//   8. Edit and turn-footer diff hover previews open, survive pointer travel,
//      support keyboard focus, and never attach themselves to Read rows.
//   9. File/diff reading surfaces wrap long lines, keep 450×350 hover geometry,
//      and never expose horizontal scrolling.
//  10. Design workspaces keep their native canvas/sidebar contract and never
//      mount a coding-agent chat.
//  11. File Edit mode hangs soft-wrapped continuation rows at the line's own
//      indentation instead of dropping them to column 0.
//  12. The Files-tab tree keeps its indent guides visible without hover and
//      nests ~15.5px per level.
//  13. The collapsed Files tab's floating tree popup wears the popover recipe
//      (inset + rounded + shadow, quick-open search row, padded list),
//      freezes its open-time height across container resizes, re-measures on
//      reopen, keeps its filter input focused through tree clicks, and
//      dismisses on file-open / double Escape / outside pointerdown while the
//      trigger stays a toggle.
//  14. A file editor is ALREADY syntax-colored on its first painted frame, with
//      the code theme's own base foreground — the "opens white, then repaints"
//      flash. Only a real browser can prove this: the editor is mounted inside
//      flushSync (CodeMirror's creating layout effect runs before paint) and the
//      DOM is inspected in that same task, so no paint can have intervened.
//
// Usage:  node scripts/ui-smoke-composer.mjs   (pnpm test:ui-smoke)
// ============================================================

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

import { runDesignWorkspaceSmoke } from "./ui-smoke-design-workspace.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function freePort() {
  return new Promise((resolveFn, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolveFn(port));
    });
    srv.on("error", reject);
  });
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`vite dev server did not answer at ${url}`);
}

const failures = [];
function check(name, ok, detail = "") {
  const mark = ok ? "ok" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

const port = await freePort();
// detached → its own process GROUP, so teardown can kill pnpm AND the vite
// child it execs. Killing just the wrapper leaves vite alive holding our
// stdio pipes — node then never exits and the run hangs after "all checks
// passed" (observed here and it would hang the CI job the same way).
const vite = spawn(
  "pnpm",
  ["exec", "vite", "--port", String(port), "--strictPort"],
  {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    detached: true,
  },
);
vite.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));

let browser = null;
try {
  const harnessBase = `http://127.0.0.1:${port}/apps/desktop/src/renderer/harnesses`;
  const pageUrl = `${harnessBase}/harness-model-menu.html`;
  await waitForHttp(pageUrl);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const consoleLines = [];
  const pageErrors = [];
  page.on("console", (msg) => consoleLines.push(msg.text()));
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto(pageUrl, { waitUntil: "networkidle" });
  const pill = page.locator('[data-testid="pill-host"] button').first();
  await pill.waitFor({ state: "visible", timeout: 10_000 });

  const menuOpen = () =>
    page.evaluate(() => !!document.querySelector("[cmdk-root]"));
  // Poll-based waits, NOT fixed sleeps: CI machines (and this sandbox under
  // parallel test load) stretch event timing enough that a 150-300ms sleep
  // flakes while the behavior is correct. `waitFor` polls to a generous
  // deadline and returns as soon as the condition holds.
  const waitFor = async (fn, label, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  // 1. Open — and survive the guardian (the 2026-07-24 regression closed it
  //    within one macrotask of opening).
  await pill.click();
  check("menu opens on pill click", await waitFor(menuOpen, "open"));
  // The regression dismissed the menu within ~1 macrotask; give any late
  // dismiss path ample room to fire before asserting stability.
  await page.waitForTimeout(600);
  check("menu stays open (no guardian dismiss)", await menuOpen());
  const rowCount = await page.locator("[cmdk-item]").count();
  check("menu lists models", rowCount > 0, `${rowCount} rows`);

  // 2. Selecting a row fires onChange and closes the menu. Row 0 is the
  //    current model (harness default), so pick the second row for a real
  //    change; the harness logs "[harness] onChange <value>".
  const targetRow = page.locator("[cmdk-item]").nth(Math.min(1, rowCount - 1));
  await targetRow.click();
  check(
    "selecting a row closes the menu",
    await waitFor(async () => !(await menuOpen()), "close-on-select"),
  );
  check(
    "selection reaches onChange",
    consoleLines.some((l) => l.includes("[harness] onChange")),
  );

  // 3. Re-open after close — catches open-state desync between the pill's
  //    controlled state and Radix's internal toggle. Wait for focus to land
  //    in the search input (Radix's focus scope settles async) before
  //    sending Escape, mirroring what a real user's key press would meet.
  await pill.click();
  check("menu re-opens after a selection", await waitFor(menuOpen, "reopen"));
  await waitFor(
    () => page.evaluate(() => document.activeElement?.tagName === "INPUT"),
    "search-focus",
  );
  await page.keyboard.press("Escape");
  check(
    "Escape closes the menu",
    await waitFor(async () => !(await menuOpen()), "esc-close"),
  );

  // The design surface owns a separate harness contract and deliberately has
  // no coding-agent chat mounted.
  await runDesignWorkspaceSmoke({ page, waitFor, check });

  // 4. Diff previews use a hover portal around an already-clickable row/pill.
  // Drive the real components so Slot handler composition and pointer travel
  // into the portal cannot regress unnoticed.
  await page.goto(`${harnessBase}/harness-diff-preview.html`, {
    waitUntil: "networkidle",
  });
  const preview = page.locator("[data-agent-diff-preview]");
  const placementEditRow = page
    .locator('[data-testid="placement-edit-host"] button')
    .first();
  await placementEditRow.hover();
  const placementPreview = page.locator(
    '[aria-label="Diff preview for src/placement.ts"]',
  );
  check(
    "A preview that would cross the transcript top opens below its pill",
    await waitFor(
      () =>
        placementPreview
          .evaluate(
            (section) =>
              section.parentElement?.getAttribute("data-side") === "bottom",
          )
          .catch(() => false),
      "top-boundary-placement",
    ),
  );
  await page.getByTestId("parking-lot").hover();
  await waitFor(
    async () => !(await placementPreview.isVisible().catch(() => false)),
    "placement-preview-close",
  );
  await page.getByTestId("placement-edit-host").evaluate((host) => {
    if (host instanceof HTMLElement) host.style.top = "180px";
  });
  await placementEditRow.hover();
  check(
    "The same preview stays above its pill when it clears the transcript top",
    await waitFor(
      () =>
        placementPreview
          .evaluate(
            (section) =>
              section.parentElement?.getAttribute("data-side") === "top",
          )
          .catch(() => false),
      "clear-top-placement",
    ),
  );
  await page.getByTestId("parking-lot").hover();
  await waitFor(
    async () => !(await placementPreview.isVisible().catch(() => false)),
    "clear-top-preview-close",
  );
  const editRow = page.locator('[data-testid="edit-host"] button').first();
  const editPreview = page.locator(
    '[aria-label="Diff preview for src/shared.ts"]',
  );
  await editRow.waitFor({ state: "visible", timeout: 10_000 });
  // Enter at the row's leading edge so the just-closed placement fixture's
  // exit-animation box cannot intercept the pointer over the wide filename.
  await editRow.hover({ position: { x: 8, y: 8 } });
  check(
    "Edit hover opens its diff preview",
    await waitFor(
      () => editPreview.isVisible().catch(() => false),
      "edit-hover",
    ),
  );
  // offset geometry ignores Radix's short opening scale transform and verifies
  // the settled layout box the user actually receives.
  const editBox = await editPreview.evaluate((section) => ({
    width:
      section.parentElement instanceof HTMLElement
        ? section.parentElement.offsetWidth
        : 0,
    height: section instanceof HTMLElement ? section.offsetHeight : 0,
  }));
  check(
    "Edit preview uses the fixed 450px width",
    editBox.width === 450,
    `${editBox.width}px`,
  );
  check(
    "Edit preview stays within the 350px height cap",
    editBox.height <= 350,
    `${editBox.height}px`,
  );
  const editScroll = await editPreview
    .locator(":scope > div")
    .last()
    .evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
  check(
    "Edit preview wraps without horizontal overflow",
    editScroll.scrollWidth <= editScroll.clientWidth + 1,
    `${editScroll.scrollWidth}/${editScroll.clientWidth}`,
  );
  check(
    "Edit preview retains vertical scrolling for long changes",
    editScroll.scrollHeight > editScroll.clientHeight,
    `${editScroll.scrollHeight}/${editScroll.clientHeight}`,
  );
  await editPreview.hover();
  await page.waitForTimeout(500);
  check(
    "Edit preview stays open across trigger-to-card travel",
    await editPreview.isVisible().catch(() => false),
  );
  await page.mouse.move(899, 699);
  check(
    "Edit preview closes after leaving it",
    await waitFor(
      async () => !(await editPreview.isVisible().catch(() => false)),
      "edit-hover-close",
    ),
  );

  const readRow = page.locator('[data-testid="read-host"] button').first();
  await readRow.hover();
  await page.waitForTimeout(500);
  check(
    "Read rows have no diff hover preview",
    !(await preview.isVisible().catch(() => false)),
  );

  const footerPill = page.locator('[data-testid="footer-host"] button').first();
  await footerPill.focus();
  const footerPreview = page.locator(
    '[aria-label="Diff preview for src/footer-preview.ts"]',
  );
  check(
    "Footer diff pill opens from keyboard focus",
    await waitFor(
      () => footerPreview.isVisible().catch(() => false),
      "footer-focus-preview",
    ),
  );
  check(
    "Footer preview identifies the exact file",
    (await footerPreview.textContent()).includes("src/footer-preview.ts"),
  );
  const footerBox = await footerPreview.evaluate((section) => ({
    width:
      section.parentElement instanceof HTMLElement
        ? section.parentElement.offsetWidth
        : 0,
    height: section instanceof HTMLElement ? section.offsetHeight : 0,
  }));
  check(
    "Footer preview uses the fixed 450px width",
    footerBox.width === 450,
    `${footerBox.width}px`,
  );
  check(
    "Footer preview stays within the 350px height cap",
    footerBox.height <= 350,
    `${footerBox.height}px`,
  );
  check(
    "Footer filename header uses bg1 above the Changes-matched diff surface",
    await footerPreview.evaluate((section) => {
      const header = section.firstElementChild;
      const body = header?.nextElementSibling;
      if (!(header instanceof HTMLElement) || !(body instanceof HTMLElement))
        return false;
      const bg1Probe = document.createElement("div");
      const changesProbe = document.createElement("div");
      bg1Probe.style.backgroundColor = "var(--bg1)";
      changesProbe.style.backgroundColor = "var(--sidebar-bg)";
      document.body.append(bg1Probe, changesProbe);
      const matches =
        getComputedStyle(header).backgroundColor ===
          getComputedStyle(bg1Probe).backgroundColor &&
        getComputedStyle(body).backgroundColor ===
          getComputedStyle(changesProbe).backgroundColor;
      bg1Probe.remove();
      changesProbe.remove();
      return matches;
    }),
  );
  const footerScroll = await footerPreview
    .locator(":scope > div")
    .last()
    .evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
  check(
    "Footer preview wraps without horizontal overflow",
    footerScroll.scrollWidth <= footerScroll.clientWidth + 1,
    `${footerScroll.scrollWidth}/${footerScroll.clientWidth}`,
  );
  check(
    "Footer preview retains vertical scrolling for long changes",
    footerScroll.scrollHeight > footerScroll.clientHeight,
    `${footerScroll.scrollHeight}/${footerScroll.clientHeight}`,
  );
  await page.getByTestId("parking-lot").focus();

  // The expanded transcript reuses the same wrapped renderer without inheriting
  // the hover portal's fixed width.
  await editRow.click();
  const inlinePreview = page.locator(
    '[aria-label="Diff preview for src/shared.ts"]:visible',
  );
  check(
    "Expanded Edit transcript wraps without horizontal overflow",
    await waitFor(
      () =>
        inlinePreview
          .locator(":scope > div")
          .last()
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
          .catch(() => false),
      "inline-edit-wrap",
    ),
  );

  check(
    "File Edit mode enables CodeMirror line wrapping",
    await page
      .locator('[data-testid="file-editor-host"] .cm-content')
      .evaluate((el) => el.classList.contains("cm-lineWrapping"))
      .catch(() => false),
  );
  check(
    "File Edit mode has no horizontal overflow",
    await page
      .locator('[data-testid="file-editor-host"] .cm-scroller')
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
      .catch(() => false),
  );
  // Hanging indent for soft-wrapped lines: every continuation row of an
  // indented line must start at the line's own indent, not at column 0
  // (the wrapped-JSON-description regression). The fixture's second line is
  // indented 6 spaces and long enough to wrap in the 450px host.
  const hang = await page
    .locator('[data-testid="file-editor-host"] .cm-line')
    .nth(1)
    .evaluate((line) => {
      const cs = getComputedStyle(line);
      const paddingLeft = parseFloat(cs.paddingLeft);
      const textIndent = parseFloat(cs.textIndent);
      // One rect per (span × visual row) fragment; the minimum left per row is
      // where that visual row's text actually starts.
      const range = document.createRange();
      range.selectNodeContents(line);
      const rows = [];
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0) continue;
        const row = rows.find((r) => Math.abs(r.top - rect.top) < 2);
        if (row) row.left = Math.min(row.left, rect.left);
        else rows.push({ top: rect.top, left: rect.left });
      }
      rows.sort((a, b) => a.top - b.top);
      return { paddingLeft, textIndent, rowLefts: rows.map((r) => r.left) };
    })
    .catch(() => null);
  check(
    "File Edit fixture's indented line wraps",
    (hang?.rowLefts.length ?? 0) >= 2,
    `${hang?.rowLefts.length ?? 0} visual rows`,
  );
  check(
    "Wrapped rows hang at the line's own indent",
    hang !== null &&
      hang.textIndent < 0 &&
      Math.abs(hang.paddingLeft + hang.textIndent - 6) < 0.5,
    `padding-left ${hang?.paddingLeft}px, text-indent ${hang?.textIndent}px`,
  );
  check(
    "Continuation rows align with row 1's indent point",
    hang !== null &&
      hang.rowLefts.length >= 2 &&
      Math.abs(hang.rowLefts[1] - (hang.rowLefts[0] - hang.textIndent)) < 1,
    `row lefts ${hang?.rowLefts.map((x) => x.toFixed(1)).join(", ")}`,
  );
  // FIRST PAINT in the code theme. The reported bug was a file opening with
  // chrome-white text that then repainted into the theme. The fixture mounts the
  // real editor inside flushSync and we read the DOM in that same task — the
  // browser cannot have painted in between, so what we see here IS the first
  // frame the user would see.
  const firstPaint = await page
    .evaluate(async () => {
      const themeFg = await window.__zerosFirstPaintEditor();
      const host = document.querySelector(
        '[data-testid="file-editor-first-paint-host"]',
      );
      const content = host?.querySelector(".cm-content") ?? null;
      const colored = host
        ? host.querySelectorAll('.cm-content span[style*="color"]')
        : [];
      const distinct = new Set();
      for (const span of colored) {
        const declared = /color:\s*([^;]+)/.exec(span.getAttribute("style"));
        if (declared) distinct.add(declared[1].trim().toLowerCase());
      }
      const expected = themeFg
        ? (() => {
            const probe = document.createElement("span");
            probe.style.color = themeFg;
            document.body.appendChild(probe);
            const resolved = getComputedStyle(probe).color;
            probe.remove();
            return resolved;
          })()
        : "";
      return {
        mounted: content !== null,
        coloredSpans: colored.length,
        distinctColors: distinct.size,
        baseColor: content ? getComputedStyle(content).color : "",
        expectedBaseColor: expected,
      };
    })
    .catch((err) => ({ error: String(err) }));
  check(
    "File editor exists on its first paint (mounted before the browser paints)",
    firstPaint?.mounted === true,
    firstPaint?.error ?? "",
  );
  check(
    "File editor is syntax-colored on its FIRST paint (no unthemed flash)",
    (firstPaint?.coloredSpans ?? 0) > 5,
    `${firstPaint?.coloredSpans ?? 0} colored spans`,
  );
  check(
    "First paint carries real token variety, not one flat color",
    (firstPaint?.distinctColors ?? 0) >= 3,
    `${firstPaint?.distinctColors ?? 0} distinct token colors`,
  );
  check(
    "Editor base foreground is the code theme's own, not the app --fg1",
    Boolean(firstPaint?.expectedBaseColor) &&
      firstPaint.baseColor === firstPaint.expectedBaseColor,
    `${firstPaint?.baseColor} vs theme ${firstPaint?.expectedBaseColor}`,
  );

  check(
    "Markdown Preview wraps unbroken text and code",
    await page
      .getByTestId("markdown-preview-host")
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  );

  // The Files-tab tree (real WorkspaceFileTree over a primed listing). Park
  // the pointer far from the tree first: the library only paints indent
  // guides under :host(:hover), so measuring them un-hovered is the contract.
  await page.mouse.move(880, 10);
  await page
    .locator(
      '[data-testid="file-tree-host"] [data-item-path="artifacts/api-server/src/index.ts"]',
    )
    .waitFor({ state: "visible", timeout: 10_000 });
  const tree = await page
    .getByTestId("file-tree-host")
    .evaluate((host) => {
      let shadow = null;
      for (const el of host.querySelectorAll("*")) {
        if (el.shadowRoot) {
          shadow = el.shadowRoot;
          break;
        }
      }
      if (!shadow) return null;
      const iconLeft = (path) => {
        const icon = shadow.querySelector(
          `[data-item-path="${path}"] > [data-item-section='icon']`,
        );
        return icon ? icon.getBoundingClientRect().left : null;
      };
      // The pre-selected depth-3 file keeps this chain expanded: one icon
      // x-position per depth, so consecutive deltas are the per-level step.
      const chain = [
        "artifacts/",
        "artifacts/api-server/",
        "artifacts/api-server/src/",
        "artifacts/api-server/src/index.ts",
      ];
      const lefts = chain.map(iconLeft);
      const guide = shadow.querySelector("[data-item-section='spacing-item']");
      return {
        lefts,
        steps: lefts
          .slice(1)
          .map((left, i) =>
            left !== null && lefts[i] !== null ? left - lefts[i] : null,
          ),
        guideOpacity: guide ? getComputedStyle(guide).opacity : null,
      };
    })
    .catch(() => null);
  check(
    "File tree renders the expanded fixture chain",
    tree !== null && tree.lefts.every((x) => x !== null),
    `icon lefts ${tree?.lefts.map((x) => x?.toFixed(1)).join(", ")}`,
  );
  check(
    "File tree nests ~15.5px per level (tightened from ~21.5px)",
    tree !== null && tree.steps.every((s) => s !== null && s >= 13 && s <= 17),
    `steps ${tree?.steps.map((s) => s?.toFixed(1)).join(", ")}`,
  );
  check(
    "File tree indent guides stay visible without hover",
    tree?.guideOpacity === "0.75",
    `opacity ${tree?.guideOpacity}`,
  );

  // The collapsed Files tab's floating tree POPUP (FilesTreePanel over the
  // same primed listing). Real-browser contract: popover geometry captured at
  // open time, focus locked to the filter input across shadow-DOM tree
  // clicks, and the popup's dismissal surface (file open, Escape, outside
  // pointerdown, trigger toggle).
  const treePanelTrigger = page.getByTestId("tree-panel-trigger");
  const treePanel = page.locator('[data-testid="files-tree-panel"]');
  const treePanelInput = page.locator(
    '[data-testid="files-tree-panel"] input[aria-label="Search workspace files"]',
  );
  const treePanelVisible = () => treePanel.isVisible().catch(() => false);
  const treePanelHidden = () =>
    treePanel
      .isVisible()
      .then((v) => !v)
      .catch(() => true);
  const treePanelInputFocused = () =>
    treePanelInput
      .evaluate((el) => el === document.activeElement)
      .catch(() => false);

  await treePanelTrigger.click();
  check(
    "Tree panel opens from its trigger",
    await waitFor(treePanelVisible, "tree-panel-open"),
  );
  const panelGeo = await page
    .evaluate(() => {
      const container = document.querySelector(
        '[data-testid="tree-panel-container"]',
      );
      const panel = document.querySelector('[data-testid="files-tree-panel"]');
      if (!container || !panel) return null;
      const c = container.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      const cs = getComputedStyle(panel);
      const row = panel.firstElementChild;
      const list = panel.lastElementChild;
      const input = row?.querySelector("input");
      return {
        clientHeight: container.clientHeight,
        clientWidth: container.clientWidth,
        topInset: p.top - (c.top + container.clientTop),
        leftInset: p.left - (c.left + container.clientLeft),
        height: p.height,
        width: p.width,
        bottomGap:
          c.top +
          container.clientTop +
          container.clientHeight -
          (p.top + p.height),
        radius: parseFloat(cs.borderRadius),
        shadow: cs.boxShadow,
        borderWidth: cs.borderTopWidth,
        rowHeight: row ? row.getBoundingClientRect().height : null,
        rowBorderBottom: row ? getComputedStyle(row).borderBottomWidth : null,
        rowHasIcon: !!row?.querySelector("svg"),
        inputBorder: input ? getComputedStyle(input).borderTopWidth : null,
        listPadding: list ? getComputedStyle(list).padding : null,
      };
    })
    .catch(() => null);
  check(
    "Tree panel floats inset below the header band",
    panelGeo !== null &&
      Math.abs(panelGeo.topInset - 40) < 1 &&
      Math.abs(panelGeo.leftInset - 8) < 1,
    `top inset ${panelGeo?.topInset}, left inset ${panelGeo?.leftInset}`,
  );
  check(
    "Tree panel height is the open-time tab body minus header + bottom gap",
    panelGeo !== null &&
      Math.abs(panelGeo.height - (panelGeo.clientHeight - 48)) < 1 &&
      Math.abs(panelGeo.bottomGap - 8) < 1,
    `height ${panelGeo?.height}, bottom gap ${panelGeo?.bottomGap}`,
  );
  check(
    "Tree panel takes 80% of the tab width",
    panelGeo !== null &&
      Math.abs(panelGeo.width - panelGeo.clientWidth * 0.8) < 1.5,
    `width ${panelGeo?.width} of ${panelGeo?.clientWidth}`,
  );
  check(
    "Tree panel wears the popover recipe (rounded + border + shadow)",
    panelGeo !== null &&
      panelGeo.radius >= 6 &&
      panelGeo.shadow !== "none" &&
      panelGeo.borderWidth === "1px",
    `radius ${panelGeo?.radius}, border ${panelGeo?.borderWidth}`,
  );
  check(
    "Tree panel search row matches the quick-open recipe",
    panelGeo !== null &&
      panelGeo.rowHeight === 36 &&
      panelGeo.rowBorderBottom === "1px" &&
      panelGeo.rowHasIcon &&
      panelGeo.inputBorder === "0px",
    `row ${panelGeo?.rowHeight}px, separator ${panelGeo?.rowBorderBottom}, borderless input ${panelGeo?.inputBorder}`,
  );
  check(
    "Tree panel list is padded on all sides",
    panelGeo?.listPadding === "4px",
    `padding ${panelGeo?.listPadding}`,
  );
  check(
    "Tree panel focuses its search on open",
    await waitFor(treePanelInputFocused, "tree-panel-input-focus"),
  );

  // The trigger stays a TOGGLE while the popup is open (it is exempt from the
  // outside-pointerdown dismissal — without the exemption this click would
  // dismiss-then-reopen and the panel would appear stuck open).
  await treePanelTrigger.click();
  check(
    "Trigger click closes the open panel (toggle, not dismiss-then-reopen)",
    await waitFor(treePanelHidden, "tree-panel-toggle-close"),
  );

  await treePanelTrigger.click();
  await treePanel.waitFor({ state: "visible", timeout: 10_000 });
  await page
    .locator('[data-testid="files-tree-panel"] [data-item-path="lib/"]')
    .click();
  check(
    "Tree panel folder click expands the folder",
    await waitFor(
      () =>
        page
          .locator(
            '[data-testid="files-tree-panel"] [data-item-path="lib/readme.md"]',
          )
          .isVisible()
          .catch(() => false),
      "tree-panel-folder-expand",
    ),
  );
  check(
    "Tree panel search keeps focus through tree clicks",
    await waitFor(treePanelInputFocused, "tree-panel-focus-lock"),
  );

  // A popup keeps its size: shrinking the tab body must not reflow it.
  const frozenHeight = await treePanel.evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  await page.getByTestId("tree-panel-container").evaluate((el) => {
    el.style.height = "300px";
  });
  const shrunkHeight = await treePanel.evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  check(
    "Tree panel keeps its open-time height when the tab body resizes",
    Math.abs(shrunkHeight - frozenHeight) < 0.5,
    `${shrunkHeight} after shrink vs ${frozenHeight} at open`,
  );

  await page
    .locator(
      '[data-testid="files-tree-panel"] [data-item-path="lib/readme.md"]',
    )
    .click();
  check(
    "Tree panel closes on file open",
    await waitFor(treePanelHidden, "tree-panel-file-close"),
  );
  check(
    "Tree panel routed the opened file",
    consoleLines.some((l) => l.includes("[harness] panel open lib/readme.md")),
  );

  // Reopening measures the CURRENT tab body — the freeze is per open.
  await treePanelTrigger.click();
  await treePanel.waitFor({ state: "visible", timeout: 10_000 });
  const reopened = await page
    .evaluate(() => {
      const container = document.querySelector(
        '[data-testid="tree-panel-container"]',
      );
      const panel = document.querySelector('[data-testid="files-tree-panel"]');
      if (!container || !panel) return null;
      return {
        height: panel.getBoundingClientRect().height,
        clientHeight: container.clientHeight,
      };
    })
    .catch(() => null);
  check(
    "Reopening re-measures the resized tab body",
    reopened !== null &&
      Math.abs(reopened.height - (reopened.clientHeight - 48)) < 1,
    `height ${reopened?.height} for body ${reopened?.clientHeight}`,
  );

  await page.keyboard.type("readme");
  check(
    "Typing lands in the locked filter input",
    (await treePanelInput.inputValue().catch(() => "")) === "readme",
  );
  check(
    "Header-driven tree search keeps matches and filters unrelated rows",
    await waitFor(
      async () => {
        const match = page.locator(
          '[data-testid="files-tree-panel"] [data-item-path="lib/readme.md"]',
        );
        const unrelated = page.locator(
          '[data-testid="files-tree-panel"] [data-item-path="package.json"]',
        );
        return (
          (await match.isVisible().catch(() => false)) &&
          !(await unrelated.isVisible().catch(() => true))
        );
      },
      "tree-panel-search-filter",
    ),
  );
  await page.keyboard.press("Escape");
  check(
    "Escape clears a live filter without dismissing",
    (await treePanelInput.inputValue().catch(() => null)) === "" &&
      (await treePanelVisible()),
  );
  await page.keyboard.press("Escape");
  check(
    "Escape on an empty filter dismisses the panel",
    await waitFor(treePanelHidden, "tree-panel-escape-close"),
  );

  await treePanelTrigger.click();
  await treePanel.waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("parking-lot").click();
  check(
    "Outside pointerdown dismisses the panel",
    await waitFor(treePanelHidden, "tree-panel-outside-close"),
  );

  // 5. The GitHub settings overflow and disconnect dialog use Radix focus
  //    scopes. Exercise the real component: unit tests cannot reproduce the
  //    event ordering between portal mount, auto-focus, Escape, and focus
  //    return.
  await page.goto(`${harnessBase}/harness-github-settings.html`, {
    waitUntil: "networkidle",
  });
  const cliRadio = page.getByRole("radio", { name: "gh CLI auth" });
  await cliRadio.waitFor({ state: "visible", timeout: 10_000 });
  check(
    "GitHub cold snapshot keeps auth choices inert",
    await cliRadio.isDisabled(),
  );
  check(
    "GitHub cold snapshot does not flash sign-in",
    (await page.getByRole("button", { name: "Run gh auth login" }).count()) ===
      0,
  );

  const appMenuTrigger = page.getByRole("button", {
    name: "More actions for GitHub App",
  });
  await appMenuTrigger.waitFor({ state: "visible", timeout: 10_000 });

  const githubMenuOpen = async () =>
    page
      .getByRole("menu")
      .isVisible()
      .catch(() => false);
  await appMenuTrigger.click();
  check(
    "GitHub overflow opens",
    await waitFor(githubMenuOpen, "github-menu-open"),
  );
  await page.keyboard.press("Escape");
  check(
    "Escape closes GitHub overflow",
    await waitFor(async () => !(await githubMenuOpen()), "github-menu-escape"),
  );
  check(
    "GitHub overflow returns focus",
    await page.evaluate(
      () =>
        document.activeElement?.getAttribute("aria-label") ===
        "More actions for GitHub App",
    ),
  );

  await appMenuTrigger.click();
  await page.getByRole("menuitem", { name: "Disconnect" }).click();
  const disconnectDialog = page.getByRole("dialog", {
    name: "Disconnect GitHub App?",
  });
  check(
    "GitHub disconnect dialog opens",
    await waitFor(
      () => disconnectDialog.isVisible().catch(() => false),
      "github-dialog-open",
    ),
  );
  check(
    "GitHub disconnect consequences are itemized",
    (await disconnectDialog.locator("li").count()) === 3,
  );
  check(
    "Cancel owns initial dialog focus",
    await page.evaluate(
      () => document.activeElement?.textContent?.trim() === "Cancel",
    ),
  );
  await page.keyboard.press("Escape");
  check(
    "Escape closes GitHub disconnect dialog",
    await waitFor(
      async () => !(await disconnectDialog.isVisible().catch(() => false)),
      "github-dialog-escape",
    ),
  );
  check(
    "GitHub dialog returns focus to overflow trigger",
    await page.evaluate(
      () =>
        document.activeElement?.getAttribute("aria-label") ===
        "More actions for GitHub App",
    ),
  );

  // 6. A complete zero-installation snapshot must not send users back through
  //    ordinary OAuth. Exercise the real Settings CTA and inspect the native
  //    boundary payload emitted by the harness bridge.
  await page.goto(
    `${harnessBase}/harness-github-settings.html?state=not-installed`,
    { waitUntil: "networkidle" },
  );
  const installApp = page.getByRole("button", { name: "Install GitHub App" });
  await installApp.waitFor({ state: "visible", timeout: 10_000 });
  check(
    "GitHub missing-installation recovery is visible",
    await installApp.isVisible().catch(() => false),
  );
  await installApp.click();
  check(
    "GitHub recovery forces the install flow",
    await waitFor(
      () =>
        Promise.resolve(
          consoleLines.some(
            (line) =>
              line.includes("[harness] gh_app_connect") &&
              line.includes('"installFlow":true') &&
              line.includes('"forceInstall":true'),
          ),
        ),
      "github-force-install",
    ),
  );
  check(
    "GitHub recovery advances to browser completion",
    await page
      .getByRole("heading", { name: "Finish on GitHub" })
      .isVisible()
      .catch(() => false),
  );

  // 7. Whole-run invariant.
  check(
    "no uncaught page errors",
    pageErrors.length === 0,
    pageErrors.join("; "),
  );
} catch (err) {
  failures.push("harness run crashed");
  console.error(err);
} finally {
  await browser?.close();
  try {
    process.kill(-vite.pid, "SIGTERM");
  } catch {
    vite.kill("SIGTERM");
  }
}

if (failures.length > 0) {
  console.error(
    `\nui-smoke-composer: ${failures.length} failure(s): ${failures.join(", ")}`,
  );
  process.exit(1);
}
console.log("\nui-smoke-composer: all checks passed");
// Explicit exit: a straggler child (or its pipes) must not keep a green run
// alive past its result — CI treats a hang as a timeout, not a pass.
process.exit(0);
