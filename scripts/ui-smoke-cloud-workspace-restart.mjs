import { expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Called by the cloud-workspace shard, which already owns the page clock. */
export async function runCloudWorkspaceRestartSmoke({ page, check, harnessBase }) {
  const screenshotDirectory = process.env.ZEROS_UI_SMOKE_SCREENSHOT_DIR;
  if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
  const screenshot = async (state, theme) => {
    if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, `cloud-restart-${state}-${theme}.png`), animations: "disabled" });
  };
  const writes = [];
  let failNext = null;
  await page.route("https://api.example.test/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      return route.fulfill({ json: { workspace: await page.evaluate(() => window.cloudRestartFixture.document) } });
    }
    const operation = path.split("/").at(-1);
    writes.push({ operation, key: request.headers()["idempotency-key"] });
    if (failNext === operation) {
      failNext = null;
      return route.fulfill({ status: 409, json: { error: { code: "workspace_operation_rejected", message: "Fixture lifecycle failure" } } });
    }
    if (operation === "wake") expect(await page.evaluate(() => window.cloudRestartFixture.document.status)).toBe("stopped");
    const document = await page.evaluate(operation => {
      window.cloudRestartFixture.bridge.setConnection("disconnected");
      return window.cloudRestartFixture.publish({ status: operation === "stop" ? "stopping" : "waking" });
    }, operation);
    return route.fulfill({ json: { workspace: document } });
  });
  await page.goto(`${harnessBase}/harness-cloud-workspace-restart.html`);
  await page.waitForFunction(() => !!window.cloudRestartFixture);
  const setup = page.getByRole("region", { name: "Setup tab", exact: true });
  const status = setup.getByLabel("Cloud workspace status", { exact: true });
  const restart = status.getByRole("button", { name: "Restart workspace", exact: true });
  const row = page.locator("[data-workspace-tab]");
  const confirm = page.getByRole("dialog", { name: "Restart this workspace?", exact: true });
  const errors = page.locator('[data-workbench-banner][data-tone="error"]:visible');
  const noErrors = async () => {
    await expect(errors).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  };
  for (const theme of ["dark", "light"]) {
    await page.evaluate(() => window.cloudRestartFixture.work("idle"));
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await expect(status.getByRole("status")).toHaveText("Running");
    await expect(restart).toBeEnabled();
    await screenshot("running", theme);
    await page.evaluate(() => { window.cloudRestartFixture.bridge.holdConnect = true; });
    const before = writes.length;
    await restart.click();
    await expect(confirm).toHaveCount(0);
    await expect(status.getByRole("status")).toHaveText("Restarting…");
    await expect(restart).toBeDisabled();
    await expect.poll(() => writes.length).toBe(before + 1);
    expect(writes.at(-1).operation).toBe("stop");
    await noErrors();
    await screenshot("restarting", theme);
    // The deliberate final checkpoint may take longer than the normal 45s
    // transport threshold. It must never become an error banner/toast.
    await page.clock.fastForward(46_000);
    await noErrors();
    expect(writes.length).toBe(before + 1);
    await page.evaluate(() => window.cloudRestartFixture.publish({ status: "stopped" }));
    await page.clock.runFor(1_100);
    await expect.poll(() => writes.length).toBe(before + 2);
    expect(writes.at(-1).operation).toBe("wake");
    expect(writes.at(-1).key).not.toBe(writes.at(-2).key);
    await expect.poll(() => page.evaluate(() => window.cloudRestartFixture.document.status)).toBe("waking");
    await page.evaluate(() => window.cloudRestartFixture.publish({ status: "ready" }));
    await expect.poll(async () => {
      await page.clock.runFor(1_000);
      return page.evaluate(() => window.cloudRestartFixture.restartPhase);
    }).toBe("connecting");
    await expect(status.getByRole("status")).toHaveText("Restarting…");
    await page.evaluate(() => { window.cloudRestartFixture.bridge.holdConnect = false; window.cloudRestartFixture.bridge.releaseConnect(); });
    await expect(status.getByRole("status")).toHaveText("Running");
    await expect(restart).toBeEnabled();
    await noErrors();

    await page.evaluate(() => {
      window.cloudRestartFixture.publish({ status: "stopped" });
      window.cloudRestartFixture.bridge.setConnection("disconnected");
    });
    await expect(status.getByRole("status")).toHaveText("Sleeping");
    await screenshot("sleeping", theme);
    await page.evaluate(() => { window.cloudRestartFixture.publish({ status: "ready" }); window.cloudRestartFixture.bridge.setConnection("connected"); });
    await page.evaluate(() => window.cloudRestartFixture.work("agent"));
    await restart.click();
    await expect(confirm).toContainText("Running work will stop.");
    await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await screenshot("confirm", theme);
    const cancelWrites = writes.length;
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    expect(writes.length).toBe(cancelWrites);
  }

  for (const work of ["queued", "dispatching", "script", "terminal", "preview"]) {
    await page.evaluate(work => window.cloudRestartFixture.work(work), work);
    await restart.click();
    await expect(confirm).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
  }
  await page.evaluate(() => window.cloudRestartFixture.work("agent"));
  await row.click({ button: "right" });
  const menuRestart = page.getByRole("menuitem", { name: "Restart workspace", exact: true });
  const workspaceMenu = page.getByRole("menu").first();
  const closeWorkspaceMenu = async () => {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  };
  await expect(menuRestart).toBeVisible();
  await screenshot("menu", "light");
  await menuRestart.click();
  await expect(confirm).toBeVisible();
  const beforeConfirm = writes.length;
  await confirm.getByRole("button", { name: "Restart workspace", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect.poll(() => writes.length).toBe(beforeConfirm + 1);
  await page.evaluate(() => window.cloudRestartFixture.publish({ status: "stopped" }));
  await page.clock.runFor(1_100);
  await expect.poll(() => writes.length).toBe(beforeConfirm + 2);
  await expect.poll(() => page.evaluate(() => window.cloudRestartFixture.document.status)).toBe("waking");
  await page.evaluate(() => { window.cloudRestartFixture.work("idle"); window.cloudRestartFixture.publish({ status: "ready" }); });
  await expect.poll(async () => {
    await page.clock.runFor(1_000);
    return page.evaluate(() => window.cloudRestartFixture.restartPhase);
  }).toBeNull();
  await expect(status.getByRole("status")).toHaveText("Running");
  await noErrors();
  check("Cloud Restart checkpoints Stop before a fresh wake and normal admission, with calm Running/Restarting/Sleeping status in both themes", true);
  check("Header and workspace menu confirm streaming, queued, dispatching, script, live terminal and preview work; cancel and Escape perform no lifecycle mutation", true);

  const beforeUpgrade = writes.length;
  await restart.click();
  await expect.poll(() => writes.length).toBe(beforeUpgrade + 1);
  await expect.poll(() => page.evaluate(() => window.cloudRestartFixture.document.status)).toBe("stopping");
  await page.evaluate(() => window.cloudRestartFixture.publish({ status: "stopped" }));
  await page.clock.runFor(1_100);
  await expect.poll(() => writes.length).toBe(beforeUpgrade + 2);
  await expect.poll(() => page.evaluate(() => window.cloudRestartFixture.document.status)).toBe("waking");
  const generation = await page.evaluate(() => {
    const generation = { ...window.cloudRestartFixture.document.generation, number: window.cloudRestartFixture.document.generation.number + 1 };
    window.cloudRestartFixture.publish({ status: "provisioning", generation });
    return generation;
  });
  await page.clock.runFor(1_100);
  await expect(status.getByRole("status")).toHaveText("Restarting…");
  await noErrors();
  await page.evaluate(() => window.cloudRestartFixture.publish({ status: "ready" }));
  await expect.poll(async () => {
    await page.clock.runFor(1_000);
    return page.evaluate(() => window.cloudRestartFixture.restartPhase);
  }).toBeNull();
  await expect(status.getByRole("status")).toHaveText("Running");
  expect(await page.evaluate(() => window.cloudRestartFixture.document.generation.number)).toBe(generation.number);
  expect(writes.slice(beforeUpgrade).map(write => write.operation)).toEqual(["stop", "wake"]);
  await noErrors();
  check("Restart follows IW2's accepted wake to a replacement generation without another lifecycle mutation", true);

  await page.evaluate(() => window.cloudRestartFixture.publish({ capabilities: { ...window.cloudRestartFixture.document.capabilities, canWrite: false } }));
  await expect(restart).toBeDisabled();
  await page.mouse.move(1, 1);
  await restart.locator("..").hover();
  await page.clock.runFor(1_000);
  await expect(page.getByRole("tooltip")).toContainText("Workspace run access is required to restart.");
  await page.mouse.move(1, 1);
  await row.click({ button: "right" });
  await expect(menuRestart).toBeDisabled();
  await closeWorkspaceMenu();
  for (const state of ["archived", "deleting"]) {
    await page.evaluate(state => window.cloudRestartFixture.publish({ status: state }), state);
    await expect(status).toHaveCount(0);
    await row.click({ button: "right" });
    // Absence of Restart alone can pass before the menu has opened.
    await expect(workspaceMenu).toBeVisible();
    await expect(menuRestart).toHaveCount(0);
    await closeWorkspaceMenu();
  }
  await page.evaluate(() => window.cloudRestartFixture.publish({ status: "ready", deletedAt: null,
    capabilities: { ...window.cloudRestartFixture.document.capabilities, canWrite: true } }));
  const beforeLocal = writes.length;
  for (const owner of ["Personal", "organization"]) {
    await page.getByRole("button", { name: `Local ${owner} fixture`, exact: true }).click();
    await expect(status).toHaveCount(0);
    await row.click({ button: "right" });
    // Absence of Restart alone can pass before the menu has opened.
    await expect(workspaceMenu).toBeVisible();
    await expect(menuRestart).toHaveCount(0);
    await closeWorkspaceMenu();
  }
  expect(writes.length).toBe(beforeLocal);
  await page.getByRole("button", { name: "Cloud fixture", exact: true }).click();
  await expect(restart).toBeEnabled();
  failNext = "stop";
  await restart.click();
  await expect(errors).toHaveCount(1);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await expect(restart).toBeEnabled();
  expect(writes.at(-1).operation).toBe("stop");
  failNext = "wake";
  const beforeWakeFailure = writes.length;
  await restart.click();
  await expect.poll(() => writes.length).toBe(beforeWakeFailure + 1);
  await expect.poll(() => page.evaluate(() => window.cloudRestartFixture.document.status)).toBe("stopping");
  await expect(errors).toHaveCount(0);
  await page.evaluate(() => window.cloudRestartFixture.publish({ status: "stopped" }));
  await page.clock.runFor(1_100);
  await expect.poll(() => writes.length).toBe(beforeWakeFailure + 2);
  await expect(errors).toHaveCount(1);
  await expect(status.getByRole("status")).toHaveText("Needs attention");
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await expect(restart).toBeEnabled();
  expect(writes.slice(beforeWakeFailure).map(write => write.operation)).toEqual(["stop", "wake"]);
  check("Cloud Restart fails closed for canWrite, archived/deleting and both Local owners; a real failure appears once in the existing visible banner", true);
}
