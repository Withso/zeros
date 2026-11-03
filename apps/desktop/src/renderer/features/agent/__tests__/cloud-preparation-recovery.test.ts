import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

let browser: Browser;
let server: ViteDevServer;
let listener: Server;
let origin: string;
interface RecoveryFixture { sends: number; preparations: number; modelRefreshes: number }

beforeAll(async () => {
  server = await createServer({
    mode: "ui-smoke", logLevel: "error",
    cacheDir: path.resolve("node_modules/.vite-cloud-preparation-test"),
    define: { "import.meta.env.VITE_CONTROL_PLANE_URL": JSON.stringify("https://api.example.test") },
    server: { middlewareMode: true, hmr: false },
  });
  // Vite treats port 0 as its default port; Node binds an actual ephemeral port.
  listener = createHttpServer(server.middlewares);
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => { listener.off("error", reject); resolve(); });
  });
  origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (listener?.listening) await new Promise<void>((resolve, reject) => {
    listener.close(error => error ? reject(error) : resolve());
  });
});

async function openChat(page: Page, reason: string) {
  await page.route("https://**", route => route.abort());
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-composer-send-failures.html`);
  await browserExpect(page.getByRole("button", { name: "Cloud", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(async reason => {
    const base = "/apps/desktop/src/renderer/";
    // Keep these imports in the browser instead of Vitest's SSR transform.
    const load = new Function("url", "return import(url)");
    const { setActiveOrganizationSelection } = await load(base + "features/team/active-team.ts");
    const { useSessionsStore } = await load(base + "features/agent/sessions-store.ts");
    setActiveOrganizationSelection("11111111-1111-4111-8111-111111111111", false);
    useSessionsStore.getState().patchSession("composer-chat-0", {
      status: reason === "auth-required" ? "auth-required" : "failed", messages: [],
      failure: { kind: reason === "model-unavailable" ? "protocol-error" : reason === "provider-unavailable" ? "transport-closed" : reason,
        stage: "loadSession", agentId: "codex", message: "Synthetic provider rejection.",
        cloud: { source: "provider", provider: "codex", reason } },
    });
  }, reason);
}

it("opens the real model menu from a cloud preparation failure", async () => {
  const page = await browser.newPage();
  try {
    await openChat(page, "model-unavailable");
    await page.getByRole("button", { name: "Choose another model" }).click();
    await browserExpect(page.locator("[cmdk-input]")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { composerSendFailureFixture: RecoveryFixture })
      .composerSendFailureFixture.modelRefreshes)).toBe(1);
  } finally { await page.close(); }
}, 90_000);

it("offers a fresh conversation when native session recovery fails before a new turn", async () => {
  const page = await browser.newPage();
  try {
    await openChat(page, "session-expired");
    await page.locator(".ProseMirror[contenteditable=true]:visible").fill("Unsent work stays with the original chat");
    await page.getByRole("button", { name: "Start a new session" }).click({ timeout: 5_000 });
    const result = await page.evaluate(async () => {
      const base = "/apps/desktop/src/renderer/";
      const load = new Function("url", "return import(url)");
      const { useWorkspaceStore } = await load(base + "state/workspace-store.ts");
      const { getLiveChatDraft } = await load(base + "features/agent/composer-live-drafts.ts");
      const state = useWorkspaceStore.getState();
      const fresh = state.chats.find((chat: { id: string }) => chat.id === state.activeChatId);
      return { fresh, previousRetained: state.chats.some((chat: { id: string }) => chat.id === "composer-chat-0"),
        originalDraft: getLiveChatDraft("composer-chat-0") ?? state.chatComposerDrafts["composer-chat-0"],
        freshDraft: state.chatComposerDrafts[fresh.id] };
    });
    expect(result.previousRetained).toBe(true);
    expect(result.fresh).toMatchObject({ sourceChatId: "composer-chat-0", agentId: "codex",
      folder: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222" });
    expect(result.fresh.id).not.toBe("composer-chat-0");
    expect(result.fresh.executionId).toBeUndefined();
    expect(result.fresh.sessionId).toBeUndefined();
    expect(result.originalDraft.text).toBe("Unsent work stays with the original chat");
    expect(result.freshDraft).toBeUndefined();
  } finally { await page.close(); }
}, 90_000);

it("keeps an existing prompt's authentication notice as the single recovery action", async () => {
  const page = await browser.newPage();
  try {
    await openChat(page, "auth-required");
    await page.evaluate(async () => {
      const load = new Function("url", "return import(url)");
      const { useSessionsStore } = await load("/apps/desktop/src/renderer/features/agent/sessions-store.ts");
      useSessionsStore.getState().patchSession("composer-chat-0", { messages: [
        { id: "auth-prompt", kind: "text", role: "user", text: "Please continue", createdAt: Date.now() },
      ] });
    });
    await browserExpect(page.locator("[data-authentication-notice]")).toBeVisible();
    await browserExpect(page.getByRole("button", { name: "Reconnect provider account" })).toHaveCount(1);
    await browserExpect(page.locator("[data-turn-failure-card]")).toHaveCount(0);
  } finally { await page.close(); }
}, 90_000);

it("offers account recovery when cloud startup rejects credentials before any prompt", async () => {
  const page = await browser.newPage();
  try {
    await openChat(page, "auth-required");
    await page.getByRole("button", { name: "Reconnect provider account" }).click({ timeout: 5_000 });
    expect(await page.evaluate(async () => {
      const base = "/apps/desktop/src/renderer/";
      const load = new Function("url", "return import(url)");
      const { useWorkspaceStore } = await load(base + "state/workspace-store.ts");
      return useWorkspaceStore.getState().activePage;
    })).toBe("settings");
  } finally { await page.close(); }
}, 90_000);

it("offers preparation retry without resending a prompt when the cloud provider is unavailable", async () => {
  const page = await browser.newPage();
  try {
    await openChat(page, "provider-unavailable");
    await page.getByRole("button", { name: "Retry", exact: true }).click({ timeout: 5_000 });
    expect(await page.evaluate(() => {
      const fixture = (window as unknown as { composerSendFailureFixture: RecoveryFixture }).composerSendFailureFixture;
      return { sends: fixture.sends, preparations: fixture.preparations };
    })).toEqual({ sends: 0, preparations: 1 });
  } finally { await page.close(); }
}, 90_000);
