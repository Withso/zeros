import { mkdir } from "node:fs/promises";
import { expect } from "@playwright/test";
import { checkOptimisticSendPresentation } from "./ui-smoke-optimistic-send.mjs";
import { checkLocalTranscriptPaint } from "./ui-smoke-local-transcript-paint.mjs";
import { checkEmptyChatTranscriptRow } from "./ui-smoke-transcript-row.mjs";
import { checkTranscriptResumePresentation } from "./ui-smoke-transcript-resume.mjs";
import { checkAgentPreparationFailures } from "./ui-smoke-agent-preparation.mjs";

export async function runComposerSendFailuresSmoke({ page, check, harnessBase }) {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const screenshotDir = process.env.ZEROS_UI_SMOKE_SCREENSHOT_DIR;
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  const open = () => page.goto(`${harnessBase}/harness-composer-send-failures.html`);
  await open();
  await checkAgentPreparationFailures({ page, check });
  await checkTranscriptResumePresentation({ page, check, screenshotDir });
  await open();
  await checkLocalTranscriptPaint({ page, check, screenshotDir });
  await checkEmptyChatTranscriptRow({ page, check, harnessBase, screenshotDir });
  await checkOptimisticSendPresentation({ page, check, screenshotDir });
  await open();
  const { checkRunningTurnPresentation } = await import("./ui-smoke-running-turn.mjs");
  await checkRunningTurnPresentation({ page, check, screenshotDir });
  const { checkStreamingRenderScope } = await import("./ui-smoke-transcript-render-scope.mjs");
  await checkStreamingRenderScope({ page, check });
  await runFollowUpBehaviorSmoke({ page, check, harnessBase });
  await open();
  const { checkIncrementalTranscriptPresentation } = await import("./ui-smoke-transcript-incremental.mjs");
  await checkIncrementalTranscriptPresentation({ page, check });
  expect(errors).toEqual([]);
}

export async function runFollowUpBehaviorSmoke({ page, check, harnessBase }) {
  await page.goto(`${harnessBase}/harness-composer-send-failures.html?follow-up`);
  const setting = page.getByRole("combobox", { name: "Follow-up behavior", exact: true });
  const editor = page.locator('[data-slot="prompt-input"]:visible').locator("..").locator('[contenteditable="true"]');
  await expect(setting).toHaveText("Queue");
  const select = async label => {
    await setting.click();
    await page.getByRole("option", { name: label, exact: true }).click();
    await expect(setting).toHaveText(label);
  };
  for (const [index, placement] of [[0, "Cloud"], [1, "Local"], [2, "Organization local"]]) {
    await page.getByRole("button", { name: placement, exact: true }).click();
    for (const [behavior, key, expected] of [
      ["Queue", "Enter", "queue"], ["Queue", "ControlOrMeta+Enter", "steer"],
      ["Steer", "Enter", "steer"], ["Steer", "ControlOrMeta+Enter", "queue"],
    ]) {
      await select(behavior);
      const before = await page.evaluate(() => window.composerSendFailureFixture.followUps.length);
      await editor.fill(`${placement} ${behavior} follow-up`);
      await editor.press(key);
      await expect.poll(() => page.evaluate(() => window.composerSendFailureFixture.followUps.length)).toBe(before + 1);
      expect(await page.evaluate(() => window.composerSendFailureFixture.followUps.at(-1))).toEqual({ chatId: `composer-chat-${index}`, behavior: expected });
      await expect(editor).toBeEmpty();
    }
    await select("Queue");
  }
  await select("Steer");
  await page.reload();
  await expect(setting).toHaveText("Steer");
  await expect(page.locator("[data-follow-up-setting]")).toContainText("Use Cmd/Ctrl+Enter to queue.");
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.locator("[data-follow-up-setting]").screenshot({ path: `.context/follow-up-settings-${theme}.png` });
  }
  await select("Queue");
  check("Follow-up settings default to Queue, persist Steer, and invert Enter for Local, organization-local and cloud composers", true);
}
