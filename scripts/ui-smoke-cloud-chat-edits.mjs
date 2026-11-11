import { expect } from "@playwright/test";

/** Rename and close (archive) a chat of a stopped cloud workspace from the
 * real tab strip. The edits go to the control-plane route only; nothing may
 * reach the workspace bridge, which would wake the VM. */
export async function runCloudChatEditsSmoke({ page, harnessBase, check }) {
  const url = `${new URL(harnessBase).origin}/apps/desktop/src/renderer/harnesses/harness-cloud-chat-edits.html`;
  const edits = [];
  let refuse = null;
  const endpoint = "https://api.example.test/v1/cloud-v2/workspaces/*/chats/*/edit";
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, idempotency-key, x-zeros-client",
    "access-control-allow-methods": "POST, OPTIONS" };
  const handle = async route => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const chatId = decodeURIComponent(new URL(request.url()).pathname.split("/").at(-2));
    const body = request.postDataJSON();
    edits.push({ chatId, body });
    if (refuse) return route.fulfill({ status: 409, headers: cors, json: { error: refuse } });
    return route.fulfill({ headers: cors, json: { chat: { id: chatId, title: body.title ?? "Second chat", archived: body.archived ?? false } } });
  };
  // Any other control-plane call (start, connect, lifecycle) would be a wake.
  const others = [];
  const record = route => { if (route.request().method() !== "OPTIONS") others.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 404, headers: cors, json: { error: { code: "not_found", message: "Not in this fixture." } } }); };
  await page.route("https://api.example.test/**", record);
  await page.route(endpoint, handle);
  try {
    await page.goto(url);
    const tabs = page.getByRole("tablist").first();
    await expect(page.getByText("First chat", { exact: true })).toBeVisible();
    const state = () => page.evaluate(() => globalThis.__chatEdits.chats());
    const bridge = () => page.evaluate(() => globalThis.__chatEdits.bridgeCalls());

    await page.getByText("First chat", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const input = page.getByRole("textbox", { name: "Rename chat" });
    await input.fill("Renamed from the app");
    await input.press("Enter");
    await expect(page.getByText("Renamed from the app", { exact: true })).toBeVisible();
    await expect.poll(() => edits).toEqual([{ chatId: "first", body: { title: "Renamed from the app" } }]);
    expect((await state()).find(row => row.id.endsWith(":first")).title).toBe("Renamed from the app");
    check("A stopped cloud workspace's chat renames at once through the control-plane route", true);

    refuse = { code: "worker_update_required", message: "Restart the workspace to update its worker." };
    await page.getByText("Second chat", { exact: true }).hover();
    await page.getByRole("button", { name: "Close chat" }).last().click();
    await expect.poll(() => edits.length).toBe(2);
    expect(edits[1]).toEqual({ chatId: "second", body: { archived: true } });
    await expect(page.getByText("Couldn't close the chat")).toBeVisible();
    await expect(page.getByText("Restart the workspace to update its worker.")).toBeVisible();
    await expect(page.getByText("Second chat", { exact: true })).toBeVisible();
    expect((await state()).find(row => row.id.endsWith(":second")).archived).toBe(false);
    check("A refused close of a cloud chat is reverted with the server's reason", true);

    // A chat the server still sees working closes exactly as before: it stays closed, quietly.
    refuse = { code: "session_busy", message: "Stop the agent first." };
    await page.getByText("Second chat", { exact: true }).hover();
    await page.getByRole("button", { name: "Close chat" }).last().click();
    await expect.poll(() => edits.length).toBe(3);
    await expect(page.getByText("Second chat", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Stop the agent first.")).toHaveCount(0);
    await expect.poll(async () => (await state()).find(row => row.id.endsWith(":second")).archived).toBe(true);
    // The tab strip reads its workspace list; no chat write or other op reaches the VM.
    expect((await bridge()).filter(call => call.startsWith("request") || call.startsWith("send"))
      .every(call => call === "request WORKSPACE_REQUEST workspace.list")).toBe(true);
    expect(others).toEqual([]);
    await expect(tabs).toBeVisible();
    check("A close the route calls busy stays closed without an error, and no edit touched the workspace bridge (no wake)", true);
  } finally { await page.unroute(endpoint, handle); await page.unroute("https://api.example.test/**", record); }
}
