// Real renderer request, HTTP router, workspace reducer, and chat tab. Only
// authentication and the final OpenAI response are synthetic; no paid
// API request, provider process, or hosted service is used by this check.
import { createRequire } from "node:module";
import { once } from "node:events";
import { expect } from "@playwright/test";
import { tsImport } from "tsx/esm/api";

const backendRequire = createRequire(
  new URL("../apps/control-plane/package.json", import.meta.url),
);
const { Hono } = backendRequire("hono");
const { serve } = backendRequire("@hono/node-server");

export async function runChatTitlesSmoke({
  page,
  check,
  harnessBase,
  screenshotPath,
}) {
  const { createChatTitleRoutes } = await tsImport(
    "../apps/control-plane/src/chat-titles.ts",
    import.meta.url,
  );
  const token = "synthetic-chat-title-session";
  const errors = [];
  const requests = [];
  const modelCalls = [];
  const userId = crypto.randomUUID();
  page.on("pageerror", (error) => errors.push(error.message));

  const app = new Hono();
  app.use("*", async (context, next) => {
    if (context.req.header("authorization") !== `Bearer ${token}`)
      return context.json({ error: "unauthorized" }, 401);
    context.set("user", { id: userId });
    await next();
  });
  app.route("/", createChatTitleRoutes("synthetic-server-key"));
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input) !== "https://api.openai.com/v1/responses")
      return originalFetch(input, init);
    modelCalls.push(JSON.parse(init.body));
    return Response.json({
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Summarize this project briefly now please",
            },
          ],
        },
      ],
    });
  };
  try {
    await page.route("**/v1/chat-titles", async (route) => {
      const request = route.request();
      const headers = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "POST, OPTIONS",
      };
      if (request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers });
        return;
      }
      requests.push(request.postDataJSON());
      const response = await originalFetch(`${apiUrl}/v1/chat-titles`, {
        method: "POST",
        headers: {
          authorization: request.headers().authorization ?? "",
          "content-type": "application/json",
        },
        body: request.postData(),
      });
      await route.fulfill({
        status: response.status,
        headers: { ...headers, "content-type": "application/json" },
        body: await response.text(),
      });
    });
    await page.setViewportSize({ width: 900, height: 340 });
    await page.goto(`${harnessBase}/harness-draft-indicators.html?fresh`, {
      waitUntil: "networkidle",
    });
    await page.evaluate(async (accessToken) => {
      const { useWorkspaceStore } =
        await import("/apps/desktop/src/renderer/state/workspace-store.ts");
      const { startChatTitleRequest } =
        await import("/apps/desktop/src/renderer/features/agent/chat-title.ts");
      const { resync } =
        await import("/apps/desktop/src/renderer/features/auth/auth-store.ts");
      let signedIn = false;
      window.__ZEROS_NATIVE__ = {
        on: () => () => {},
        invoke: async (command) => {
          if (command === "auth_get_access_token")
            return { access_token: signedIn ? accessToken : null };
          if (command === "auth_get_session_user")
            return {
              sub: "title-smoke-user",
              provider: "auth0",
              email: "title@example.test",
              name: null,
            };
          return null;
        },
      };
      const { dispatch } = useWorkspaceStore.getState();
      dispatch({ type: "UPDATE_CHAT_TITLE", id: "draft-a", title: "Untitled" });
      const stop = startChatTitleRequest({
        chatId: "draft-a",
        messageId: "first-message",
        expectedTitle: "Untitled",
        prompt: "a".repeat(400) + "omitted-middle" + "z".repeat(100),
        dispatch,
      });
      window.chatTitleSmoke = {
        signIn: async () => {
          signedIn = true;
          await resync();
        },
        stop,
      };
      await new Promise((resolve) => setTimeout(resolve, 0));
    }, token);
    const tab = page.locator('[data-chat-id="draft-a"]');
    await expect(tab).toContainText("Untitled");
    expect(requests).toHaveLength(0);
    await page.evaluate(() => window.chatTitleSmoke.signIn());
    await expect(tab).toContainText("Summarize this project briefly now");
    expect(requests).toEqual([
      {
        chatId: "draft-a",
        messageId: "first-message",
        prompt: "a".repeat(400) + "z".repeat(100),
      },
    ]);
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]).toMatchObject({
      model: "gpt-6-luna",
      reasoning: { effort: "none" },
      max_output_tokens: 32,
      input: requests[0].prompt,
    });
    await page.evaluate(async () => {
      await window.chatTitleSmoke.signIn();
      window.chatTitleSmoke.stop();
    });
    expect(requests).toHaveLength(1);
    expect(errors).toEqual([]);
    check(
      "sign-in wakes naming through HTTP and updates the actual chat tab",
      true,
    );
    check(
      "title requests contain 400 + 100 characters and visible titles stop at five words",
      true,
    );
    if (screenshotPath) await page.screenshot({ path: screenshotPath });
  } finally {
    globalThis.fetch = originalFetch;
    await page.unroute("**/v1/chat-titles");
    await new Promise((resolve) => server.close(resolve));
  }
}
