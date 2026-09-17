import { runTurnUsageSmoke } from "./ui-smoke-turn-usage.mjs";
import { runArtifactLinksSmoke } from "./ui-smoke-artifact-links.mjs";
import { runSubagentPresentationSmoke } from "./ui-smoke-subagent-presentation.mjs";
import { runModelFallbackSmoke } from "./ui-smoke-model-fallback.mjs";
import { runStreamingTextSmoke } from "./ui-smoke-streaming-text.mjs";
import { runToolPresentationSmoke } from "./ui-smoke-tool-presentation.mjs";
import { runAgentNoticesSmoke } from "./ui-smoke-agent-notices.mjs";
import { expect } from "@playwright/test";

export async function runCodexTranscriptSmoke({ page, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-codex-transcript.html`,
  );
  const transcript = page.locator("#codex-transcript");
  await expect(
    transcript.getByText("I am checking the implementation."),
  ).toBeVisible();
  await expect(
    transcript.getByRole("button", { name: /Bash pnpm test/ }),
  ).toBeVisible();
  await transcript.getByRole("button", { name: /Thinking/ }).click();
  await expect(
    transcript
      .getByText("Reviewing the event boundaries.", { exact: true })
      .last(),
  ).toBeVisible();
  await transcript.getByRole("button", { name: /Bash pnpm typecheck/ }).click();
  await expect(transcript.getByText("Exit code: 0")).toHaveCount(0);
  await expect(transcript.getByText("No output was captured.")).toBeVisible();
  await transcript.getByRole("button", { name: /Find in page/ }).click();
  await expect(transcript.getByText(/API reference found/)).toBeVisible();
  const a = transcript.getByRole("button", { name: /^Edit a.ts/ });
  const b = transcript.getByRole("button", { name: /^Edit b.ts/ });
  await a.click();
  await expect(a).toHaveAttribute("aria-expanded", "true");
  await expect(b).toHaveAttribute("aria-expanded", "false");
  await b.click();
  await expect(b).toHaveAttribute("aria-expanded", "true");
  await expect(
    transcript.getByText("/workspace/a.ts", { exact: true }),
  ).toBeVisible();
  await expect(
    transcript.getByText("/workspace/b.ts", { exact: true }),
  ).toBeVisible();
  await transcript.getByRole("button", { name: /^Future tool/ }).click();
  await expect(transcript.getByText(/Captured future result/)).toBeVisible();
  await transcript.getByRole("button", { name: /Bash pnpm verify/ }).click();
  await expect(transcript.getByText("Exit code: 1")).toHaveCount(0);
  await expect(
    transcript.getByText("Verification failed", { exact: true }),
  ).toBeVisible();
  await transcript
    .getByRole("button", { name: "Agent Worker result", exact: true })
    .click();
  await expect(
    transcript.getByText(/Worker completed its audit/),
  ).toBeVisible();
  check(
    "Live commentary, reasoning, running tools and every expanded tool fixture expose their details",
    true,
  );

  await page
    .getByRole("button", { name: "Complete turn", exact: true })
    .click();
  await expect(
    transcript.getByText("The final answer stays visible."),
  ).toBeVisible();
  await transcript.getByRole("button", { name: /tool calls/ }).click();
  await transcript.getByRole("button", { name: /^1 tool call$/ }).click();
  await expect(
    transcript.getByRole("button", {
      name: /^Background agent completed/,
    }),
  ).toBeVisible();
  await expect(
    transcript.getByText("The final answer stays visible."),
  ).toBeVisible();
  check("Late background tools cannot hide a completed final answer", true);

  const composer = page.getByRole("textbox", { name: "Composer", exact: true });
  await composer.fill("1");
  await composer.press("Enter");
  await composer.press("Escape");
  await expect(page.locator("#question-response")).toHaveText("null");
  await expect(composer).toHaveValue("1\n");
  await page
    .getByRole("button", { name: "Toggle active", exact: true })
    .click();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Enter");
  await expect(page.locator("#question-response")).toHaveText("null");
  await page
    .getByRole("button", { name: "Toggle active", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await expect(page.locator("#question-response")).toContainText(
    '"selectedOptionIds":["json"]',
  );
  check(
    "Optional questions keep the composer usable and cannot submit from inactive or unrelated keyboard input",
    true,
  );

  const failed = page.locator("#failed-turn-transcript");
  const card = failed.locator("[data-turn-failure-card]");
  await expect(card).toBeVisible();
  await expect(card.getByText(/The agent session expired/)).toBeVisible();
  const colors = await card.evaluate((element) => {
    const style = getComputedStyle(element);
    const probe = document.createElement("span");
    element.appendChild(probe);
    probe.style.color = "var(--fg1)";
    probe.style.backgroundColor = "var(--brown-bg)";
    const expected = getComputedStyle(probe);
    const matches =
      style.color === expected.color &&
      style.backgroundColor === expected.backgroundColor;
    probe.style.color = "var(--brown-fg)";
    const actionColor = getComputedStyle(probe).color;
    const actionsMatch = [
      ...element.querySelectorAll("button, button svg"),
    ].every((node) => getComputedStyle(node).color === actionColor);
    probe.remove();
    return matches && actionsMatch;
  });
  check(
    "Failure card uses the requested background, text and arrow colors",
    colors,
  );
  await expect(card.getByRole("link")).toHaveAttribute(
    "href",
    "https://example.com/help",
  );
  const retry = card.getByRole("button", { name: "Retry", exact: true });
  await retry.click();
  await expect(page.locator("#retry-count")).toHaveText("1");
  await expect(retry).toBeDisabled();
  await expect(
    card.getByRole("button", { name: "Retry in new chat" }),
  ).toBeDisabled();
  await failed.getByRole("button", { name: "Finish retry" }).click();
  await expect(retry).toBeEnabled();
  await card.getByRole("button", { name: "Retry in new chat" }).click();
  await expect(page.locator("#fresh-retry-count")).toHaveText("1");
  check(
    "Collapsed failed turns retain the reason and serialize recovery actions",
    true,
  );

  await runAgentNoticesSmoke({ page, check });

  const background = page.locator("#claude-background-fixture");
  const backgroundTranscript = background.locator("#background-transcript");
  const waitingLoader = (locator) => locator.getByRole("status", { name: "Waiting for background tasks", exact: true });
  const workingLoader = (locator) => locator.getByRole("status", { name: "Agent working", exact: true });
  const chatTab = background.locator("#background-chat-tab");
  const workspaceTab = background.locator("#background-workspace-tab");
  await background.scrollIntoViewIfNeeded();
  await expect(waitingLoader(backgroundTranscript)).toBeVisible();
  await expect(waitingLoader(chatTab)).toBeVisible();
  await expect(waitingLoader(workspaceTab)).toBeVisible();
  await expect(backgroundTranscript.getByText("The implementation is ready. Tests are still running.")).toBeVisible();
  const footer = background.getByTestId("background-output-footer");
  const waitingText = backgroundTranscript.getByText("Waiting for 1 background task", { exact: true });
  const footerBox = await footer.boundingBox();
  const waitingBox = await waitingText.boundingBox();
  check("Claude waiting activity is below the settled output footer", !!footerBox && !!waitingBox && waitingBox.y >= footerBox.y + footerBox.height);
  const elapsed = () => backgroundTranscript.locator(".tabular-nums").last();
  await expect(elapsed()).toContainText(/\d+m/);
  await background
    .getByRole("button", { name: "Run two children", exact: true })
    .click();
  await expect(
    backgroundTranscript.getByText("Waiting for 2 background tasks", {
      exact: true,
    }),
  ).toBeVisible();
  await background
    .getByRole("button", { name: "Complete first child", exact: true })
    .click();
  await expect(waitingText).toBeVisible();
  await expect(waitingLoader(chatTab)).toBeVisible();
  await expect(waitingLoader(workspaceTab)).toBeVisible();
  await background
    .getByRole("button", { name: "Child progress", exact: true })
    .click();
  await expect(waitingLoader(backgroundTranscript)).toBeVisible();
  await background.getByRole("button", { name: "Reload activity", exact: true }).click();
  await expect(elapsed()).toContainText(/\d+m/);
  await expect(waitingLoader(chatTab)).toBeVisible();
  await background.getByRole("button", { name: "Start other chat", exact: true }).click();
  await expect(workingLoader(workspaceTab)).toBeVisible();
  await expect(waitingLoader(chatTab)).toBeVisible();
  await background.getByRole("button", { name: "Stop other chat", exact: true }).click();
  await expect(waitingLoader(workspaceTab)).toBeVisible();
  await background.getByRole("button", { name: "Resume parent", exact: true }).click();
  await expect(workingLoader(backgroundTranscript)).toBeVisible();
  await expect(workingLoader(chatTab)).toBeVisible();
  await expect(workingLoader(workspaceTab)).toBeVisible();
  await expect(footer).toHaveCount(0);
  await expect(waitingText).toHaveCount(0);
  await expect(backgroundTranscript.getByText("The implementation is ready. Tests are still running.", { exact: true })).toBeVisible();
  await expect(backgroundTranscript.locator(".zeros-working-feed").getByText("The implementation is ready. Tests are still running.")).toHaveCount(0);
  await expect(elapsed()).toContainText(/\d+m/);
  await background.getByRole("button", { name: "Complete parent", exact: true }).click();
  await expect(footer).toBeVisible();
  await expect(footer).toContainText("15m");
  await expect(workingLoader(backgroundTranscript)).toHaveCount(0);
  await expect(chatTab.getByRole("status")).toHaveCount(0);
  await expect(workspaceTab.getByRole("status")).toHaveCount(0);
  await background.getByRole("button", { name: "Wait again", exact: true }).click();
  await expect(waitingLoader(backgroundTranscript)).toBeVisible();
  await background.getByRole("button", { name: "Stop background work", exact: true }).click();
  await expect(waitingLoader(backgroundTranscript)).toHaveCount(0);
  await expect(chatTab.getByRole("status")).toHaveCount(0);
  check("Claude waiting/resume retains its clock, child updates stay quiet, and both tabs clear on completion or Stop", true);
  await runToolPresentationSmoke({ page, check });
  await runArtifactLinksSmoke({ page, check });
  await runSubagentPresentationSmoke({ page, check });
  await runStreamingTextSmoke({ page, check });
  await runModelFallbackSmoke({ page, check });
  await runTurnUsageSmoke({ page, check });
}
