import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import type { ElectronApplication } from "@playwright/test";

const { launchNativeElectron } = createRequire(import.meta.url)("../design-native-electron.mjs");
const { nativePageSession } = createRequire(import.meta.url)("../design-native-renderer.mjs");

// Headless Chromium has no native window visibility. This assertion belongs on
// the platform whose scheduling is being qualified, alongside the full soak.
it.skipIf(process.platform !== "darwin")("removes the owning inspector's focus override for actual native hide/show", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zeros-native-visibility-"));
  const entry = path.join(root, "probe.cjs");
  await fs.writeFile(entry, `const { app, BrowserWindow } = require("electron");
    app.setName("Zeros Native Visibility Test"); app.setPath("userData", ${JSON.stringify(root)});
    app.whenReady().then(() => { const w = new BrowserWindow({width:400,height:250}); w.loadURL("data:text/html,<main>Native visibility qualification</main>"); });
    app.on("window-all-closed", () => app.quit());
  `);
  let app: ElectronApplication | undefined;
  try {
    app = await launchNativeElectron({ args: [entry], timeout: 15_000 });
    const page = await app!.firstWindow();
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
    const session = await nativePageSession(page);
    try {
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("hidden");
      await app!.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.show(); w.focus(); });
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
    } finally { await session.detach(); }
  } finally { await app?.close(); await fs.rm(root, { recursive: true, force: true }); }
}, 25_000);

it("qualifies the real Keychain and background scheduling without Playwright's mock switches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zeros-native-launch-"));
  const entry = path.join(root, "probe.cjs");
  await fs.writeFile(entry, `const { app } = require("electron");
    app.setName("Zeros Native Launch Test");
    app.setPath("userData", ${JSON.stringify(root)});
    const timer = setInterval(() => {}, 1000);
    app.on("will-quit", () => clearInterval(timer));
  `);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  try {
    // No window, shared profile or credential read. Linux uses its headless
    // backend; the qualification app on macOS keeps its ordinary native UI.
    app = await launchNativeElectron({ args: [entry, ...(process.platform === "linux"
      ? ["--headless", "--ozone-platform=headless", "--disable-gpu"] : [])], env, timeout: 15_000 });
    const observed = await app!.evaluate(({ app }) => ({
      mockKeychain: app.commandLine.hasSwitch("use-mock-keychain"),
      basicPasswords: app.commandLine.getSwitchValue("password-store") === "basic",
      backgroundTimersDisabled: app.commandLine.hasSwitch("disable-background-timer-throttling"),
      rendererBackgroundingDisabled: app.commandLine.hasSwitch("disable-renderer-backgrounding"),
    }));
    expect(observed).toEqual({ mockKeychain: false, basicPasswords: false,
      backgroundTimersDisabled: false, rendererBackgroundingDisabled: false });
  } finally {
    await app?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 25_000);
