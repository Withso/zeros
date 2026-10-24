import { expect } from "@playwright/test";

/** Exercise production organization UI/API codecs with fixture native and HTTP boundaries. */
export async function runOrganizationMcpSmoke({ page: parent, check }) {
  const context = await parent.context().browser().newContext({ viewport: { width: 1200, height: 1000 } });
  const page = await context.newPage();
  const orgA = "11111111-1111-4111-8111-111111111111";
  const orgB = "22222222-2222-4222-8222-222222222222";
  const userA = "33333333-3333-4333-8333-333333333333";
  const userB = "44444444-4444-4444-8444-444444444444";
  const attempt = "55555555-5555-4555-8555-555555555555";
  const organization = (id, name, role) => ({ id, name, slug: name.toLowerCase(), role, isPersonal: false, logo: null,
    defaultTeamId: null, workspaceCapabilities: { local: true, cloud: true }, teamCapabilities: { multiple: false, canCreate: false } });
  const organizations = [organization(orgA, "Team A", "owner"), organization(orgB, "Team B", "member")];
  const me = id => ({ user: { id, email: "fixture@example.test", displayName: "Fixture", staffRole: null }, teams: organizations, organizations });
  const rows = new Map([[orgA, []], [orgB, [{
    id: "66666666-6666-4666-8666-666666666666", kind: "mcp", owner: "organization", repository: "team-b/project", revision: 1,
    config: { name: "shared-sign-in", transport: "http", url: "https://oauth.example.test/mcp", auth: "oauth" },
    secrets: { env: [], headers: [], oauthClientSecret: false }, canEdit: false, updatedAt: new Date(0).toISOString(), oauth: { status: "needs-auth" },
  }]]]);
  let probes = 0;
  let polls = 0;
  let cancellations = 0;
  let holdProbe = false;
  let releaseProbe;
  let heldRead;
  let holdRead = false;
  let completeAuth = false;
  let failWrite = false;
  const authInputs = [];
  let lastWrite;
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ userA }) => {
    window.organizationMcpFixture = { account: userA, opened: [], native: [] };
    window.__ZEROS_NATIVE__ = {
      on: () => () => {},
      invoke: async (command, args) => {
        const fixture = window.organizationMcpFixture;
        if (command === "auth_get_access_token") return { access_token: "fixture-" + fixture.account };
        if (command === "auth_get_session_user") return { sub: fixture.account, email: "fixture@example.test", name: "Fixture", provider: "workos" };
        if (command === "app_info") return { version: "0.0.0", runtimeMode: "dev" };
        if (command === "shell_open_url") { fixture.opened.push(args.url); return; }
        if (command === "gh_cloud") {
          fixture.native.push(args.action);
          if (args.action === "catalog") return { login: "fixture", complete: true, installUrl: "https://github.com/apps/fixture/installations/new",
            installations: [{ id: "77777777-7777-4777-8777-777777777777", accountLogin: "team", accountType: "Organization", connected: true, suspendedAt: null }] };
          if (args.action === "repositories") return { repositories: [], nextPage: null };
        }
        return null;
      },
    };
  }, { userA });
  await page.route("**/v1/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = data => route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    if (url.pathname === "/v1/me") return json(me(request.headers().authorization?.endsWith(userB) ? userB : userA));
    const org = url.pathname.split("/")[3];
    if (url.pathname.endsWith("/mcp/repositories")) return json({ repositories: [{ repository: org === orgA ? "team-a/project" : "team-b/project" }] });
    if (url.pathname.endsWith("/mcp/probe")) {
      probes++;
      if (holdProbe) await new Promise(resolve => { releaseProbe = resolve; });
      const input = request.postDataJSON();
      const needsAuth = input.config.auth === "oauth" && !completeAuth;
      return json({ status: needsAuth ? "needs-auth" : "connected", toolCount: 2,
        ...(!needsAuth ? { tools: ["org_read", "org_write"] } : {}),
        stages: [{ stage: "transport", status: "passed" }, { stage: "initialize", status: needsAuth ? "needs-auth" : "passed" }, { stage: "tools", status: needsAuth ? "needs-auth" : "passed" }] });
    }
    if (url.pathname.endsWith("/mcp/oauth/start")) {
      authInputs.push(request.postDataJSON());
      return json({ attemptId: attempt, authorizationUrl: "https://identity.example.test/authorize", expiresAt: Date.now() + 60_000 });
    }
    if (url.pathname.endsWith("/mcp/oauth/" + attempt)) {
      if (request.method() === "DELETE") { cancellations++; return json({ ok: true }); }
      polls++;
      if (completeAuth) for (const row of rows.get(org) ?? []) if (row.config.auth === "oauth") row.oauth = { status: "connected" };
      return json({ status: completeAuth ? "connected" : "pending" });
    }
    if (url.pathname.endsWith("/extensions") && request.method() === "GET") {
      const extensions = structuredClone(rows.get(org) ?? []);
      if (holdRead && org === orgA) { holdRead = false; await new Promise(resolve => { heldRead = resolve; }); }
      return json({ extensions });
    }
    if (request.method() === "PUT") {
      if (failWrite) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "mcp_fixture_conflict", message: "The server changed. Review it and try again." } }) });
      const input = request.postDataJSON();
      const existing = rows.get(org).find(row => row.id === url.pathname.split("/").at(-1));
      lastWrite = input;
      const saved = { id: url.pathname.split("/").at(-1), kind: "mcp", owner: input.owner, repository: input.repository,
        revision: (existing?.revision ?? 0) + 1, config: input.config, canEdit: true, updatedAt: new Date().toISOString(),
        secrets: { env: Object.keys(input.secrets?.env ?? {}), headers: Object.keys(input.secrets?.headers ?? {}), oauthClientSecret: false } };
      rows.set(org, [...rows.get(org).filter(row => row.id !== saved.id), saved]);
      return json({ extension: saved });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":{"code":"fixture","message":"Unexpected fixture request"}}' });
  });
  const selectOwner = async (id, account) => page.evaluate(async ({ id, account, snapshot }) => {
    const store = await import("/apps/desktop/src/renderer/features/team/team-store.ts");
    const active = await import("/apps/desktop/src/renderer/features/team/active-team.ts");
    if (account) { window.organizationMcpFixture.account = account; store.clearTeamStore(); }
    store.acceptOrganizationSnapshot(snapshot);
    active.setActiveOrganizationSelection(id, false);
  }, { id, account, snapshot: me(account ?? userA) });
  const button = name => page.getByRole("button", { name, exact: true });
  const field = name => page.getByLabel(name, { exact: true });
  const section = name => page.getByRole("region", { name, exact: true });
  try {
    await page.goto(new URL("/apps/desktop/src/renderer/harnesses/harness-customize.html", parent.url()).href);
    await selectOwner(orgA);
    await button("Add server").click();
    await page.getByRole("combobox", { name: "Owner" }).click();
    await expect(page.getByRole("option")).toHaveText(["Organisation", "You"]);
    await page.getByRole("option", { name: "You", exact: true }).click();
    await page.getByRole("combobox", { name: "Project" }).click();
    await expect(page.getByRole("option")).toHaveText(["All projects", "team-a/project"]);
    await page.getByRole("option", { name: "team-a/project", exact: true }).click();
    await field("Name").fill("private-api");
    await page.getByRole("combobox", { name: "Transport" }).click();
    await page.getByRole("option", { name: "Streamable HTTP", exact: true }).click();
    await field("URL").fill("https://tools.example.test/mcp");
    await page.getByRole("combobox", { name: "Authentication", exact: true }).click();
    await page.getByRole("option", { name: "API key", exact: true }).click();
    await button("Add header").click();
    await field("Header name 1").fill("Authorization");
    await button("Add server").click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Enter a value for the Authorization header." })).toBeVisible();
    expect(lastWrite).toBeUndefined();
    await field("Header value 1").fill("fixture-private-value");
    await expect(section("Connection")).toContainText("2 tools available.");
    await expect(section("Tools").getByRole("switch", { name: "Allow org_write", exact: true })).toBeEnabled();
    await section("Tools").getByRole("switch", { name: "Allow org_write", exact: true }).click();
    await button("Add server").click();
    const savedRow = () => button("Edit private-api");
    const savedStatus = () => savedRow().locator("..");
    await expect(savedStatus()).toContainText("Connected");
    expect(lastWrite).toMatchObject({ owner: "user", repository: "team-a/project", config: { headers: { Authorization: "${zeros.secret}" }, disabled_tools: ["org_write"] }, secrets: { headers: { Authorization: "fixture-private-value" } } });
    check("Organisation projects use authorized owner/repo names and private credentials travel separately from config", true);

    holdProbe = true;
    await savedRow().click();
    await expect(section("Connection")).toContainText("Checking connection");
    await expect(section("Connection")).toContainText("Connected");
    await expect(section("Tools").getByRole("switch", { name: "Allow org_write", exact: true })).not.toBeChecked();
    releaseProbe?.(); holdProbe = false;
    await expect(section("Connection")).toContainText("2 tools available.");
    rows.get(orgA)[0].revision++;
    await button("MCP").click();
    await expect(savedStatus()).toContainText("Needs connection");
    check("Saved checks survive reopening while shared credential revisions invalidate them", true);

    await savedRow().click();
    await page.getByRole("combobox", { name: "Authentication", exact: true }).click();
    await page.getByRole("option", { name: "Sign in", exact: true }).click();
    await expect(section("Connection")).toContainText("Sign-in required");
    failWrite = true;
    await button("Save & connect").click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "The server changed" })).toBeVisible();
    expect(authInputs).toHaveLength(0);
    failWrite = false; completeAuth = true;
    await button("Save & connect").click();
    await expect(section("Connection")).toContainText("Connected");
    expect(authInputs).toHaveLength(1);
    expect(authInputs[0]).toMatchObject({ extensionId: rows.get(orgA)[0].id, expectedRevision: rows.get(orgA)[0].revision, config: { auth: "oauth" } });
    await button("MCP").click();
    await expect(savedStatus()).toContainText("Connected");
    check("Organization save-and-connect uses the saved revision and never authorizes a failed write", true);
    completeAuth = false;

    holdRead = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => Boolean(heldRead)).toBe(true);
    await selectOwner(orgB, userB);
    await expect(page.getByRole("button").filter({ hasText: "shared-sign-in" })).toBeVisible();
    heldRead(); heldRead = undefined;
    await expect(savedRow()).toHaveCount(0);
    await page.getByRole("button").filter({ hasText: "shared-sign-in" }).click();
    await expect(field("Name")).toBeDisabled();
    await expect(button("Save changes")).toHaveCount(0);
    await expect(button("Connect")).toBeEnabled();
    await button("Connect").click();
    await expect.poll(() => polls).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => window.organizationMcpFixture.opened)).toEqual(["https://identity.example.test/authorize", "https://identity.example.test/authorize"]);
    await page.evaluate(() => window.mcpFormFixture.setSurfaceActive(false));
    await expect.poll(() => cancellations).toBeGreaterThan(0);
    const stoppedPolls = polls;
    await page.clock.install();
    await page.clock.fastForward(5000);
    expect(polls).toBe(stoppedPolls);
    await page.clock.resume();
    await page.evaluate(() => window.mcpFormFixture.setSurfaceActive(true));
    completeAuth = true;
    await button("Connect").click();
    await expect(section("Connection")).toContainText("Connected");
    await expect(section("Tools").getByRole("switch", { name: "Allow org_read", exact: true })).toBeDisabled();
    await expect(section("Tools").getByRole("switch", { name: "Allow org_write", exact: true })).toBeDisabled();
    check("Member editors remain read-only, allow personal sign-in, and cancel polling while hidden", true);
    await selectOwner(orgA, userA);
    await expect(savedStatus()).toContainText("Connected");
    await expect(page.getByRole("button").filter({ hasText: "shared-sign-in" })).toHaveCount(0);
    expect(probes).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    check("Account and organisation A → B → A switches fence delayed responses and saved connection status", true);
  } finally {
    releaseProbe?.(); heldRead?.();
    await context.close();
  }
}
