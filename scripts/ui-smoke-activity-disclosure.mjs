import { expect } from "@playwright/test";
import { runWorkingGroupsSmoke } from "./ui-smoke-working-groups.mjs";

export async function runActivityDisclosureSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  // The large history interleaves calls with narration. With in-between
  // messages folded (the setting off) it is one group whose disclosure must
  // survive paging, retention and reload.
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-activity-disclosure.html`);
  await page.evaluate(() => localStorage.setItem("zeros.showInBetweenMessages", "false"));
  try {
    await runFoldedActivityDisclosure({ page, check, origin });
  } finally {
    await page.evaluate(() => localStorage.removeItem("zeros.showInBetweenMessages"));
  }
  await runWorkingGroupsSmoke({ page, check, origin });
}

async function runFoldedActivityDisclosure({ page, check, origin }) {
  for (const provider of ["Claude", "Codex", "Cursor"]) {
    await page.goto(
      `${origin}/apps/desktop/src/renderer/harnesses/harness-activity-disclosure.html?provider=${provider}`,
    );
    const transcript = page.locator("#activity-transcript-a");
    const scroller = page.locator("#activity-scroller-a");
    const largeGroup = transcript.getByRole("button", {
      name: /^Worked for .+, \d+ tool calls, \d+ messages, 2 agents$/,
    });
    await expect(largeGroup).toHaveAttribute(
      "aria-label", /, 257 tool calls, 224 messages, 2 agents$/,
    );
    await expect(largeGroup).toHaveAttribute("aria-expanded", "false");
    await largeGroup.click();
    await expect(largeGroup).toHaveAttribute("aria-expanded", "true");
    const tool = transcript.getByRole("button", {
      name: "Bash echo tool-0",
      exact: true,
    });
    const worker = transcript.getByRole("button", {
      name: "Agent Synthetic worker worker-one",
      exact: true,
    });
    await tool.click();
    await worker.click();
    const childTool = transcript.getByRole("button", {
      name: "Bash echo child-tool",
      exact: true,
    });
    const prompt = transcript.getByRole("button", {
      name: "Prompt",
      exact: true,
    });
    await childTool.click();
    await prompt.click();

    // CSS content-visibility may skip the offscreen turn's layout, but must
    // preserve the mounted disclosure and its explicit expanded choice.
    await largeGroup.evaluate((element) => {
      window.activitySummaryNode = element;
    });
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(largeGroup).toHaveAttribute("aria-expanded", "true");
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(largeGroup).toHaveAttribute("aria-expanded", "true");
    check(
      `${provider}: offscreen history keeps its mounted activity disclosure`,
      await largeGroup.evaluate(
        (element) => element === window.activitySummaryNode,
      ),
    );

    // A real upward wheel crosses the same near-top pagination threshold as
    // AgentChat. The prepend changes both first-event React keys.
    await scroller.evaluate((element) => {
      element.scrollTop = 1400;
    });
    await page
      .getByRole("button", { name: "Enable pagination", exact: true })
      .click();
    await scroller.hover();
    await page.mouse.wheel(0, -1600);
    await expect(page.locator("#history-page")).toHaveText("1");
    await expect(largeGroup).toHaveAttribute(
      "aria-label", /, 357 tool calls, 324 messages, 2 agents$/,
    );
    await expect(largeGroup).toHaveAttribute("aria-expanded", "true");
    for (const nested of [tool, worker, childTool, prompt])
      await expect(nested).toHaveAttribute("aria-expanded", "true");
    await page
      .getByRole("button", { name: "Load opening prompt", exact: true })
      .click();
    await expect(page.locator("#history-page")).toHaveText("2");
    await expect(largeGroup).toHaveAttribute("aria-expanded", "true");
    for (const nested of [tool, worker, childTool, prompt])
      await expect(nested).toHaveAttribute("aria-expanded", "true");
    await page
      .getByRole("button", { name: "Reload transcript", exact: true })
      .click();
    for (const nested of [tool, worker, childTool, prompt])
      await expect(nested).toHaveAttribute("aria-expanded", "true");
    check(
      `${provider}: prepending history, its missing prompt and child rows preserves the expanded subtree`,
      await largeGroup.evaluate(
        (element) => element === window.activitySummaryNode,
      ),
    );

    // A single call between two reports is a row, not a group; each row
    // keeps its own disclosure.
    const reportGroups = transcript.getByRole("button", {
      name: /^Bash echo after-steer-(?:one|two)$/,
    });
    await reportGroups.first().click();
    await expect(reportGroups.first()).toHaveAttribute("aria-expanded", "true");
    await expect(reportGroups.last()).toHaveAttribute("aria-expanded", "false");
    await largeGroup.click();
    await expect(largeGroup).toHaveAttribute("aria-expanded", "false");
    await page
      .getByRole("button", { name: "Reload transcript", exact: true })
      .click();
    await expect(largeGroup).toHaveAttribute("aria-expanded", "false");
    await expect(reportGroups.first()).toHaveAttribute("aria-expanded", "true");
    await expect(reportGroups.last()).toHaveAttribute("aria-expanded", "false");

    await page
      .getByRole("button", { name: "Switch chat", exact: true })
      .click();
    await expect(page.locator("#activity-chat")).toHaveText("b");
    const otherTranscript = page.locator("#activity-transcript-b");
    const otherReports = otherTranscript.getByRole("button", {
      name: /^Bash echo after-steer-(?:one|two)$/,
    });
    const otherLarge = otherTranscript.getByRole("button", {
      name: /^Worked for .+, \d+ tool calls, \d+ messages, 2 agents$/,
    });
    await expect(otherReports.first()).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await page
      .getByRole("button", { name: "Resume turn", exact: true })
      .click();
    // Live, narration sits outside the runs, so the folded group splits up.
    await expect(otherLarge).toHaveCount(0);
    await expect(otherReports.first()).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "Stop turn", exact: true }).click();
    await expect(otherReports.first()).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(otherLarge).toHaveAttribute("aria-expanded", "false");
    await page
      .getByRole("button", { name: "Switch chat", exact: true })
      .click();
    await expect(page.locator("#activity-chat")).toHaveText("a");
    await expect(reportGroups.first()).toHaveAttribute("aria-expanded", "true");
    await expect(reportGroups.last()).toHaveAttribute("aria-expanded", "false");

    await page
      .getByRole("button", { name: "Resume turn", exact: true })
      .click();
    await expect(
      transcript.getByRole("status", { name: "Agent working", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Toggle surface", exact: true })
      .click();
    await expect(scroller).toHaveAttribute("inert", "");
    await expect(scroller).toHaveAttribute("aria-hidden", "true");
    await expect(
      transcript.getByRole("status", { includeHidden: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Toggle surface", exact: true })
      .click();
    await page.getByRole("button", { name: "Stop turn", exact: true }).click();
    await expect(reportGroups.first()).toHaveAttribute("aria-expanded", "true");
    await expect(reportGroups.last()).toHaveAttribute("aria-expanded", "false");
    check(
      `${provider}: choices are independent by report and chat; Stop and inactive surfaces retain normal behavior`,
      true,
    );
  }
}
