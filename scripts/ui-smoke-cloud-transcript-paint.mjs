// The same production ChatView/provider as the app, with all native/history
// promises held through the first frame. Also runnable on its own.
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STORE = "/apps/desktop/src/renderer/features/agent/sessions-store.ts";

export async function checkCloudTranscriptPaint({ page, check, harnessBase, screenshotDir, theme }) {
  await page.clock.resume();
  const url = `${harnessBase}/harness-cloud-transcript.html`;
  await page.goto(`${url}?seed`);
  await expect.poll(() => page.evaluate(() => window.cloudTranscriptFixture?.seeded), { timeout: 60000 }).toBe(true);
  await page.goto(url);
  // Vite's cold module graph is outside the paint measurement. The fixture
  // records the first actual frame once React mounts, without a grace period.
  await expect.poll(() => page.evaluate(() => window.cloudTranscriptFixture?.firstFrame), { timeout: 60000 }).toBeTruthy();
  expect(await page.evaluate(() => window.cloudTranscriptFixture.firstFrame)).toEqual({ painted: true, loading: false, provisional: true });
  const fixture = await page.evaluate(() => ({ boot: window.cloudTranscriptFixture.bootReads, history: window.cloudTranscriptFixture.historyReads }));
  expect(fixture.boot.length).toBeGreaterThan(0);
  expect(new Set(fixture.boot).size).toBe(1);
  expect(fixture.history).toHaveLength(1);
  expect(fixture.history[0]).toBe(fixture.boot[0]);
  check("After restart the cloud transcript paints in its first frame while token, bridge and history promises remain held", true);
  await expect(page.getByLabel("Loading conversation", { exact: true })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Edit message", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Turn actions", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Turn usage,/ })).toHaveCount(0);
  const editor = page.locator('[data-slot="prompt-input"]:visible').locator("..").locator('[contenteditable="true"]');
  await editor.fill("A draft while history revalidates");
  await expect(editor).toContainText("A draft while history revalidates");
  check("Cached cloud rows expose no edit/retry/fork controls and the composer remains editable; the hidden chat starts no reads", true);
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true });
    if (theme) await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const renderedTheme = await page.locator("html").getAttribute("data-theme");
    expect(["dark", "light"]).toContain(renderedTheme);
    await page.screenshot({ path: `${screenshotDir}/cloud-transcript-${renderedTheme}.png`, animations: "disabled" });
  }
  await page.evaluate(async store => {
    const { useSessionsStore } = await import(store);
    const chatId = window.cloudTranscriptFixture.historyReads[0];
    const messages = useSessionsStore.getState().sessions[chatId].messages;
    window.cloudTranscriptBefore = { messages, node: document.querySelector('[data-checkpoint-id="cached-196"]') };
    // Remove the last turn and edit one row without changing its ID.
    window.cloudTranscriptFixture.releaseHistory(messages.slice(0, -2).map(message => message.id === "cached-197"
      ? { ...message, text: "Revalidated cloud answer" } : { ...message }));
  }, STORE);
  await expect(page.getByText("Revalidated cloud answer", { exact: true })).toBeVisible();
  await expect(page.getByText("Cloud cached transcript row 199", { exact: true })).toHaveCount(0);
  const stable = await page.evaluate(async store => {
    const { useSessionsStore } = await import(store);
    const slot = useSessionsStore.getState().sessions[window.cloudTranscriptFixture.historyReads[0]];
    const before = window.cloudTranscriptBefore;
    return { row: slot.messages[196] === before.messages[196], edited: slot.messages[197] !== before.messages[197],
      node: before.node !== null && document.querySelector('[data-checkpoint-id="cached-196"]') === before.node,
      authority: slot.transcriptState, presentation: slot.transcriptPresentation };
  }, STORE);
  expect(stable).toEqual({ row: true, edited: true, node: true, authority: "resident", presentation: null });
  await expect(editor).toContainText("A draft while history revalidates");
  check("Authoritative cloud revalidation retains unchanged rows and DOM, applies edits/deletions, and preserves the draft", true);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const port = await new Promise((done, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => done(port)); });
  });
  const vite = spawn("pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: root, env: { ...process.env, VITE_CONTROL_PLANE_URL: "https://api.example.test" }, stdio: ["ignore", "ignore", "pipe"], detached: true,
  });
  vite.stderr.on("data", data => process.stderr.write(data));
  const harnessBase = `http://127.0.0.1:${port}/apps/desktop/src/renderer/harnesses`;
  let browser;
  try {
    const deadline = Date.now() + 45000;
    for (;;) {
      try { if ((await fetch(`${harnessBase}/harness-cloud-transcript.html`)).ok) break; } catch { /* starting */ }
      if (Date.now() > deadline) throw new Error("Cloud transcript harness did not start");
      await new Promise(done => setTimeout(done, 200));
    }
    browser = await chromium.launch({ headless: true });
    for (const theme of ["dark", "light"]) {
      const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
      await context.addInitScript(theme => { window.__ZEROS_APPEARANCE_MODE__ = theme; document.documentElement?.setAttribute("data-theme", theme); }, theme);
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.clock.install();
      await checkCloudTranscriptPaint({ page, check: name => console.log(`[ok] ${theme}: ${name}`), harnessBase, theme,
        screenshotDir: process.env.ZEROS_UI_SMOKE_SCREENSHOT_DIR });
      expect(errors).toEqual([]);
      await context.close();
    }
    console.log("Cloud transcript smoke: all checks passed in both themes");
  } finally {
    await browser?.close();
    try { process.kill(-vite.pid, "SIGTERM"); } catch { vite.kill("SIGTERM"); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(error); process.exitCode = 1; });
