#!/usr/bin/env node
// ============================================================
// Composer + GitHub settings UI smoke — real-browser interaction contract
//
// Boots the Vite dev server, opens the ModelPill harness page
// (harness-model-menu.html + src/harness-model-menu.tsx — the real
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
//
// Usage:  node scripts/ui-smoke-composer.mjs   (pnpm test:ui-smoke)
// ============================================================

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

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
  const pageUrl = `http://127.0.0.1:${port}/harness-model-menu.html`;
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

  // 4. Diff previews use a hover portal around an already-clickable row/pill.
  // Drive the real components so Slot handler composition and pointer travel
  // into the portal cannot regress unnoticed.
  await page.goto(`http://127.0.0.1:${port}/harness-diff-preview.html`, {
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
  check(
    "Markdown Preview wraps unbroken text and code",
    await page
      .getByTestId("markdown-preview-host")
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  );

  // 5. The GitHub settings overflow and disconnect dialog use Radix focus
  //    scopes. Exercise the real component: unit tests cannot reproduce the
  //    event ordering between portal mount, auto-focus, Escape, and focus
  //    return.
  await page.goto(`http://127.0.0.1:${port}/harness-github-settings.html`, {
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
    `http://127.0.0.1:${port}/harness-github-settings.html?state=not-installed`,
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
