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
  const pill = page.getByRole("button", { name: /^Model:/ });
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
  const closeModelMenuWithEscape = async (label) => {
    // A collapsed selected row can reopen its hover catalog underneath the
    // stationary pointer. Escape intentionally closes that nested layer first,
    // so allow one more press before declaring the outer menu stuck.
    for (let attempt = 0; attempt < 3 && (await menuOpen()); attempt += 1) {
      await page.keyboard.press("Escape");
      if (
        await waitFor(
          async () => !(await menuOpen()),
          `${label}-${attempt}`,
          500,
        )
      ) {
        return true;
      }
    }
    return !(await menuOpen());
  };

  // Composer controls are container-responsive: split-pane width, not browser
  // viewport width, decides how much of the model summary remains. Exercise
  // both strict boundaries (450/400 stay in the wider state; 449/399 collapse).
  const responsiveHost = page.getByTestId("responsive-chat-host");
  const responsiveModelState = async (width) => {
    await responsiveHost.evaluate((host, nextWidth) => {
      host.style.width = `${nextWidth}px`;
    }, width);
    return pill.evaluate((button) => {
      const name = button.querySelector("[data-model-pill-name]");
      const metadata = button.querySelector("[data-model-pill-metadata]");
      const label = button.querySelector("[data-model-pill-label]");
      const visible = (element) =>
        !!element && getComputedStyle(element).display !== "none";
      return {
        name: visible(name),
        metadata: visible(metadata),
        label: visible(label),
        icon: !!button.querySelector("svg"),
      };
    });
  };
  const at450 = await responsiveModelState(450);
  const below450 = await responsiveModelState(449);
  const at400 = await responsiveModelState(400);
  const below400 = await responsiveModelState(399);
  check(
    "450px keeps logo, model, and effort metadata",
    at450.icon && at450.name && at450.metadata && at450.label,
    JSON.stringify(at450),
  );
  check(
    "below 450px keeps logo plus effort metadata without model name",
    below450.icon && !below450.name && below450.metadata && below450.label,
    JSON.stringify(below450),
  );
  check(
    "400px still keeps effort metadata",
    at400.icon && !at400.name && at400.metadata && at400.label,
    JSON.stringify(at400),
  );
  check(
    "below 400px shows only the agent logo",
    below400.icon &&
      !below400.label &&
      (await page.getByRole("button", { name: /^Model:/ }).count()) === 1,
    JSON.stringify(below400),
  );
  await responsiveModelState(360);
  const compactRowOverflow = await page
    .getByTestId("pill-host")
    .evaluate((row) => ({
      clientWidth: row.clientWidth,
      scrollWidth: row.scrollWidth,
    }));
  check(
    "360px chat floor keeps the composer controls on one row without overflow",
    compactRowOverflow.scrollWidth <= compactRowOverflow.clientWidth,
    `${compactRowOverflow.scrollWidth}/${compactRowOverflow.clientWidth}`,
  );
  await responsiveModelState(500);

  const sendButtonShape = await page
    .getByTestId("composer-send")
    .evaluate((button) => {
      const style = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        radius: Number.parseFloat(style.borderTopLeftRadius),
        border: style.borderTopWidth,
      };
    });
  check(
    "composer send is a borderless circle",
    Math.abs(sendButtonShape.width - sendButtonShape.height) <= 0.5 &&
      sendButtonShape.radius >= sendButtonShape.width / 2 &&
      sendButtonShape.border === "0px",
    JSON.stringify(sendButtonShape),
  );

  // Permission tooltip is immediate during an ordinary hover. A click gives
  // the transient feedback exclusive use of that surface: right-first when it
  // fits, then top when a live resize removes the space beside the icon.
  const pillHost = page.getByTestId("pill-host");
  const permissionButton = pillHost.locator(
    'button[aria-label^="Permission mode:"]',
  );
  const visibleTooltipCount = () =>
    page
      .locator(
        "[data-radix-popper-content-wrapper] > [data-side][data-state]:visible",
      )
      .count();
  await permissionButton.hover();
  check(
    "permission tooltip opens immediately outside a click-feedback cycle",
    await waitFor(
      async () => (await visibleTooltipCount()) === 1,
      "permission-tooltip-immediate",
      1_000,
    ),
  );
  await page.getByTestId("fake-editor").hover();
  // Radix creates a trigger→content grace polygon on pointerleave. Playwright's
  // hover is a single coordinate jump, so deliver the follow-up movement a
  // real travelling pointer would naturally produce to leave that polygon.
  await page.mouse.move(800, 100, { steps: 2 });
  check(
    "permission tooltip closes when ordinary hover ends",
    await waitFor(
      async () => (await visibleTooltipCount()) === 0,
      "permission-tooltip-close",
      1_000,
    ),
  );
  const rowHeightBeforePermission = await pillHost.evaluate(
    (row) => row.getBoundingClientRect().height,
  );
  await permissionButton.click();
  const permissionFeedback = page.locator("[data-permission-mode-feedback]");
  check(
    "permission toggle shows transient mode feedback",
    await waitFor(
      () => permissionFeedback.isVisible().catch(() => false),
      "permission-feedback",
    ),
  );
  const permissionGeometry = await Promise.all([
    permissionButton.boundingBox(),
    permissionFeedback.boundingBox(),
    pillHost.evaluate((row) => row.getBoundingClientRect().height),
    permissionFeedback.getAttribute("data-placement"),
  ]);
  check(
    "permission feedback prefers the icon's right without changing row height",
    !!permissionGeometry[0] &&
      !!permissionGeometry[1] &&
      permissionGeometry[1].x >=
        permissionGeometry[0].x + permissionGeometry[0].width &&
      Math.abs(permissionGeometry[2] - rowHeightBeforePermission) <= 0.5 &&
      permissionGeometry[3] === "right",
    JSON.stringify(permissionGeometry),
  );
  check(
    "permission tooltip yields while click feedback is visible",
    await waitFor(
      async () => (await visibleTooltipCount()) === 0,
      "permission-tooltip-click-suppression",
      1_000,
    ),
  );
  await responsiveModelState(160);
  check(
    "permission feedback moves above only when right-side room disappears",
    await waitFor(
      async () =>
        (await permissionFeedback.getAttribute("data-placement")) === "top",
      "permission-feedback-top-fallback",
      1_000,
    ),
  );
  const compactPermissionGeometry = await Promise.all([
    permissionButton.boundingBox(),
    permissionFeedback.boundingBox(),
    pillHost.evaluate((row) => row.getBoundingClientRect().height),
  ]);
  check(
    "top fallback remains outside the one-line composer row",
    !!compactPermissionGeometry[0] &&
      !!compactPermissionGeometry[1] &&
      compactPermissionGeometry[1].y + compactPermissionGeometry[1].height <=
        compactPermissionGeometry[0].y &&
      Math.abs(compactPermissionGeometry[2] - rowHeightBeforePermission) <= 0.5,
    JSON.stringify(compactPermissionGeometry),
  );
  await responsiveModelState(500);
  check(
    "permission feedback returns right when resize restores room",
    await waitFor(
      async () =>
        (await permissionFeedback.getAttribute("data-placement")) === "right",
      "permission-feedback-right-restore",
      1_000,
    ),
  );
  await permissionButton.hover();
  check(
    "permission tooltip appears after the click-feedback delay",
    await waitFor(
      async () =>
        (await permissionFeedback.count()) === 0 &&
        (await visibleTooltipCount()) === 1,
      "permission-tooltip-after-click-delay",
      3_500,
    ),
  );
  await page.mouse.move(800, 100, { steps: 2 });
  await waitFor(
    async () => (await visibleTooltipCount()) === 0,
    "permission-tooltip-post-delay-close",
    1_000,
  );

  // The "+" overlay owns its open update in a tiny memoized subtree. There is
  // no loading wait or parent-state turn: the menu is visible as soon as the
  // real pointer click finishes.
  const attachmentTrigger = page.getByRole("button", {
    name: "Add attachment or link a workspace",
  });
  const attachmentMenu = page.locator("[data-composer-attachment-menu]");
  await attachmentTrigger.click();
  check(
    "composer attachment menu opens on the click turn",
    await attachmentMenu.isVisible().catch(() => false),
  );
  check(
    "composer attachment menu exposes all three actions",
    (await attachmentMenu.getByRole("menuitem").count()) === 3,
  );
  await page.keyboard.press("Escape");
  check(
    "composer attachment menu closes with Escape",
    await waitFor(
      async () => !(await attachmentMenu.isVisible().catch(() => false)),
      "attachment-menu-close",
    ),
  );

  // 1. Open — and survive the guardian (the 2026-07-24 regression closed it
  //    within one macrotask of opening).
  await pill.click();
  check("menu opens on pill click", await waitFor(menuOpen, "open"));
  // The regression dismissed the menu within ~1 macrotask; give any late
  // dismiss path ample room to fire before asserting stability.
  await page.waitForTimeout(600);
  check("menu stays open (no guardian dismiss)", await menuOpen());
  const searchInput = page.getByPlaceholder("Search models…");
  check(
    "model search receives open-time focus",
    await waitFor(
      () => searchInput.evaluate((input) => input === document.activeElement),
      "search-open-focus",
    ),
  );
  const modelRow = (label) =>
    page.locator("[cmdk-item]").filter({ hasText: label }).first();
  const rowText = async (label) => (await modelRow(label).textContent()) ?? "";
  const modelMenu = () => page.locator("[cmdk-root]").locator("xpath=..");
  const selectedModel = () => page.getByTestId("selected-model-browser");
  const catalog = () => page.getByTestId("model-catalog-sidecar");
  const catalogRow = (label) =>
    catalog()
      .locator("[data-model-catalog-item]")
      .filter({ hasText: label })
      .first();
  const catalogEditButton = (label) =>
    catalogRow(label).getByRole("button", {
      name: `Edit settings for ${label}`,
    });
  const catalogFavoriteButton = (label) =>
    catalogRow(label).locator("[data-model-favorite-action]");
  const defaultIndicators = () =>
    page.locator("[data-default-model-indicator]");
  const modelEditor = () => page.getByTestId("model-configuration-popover");

  const initialPillText = (
    (await pill.locator("[data-model-pill-label]").textContent()) ?? ""
  )
    .replace(/\s+/g, " ")
    .trim();
  check(
    "composer combines model and effort in one pill",
    initialPillText === "Opus 5 High",
    initialPillText,
  );
  const pillMetadataPresentation = await pill
    .locator("[data-model-pill-metadata]")
    .evaluate((metadata) => {
      const fg2Probe = document.createElement("span");
      fg2Probe.style.color = "var(--fg2)";
      document.body.append(fg2Probe);
      const presentation = {
        text: metadata.textContent?.trim() ?? "",
        color: getComputedStyle(metadata).color,
        fg2: getComputedStyle(fg2Probe).color,
        opacity: getComputedStyle(metadata).opacity,
      };
      fg2Probe.remove();
      return presentation;
    })
    .catch(() => null);
  check(
    "composer renders effort/Fast as 80%-opacity fg2 metadata",
    pillMetadataPresentation?.text === "High" &&
      pillMetadataPresentation.color === pillMetadataPresentation.fg2 &&
      pillMetadataPresentation.opacity === "0.8",
    JSON.stringify(pillMetadataPresentation),
  );
  check(
    "composer has no standalone Fast or effort controls",
    (await page.getByRole("button", { name: /fast mode/i }).count()) === 0 &&
      (await page
        .getByRole("button", { name: /reasoning effort:/i })
        .count()) === 0,
  );

  const modelMenuWidth = await modelMenu().evaluate((element) =>
    element instanceof HTMLElement ? element.offsetWidth : 0,
  );
  check(
    "model popup is at most 230px wide",
    modelMenuWidth > 0 && modelMenuWidth <= 230,
    `${modelMenuWidth}px`,
  );
  const modelMenuOverflow = await modelMenu().evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  check(
    "narrow model popup has no horizontal overflow",
    modelMenuOverflow.scrollWidth <= modelMenuOverflow.clientWidth,
    `${modelMenuOverflow.scrollWidth}/${modelMenuOverflow.clientWidth}`,
  );

  // 2. The default surface is deliberately collapsed: no provider-logo rail
  //    and no full catalog in the main popup. Only the selected model sits
  //    below the focused search; hovering it opens a grouped sidecar without
  //    stealing focus from search.
  check(
    "model popup has no provider-logo rail",
    (await page.getByRole("tablist", { name: "Agents" }).count()) === 0,
  );
  check(
    "default model section renders no expanded command rows",
    (await page.locator("[cmdk-item]").count()) === 0,
  );
  check(
    "default model section shows only the selected model",
    (await selectedModel().count()) === 1 &&
      ((await selectedModel().textContent()) ?? "").includes("Opus 5") &&
      ((await selectedModel().textContent()) ?? "").includes("High"),
  );
  await selectedModel().hover();
  check(
    "hovering the selected model opens the catalog sidecar",
    await waitFor(() => catalog().isVisible(), "model-catalog-hover"),
  );
  const catalogWidth = await catalog().evaluate((element) =>
    element instanceof HTMLElement ? element.offsetWidth : 0,
  );
  check(
    "model catalog popup is at most 230px wide",
    catalogWidth > 0 && catalogWidth <= 230,
    `${catalogWidth}px`,
  );
  const catalogOverflow = await catalog().evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  check(
    "narrow model catalog has no horizontal overflow",
    catalogOverflow.scrollWidth <= catalogOverflow.clientWidth,
    `${catalogOverflow.scrollWidth}/${catalogOverflow.clientWidth}`,
  );
  await selectedModel().click();
  check(
    "clicking the hovered selected model keeps its catalog open",
    await catalog().isVisible(),
  );
  check(
    "clicking the selected model preserves search focus",
    await searchInput.evaluate((input) => input === document.activeElement),
  );
  check(
    "catalog sidecar groups rows under agent titles",
    (await catalog().getByRole("group", { name: "Claude Code" }).count()) ===
      1 &&
      (await catalog().getByRole("group", { name: "Codex" }).count()) === 1 &&
      (await catalog().getByRole("group", { name: "Cursor" }).count()) === 1,
  );
  check(
    "every catalog agent heading leads with one brand mark",
    (await catalog()
      .locator('[data-model-section-heading="agent"] > span:first-child svg')
      .count()) === (await catalog().locator('section[role="group"]').count()),
  );
  await catalogRow("GPT-5.6 Sol").hover();
  check(
    "catalog stays open across trigger-to-sidecar travel",
    await catalog().isVisible(),
  );
  check(
    "hover catalog preserves search focus",
    await searchInput.evaluate((input) => input === document.activeElement),
  );
  await page.keyboard.press("Escape");
  check(
    "Escape closes only the nested catalog first",
    (await menuOpen()) &&
      (await waitFor(
        async () => !(await catalog().isVisible()),
        "catalog-esc",
      )),
  );
  await selectedModel().hover();
  check(
    "catalog can reopen after nested Escape",
    await waitFor(() => catalog().isVisible(), "catalog-reopen"),
  );

  // An empty query renders NO cmdk rows on purpose — the collapsed selected
  // model is the only default row. That makes the catalog the sole browse
  // surface, so it has to be reachable without a pointer: Tab moves from the
  // always-focused search to the selected-model button (whose focus opens the
  // sidecar) and then into the grouped rows themselves. Typing remains the
  // primary path (arrows + Enter over universal results).
  await searchInput.press("Tab");
  const browserFocused = await selectedModel().evaluate(
    (element) => element === document.activeElement,
  );
  await page.keyboard.press("Tab");
  const rowFocus = await page.evaluate(() => {
    const sidecar = document.querySelector(
      '[data-testid="model-catalog-sidecar"]',
    );
    const active = document.activeElement;
    return {
      inside: !!sidecar && !!active && sidecar.contains(active),
      label: active?.getAttribute("aria-label") ?? "",
    };
  });
  check(
    "Tab walks from search into the catalog's model rows",
    browserFocused && rowFocus.inside && /^Select /.test(rowFocus.label),
    `${browserFocused}/${rowFocus.inside}/${rowFocus.label}`,
  );
  // Return to the pointer-driven state the geometry checks below measure: focus
  // inside the sidecar keeps a row's hover-only actions revealed, and handing
  // the caret straight back mid-flight makes Radix re-mount the layer under
  // them. Tear the catalog down and reopen it the same way the checks above do.
  await page.keyboard.press("Escape");
  await waitFor(async () => !(await catalog().isVisible()), "catalog-esc-tab");
  // The pointer never left the selected row during the keyboard probe, so it
  // has to move away before hovering it can emit pointerenter again.
  await searchInput.hover();
  await searchInput.focus();
  await selectedModel().hover();
  await waitFor(() => catalog().isVisible(), "catalog-reopen-after-tab");

  // Rows are one left-aligned phrase: model, effort, Fast, default star. The
  // right edge is reserved for the active tick or a non-active model's editor.
  // An agent heading leads with its brand mark on the model names' left edge,
  // and its title follows that mark.
  check(
    "model rows have no command-number badges",
    (await page.locator("kbd").count()) === 0,
  );
  check(
    "active model row shows default High effort",
    ((await catalogRow("Opus 5").textContent()) ?? "").includes("High"),
  );
  const claudeGroup = catalog().getByRole("group", { name: "Claude Code" });
  const claudeMarkBox = await claudeGroup
    .locator('[data-model-section-heading="agent"] > span:first-child')
    .boundingBox();
  const claudeHeadingBox = await claudeGroup
    .locator("[data-model-section-title]")
    .boundingBox();
  const opusNameBox = await catalogRow("Opus 5")
    .getByText("Opus 5", { exact: true })
    .boundingBox();
  check(
    "agent brand marks and model names share the same left edge",
    !!claudeMarkBox &&
      !!opusNameBox &&
      Math.abs(claudeMarkBox.x - opusNameBox.x) <= 1,
  );
  check(
    "agent titles sit directly after their brand mark",
    !!claudeMarkBox &&
      !!claudeHeadingBox &&
      claudeHeadingBox.x - (claudeMarkBox.x + claudeMarkBox.width) <= 8,
  );
  const modelNameFontWeight = await catalogRow("Opus 5")
    .locator("[data-model-name]")
    .evaluate((name) => getComputedStyle(name).fontWeight);
  // "Reasoning", "Options", "Model", and every agent title are one label tier:
  // model-name weight, 12px, on the 28px heading rhythm.
  const sectionTitles = [
    page.getByText("Reasoning", { exact: true }),
    page.getByText("Options", { exact: true }),
    modelMenu().getByText("Model", { exact: true }),
    catalog().locator("[data-model-section-title]").first(),
  ];
  const titleFontWeights = await Promise.all(
    sectionTitles.map((title) =>
      title.evaluate((node) => getComputedStyle(node).fontWeight),
    ),
  );
  check(
    "configuration, Model, and agent titles match model-name weight",
    titleFontWeights.every((weight) => weight === modelNameFontWeight),
    `${modelNameFontWeight}/${titleFontWeights.join(",")}`,
  );
  const titleFontSizes = await Promise.all(
    sectionTitles.map((title) =>
      title.evaluate((node) => getComputedStyle(node).fontSize),
    ),
  );
  check(
    "every model-menu section title is 12px",
    titleFontSizes.every((size) => size === "12px"),
    titleFontSizes.join(","),
  );
  const titleHeights = await Promise.all([
    ...sectionTitles
      .slice(0, 3)
      .map((title) => title.evaluate((node) => node.offsetHeight)),
    catalog()
      .locator("[data-model-section-title]")
      .first()
      .locator("xpath=..")
      .evaluate((title) => title.offsetHeight),
  ]);
  check(
    "all model-menu titles use the compact 28px rhythm",
    titleHeights.every((height) => height <= 28),
    titleHeights.join(","),
  );
  const catalogRowHeights = await catalog()
    .locator("[data-model-catalog-item]")
    .evaluateAll((items) => items.map((item) => item.offsetHeight));
  check(
    "all catalog models use one compact 26px row height",
    catalogRowHeights.length > 0 &&
      catalogRowHeights.every((height) => Math.abs(height - 26) <= 0.5),
    catalogRowHeights.join(","),
  );
  const effortRowHeights = await page
    .getByRole("radiogroup", { name: "Reasoning effort" })
    .getByRole("radio")
    .evaluateAll((items) => items.map((item) => item.offsetHeight));
  const fastOptionRowHeight = await page
    .getByRole("switch", { name: /Fast mode for/ })
    .locator("xpath=..")
    .evaluate((row) => row.offsetHeight);
  check(
    "configuration choices share the same 26px dropdown row height",
    effortRowHeights.length > 0 &&
      effortRowHeights.every((height) => Math.abs(height - 26) <= 0.5) &&
      Math.abs(fastOptionRowHeight - 26) <= 0.5,
    `${effortRowHeights.join(",")}/${fastOptionRowHeight}`,
  );
  const compactRowPadding = await Promise.all([
    catalogRow("GPT-5.6 Sol").evaluate((row) => ({
      top: getComputedStyle(row).paddingTop,
      bottom: getComputedStyle(row).paddingBottom,
    })),
    page
      .getByRole("radiogroup", { name: "Reasoning effort" })
      .getByRole("radio")
      .first()
      .evaluate((row) => ({
        top: getComputedStyle(row).paddingTop,
        bottom: getComputedStyle(row).paddingBottom,
      })),
    page
      .getByRole("switch", { name: /Fast mode for/ })
      .locator("xpath=..")
      .evaluate((row) => ({
        top: getComputedStyle(row).paddingTop,
        bottom: getComputedStyle(row).paddingBottom,
      })),
    selectedModel().evaluate((row) => ({
      top: getComputedStyle(row).paddingTop,
      bottom: getComputedStyle(row).paddingBottom,
    })),
  ]);
  check(
    "model-menu items use 4px top and bottom padding",
    compactRowPadding.every(
      ({ top, bottom }) => top === "4px" && bottom === "4px",
    ),
    JSON.stringify(compactRowPadding),
  );
  const catalogItemGaps = await catalog()
    .getByRole("group")
    .evaluateAll((groups) =>
      groups.flatMap((group) => {
        const items = Array.from(
          group.querySelectorAll("[data-model-catalog-item]"),
        );
        return items.slice(1).map((item, index) => {
          const previous = items[index].getBoundingClientRect();
          const current = item.getBoundingClientRect();
          return current.top - previous.bottom;
        });
      }),
    );
  const reasoningItemGaps = await page
    .getByRole("radiogroup", { name: "Reasoning effort" })
    .getByRole("radio")
    .evaluateAll((items) =>
      items.slice(1).map((item, index) => {
        const previous = items[index].getBoundingClientRect();
        const current = item.getBoundingClientRect();
        return current.top - previous.bottom;
      }),
    );
  check(
    "catalog and reasoning items have an exact 1px inter-item gap",
    catalogItemGaps.length > 0 &&
      reasoningItemGaps.length > 0 &&
      [...catalogItemGaps, ...reasoningItemGaps].every(
        (gap) => Math.abs(gap - 1) <= 0.5,
      ),
    `${catalogItemGaps.join(",")}/${reasoningItemGaps.join(",")}`,
  );
  // A group's separator is the NEXT group's border-top, so its section box top
  // is the rule itself: the previous group's 2px tail keeps a hovered last row
  // from painting flush against it.
  const haikuRowBox = await catalogRow("Haiku 4.5").boundingBox();
  const codexGroupBox = await catalog()
    .getByRole("group", { name: "Codex" })
    .boundingBox();
  check(
    "agent group separators clear the last row by 2px",
    !!haikuRowBox &&
      !!codexGroupBox &&
      Math.abs(codexGroupBox.y - (haikuRowBox.y + haikuRowBox.height) - 2) <= 1,
    codexGroupBox && haikuRowBox
      ? `${codexGroupBox.y - haikuRowBox.y - haikuRowBox.height}`
      : "no box",
  );
  const solNameBox = await catalogRow("GPT-5.6 Sol")
    .getByText("GPT-5.6 Sol", { exact: true })
    .boundingBox();
  const solEffortBox = await catalogRow("GPT-5.6 Sol")
    .getByText("High", { exact: true })
    .boundingBox();
  check(
    "effort sits directly beside the model name",
    !!solNameBox &&
      !!solEffortBox &&
      solEffortBox.x - (solNameBox.x + solNameBox.width) <= 12,
  );
  const solMetadataPresentation = await catalogRow("GPT-5.6 Sol")
    .locator("[data-model-metadata]")
    .evaluate((metadata) => {
      const fg2Probe = document.createElement("span");
      fg2Probe.style.color = "var(--fg2)";
      document.body.append(fg2Probe);
      const presentation = {
        color: getComputedStyle(metadata).color,
        fg2: getComputedStyle(fg2Probe).color,
        opacity: getComputedStyle(metadata).opacity,
      };
      fg2Probe.remove();
      return presentation;
    });
  check(
    "row effort/Fast metadata uses fg2 at 80% opacity",
    solMetadataPresentation.color === solMetadataPresentation.fg2 &&
      solMetadataPresentation.opacity === "0.8",
    JSON.stringify(solMetadataPresentation),
  );
  check(
    "Codex fallback is the single connected-provider default",
    (await defaultIndicators().count()) === 1 &&
      (await defaultIndicators()
        .first()
        .evaluate((indicator) =>
          indicator
            .closest("[data-model-catalog-item]")
            ?.textContent?.includes("GPT-5.6 Sol"),
        )),
  );
  const solStarBox = await catalogRow("GPT-5.6 Sol")
    .locator("[data-default-model-indicator]")
    .boundingBox();
  check(
    "default star sits directly after effort metadata",
    !!solEffortBox &&
      !!solStarBox &&
      solStarBox.x - (solEffortBox.x + solEffortBox.width) <= 12,
  );
  check(
    "selected non-default model shows no star",
    (await catalogRow("Opus 5")
      .locator("[data-default-model-indicator]")
      .count()) === 0 &&
      (await selectedModel()
        .locator("[data-default-model-indicator]")
        .count()) === 0,
  );
  const activeRowBox = await catalogRow("Opus 5").boundingBox();
  const selectedTickBox = await catalogRow("Opus 5")
    .getByLabel("Selected model")
    .boundingBox();
  check(
    "selected tick occupies the row's right edge",
    !!activeRowBox &&
      !!selectedTickBox &&
      activeRowBox.x +
        activeRowBox.width -
        (selectedTickBox.x + selectedTickBox.width) <=
        12,
  );
  check(
    "selected row has no edit action",
    (await catalogEditButton("Opus 5").count()) === 0,
  );
  check(
    "non-selected configurable rows expose a right-edge edit action",
    (await catalogEditButton("GPT-5.6 Terra").count()) === 1,
  );
  const terraEditAtRest = await catalogEditButton("GPT-5.6 Terra").evaluate(
    (button) => ({
      opacity: getComputedStyle(button).opacity,
      pointerEvents: getComputedStyle(button).pointerEvents,
    }),
  );
  check(
    "Edit is visually and pointer-inert until its model row is hovered",
    terraEditAtRest.opacity === "0" && terraEditAtRest.pointerEvents === "none",
    JSON.stringify(terraEditAtRest),
  );
  await catalogRow("GPT-5.6 Terra").hover();
  check(
    "Edit appears when its model row is hovered",
    await waitFor(
      () =>
        catalogEditButton("GPT-5.6 Terra").evaluate(
          (button) =>
            getComputedStyle(button).opacity === "1" &&
            getComputedStyle(button).pointerEvents !== "none",
        ),
      "catalog-edit-hover",
    ),
  );
  const terraEditPresentation = await catalogEditButton("GPT-5.6 Terra")
    .evaluate((button) => {
      const fg2Probe = document.createElement("span");
      fg2Probe.style.color = "var(--fg2)";
      document.body.append(fg2Probe);
      const presentation = {
        text: button.textContent?.trim() ?? "",
        fontSize: getComputedStyle(button).fontSize,
        color: getComputedStyle(button).color,
        fg2: getComputedStyle(fg2Probe).color,
        iconCount: button.querySelectorAll("svg").length,
      };
      fg2Probe.remove();
      return presentation;
    })
    .catch(() => null);
  check(
    "model editor action is 12px fg2 Edit text without an icon",
    terraEditPresentation?.text === "Edit" &&
      terraEditPresentation.fontSize === "12px" &&
      terraEditPresentation.color === terraEditPresentation.fg2 &&
      terraEditPresentation.iconCount === 0,
    JSON.stringify(terraEditPresentation),
  );
  const terraRowBox = await catalogRow("GPT-5.6 Terra").boundingBox();
  const terraEditBox = await catalogEditButton("GPT-5.6 Terra").boundingBox();
  check(
    "non-selected edit occupies the row's right edge",
    !!terraRowBox &&
      !!terraEditBox &&
      terraRowBox.x +
        terraRowBox.width -
        (terraEditBox.x + terraEditBox.width) <=
        8,
  );
  const terraFavorite = catalogFavoriteButton("GPT-5.6 Terra");
  const terraMetadataBox = await catalogRow("GPT-5.6 Terra")
    .locator("[data-model-metadata]")
    .boundingBox();
  const terraFavoriteBox = await terraFavorite.boundingBox();
  check(
    "favorite stays directly beside a model phrase when the row has room",
    (await catalogRow("GPT-5.6 Terra").getAttribute(
      "data-favorite-placement",
    )) === "inline" &&
      !!terraMetadataBox &&
      !!terraFavoriteBox &&
      terraFavoriteBox.x - (terraMetadataBox.x + terraMetadataBox.width) <= 8,
  );
  const hoverActionTransitions = await catalogRow("GPT-5.6 Terra").evaluate(
    (row) => {
      const actions = row.querySelector("[data-model-row-actions]");
      const favorite = row.querySelector("[data-model-favorite-action]");
      const edit = row.querySelector('[aria-label^="Edit settings for"]');
      const read = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          transitionDuration: style.transitionDuration,
        };
      };
      return {
        actions: read(actions),
        favorite: read(favorite),
        edit: read(edit),
      };
    },
  );
  check(
    "favorite/Edit reveal has no delayed opacity or background transition",
    Object.values(hoverActionTransitions).every(
      (style) =>
        style !== null &&
        style.transitionDuration
          .split(",")
          .every((duration) => Number.parseFloat(duration) === 0),
    ) && hoverActionTransitions.edit?.background === "rgba(0, 0, 0, 0)",
    JSON.stringify(hoverActionTransitions),
  );
  await catalogRow("GPT-5.6 Luna").hover();
  const departedTerraActions = await catalogRow("GPT-5.6 Terra").evaluate(
    (row) => ({
      favoriteOpacity: getComputedStyle(
        row.querySelector("[data-model-favorite-action]"),
      ).opacity,
      editOpacity: getComputedStyle(
        row.querySelector('[aria-label^="Edit settings for"]'),
      ).opacity,
      overlayBackground: getComputedStyle(
        row.querySelector("[data-model-row-actions]"),
      ).backgroundColor,
    }),
  );
  check(
    "moving between rows clears the departed action background immediately",
    departedTerraActions.favoriteOpacity === "0" &&
      departedTerraActions.editOpacity === "0" &&
      departedTerraActions.overlayBackground === "rgba(0, 0, 0, 0)",
    JSON.stringify(departedTerraActions),
  );
  await catalog().evaluate((element) => {
    element.style.width = "140px";
  });
  check(
    "favorite overlays a long model phrase only when available width runs out",
    await waitFor(
      async () =>
        (await catalogRow("GPT-5.6 Terra").getAttribute(
          "data-favorite-placement",
        )) === "overlay",
      "favorite-overlay-on-narrow-row",
    ),
  );
  const narrowTerraName = await catalogRow("GPT-5.6 Terra")
    .locator("[data-model-name]")
    .evaluate((name) => ({
      clientWidth: name.clientWidth,
      scrollWidth: name.scrollWidth,
    }));
  check(
    "overlay placement keeps the full model name ahead of optional metadata",
    narrowTerraName.clientWidth >= narrowTerraName.scrollWidth,
    JSON.stringify(narrowTerraName),
  );
  await catalog().evaluate((element) => {
    element.style.width = "";
  });
  check(
    "favorite returns beside the phrase when width becomes available",
    await waitFor(
      async () =>
        (await catalogRow("GPT-5.6 Terra").getAttribute(
          "data-favorite-placement",
        )) === "inline",
      "favorite-inline-after-resize",
    ),
  );
  await catalog()
    .getByRole("group", { name: "Cursor" })
    .locator("[data-model-section-title]")
    .hover();
  const cursorName = catalogRow("Cursor Grok 4.5").locator("[data-model-name]");
  const cursorNameAtRest = await cursorName.evaluate((name) => ({
    clientWidth: name.clientWidth,
    scrollWidth: name.scrollWidth,
  }));
  check(
    "model name gets width priority over metadata and hidden actions",
    cursorNameAtRest.clientWidth >= cursorNameAtRest.scrollWidth,
    JSON.stringify(cursorNameAtRest),
  );
  const cursorRowHeightBeforeHover = await catalogRow(
    "Cursor Grok 4.5",
  ).evaluate((row) => row.getBoundingClientRect().height);
  const cursorActionOverlay = catalogRow("Cursor Grok 4.5").locator(
    "[data-model-row-actions]",
  );
  const cursorActionLayout = await cursorActionOverlay
    .evaluate((overlay) => ({
      position: getComputedStyle(overlay).position,
      right: getComputedStyle(overlay).right,
    }))
    .catch(() => null);
  await catalogRow("Cursor Grok 4.5").hover();
  const cursorRowHeightAfterHover = await catalogRow(
    "Cursor Grok 4.5",
  ).evaluate((row) => row.getBoundingClientRect().height);
  check(
    "hover actions overlay long labels without reflowing the row",
    cursorActionLayout?.position === "absolute" &&
      cursorActionLayout.right !== "auto" &&
      Math.abs(cursorRowHeightAfterHover - cursorRowHeightBeforeHover) <= 0.5,
    JSON.stringify({
      cursorActionLayout,
      cursorRowHeightBeforeHover,
      cursorRowHeightAfterHover,
    }),
  );

  // Editing a non-selected row changes only that exact model's durable memory:
  // it must not select the row, close the catalog, or reconfigure active Opus.
  const selectionsBeforeEdit = consoleLines.filter((line) =>
    line.includes("[harness] onChange"),
  ).length;
  await catalogRow("GPT-5.6 Terra").hover();
  await catalogEditButton("GPT-5.6 Terra").click();
  check(
    "non-selected model editor opens beside its row",
    await waitFor(() => modelEditor().isVisible(), "model-editor-open"),
  );
  const modelEditorWidth = await modelEditor().evaluate((element) =>
    element instanceof HTMLElement ? element.offsetWidth : 0,
  );
  check(
    "model editor popup is at most 230px wide",
    modelEditorWidth > 0 && modelEditorWidth <= 230,
    `${modelEditorWidth}px`,
  );
  const modelEditorOverflow = await modelEditor().evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  check(
    "narrow model editor has no horizontal overflow",
    modelEditorOverflow.scrollWidth <= modelEditorOverflow.clientWidth,
    `${modelEditorOverflow.scrollWidth}/${modelEditorOverflow.clientWidth}`,
  );
  await modelEditor()
    .getByRole("radio", { name: "Medium", exact: true })
    .click();
  const terraFastSwitch = modelEditor().getByRole("switch", {
    name: "Fast mode for gpt-5.6-terra",
  });
  await terraFastSwitch.click();
  check(
    "editing a non-selected model keeps the catalog and editor open",
    (await catalog().isVisible()) && (await modelEditor().isVisible()),
  );
  check(
    "editing a non-selected model does not select it",
    consoleLines.filter((line) => line.includes("[harness] onChange"))
      .length === selectionsBeforeEdit &&
      (await catalogRow("Opus 5").getByLabel("Selected model").count()) === 1 &&
      ((await selectedModel().textContent()) ?? "").includes("High") &&
      !((await selectedModel().textContent()) ?? "").includes("Medium") &&
      !((await selectedModel().textContent()) ?? "").includes("Fast"),
  );
  check(
    "edited model row immediately shows remembered Medium Fast",
    ((await catalogRow("GPT-5.6 Terra").textContent()) ?? "").includes(
      "Medium",
    ) &&
      ((await catalogRow("GPT-5.6 Terra").textContent()) ?? "").includes(
        "Fast",
      ),
  );
  await page.keyboard.press("Escape");
  check(
    "Escape closes only the model editor before the catalog",
    (await catalog().isVisible()) &&
      (await waitFor(
        async () => !(await modelEditor().isVisible()),
        "model-editor-esc",
      )),
  );

  // Every catalog row owns a favorite control beside its model metadata. The
  // global default is filled at rest; all others reveal an outline star on
  // row hover/focus. Favoriting is configuration-only: it must not select a
  // row, close either popover, or steal the search caret.
  const catalogItemsCount = await catalog()
    .locator("[data-model-catalog-item]")
    .count();
  const catalogFavoriteCount = await catalog()
    .locator("[data-model-favorite-action]")
    .count();
  check(
    "every catalog model has a favorite action",
    catalogItemsCount > 0 && catalogFavoriteCount === catalogItemsCount,
    `${catalogFavoriteCount}/${catalogItemsCount}`,
  );
  const opusFavorite = catalogFavoriteButton("Opus 5");
  if ((await opusFavorite.count()) === 1) {
    const hiddenOpacity = await opusFavorite.evaluate(
      (button) => getComputedStyle(button).opacity,
    );
    await catalogRow("Opus 5").hover();
    const favoriteRevealed = await waitFor(
      () =>
        opusFavorite.evaluate(
          (button) => getComputedStyle(button).opacity === "1",
        ),
      "catalog-favorite-hover",
    );
    check(
      "non-default favorite star reveals on row hover",
      hiddenOpacity === "0" && favoriteRevealed,
      `${hiddenOpacity} -> ${favoriteRevealed ? "1" : "not 1"}`,
    );
    const selectionsBeforeFavorite = consoleLines.filter((line) =>
      line.includes("[harness] onChange"),
    ).length;
    await opusFavorite.click();
    check(
      "favorite click moves the one global default without selecting",
      (await waitFor(
        async () =>
          (await catalogRow("Opus 5")
            .locator("[data-default-model-indicator]")
            .count()) === 1,
        "favorite-model",
      )) &&
        (await catalog().locator("[data-default-model-indicator]").count()) ===
          1 &&
        (await catalogRow("GPT-5.6 Sol")
          .locator("[data-default-model-indicator]")
          .count()) === 0 &&
        consoleLines.filter((line) => line.includes("[harness] onChange"))
          .length === selectionsBeforeFavorite,
    );
    const activeDefaultMetadataBox = await catalogRow("Opus 5")
      .locator("[data-model-metadata]")
      .boundingBox();
    const activeDefaultStarBox = await catalogRow("Opus 5")
      .locator("[data-default-model-indicator]")
      .boundingBox();
    check(
      "an active default keeps its star directly beside its configuration",
      !!activeDefaultMetadataBox &&
        !!activeDefaultStarBox &&
        activeDefaultStarBox.x -
          (activeDefaultMetadataBox.x + activeDefaultMetadataBox.width) <=
          8,
    );
    check(
      "favorite click keeps catalog open and search focused",
      (await catalog().isVisible()) &&
        (await searchInput.evaluate(
          (input) => input === document.activeElement,
        )),
    );
    check(
      "collapsed selected model reflects the new default star",
      (await selectedModel()
        .locator("[data-default-model-indicator]")
        .count()) === 1,
    );
  } else {
    check("non-default favorite star reveals on row hover", false);
    check(
      "favorite click moves the one global default without selecting",
      false,
    );
    check(
      "an active default keeps its star directly beside its configuration",
      false,
    );
    check("favorite click keeps catalog open and search focused", false);
    check("collapsed selected model reflects the new default star", false);
  }

  // 3. Active-model settings and the searchable model list share one popover.
  //    There is no top-level Edit detour. A non-empty query closes the hover
  //    catalog and puts matching results directly below the same search input.
  check(
    "model search has no top-level Edit action",
    (await modelMenu().getByText("Edit", { exact: true }).count()) === 0,
  );
  check(
    "popover shows the Reasoning section",
    await page.getByText("Reasoning", { exact: true }).isVisible(),
  );
  check(
    "popover shows the Options section",
    await page.getByText("Options", { exact: true }).isVisible(),
  );
  const optionsBox = await page
    .getByText("Options", { exact: true })
    .boundingBox();
  const searchBox = await searchInput.boundingBox();
  check(
    "model search sits below configuration",
    !!optionsBox &&
      !!searchBox &&
      searchBox.y > optionsBox.y + optionsBox.height,
  );
  const modelHeadingBox = await modelMenu()
    .getByText("Model", { exact: true })
    .boundingBox();
  const searchRowBox = await modelMenu()
    .locator('[data-slot="command-input-wrapper"]')
    .boundingBox();
  check(
    "Model title precedes the always-focused search field",
    !!modelHeadingBox &&
      !!searchRowBox &&
      modelHeadingBox.y + modelHeadingBox.height <= searchRowBox.y,
  );
  const modelSectionSeparators = await modelMenu().evaluate((menu) => {
    const command = menu.querySelector("[cmdk-root]");
    const inputWrapper = menu.querySelector(
      '[data-slot="command-input-wrapper"]',
    );
    return {
      beforeTitle: command ? getComputedStyle(command).borderTopWidth : "0px",
      afterSearch: inputWrapper
        ? getComputedStyle(inputWrapper).borderBottomWidth
        : "0px",
    };
  });
  check(
    "Model title/search block has separators before the title and after search",
    modelSectionSeparators.beforeTitle === "1px" &&
      modelSectionSeparators.afterSearch === "1px",
    JSON.stringify(modelSectionSeparators),
  );
  await searchInput.fill("GPT-5.6");
  check(
    "search query closes the unfiltered catalog sidecar",
    await waitFor(async () => !(await catalog().isVisible()), "catalog-close"),
  );
  const searchItemGaps = await page
    .locator("[cmdk-item]")
    .evaluateAll((items) =>
      items.slice(1).map((item, index) => {
        const previous = items[index].getBoundingClientRect();
        const current = item.getBoundingClientRect();
        return current.top - previous.bottom;
      }),
    );
  check(
    "search-result items have the same exact 1px gap",
    searchItemGaps.length > 0 &&
      searchItemGaps.every((gap) => Math.abs(gap - 1) <= 0.5),
    searchItemGaps.join(","),
  );
  await searchInput.fill("Fable");
  check(
    "search filters to matching model results",
    (await page.locator("[cmdk-item]").count()) === 1 &&
      (await rowText("Fable 5")).includes("Fable 5"),
  );
  const searchRowHeight = await modelRow("Fable 5").evaluate(
    (row) => row.getBoundingClientRect().height,
  );
  check(
    "search results use the same compact 26px model-row height",
    Math.abs(searchRowHeight - 26) <= 0.5,
    `${searchRowHeight}px`,
  );
  const searchRowPadding = await modelRow("Fable 5").evaluate((row) => ({
    top: getComputedStyle(row).paddingTop,
    bottom: getComputedStyle(row).paddingBottom,
  }));
  check(
    "search-result rows use 4px top and bottom padding",
    searchRowPadding.top === "4px" && searchRowPadding.bottom === "4px",
    JSON.stringify(searchRowPadding),
  );
  const resultBox = await modelRow("Fable 5").boundingBox();
  const filteredSearchBox = await searchInput.boundingBox();
  check(
    "search results render below the search field",
    !!resultBox &&
      !!filteredSearchBox &&
      resultBox.y >= filteredSearchBox.y + filteredSearchBox.height,
  );
  const fableFavorite = modelRow("Fable 5").locator(
    "[data-model-favorite-action]",
  );
  const fableEdit = modelRow("Fable 5").getByRole("button", {
    name: "Edit settings for Fable 5",
  });
  await searchInput.hover();
  const fableEditAtRest = await fableEdit.evaluate((button) => ({
    opacity: getComputedStyle(button).opacity,
    pointerEvents: getComputedStyle(button).pointerEvents,
  }));
  check(
    "search-result Edit stays hidden until row hover",
    fableEditAtRest.opacity === "0" && fableEditAtRest.pointerEvents === "none",
    JSON.stringify(fableEditAtRest),
  );
  check(
    "search result exposes its favorite action",
    (await fableFavorite.count()) === 1,
  );
  check(
    "search-result favorite stays inline when the model phrase fits",
    (await modelRow("Fable 5").getAttribute("data-favorite-placement")) ===
      "inline",
  );
  if ((await fableFavorite.count()) === 1) {
    await modelRow("Fable 5").hover();
    check(
      "search-result favorite star reveals on hover",
      await waitFor(
        () =>
          fableFavorite.evaluate(
            (button) => getComputedStyle(button).opacity === "1",
          ),
        "search-favorite-hover",
      ),
    );
    check(
      "search-result Edit reveals with the favorite action",
      await waitFor(
        () =>
          fableEdit.evaluate(
            (button) =>
              getComputedStyle(button).opacity === "1" &&
              getComputedStyle(button).pointerEvents !== "none",
          ),
        "search-edit-hover",
      ),
    );
    const searchSelectionsBeforeFavorite = consoleLines.filter((line) =>
      line.includes("[harness] onChange"),
    ).length;
    await fableFavorite.click();
    check(
      "search-result favorite changes only the default and preserves search",
      (await waitFor(
        async () =>
          (await modelRow("Fable 5")
            .locator("[data-default-model-indicator]")
            .count()) === 1,
        "search-favorite-model",
      )) &&
        (await menuOpen()) &&
        (await searchInput.inputValue()) === "Fable" &&
        (await searchInput.evaluate(
          (input) => input === document.activeElement,
        )) &&
        consoleLines.filter((line) => line.includes("[harness] onChange"))
          .length === searchSelectionsBeforeFavorite,
    );
    // The harness's null model deliberately follows Claude's default, so the
    // new Fable default also becomes its pending active model. Round-trip the
    // default to Opus before the later Opus-only Fast assertions, while proving
    // the same search-row favorite path remains selection-free in reverse.
    await searchInput.fill("Opus 5");
    const opusSearchFavorite = modelRow("Opus 5").locator(
      "[data-model-favorite-action]",
    );
    await modelRow("Opus 5").hover();
    await opusSearchFavorite.click();
    check(
      "search favorite round-trip restores a default-bound pending model",
      (await waitFor(
        async () =>
          (await modelRow("Opus 5")
            .locator("[data-default-model-indicator]")
            .count()) === 1,
        "search-favorite-restore",
      )) &&
        consoleLines.filter((line) => line.includes("[harness] onChange"))
          .length === searchSelectionsBeforeFavorite,
    );
    await searchInput.fill("Fable");
    await modelRow("Fable 5").hover();
  } else {
    check("search-result favorite star reveals on hover", false);
    check("search-result Edit reveals with the favorite action", false);
    check(
      "search-result favorite changes only the default and preserves search",
      false,
    );
    check(
      "search favorite round-trip restores a default-bound pending model",
      false,
    );
  }
  check(
    "search-result editor uses Edit text",
    (
      (await modelRow("Fable 5")
        .getByRole("button", { name: "Edit settings for Fable 5" })
        .textContent()) ?? ""
    ).trim() === "Edit",
  );
  const searchSelectionsBeforeEdit = consoleLines.filter((line) =>
    line.includes("[harness] onChange"),
  ).length;
  await modelRow("Fable 5")
    .getByRole("button", { name: "Edit settings for Fable 5" })
    .click();
  check(
    "filtered result editor opens without selecting its command row",
    (await waitFor(() => modelEditor().isVisible(), "search-editor-open")) &&
      (await menuOpen()) &&
      consoleLines.filter((line) => line.includes("[harness] onChange"))
        .length === searchSelectionsBeforeEdit,
  );
  await page.keyboard.press("Escape");
  check(
    "closing a filtered result editor preserves its query and result",
    (await menuOpen()) &&
      (await searchInput.inputValue()) === "Fable" &&
      (await page.locator("[cmdk-item]").count()) === 1,
  );
  await searchInput.fill("");
  check(
    "clearing search collapses back to selected-only",
    (await page.locator("[cmdk-item]").count()) === 0 &&
      (await selectedModel().count()) === 1,
  );
  await page.getByRole("radio", { name: "Max", exact: true }).click();
  const fastSwitch = page.getByRole("switch", {
    name: "Fast mode for claude-opus-5[1m]",
  });
  await fastSwitch.click();
  check(
    "popover enables Fast",
    (await fastSwitch.getAttribute("aria-checked")) === "true",
  );
  check(
    "selected model shows its remembered Max Fast state",
    await waitFor(async () => {
      const text = (await selectedModel().textContent()) ?? "";
      return text.includes("Max") && text.includes("Fast");
    }, "row-config"),
  );
  check(
    "Escape closes the configured model menu after nested layers",
    await closeModelMenuWithEscape("close-after-configure"),
  );
  const configuredPillText = (
    (await pill.locator("[data-model-pill-label]").textContent()) ?? ""
  )
    .replace(/\s+/g, " ")
    .trim();
  check(
    "composer model pill reflects effort and Fast configuration",
    configuredPillText === "Opus 5 Max Fast",
    configuredPillText,
  );
  check(
    "configured composer still has no standalone Fast or effort controls",
    (await page.getByRole("button", { name: /fast mode/i }).count()) === 0 &&
      (await page
        .getByRole("button", { name: /reasoning effort:/i })
        .count()) === 0,
  );

  // 4. A→B→A restores each model's own memory. Selecting rows still reaches
  //    onChange and closes, and the controlled popover can reopen.
  await pill.click();
  check(
    "menu re-opens after configuration",
    await waitFor(menuOpen, "reopen-after-configure"),
  );
  await page.waitForTimeout(600);
  check("re-opened menu stays open", await menuOpen());
  await searchInput.fill("Fable");
  await modelRow("Fable 5").click({ position: { x: 8, y: 8 } });
  check(
    "selecting a row closes the menu",
    await waitFor(async () => !(await menuOpen()), "close-on-select"),
  );
  check(
    "selection reaches onChange",
    consoleLines.some((l) => l.includes("[harness] onChange")),
  );

  await pill.click();
  check("menu re-opens after a selection", await waitFor(menuOpen, "reopen"));
  check(
    "second model keeps its own High/non-Fast defaults",
    ((await selectedModel().textContent()) ?? "").includes("High") &&
      !((await selectedModel().textContent()) ?? "").includes("Fast"),
  );
  await searchInput.fill("Opus 5");
  await modelRow("Opus 5").click({ position: { x: 8, y: 8 } });
  await waitFor(async () => !(await menuOpen()), "close-second-selection");
  await pill.click();
  await waitFor(menuOpen, "reopen-restored-model");
  check(
    "returning to the first model restores Max Fast",
    ((await selectedModel().textContent()) ?? "").includes("Max") &&
      ((await selectedModel().textContent()) ?? "").includes("Fast"),
  );
  // Wait for Radix's focus scope before Escape, mirroring a user key press.
  await waitFor(
    () => page.evaluate(() => document.activeElement?.tagName === "INPUT"),
    "search-focus",
  );
  const finalMenuClosed = await closeModelMenuWithEscape("final-escape");
  check("Escape closes the menu", finalMenuClosed);

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
      // `text-indent: <n>ch hanging` — the keyword is the whole mechanism, so
      // read it rather than inferring it from the sign.
      const hanging = cs.textIndent.includes("hanging");
      // Where the line's own content box starts: row 1 must begin exactly here.
      const contentLeft = line.getBoundingClientRect().left + paddingLeft;
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
      return {
        paddingLeft,
        textIndent,
        hanging,
        contentLeft,
        rowLefts: rows.map((r) => r.left),
      };
    })
    .catch(() => null);
  check(
    "File Edit fixture's indented line wraps",
    (hang?.rowLefts.length ?? 0) >= 2,
    `${hang?.rowLefts.length ?? 0} visual rows`,
  );
  check(
    "Wrapped rows hang at the line's own indent",
    hang !== null && hang.hanging && hang.textIndent > 0,
    `text-indent ${hang?.textIndent}px${hang?.hanging ? " hanging" : ""}`,
  );
  // Row 1 stays inside the content box. The classic `padding-left: Nch;
  // text-indent: -Nch` pair hung the same rows but pulled row 1 OUT of it,
  // which drags the CSS tab-stop origin along and renders leading tabs short.
  check(
    "Row 1 is not pulled out of the line's content box (tab stops intact)",
    hang !== null &&
      hang.paddingLeft === 6 &&
      Math.abs(hang.rowLefts[0] - hang.contentLeft) < 0.5,
    `row 1 at ${hang?.rowLefts[0]?.toFixed(1)}, content box at ${hang?.contentLeft?.toFixed(1)}, padding-left ${hang?.paddingLeft}px`,
  );
  check(
    "Continuation rows align with row 1's indent point",
    hang !== null &&
      hang.rowLefts.length >= 2 &&
      hang.rowLefts
        .slice(1)
        .every((l) => Math.abs(l - (hang.rowLefts[0] + hang.textIndent)) < 1),
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
    await waitFor(async () => {
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
    }, "tree-panel-search-filter"),
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
