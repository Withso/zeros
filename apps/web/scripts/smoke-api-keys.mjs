import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { dashboardPage } from "../lib/dashboard.mjs";

const web = fileURLToPath(new URL("../", import.meta.url));
const root = path.resolve(web, "../..");
const screenshotDirectory = process.argv[2];
const organization = {
  id: "33333333-3333-4333-8333-333333333333", slug: "example", name: "Example",
  role: "owner", isPersonal: false, workspaceCapabilities: { local: true, cloud: true },
};
const otherOrganization = { ...organization, id: "44444444-4444-4444-8444-444444444444", slug: "another", name: "Another" };
const user = { id: "fixture-user", email: "person@example.test", displayName: "Example member" };
const me = { user, organizations: [organization, otherOrganization], capabilities: { createOrganization: false } };
const tokenSource = await readFile(path.join(root, "styles/zeros-tokens.css"), "utf8");
const concreteStart = tokenSource.indexOf("\n:root {");
assert.ok(concreteStart >= 0);
const assets = new Map([
  ["/dashboard.js", ["text/javascript", await readFile(path.join(web, "public/dashboard.js"), "utf8")]],
  ["/dashboard.css", ["text/css", await readFile(path.join(web, "public/dashboard.css"), "utf8")]],
  ["/dashboard-tokens.css", ["text/css", tokenSource.slice(concreteStart + 1)]],
]);
const keys = new Map(me.organizations.map(org => [org.id, []]));
let failCreate = false, failRevoke = false, holdCreate = false, releaseCreate, createArrived;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const json = (value, status = 200) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  if (assets.has(url.pathname)) {
    const [type, body] = assets.get(url.pathname);
    response.writeHead(200, { "content-type": type }); response.end(body); return;
  }
  if (url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(dashboardPage({ session: { email: user.email, name: user.displayName }, me,
      requestUrl: `http://127.0.0.1${request.url}`, signOutHref: "/auth/logout" }));
    return;
  }
  if (url.pathname === "/api/v1/me") return json(me);
  if (url.pathname === "/api/v1/auth/snapshot")
    return json({ account: { id: user.id, revision: 1 }, session: { id: "fixture" }, organizations: [], workspaces: [], cursor: 1 });
  if (url.pathname === "/api/v1/auth/events") {
    response.writeHead(200, { "content-type": "text/event-stream" }); response.write("event: ready\ndata: {}\n\n"); return;
  }
  const match = /^\/api\/v1\/organizations\/([^/]+)\/api-keys(?:\/([^/]+))?$/.exec(url.pathname);
  if (match && keys.has(match[1])) {
    const entries = keys.get(match[1]);
    if (request.method === "GET") return json({ apiKeys: entries });
    if (request.method === "DELETE") {
      if (failRevoke) return json({ error: { code: "unavailable", message: "Try revoking again." } }, 503);
      keys.set(match[1], entries.filter(entry => entry.id !== match[2]));
      response.writeHead(204); response.end(); return;
    }
    if (request.method === "POST") {
      if (failCreate) return json({ error: { code: "api_key_limit", message: "Revoke a key before creating another." } }, 409);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (holdCreate) await new Promise(resolve => { releaseCreate = resolve; createArrived(); });
      const key = `zk_${randomBytes(32).toString("base64url")}`;
      const apiKey = { id: randomUUID(), name: input.name, ownerUserId: user.id, ownerName: user.displayName,
        prefix: key.slice(0, 7), createdAt: "2026-11-10T00:00:00Z", lastUsedAt: null };
      entries.push(apiKey);
      return json({ apiKey, key }, 201);
    }
  }
  response.writeHead(404); response.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }), headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const failures = [];
const requireCheck = (condition, label) => { if (!condition) failures.push(label); };
const colors = [];
try {
  if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
  for (const theme of ["light", "dark"]) {
    keys.set(organization.id, []); keys.set(otherOrganization.id, []);
    const context = await browser.newContext({ viewport: { width: 1200, height: 840 }, colorScheme: theme });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", () => errors.push("browser exception"));
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.addInitScript(() => {
      window.clipboardFails = false; window.copiedKey = false;
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async value => {
        if (window.clipboardFails) throw new Error("Fixture clipboard refusal");
        window.copiedKey = /^zk_[A-Za-z0-9_-]{43}$/.test(value);
      } } });
    });
    await page.goto(`${origin}/?organization=${organization.id}&section=api-keys`);
    await page.getByText("No API keys yet.", { exact: true }).waitFor();
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    colors.push(await page.locator(".main-content").evaluate(node => getComputedStyle(node).backgroundColor));
    const capture = async label => {
      assert.equal(await page.locator("[data-api-key-secret]").count(), 0, "A capture must never contain a credential");
      if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, `api-keys-${theme}-${label}.png`), animations: "disabled" });
    };
    await capture("empty");
    const openCreate = async name => {
      await page.getByRole("button", { name: "Create key", exact: true }).press("Enter");
      await page.locator("#create-api-key-dialog[open]").waitFor();
      requireCheck(await page.getByRole("textbox", { name: "Name", exact: true }).evaluate(node => node === document.activeElement), `${theme}: create dialog focuses name`);
      await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
    };
    await openCreate("Automation");
    await capture("create");
    await page.getByRole("textbox", { name: "Name", exact: true }).press("Enter");
    await page.locator("[data-api-key-secret]").waitFor();
    requireCheck(await page.evaluate(() => {
      const field = document.querySelector("[data-api-key-secret]");
      return field.value.length === 46 && !field.hasAttribute("value") &&
        !document.documentElement.outerHTML.includes(field.value) &&
        !JSON.stringify(localStorage).includes(field.value) && !JSON.stringify(sessionStorage).includes(field.value);
    }), `${theme}: credential exists only in the displayed value`);
    await page.evaluate(() => { window.clipboardFails = true; });
    await page.getByRole("button", { name: "Copy key", exact: true }).click();
    await page.getByText("Couldn’t copy the API key", { exact: true }).waitFor();
    requireCheck(await page.getByText("Couldn’t copy the API key", { exact: true }).evaluate(node => node.closest(".toast").classList.contains("error")), `${theme}: clipboard refusal uses error feedback`);
    await page.evaluate(() => { window.clipboardFails = false; });
    await page.getByRole("button", { name: "Copy key", exact: true }).click();
    requireCheck(await page.evaluate(() => window.copiedKey), `${theme}: Copy key writes the credential`);
    await page.keyboard.press("Escape");
    await page.locator("[data-api-key-secret]").waitFor({ state: "detached" });
    await page.getByText("Automation", { exact: true }).waitFor();
    requireCheck(await page.evaluate(() => document.activeElement?.dataset.action === "create-api-key"), `${theme}: close returns focus to Create key`);
    await page.getByRole("button", { name: "Dismiss", exact: true }).first().click();
    await page.getByRole("button", { name: "Dismiss", exact: true }).first().click();
    await capture("list");
    await page.getByRole("button", { name: "Revoke Automation", exact: true }).click();
    await page.locator("#revoke-api-key-dialog[open]").waitFor();
    await capture("revoke");
    failRevoke = true;
    await page.getByRole("button", { name: "Revoke key", exact: true }).click();
    await page.getByText("Try revoking again.", { exact: true }).waitFor();
    failRevoke = false;
    await page.getByRole("button", { name: "Revoke key", exact: true }).click();
    await page.getByText("No API keys yet.", { exact: true }).waitFor();
    await page.locator("#revoke-api-key-dialog").waitFor({ state: "detached" });
    await openCreate("Limit error");
    failCreate = true;
    await page.getByRole("textbox", { name: "Name", exact: true }).press("Enter");
    await page.getByText("Revoke a key before creating another.", { exact: true }).waitFor();
    failCreate = false;
    await page.keyboard.press("Escape");
    await page.locator("#create-api-key-dialog").waitFor({ state: "detached" });
    await openCreate("Late response");
    holdCreate = true;
    const arrived = new Promise(resolve => { createArrived = resolve; });
    await page.getByRole("textbox", { name: "Name", exact: true }).press("Enter");
    await arrived;
    await page.keyboard.press("Escape");
    await page.locator("#create-api-key-dialog").waitFor({ state: "detached" });
    for (const org of [otherOrganization, organization]) {
      await page.locator("#org-switcher > summary").click();
      await page.locator(`[data-org-id="${org.id}"]`).click();
      await page.waitForURL(url => url.searchParams.get("organization") === org.id);
    }
    holdCreate = false; releaseCreate();
    await page.getByText("Late response", { exact: true }).waitFor();
    requireCheck(await page.locator("[data-api-key-secret]").count() === 0, `${theme}: closed A to B to A create cannot reveal a late key`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector(".sidebar").getBoundingClientRect().right <= 0);
    requireCheck(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}: mobile page has no horizontal overflow`);
    await capture("mobile");
    assert.deepEqual(errors, [], "Production dashboard raised a browser exception");
    await context.close();
    console.log(`${theme}: API key create, reveal, copy, close, revoke, errors, owner switch and mobile checked`);
  }
  assert.notEqual(colors[0], colors[1], "The computed surface must change with the theme");
  assert.deepEqual(failures, [], "API key browser regressions");
} finally {
  releaseCreate?.();
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
