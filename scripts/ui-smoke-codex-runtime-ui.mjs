import { expect } from "@playwright/test";

export async function runCodexRuntimeUiSmoke({ page, check, harnessBase }) {
  for (const owner of ["personal-local", "organization-local", "organization-cloud"]) {
    const placement = owner === "organization-cloud" ? "cloud" : "local";
    for (const theme of ["dark", "light"]) {
      await page.goto(`${harnessBase}/harness-codex-runtime-ui.html?placement=${placement}&owner=${owner}&theme=${theme}`);
      await checkTranscript({ page, check, owner, theme });
      const row = state => page.locator(`#codex-mcp-${state} [data-tool-id=linear]`);
      await expect(row("authenticate").getByRole("button", { name: "Authenticate linear", exact: true })).toHaveText("Authenticate");
      for (const state of ["opening", "stale-completion"]) {
        await expect(row(state).getByRole("button", { name: "Authenticate linear", exact: true })).toHaveText("Opening…");
        await expect(row(state).getByRole("button")).toBeDisabled();
        await expect(row(state).getByRole("img", { name: /Connected|Sign-in failed/ })).toHaveCount(0);
      }
      await expect(row("connected").getByRole("img", { name: "Connected", exact: true })).toBeVisible();
      await expect(row("failed").getByRole("img", { name: "Sign-in failed", exact: true })).toBeVisible();
      await row("failed").getByRole("button", { name: "Authenticate linear", exact: true }).click();
      await expect(row("failed").getByRole("button")).toHaveText("Opening…");
      await expect(row("failed").getByRole("button")).toBeDisabled();
      await page.evaluate(() => window.setCodexMcpFixture("failed", "connected"));
      await expect(row("failed").getByRole("img", { name: "Connected", exact: true })).toBeVisible();
      await row("authenticate").getByRole("button", { name: "Authenticate linear", exact: true }).click();
      await expect(row("authenticate").getByRole("button")).toHaveText("Opening…");
      for (const id of ["authenticate", "opening", "stale-completion", "connected", "failed"]) {
        await expect(page.locator(`#codex-mcp-${id} [data-tool-group-count]`)).toHaveText("3");
        await expect(page.locator(`#codex-mcp-${id} [data-tool-id=github] [role=img]`)).toHaveAttribute("aria-label", "Connected");
        await expect(page.locator(`#codex-mcp-${id} [data-tool-id=sentry] [role=img]`)).toHaveAttribute("aria-label", "Connected");
      }
      check(`MCP Authenticate, Opening, ignored stale completion, success, failure and retry render in ${owner}/${theme}`, true);

      const write = page.locator("#codex-write-access [data-permission-card]");
      await expect(write.getByText("Do you want to allow write access outside the workspace?", { exact: true })).toBeVisible();
      await expect(write.locator("[data-permission-context-item]")).toHaveText(["Write · ../shared/build"]);
      await expect(write).not.toContainText("pnpm build");
      await expect(write).not.toContainText("Reads unchanged");
      await expect(write).not.toContainText("Network unchanged");
      await expect(write.getByRole("button")).toHaveText([/Yes/, /Allow for this chat/, /No/]);
      await write.getByRole("button", { name: /^Yes/ }).click();
      await expect.poll(() => page.evaluate(() => window.codexPermissionResponses)).toEqual(["codex-write-access:accept"]);
      const ordinary = page.locator("#codex-ordinary-approval [data-permission-card]");
      await expect(ordinary).toContainText("Do you want to run this command?");
      await expect(ordinary).toContainText("Bash");
      await expect(ordinary).toContainText("pnpm test --filter engine");
      await expect(ordinary.locator("[data-permission-context-item]")).toHaveCount(0);
      await expect(ordinary.getByRole("button")).toHaveText([/Yes/, /Allow for this chat/, /No/]);
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      check(`Write access uses one chip and unchanged options; ordinary command stays visible in ${owner}/${theme}`, fits);
    }
  }
}

async function checkTranscript({ page, check, owner, theme }) {
  const fixture = page.locator("#codex-runtime-transcript");
  const feed = fixture.locator("#codex-runtime-feed");
  const header = feed.getByRole("button", { name: "Agent Research", exact: true });
  const timer = feed.locator('[role="status"] [aria-live="off"]');
  const report = feed.getByText(`First confirmed finding for ${owner}.`, { exact: true });
  const start = await fixture.getAttribute("data-started-at");
  await expect(header).toContainText("GPT-6.1 Sol Max");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(timer).toHaveCount(1);
  await expect(timer).toHaveText(/1m,/);
  await header.focus();
  await page.keyboard.press("Enter");
  const childReport = feed.getByText("The child found the affected code.", { exact: true });
  await expect(childReport).toBeVisible();
  check(`Child partial answer stays outside its work feed in ${owner}/${theme}`,
    await childReport.evaluate((node) => !!node.closest("[data-agent-output]") && !node.closest("[data-agent-output] .zeros-working-feed")));
  const disclosures = [
    feed.getByRole("button", { name: "Prompt", exact: true }),
    feed.getByRole("button", { name: "Agent Nested review", exact: true }),
    feed.getByRole("button", { name: "Bash printf nested-details", exact: true }),
    feed.getByRole("button", { name: "Bash printf before-report", exact: true }),
    feed.getByRole("button", { name: "Bash printf phase-details", exact: true }),
    feed.getByRole("button", { name: /^Read.*batch-b\.ts$/ }),
    feed.getByRole("button", { name: /^(?:Edit|Write).*changed-b\.ts$/ }),
    feed.getByRole("button", { name: "Used the browser", exact: true }),
    feed.getByRole("button", { name: /^Thinking/ }),
  ];
  for (const disclosure of disclosures) {
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  }
  await fixture.getByRole("button", { name: "Show partial answer", exact: true }).click();
  await expect(report).toBeVisible();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  for (const disclosure of disclosures) await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await fixture.getByRole("button", { name: "Confirm child partial answer", exact: true }).click();
  for (const disclosure of disclosures) await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  for (const text of ["Inspect the affected source.", "Nested review details stay visible.",
    "Nested command details stay visible.", "Earlier tool details stay visible.", "Later tool details stay visible.",
    "Shared batch read result."]) {
    await expect(feed.getByText(text, { exact: true })).toBeVisible();
  }
  const nestedReport = feed.getByText("The child confirmed another finding.", { exact: true });
  check(`Late parent and child phases preserve Agent, prompt, tool and Thinking disclosures in ${owner}/${theme}`,
    await nestedReport.evaluate((node) => !!node.closest("[data-agent-output]")));
  await expect(feed.getByRole("button", { name: /^Read.*batch-a\.ts$/ })).toHaveAttribute("aria-expanded", "false");
  await expect(feed.getByRole("button", { name: /^(?:Edit|Write).*changed-a\.ts$/ })).toHaveAttribute("aria-expanded", "false");
  check(`Partial answer stays in source order with more work below it in ${owner}/${theme}`, await report.evaluate((node) => {
    const root = document.getElementById("codex-runtime-feed");
    const prose = [...root.querySelectorAll(".zeros-agent-md")];
    const index = prose.findIndex((element) => element.contains(node));
    return !node.closest(".zeros-working-feed") && index > 0 && prose.slice(index + 1).some((element) => element.textContent.includes("Checking the remaining cases."));
  }));
  await expect(fixture).toHaveAttribute("data-started-at", start);
  await expect(timer).toHaveCount(1);
  const before = await timer.textContent();
  await expect(timer).not.toHaveText(before);
  await fixture.getByRole("button", { name: "Complete child", exact: true }).click();
  await expect(header).toContainText("GPT-6.1 Sol Max");
  await expect(header.getByLabel("Agent working", { exact: true })).toHaveCount(0);
  await expect(timer).toHaveCount(1);
  await fixture.getByRole("button", { name: "Resume child", exact: true }).click();
  await expect(header).toContainText("GPT-6.1 Sol Max");
  await expect(header.getByLabel("Agent working", { exact: true })).toHaveCount(1);
  await fixture.getByRole("button", { name: "Switch chat", exact: true }).click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  await fixture.getByRole("button", { name: "Switch chat", exact: true }).click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  for (const other of ["personal-local", "organization-local", "organization-cloud"].filter((value) => value !== owner)) {
    await fixture.getByRole("button", { name: other, exact: true }).click();
    await expect(report).toHaveCount(0);
    await expect(feed.getByText(`Inspecting source for ${other}.`, { exact: true })).toBeVisible();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(feed.getByRole("button", { name: "Bash printf phase-details", exact: true })).toHaveAttribute("aria-expanded", "false");
  }
  await fixture.getByRole("button", { name: owner, exact: true }).click();
  await expect(report).toBeVisible();
  await expect(fixture).toHaveAttribute("data-started-at", start);
  await fixture.getByRole("button", { name: "Toggle transcript visibility", exact: true }).click();
  await expect(feed).toBeHidden();
  await expect(timer).toHaveCount(0);
  await fixture.getByRole("button", { name: "Toggle transcript visibility", exact: true }).click();
  await expect(report).toBeVisible();
  await page.reload();
  await expect(report).toBeVisible();
  await expect(header).toContainText("GPT-6.1 Sol Max");
  await expect(fixture).toHaveAttribute("data-started-at", start);
  await expect(timer).toHaveCount(1);
  await fixture.getByRole("button", { name: "Complete turn", exact: true }).click();
  await expect(report).toBeVisible();
  await expect(feed.getByText("All findings are confirmed.", { exact: true })).toBeVisible();
  await expect(timer).toHaveCount(0);
  await page.reload();
  await expect(report).toBeVisible();
  await expect(feed.getByText("All findings are confirmed.", { exact: true })).toBeVisible();
  await expect(feed.locator("[data-codex-fixture-footer]")).toHaveCount(1);
  check(`Partial reports, model/effort and the single turn clock survive resume, owner switching and reload in ${owner}/${theme}`, true);
}
