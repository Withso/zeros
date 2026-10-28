import { expect } from "@playwright/test";
import { join } from "node:path";

const orgA = "22222222-2222-4222-8222-222222222222";
const orgB = "33333333-3333-4333-8333-333333333333";
const generation = (version) => version.toString(16).padStart(64, "0");
const blank = () => ({
  generation: generation(1),
  selectedMethod: null,
  appAvailable: true,
  installUrl: "https://github.com/apps/zeros-fixture/installations/new",
  methods: {
    "github-app": { configured: false, health: "not-connected" },
    pat: { configured: false, health: "not-connected" },
  },
});

/** The real controls and HTTPS client run together. Only provider responses
 * and the desktop session are synthetic; no real account is modified. */
export async function runCloudGithubSmoke({
  page,
  harnessBase,
  check,
  screenshotDirectory,
}) {
  const states = {
    [orgA]: blank(),
    [orgB]: {
      ...blank(),
      selectedMethod: "github-app",
      methods: {
        "github-app": {
          configured: true,
          health: "connected",
          login: "second-person",
        },
        pat: { configured: false, health: "not-connected" },
      },
    },
  };
  const calls = [];
  let releaseRead;
  let held = false;
  let holdOrganization = orgA;
  let savedPat = false;
  let version = 1;
  const advance = (state) => {
    state.generation = generation(++version);
  };
  await page.route(
    "https://api.example.test/v1/cloud-v2/github/**",
    async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      const headers = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      };
      if (request.method() === "OPTIONS")
        return route.fulfill({ status: 204, headers });
      const body = request.method() === "POST" ? request.postDataJSON() : null;
      const organizationId =
        body?.organizationId ?? url.searchParams.get("organizationId");
      calls.push({
        organizationId,
        method: request.method(),
        action: body?.action ?? null,
        path: url.pathname,
      });
      const state = states[organizationId];
      if (!state) throw new Error("Cloud GitHub request lost its organization");
      let result;
      if (body) {
        if (body.expected !== state.generation)
          return route.fulfill({
            status: 409,
            headers,
            json: {
              error: {
                code: "github_authorization_changed",
                message: "Connection changed",
              },
            },
          });
        advance(state);
        if (body.action === "pat") {
          savedPat = body.token === "synthetic-personal-token";
          state.methods.pat = {
            configured: true,
            login: "token-person",
            health: "connected",
          };
          state.selectedMethod = "pat";
        } else if (body.action === "select") state.selectedMethod = body.method;
        else if (body.action === "disconnect") {
          state.methods[body.method] = {
            configured: false,
            health: "not-connected",
          };
          if (state.selectedMethod === body.method) state.selectedMethod = null;
        } else if (body.action === "oauth")
          result = {
            generation: state.generation,
            url: "https://github.com/login/oauth/authorize?state=synthetic-state",
          };
        result ??= structuredClone(state);
      } else if (url.pathname.endsWith("/repositories")) {
        result = {
          generation: state.generation,
          nextPage: null,
          complete: true,
          repositories:
            organizationId === orgA
              ? [
                  {
                    id: "42",
                    owner: "example",
                    name: "accessible",
                    defaultBranch: "main",
                    private: true,
                    canPush: true,
                  },
                  {
                    id: "43",
                    owner: "example",
                    name: "read-only",
                    defaultBranch: "main",
                    private: true,
                    canPush: false,
                  },
                ]
              : [
                  {
                    id: "77",
                    owner: "another",
                    name: "project",
                    defaultBranch: "main",
                    private: true,
                    canPush: true,
                  },
                ],
        };
      } else {
        result = structuredClone(state);
        if (holdOrganization === organizationId) {
          holdOrganization = null;
          await new Promise((resolve) => {
            releaseRead = resolve;
            held = true;
          });
        }
      }
      await route.fulfill({ headers, json: result });
    },
  );
  await page.goto(`${harnessBase}/harness-cloud-github.html`, {
    waitUntil: "domcontentloaded",
  });
  const app = page.getByRole("group", {
    name: "Zeros GitHub App",
    exact: true,
  });
  const pat = page.getByRole("group", {
    name: "Personal Access Token",
    exact: true,
  });
  await expect.poll(() => held).toBe(true);
  await expect(
    app.getByRole("button", { name: "Connect", exact: true }),
  ).toBeDisabled();
  await expect(
    pat.getByRole("button", { name: "Connect", exact: true }),
  ).toBeDisabled();
  check(
    "cloud GitHub cold controls stay inert until their owner is confirmed",
    true,
  );
  releaseRead();
  await expect(
    pat.getByRole("button", { name: "Connect", exact: true }),
  ).toBeEnabled();
  await pat.getByRole("button", { name: "Connect", exact: true }).click();
  const tokenInput = page.getByLabel("Cloud GitHub personal access token");
  await expect(tokenInput).toHaveAttribute("type", "password");
  await tokenInput.fill("synthetic-personal-token");
  await pat.getByRole("button", { name: "Save token", exact: true }).click();
  await expect(pat.getByText("Selected for cloud workspaces")).toBeVisible();
  await expect(tokenInput).toHaveCount(0);
  check(
    "cloud PAT saves through its scoped HTTPS connection and clears the input",
    savedPat,
  );
  check(
    "cloud PAT is absent from browser persistence",
    await page.evaluate(
      () =>
        !JSON.stringify([
          Object.entries(localStorage),
          Object.entries(sessionStorage),
        ]).includes("synthetic-personal-token"),
    ),
  );

  await app.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(app.getByText("Finish signing in on GitHub.")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.cloudGithubFixture.nativeCalls.some(
          (call) =>
            call.command === "shell_open_url" &&
            call.url?.startsWith("https://github.com/login/oauth/authorize"),
        ),
      ),
    )
    .toBe(true);
  states[orgA].methods["github-app"] = {
    configured: true,
    health: "connected",
    login: "app-person",
  };
  states[orgA].selectedMethod = "github-app";
  advance(states[orgA]);
  await page
    .getByRole("button", { name: "Refresh cloud GitHub connection" })
    .click();
  await expect(app.getByText("Selected for cloud workspaces")).toBeVisible();
  await expect(app.getByText("Finish signing in on GitHub.")).toHaveCount(0);
  await expect(pat.getByText("Signed in as token-person")).toBeVisible();
  check("cloud App OAuth completes without deleting the saved PAT", true);

  if (screenshotDirectory) {
    for (const theme of ["dark", "light"]) {
      await page.evaluate(
        (theme) => document.documentElement.setAttribute("data-theme", theme),
        theme,
      );
      await page
        .locator("#cloud-github-panel")
        .screenshot({
          path: join(screenshotDirectory, `cloud-github-${theme}.png`),
          animations: "disabled",
        });
    }
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
  }

  await app
    .getByRole("button", { name: "Disconnect Zeros GitHub App", exact: true })
    .click();
  await expect(
    app.getByRole("button", { name: "Connect", exact: true }),
  ).toBeEnabled();
  await expect(pat.getByText("Signed in as token-person")).toBeVisible();
  await pat.getByRole("button", { name: "Use", exact: true }).click();
  await expect(pat.getByText("Selected for cloud workspaces")).toBeVisible();
  await page.getByRole("button", { name: "Choose cloud repositories" }).click();
  await expect(
    page.getByRole("button", { name: "example/accessible", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "example/read-only Read only",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "example/accessible", exact: true })
    .click();
  check(
    "cloud repository picker shows only the selected connection and marks read-only repositories",
    true,
  );

  // A known signed-in account missing installation access needs installation
  // guidance. Asking it to sign in again does not solve that permission gap.
  states[orgA].methods["github-app"] = {
    configured: true,
    health: "not-installed",
    login: "app-person",
  };
  states[orgA].selectedMethod = "github-app";
  advance(states[orgA]);
  await page
    .getByRole("button", { name: "Refresh cloud GitHub connection" })
    .click();
  await expect(
    app.getByText("Grant Zeros access in GitHub to choose repositories."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Choose cloud repositories" }).click();
  await expect(
    page.getByText("Grant Zeros access in GitHub to choose repositories."),
  ).toHaveCount(2);
  await page.keyboard.press("Escape");
  check(
    "cloud missing-installation guidance distinguishes App access from account sign-in",
    true,
  );

  await page.clock.install();
  await app.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(app.getByText("Finish signing in on GitHub.")).toBeVisible();
  await page.getByRole("button", { name: "Hide cloud settings" }).click();
  const reads = calls.filter((call) => call.method === "GET").length;
  await page.clock.runFor(10_000);
  check(
    "hidden cloud settings stop OAuth polling",
    calls.filter((call) => call.method === "GET").length === reads,
  );
  await page.getByRole("button", { name: "Show cloud settings" }).click();
  await expect
    .poll(() => calls.filter((call) => call.method === "GET").length)
    .toBeGreaterThan(reads);
  await app.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(app.getByText("Finish signing in on GitHub.")).toHaveCount(0);
  held = false;
  holdOrganization = orgA;
  await page
    .getByRole("button", { name: "Refresh cloud GitHub connection" })
    .click();
  await expect.poll(() => held).toBe(true);
  await page
    .getByRole("button", { name: "Organization B", exact: true })
    .click();
  await expect(app.getByText("Signed in as second-person")).toBeVisible();
  releaseRead();
  await expect(app.getByText("Signed in as app-person")).toHaveCount(0);
  await expect(pat.getByText("Signed in as token-person")).toHaveCount(0);
  await page.getByRole("button", { name: "Choose cloud repositories" }).click();
  await expect(
    page.getByRole("button", { name: "another/project", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "example/accessible", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Organization A", exact: true })
    .click();
  await expect(pat.getByText("Signed in as token-person")).toBeVisible();
  check(
    "cloud organization A to B to A never shows a late foreign response",
    true,
  );
  check(
    "cloud GitHub settings never consult the Mac GitHub login",
    await page.evaluate(() =>
      window.cloudGithubFixture.nativeCalls.every(
        (call) => !call.command.startsWith("gh_"),
      ),
    ),
  );
}
