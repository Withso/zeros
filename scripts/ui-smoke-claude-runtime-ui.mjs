import { expect } from "@playwright/test";

const unavailableCopy = "Claude couldn't load your organization's required settings. Check your connection, then retry.";
const refusedCopy = "Your organization's Claude settings were refused for this sign-in. Sign in again or ask your administrator.";

export async function runClaudeRuntimeUiSmoke({ page, check, harnessBase }) {
  const transcript = `${harnessBase}/harness-claude-runtime-ui.html`;
  const modelMenu = `${harnessBase}/harness-model-menu.html`;

  await page.goto(`${modelMenu}?haiku`);
  const pill = page.getByRole("button", { name: /^Model:/ });
  await expect(pill.locator("[data-model-pill-name]")).toHaveText("Haiku 5.5 ");
  await expect(pill.locator("[data-model-pill-metadata]")).toHaveText("Medium");
  await pill.click();
  const reasoning = page.getByRole("radiogroup", { name: "Reasoning effort" });
  await expect(reasoning.getByRole("radio")).toHaveText(["Low", "Medium", "High", "Extra High", "Max"]);
  await expect(reasoning.getByRole("radio", { name: "Medium", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: /Fast mode/ })).toHaveCount(0);
  await page.getByTestId("selected-model-browser").hover();
  const catalog = page.getByTestId("model-catalog-sidecar");
  await expect(catalog).toBeVisible();
  const names = await catalog.locator("[data-model-name]").allTextContents();
  const haikuIndex = names.indexOf("Haiku 5.5");
  check("Haiku 5.5 is between Sonnet 5 and Haiku 4.5 in the live catalog", haikuIndex > 0 && names[haikuIndex - 1] === "Sonnet 5" && names[haikuIndex + 1] === "Haiku 4.5", JSON.stringify(names));
  await page.getByTestId("selected-model-browser").hover();
  await catalog.getByRole("button", { name: "Select Haiku 5.5", exact: true }).click();
  await expect(pill.locator("[data-model-pill-name]")).toHaveText("Haiku 5.5 ");
  check("Haiku 5.5 uses its native Medium default and no Fast/Ultracode control", true);

  await page.goto(`${modelMenu}?haiku&haikuEfforts=none`);
  await page.getByRole("button", { name: /^Model:/ }).click();
  await expect(page.getByRole("radiogroup", { name: "Reasoning effort" })).toHaveCount(0);
  await expect(page.locator("[data-model-pill-metadata]")).toHaveCount(0);
  check("An exact live empty Haiku effort ladder hides Reasoning and effort metadata", true);
  await page.goto(`${modelMenu}?haiku&haikuEfforts=low,high`);
  await page.getByRole("button", { name: /^Model:/ }).click();
  await expect(page.getByRole("radio")).toHaveText(["Low", "High"]);
  await expect(page.getByRole("radio", { name: "High", exact: true })).toHaveAttribute("aria-checked", "true");
  check("A narrower live ladder never invents a Medium choice", true);

  for (const [version, expected] of [["2.1.288", 1], ["2.1.293", 0]]) {
    await page.goto(`${modelMenu}?haiku&cloudRuntime=${version}`);
    await page.getByRole("button", { name: /^Model:/ }).click();
    await expect(page.locator("[data-cloud-runtime-update-note]")).toHaveCount(expected);
    if (expected) await expect(page.locator("[data-cloud-runtime-update-note]")).toHaveText("Agents need a runtime update. It installs the next time this workspace wakes.");
  }
  check("The selected model's CLI minimum shows the cloud update note to a prompter only on older runtimes", true);

  await page.goto(transcript);
  const runIds = ["background-run-1", "background-run-finished", "background-run-2", "background-run-late"];
  for (const id of runIds) {
    const state = page.locator(`#${id}`);
    await expect(state.getByRole("button", { name: "Background Task pnpm dev --watch", exact: true })).toBeVisible();
    await state.getByRole("button", { name: "Background Task pnpm dev --watch", exact: true }).click();
    await expect(state.locator("[data-background-task-run]")).toHaveCount(id === "background-run-2" || id === "background-run-late" ? 1 : 0);
    if (id !== "background-run-finished") {
      await expect(state.getByText("Waiting for 1 background task", { exact: true })).toBeVisible();
      const elapsed = await state.locator("[role=status] .tabular-nums").innerText();
      const minutes = Number(elapsed.match(/(\d+)m/)?.[1] ?? 0);
      const seconds = Number(elapsed.match(/(\d+)s/)?.[1] ?? 0);
      check(`${id} waiting uses the original turn clock`, minutes * 60 + seconds >= 52, elapsed);
    } else await expect(state.getByText("Waiting for 1 background task", { exact: true })).toHaveCount(0);
  }
  await expect(page.locator("#background-run-2 [data-background-task-run]")).toHaveText("Run2");
  await expect(page.locator("#background-run-late [data-background-task-run]")).toHaveText("Run2");
  check("Only resumed background runs expose an ordinal; normalized stale completion retains the running state and stable task row", true);

  await expect(page.locator("#claude-agent-metadata [data-agent-label]")).toContainText("Agent · Explore · Sonnet 5.5");
  await expect(page.locator("#claude-agent-metadata [data-agent-effort]")).toHaveText("High");
  await expect(page.locator("#claude-agent-missing-metadata [data-agent-label]")).toHaveText("Agent");
  await expect(page.locator("#claude-agent-missing-metadata [data-agent-effort]")).toHaveCount(0);
  const parent = page.locator("#claude-agent-nested");
  await parent.getByRole("button", { name: "Agent Review the workspace", exact: true }).click();
  const child = parent.locator("[data-agent-children] [data-agent-group]");
  await expect(child.locator("[data-agent-label]").first()).toContainText("Agent · Plan · Haiku 5.5");
  await child.getByRole("button", { name: "Agent Plan the migration", exact: true }).click();
  await expect(child.getByRole("button", { name: "Read 1 line router.ts", exact: true })).toBeVisible();
  const resumed = page.locator("#claude-agent-resumed");
  await expect(resumed.getByLabel("Agent working", { exact: true })).toBeVisible();
  await expect(resumed.locator("[data-agent-label]")).toHaveText("Agent · Explore · Sonnet 5.5 High");
  await resumed.getByRole("button", { name: "Agent Review the workspace", exact: true }).click();
  await expect(resumed.locator("[data-agent-group]")).toHaveCount(1);
  await expect(resumed.getByRole("button", { name: "Read 1 line router.ts", exact: true })).toBeVisible();
  check("A resumed Agent projection keeps its metadata, running icon, and retained unboxed feed", true);
  await expect(page.locator("#claude-background-agent")).toContainText("Explore · Audit flaky tests");
  const label = page.locator("#claude-agent-metadata [data-agent-effort]");
  const metadataStyle = await label.evaluate(element => {
    const style = getComputedStyle(element);
    return { size: style.fontSize, opacity: style.opacity };
  });
  for (const metadata of [label, child.locator("[data-agent-effort]")]) {
    const visible = await metadata.evaluate(element => {
      const effort = element.getBoundingClientRect();
      const label = element.closest("[data-agent-label]").getBoundingClientRect();
      return effort.left >= label.left && effort.right <= label.right;
    });
    check("Agent effort stays visible beside the model when the transcript has room", visible);
  }
  check("Agent type/model/effort use the existing metadata style and child groups stay in the parent's unboxed body", metadataStyle.size === "13px" && metadataStyle.opacity === "0.8", JSON.stringify(metadataStyle));

  const unavailable = page.locator("#claude-org-unavailable");
  const refused = page.locator("#claude-org-refused");
  await expect(unavailable).toContainText(unavailableCopy);
  await expect(refused).toContainText(refusedCopy);
  await expect(unavailable.locator(".lucide-arrow-right")).toHaveCount(1);
  await expect(refused.locator(".lucide-log-in")).toHaveCount(1);
  await expect(unavailable.getByRole("button")).toHaveCount(1);
  await unavailable.getByRole("button", { name: "Retry", exact: true }).click();
  await refused.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#claude-startup-actions")).toHaveText(JSON.stringify({ retries: 1, signIns: 1, connected: true }));
  await page.locator("#claude-provider-connection").click();
  const connection = page.getByRole("dialog");
  await expect(connection.getByLabel("Connected", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  check("Organization startup reasons use the existing Retry/Sign in notices and the unavailable case retains a connected provider", true);

  const chrome = page.locator("#claude-chrome-setup");
  await expect(chrome.locator(".lucide-chrome")).toHaveCount(1);
  await expect(chrome.getByText("Test checkout in your browser", { exact: true })).toBeVisible();
  await expect(chrome.getByText("not_now", { exact: true })).toHaveCount(0);
  await expect(chrome.locator("[data-chrome-setup-notice] .lucide-settings")).toHaveCount(1);
  await chrome.getByRole("button", { name: "Open Settings", exact: true }).click();
  await expect(page.locator("#browser-use-claude-enabled")).toBeVisible();
  check("Chrome setup shows only its reason, and Open Settings navigates to the Local Browser use controls", true);

  for (const placement of ["local", "cloud"]) {
    await page.goto(`${transcript}?settings=models&placement=${placement}`);
    const toggle = page.getByRole("switch", { name: "Claude idle compaction", exact: true });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    const row = page.locator("div").filter({ has: page.locator('label[for="claude-idle-compaction"]') }).last().locator("..");
    await expect(row).toContainText("Compact long conversations while the session is idle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const state = await page.evaluate(() => ({ updates: window.claudeRuntimeUi.updates, preferences: window.claudeRuntimeUi.preferences(), folder: window.claudeRuntimeUi.folder }));
    check(`${placement} Idle compaction On updates loaded Claude sessions and the synced preference`,
      state.updates.at(-1)?.env.ZEROS_CLAUDE_IDLE_COMPACTION === "1" &&
      state.preferences.some(edit => edit.path.join(".") === "models.claude_code.idle_compaction_enabled" && edit.value === true) &&
      (placement !== "cloud" || state.folder.startsWith("cloud://")));
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    const off = await page.evaluate(() => window.claudeRuntimeUi.updates.at(-1)?.env.ZEROS_CLAUDE_IDLE_COMPACTION);
    check(`${placement} Idle compaction Off remains explicit after reload`, off === "0");
  }

  // The organization-owned Browser use panel must be reachable by the same
  // Chrome notice action, including its honest cloud availability explanation.
  await page.goto(`${transcript}?owner=organization&placement=cloud`);
  await page.getByRole("button", { name: "Open Settings", exact: true }).click();
  await expect(page.getByText("Native browser is unavailable in cloud workspaces.", { exact: true })).toHaveCount(2);
  await expect(page.locator("#browser-use-claude-enabled")).toHaveCount(0);
  check("Cloud Chrome setup opens the existing organization Browser use availability panel", true);

  for (const theme of ["dark", "light"]) {
    await page.goto(transcript);
    await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
    const widths = await page.locator("[data-agent-notice], [data-agent-group], #claude-chrome-setup").evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth));
    check(`Claude runtime UI fits its surfaces in ${theme}`, widths);
  }
}
