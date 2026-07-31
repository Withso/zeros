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
//   7. The design harness exposes editable inspector fields, inline text, code
//      view, and an explicit frame-delete confirmation with correct Escape.
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
  if (!(await waitFor(async () => !(await menuOpen()), "esc-close", 1_000))) {
    // A late Radix focus settlement can make the first key clear the search
    // rather than dismiss. A user's next Escape must still close the surface.
    await page.keyboard.press("Escape");
  }
  check(
    "Escape closes the menu",
    await waitFor(async () => !(await menuOpen()), "esc-close"),
  );

  // 4. The GitHub settings overflow and disconnect dialog use Radix focus
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
  if (
    !(await waitFor(
      async () => !(await githubMenuOpen()),
      "github-menu-escape",
      1_000,
    ))
  ) {
    await page.keyboard.press("Escape");
  }
  check(
    "Escape closes GitHub overflow",
    await waitFor(async () => !(await githubMenuOpen()), "github-menu-escape"),
  );
  check(
    "GitHub overflow returns focus",
    await waitFor(
      () =>
        page.evaluate(
          () =>
            document.activeElement?.getAttribute("aria-label") ===
            "More actions for GitHub App",
        ),
      "github-menu-focus-return",
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

  // 5. Phase 3 design interactions use a sandboxed runtime plus the same
  // Radix focus primitives. Exercise the production component against its
  // warm exact-key harness; bridge-backed writes are covered by engine tests.
  await page.goto(`http://127.0.0.1:${port}/harness-design-workspace.html`, {
    waitUntil: "networkidle",
  });
  const designCanvas = page.getByRole("region", { name: "Design workspace" });
  await designCanvas.waitFor({ state: "visible", timeout: 10_000 });
  const homeFrame = page.locator('[data-design-frame="home.html"]');
  await homeFrame.waitFor({ state: "visible", timeout: 10_000 });
  check(
    "design inspector exposes editable fill",
    await page
      .getByLabel("Fill")
      .isEditable()
      .catch(() => false),
  );
  check(
    "design inspector exposes typography controls",
    (await page.getByText("Typography", { exact: true }).count()) === 1,
  );
  check(
    "design inspector exposes the token themes table",
    (await page.getByText("Themes", { exact: true }).count()) === 1 &&
      (await page.getByLabel("Base").count()) === 1,
  );
  check(
    "design inspector exposes PNG export",
    await page
      .getByRole("button", { name: "Export PNG" })
      .isEnabled()
      .catch(() => false),
  );
  check(
    "design inspector reuses the pull request affordance",
    (await page
      .getByRole("button", { name: "Open PR #42", exact: true })
      .count()) === 1,
  );
  check(
    "design advisories are grouped and explicitly non-blocking",
    (await page.getByText("Review 1 rule", { exact: true }).count()) === 1 &&
      (await page
        .getByText(/95 non-blocking design findings/)
        .count()) === 1 &&
      (await page.getByText(/Spacing scale · 95 findings/).count()) === 1,
  );

  await page.getByRole("button", { name: "Text tool" }).click();
  const inlineText = page.getByLabel(/^Edit text for /);
  check(
    "text tool opens inline editor",
    await waitFor(
      () => inlineText.isVisible().catch(() => false),
      "design-inline-text-ready",
    ),
  );
  await page.keyboard.press("Escape");
  check(
    "Escape closes inline text editor",
    await waitFor(
      async () => !(await inlineText.isVisible().catch(() => false)),
      "design-inline-text-escape",
    ),
  );

  const codeToggle = page.getByRole("button", { name: "Toggle frame source" });
  await codeToggle.click();
  check(
    "code tool opens authored frame source",
    await page.getByText("Zeros Design/home.html").isVisible(),
  );
  await codeToggle.click();

  const deleteFrameTrigger = page.getByRole("button", {
    name: "Delete frame",
  });
  await deleteFrameTrigger.click();
  const deleteFrameDialog = page.getByRole("dialog", {
    name: "Delete Launch home?",
  });
  check(
    "frame delete requires confirmation",
    await waitFor(
      () => deleteFrameDialog.isVisible().catch(() => false),
      "design-delete-dialog",
    ),
  );
  await waitFor(
    () =>
      page.evaluate(
        () => document.activeElement?.textContent?.trim() === "Cancel",
      ),
    "design-delete-cancel-focus",
  );
  await page.keyboard.press("Escape");
  check(
    "Escape closes frame delete confirmation",
    await waitFor(
      async () => !(await deleteFrameDialog.isVisible().catch(() => false)),
      "design-delete-escape",
    ),
  );
  check(
    "frame delete dialog returns focus",
    await waitFor(
      () =>
        page.evaluate(
          () =>
            document.activeElement?.getAttribute("aria-label") ===
            "Delete frame",
        ),
      "design-delete-focus-return",
    ),
  );

  // 6. Whole-run invariant.
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
