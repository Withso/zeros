import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";

export async function runComposerSendFailuresSmoke({ page, check, harnessBase }) {
  // Keep toast acknowledgement and screenshots independent of machine load.
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const errors = [];
  const lifecycleWrites = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://api.example.test/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith("/agent-credentials/prepare")) {
      const required = await page.evaluate(() => window.composerSendFailureFixture.runtimeRequired);
      // The harness session's accountId; cloud sends select only the sender's own grant.
      return route.fulfill({ json: { delegations: [{ id: "33333333-3333-4333-8333-333333333333", kind: "codex-chatgpt",
        ownerUserId: "11111111-1111-4111-8111-111111111111", models: ["gpt-6.1-sol"], expiresAt: "2099-01-01T00:00:00Z", runtimeQualified: !required, runtimeUpgradeRequired: required }] } });
    }
    if (request.method() === "GET" && path.endsWith("/runtime-upgrade")) {
      return route.fulfill({ json: await page.evaluate(() => window.composerSendFailureFixture.runtimeAvailability) });
    }
    if (request.method() === "POST" && /\/(stop|wake)$/.test(path)) {
      const operation = path.split("/").at(-1);
      lifecycleWrites.push(operation);
      const workspace = await page.evaluate(operation => {
        const fixture = window.composerSendFailureFixture;
        if (operation === "wake" && fixture.document.status !== "stopped") throw new Error("Restart must stop before wake");
        return fixture.publish({ status: operation === "stop" ? "stopped" : "ready",
          ...(operation === "wake" ? { generation: { ...fixture.document.generation, number: fixture.document.generation.number + 1 } } : {}) });
      }, operation);
      return route.fulfill({ json: { workspace } });
    }
    if (request.method() === "GET" && path.endsWith("/22222222-2222-4222-8222-222222222222")) {
      return route.fulfill({ json: { workspace: await page.evaluate(() => window.composerSendFailureFixture.document) } });
    }
    throw new Error(`Unexpected composer fixture request: ${path}`);
  });
  const screenshotDir = process.env.ZEROS_UI_SMOKE_SCREENSHOT_DIR;
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  const capture = async name => {
    await page.clock.runFor(200);
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `composer-${name}.png`), animations: "disabled" });
  };
  const composer = page.locator('[data-slot="prompt-input"]:visible').locator("..");
  const editor = composer.locator('[contenteditable="true"]');
  const send = composer.getByRole("button", { name: "Send message", exact: true });
  const toasts = page.locator("[data-sonner-toast]");
  const failureCards = page.locator("[data-turn-failure-card]:visible");
  const dismiss = async () => {
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.clock.runFor(500);
    await expect(toasts).toHaveCount(0);
  };

  await page.goto(`${harnessBase}/harness-composer-send-failures.html`);
  await expect(editor).toBeVisible();
  for (const [code, copy, action] of [
    ["cloud_agent_model_not_authorized", "GPT-6.1 Sol isn't available for this agent", null],
    ["cloud_agent_credential_required", "Connect Codex to use agents in this workspace", "Reconnect"],
    ["cloud_agent_credential_expired", "Your Codex connection expired. Reconnect to continue", "Reconnect"],
    ["cloud_agent_credential_revoked", "Your Codex connection was disconnected. Reconnect to continue", "Reconnect"],
    ["cloud_agent_credential_refresh_required", "Your Codex connection needs to be renewed", "Reconnect"],
    ["cloud_runtime_upgrade_required", "This workspace gets the new cloud runtime the next time it wakes", null],
  ]) {
    await page.evaluate(code => window.composerSendFailureFixture.setFailure(code), code);
    await editor.fill("Keep this draft after refusal");
    await send.click();
    await page.clock.runFor(200);
    await expect(failureCards).toHaveCount(1);
    await expect(failureCards).toContainText(copy);
    await expect(toasts).toHaveCount(0);
    if (action) await expect(failureCards.getByRole("button", { name: action, exact: true })).toBeVisible();
    await expect(failureCards.getByRole("button")).toHaveCount(action ? 1 : 0);
    await expect(failureCards).not.toContainText("Enable models");
    await expect(failureCards).not.toContainText("Or choose an allowed model.");
    await expect(failureCards).not.toContainText("Retry in new chat");
    await expect(editor).toHaveText("Keep this draft after refusal");
    await expect(composer).not.toContainText(copy);
    await expect(composer.locator('[role="status"], [role="alert"]')).toHaveCount(0);
    await expect(page.getByText("AGENT STOPPED", { exact: true })).toHaveCount(0);
    if (code === "cloud_agent_model_not_authorized") {
      for (const theme of ["dark", "light"]) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await capture(`refused-send-${theme}`);
      }
    }
    if (code === "cloud_runtime_upgrade_required") {
      await expect(failureCards).not.toContainText("couldn't be completed");
      for (const theme of ["dark", "light"]) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await capture(`runtime-refused-send-${theme}`);
      }
    }
    await page.getByRole("button", { name: "Remount chat", exact: true }).click();
    await page.evaluate(() => window.composerSendFailureFixture.refresh());
    await expect(editor).toHaveText("Keep this draft after refusal");
    await expect(toasts).toHaveCount(0);
    await expect(failureCards).toHaveCount(1);
    await expect(failureCards).toContainText(copy);
  }
  check("Refused cloud sends restore drafts and retain one failure banner without a duplicate toast across remount/refresh", true);

  await page.evaluate(() => window.composerSendFailureFixture.setFailure("command_dispatch_rejected"));
  await send.click();
  await page.clock.runFor(200);
  await expect(toasts).toHaveCount(1);
  await expect(toasts).toContainText("Cloud request couldn't be completed");
  await expect(toasts).toContainText("Review the conversation before retrying.");
  await expect(toasts.getByRole("button")).toHaveCount(1); // Dismiss only.
  await expect(page.getByText("Keep this draft after refusal", { exact: true })).toBeVisible();
  await expect(editor).toBeEmpty();
  await expect(composer).not.toContainText("Cloud request");
  await dismiss();
  await page.getByRole("button", { name: "Remount chat", exact: true }).click();
  await expect(toasts).toHaveCount(0);
  check("Ambiguous dispatch shows one review toast and preserves the transcript without restoring a possibly delivered draft", true);

  // Production queued refusals retain their editable FIFO prompt outside the
  // transcript. That absence must not hide the chat's active failure banner.
  await page.goto(`${harnessBase}/harness-composer-send-failures.html`);
  await expect(editor).toBeVisible();
  await page.evaluate(async () => {
    const { useSessionsStore } = await import("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
    useSessionsStore.getState().patchSession("composer-chat-0", {
      messages: [{ id: "queued-refusal", kind: "text", role: "user", text: "Keep this queued prompt", createdAt: Date.now(), queued: true, queuedEditable: true }],
      status: "ready", queuePaused: true, cloudSendWait: { state: "failed" },
      cloudAdmissionFailure: { code: "cloud_agent_credential_expired", turnId: "queued-refusal", agentId: "codex", model: "gpt-6.1-sol",
        kind: "credential-required", message: "Your Codex connection expired. Reconnect to continue", action: "reconnect" },
    });
  });
  await expect(failureCards).toHaveCount(1);
  await expect(failureCards).toContainText("Your Codex connection expired. Reconnect to continue");
  await expect(failureCards.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  await expect(toasts).toHaveCount(0);
  await page.getByRole("button", { name: "Remount chat", exact: true }).click();
  await expect(failureCards).toHaveCount(1);
  for (const label of ["Local", "Organization local"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(failureCards).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Cloud", exact: true }).click();
  await expect(failureCards).toHaveCount(1);
  await expect(toasts).toHaveCount(0);
  check("A queued cloud refusal keeps one banner through remount and placement switching", true);

  await page.goto(`${harnessBase}/harness-composer-send-failures.html?blocked=1`);
  await expect(editor).toBeVisible();
  await expect(toasts).toHaveCount(0);
  await editor.fill("Keep this blocked draft");
  await expect(send).toBeDisabled();
  await expect(send).toHaveAttribute("aria-disabled", "true");
  const tooltipCopy = "Gets the new cloud runtime the next time this workspace wakes";
  await send.hover();
  await page.clock.runFor(200);
  await expect(page.getByRole("tooltip")).toContainText(tooltipCopy);
  await expect(composer).not.toContainText("cloud runtime");
  await send.focus();
  await expect(send).toBeFocused();
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await capture(`blocked-tooltip-${theme}`);
  }
  // Prove keyboard feedback before any pointer attempt can consume the state.
  await editor.press("Enter");
  await page.clock.runFor(200);
  await expect(toasts).toHaveCount(1);
  await expect(toasts).toContainText("This workspace is on an older runtime");
  await expect(toasts.getByRole("button", { name: "Restart workspace", exact: true })).toBeVisible();
  await expect(toasts).toContainText("Restart this workspace to update its cloud runtime.");
  await expect(toasts).not.toContainText("next time");
  // A pointer attempt and further keystrokes share the same acknowledgement.
  await send.click({ force: true });
  await editor.press("Enter");
  await editor.press("Enter");
  await expect(toasts).toHaveCount(1);
  await expect(editor).toHaveText("Keep this blocked draft");
  expect(await page.evaluate(() => window.composerSendFailureFixture.sends)).toBe(0);
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.mouse.move(0, 0);
    await editor.focus();
    await page.clock.runFor(200);
    await capture(`blocked-send-${theme}`);
  }
  await dismiss();
  await page.getByRole("button", { name: "Remount chat", exact: true }).click();
  await page.evaluate(() => window.composerSendFailureFixture.refresh());
  await editor.press("Enter");
  await send.click({ force: true });
  await expect(toasts).toHaveCount(0);
  await expect(send).toBeDisabled();
  check("Known runtime blocks use accessible disabled Send and a tooltip; pointer/Enter attempts notify once per state", true);

  for (const label of ["Local", "Organization local"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await editor.fill(`${label} still sends`);
    await expect(send).toBeEnabled();
    await send.click();
    await expect(editor).toBeEmpty();
    await expect(toasts).toHaveCount(0);
    await expect(composer.locator('[role="status"], [role="alert"]')).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Cloud", exact: true }).click();
  await expect(editor).toHaveText("Keep this blocked draft");
  await expect(send).toBeDisabled();
  await editor.press("Enter");
  await expect(toasts).toHaveCount(0);
  check("Local and organization-local sends remain available; A to B to A keeps the cloud draft and toast acknowledgement", true);

  // A fresh renderer acknowledgement lets the deliberate toast action exercise
  // the shared production restart against synthetic lifecycle responses.
  await page.goto(`${harnessBase}/harness-composer-send-failures.html?blocked=1`);
  await editor.fill("Keep this draft through Restart");
  await expect(send).toBeDisabled();
  await editor.press("Enter");
  await page.clock.runFor(200);
  await expect(toasts).toHaveCount(1);
  expect(lifecycleWrites).toEqual([]); // Showing a failure never restarts automatically.
  await toasts.getByRole("button", { name: "Restart workspace", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.composerSendFailureFixture.reconnects)).toBe(1);
  expect(lifecycleWrites).toEqual(["stop", "wake"]);
  expect(await page.evaluate(() => window.composerSendFailureFixture.document.generation.number)).toBe(2);
  expect(await page.evaluate(() => window.composerSendFailureFixture.sends)).toBe(0);
  await page.evaluate(() => window.composerSendFailureFixture.refresh(false));
  await expect(send).toBeEnabled();
  await expect(editor).toHaveText("Keep this draft through Restart");
  check("Runtime toast Restart uses an explicit Stop then fresh wake, reconnects, and preserves the unsent draft", true);
  expect(errors).toEqual([]);
}
