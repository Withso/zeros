// Real switcher and memoized workspace-list regression, using synthetic
// account snapshots only. Also callable alone: node scripts/ui-smoke-personal.mjs.
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function runPersonalOrganizationSmoke({ page, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-personal-organization.html`,
  );
  const switcher = page.getByRole("button", { name: "Switch organization", includeHidden: true });
  const rows = page
    .getByRole("list", { name: "Visible workspaces" })
    .getByRole("listitem");
  await expect(switcher).toHaveText("Local");
  await switcher.click();
  await expect(
    page.getByRole("menuitem", { name: "Local", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("menuitem", { name: "Create organization", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  check(
    "one existing Local (device Personal) entry is available without an account",
    true,
  );

  await page.getByRole("button", { name: "Use account A" }).click();
  await expect(switcher).toHaveText("Local");
  await expect(rows).toHaveText(["Unowned local", "A legacy local"]);
  await page.getByRole("button", { name: "Create local fixture" }).click();
  await expect(rows.filter({ hasText: "Created local" })).toHaveAttribute(
    "data-owner",
    "none",
  );
  await expect(page.getByTestId("cloud-capability")).toHaveText("blocked");
  check(
    "Personal creation is account-independent and cloud creation stays blocked",
    true,
  );

  // Membership may be created by another device (or Dev provisioning) after
  // sign-in. Opening the menu revalidates without blanking cached Local data.
  await page.evaluate(async () => {
    const { controlPlane } = await import("/apps/desktop/src/renderer/features/team/control-plane.ts");
    const { getTeamStoreState } = await import("/apps/desktop/src/renderer/features/team/team-store.ts");
    const cached = getTeamStoreState().me;
    const added = { ...cached.organizations.find(row => !row.isPersonal), id: "org_new", name: "New cloud organization", slug: "new-cloud" };
    const snapshot = { ...cached, organizations: [...cached.organizations, added], teams: [...cached.teams, added] };
    window.__membershipRefresh = { requests: 0, finish: null };
    controlPlane.me = () => {
      window.__membershipRefresh.requests += 1;
      return new Promise(resolve => { window.__membershipRefresh.finish = () => resolve(snapshot); });
    };
  });
  await switcher.click();
  await expect(page.getByRole("menuitem", { name: "Business A", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__membershipRefresh.requests)).toBe(1);
  const retainedRows = page.getByRole("list", { name: "Visible workspaces", includeHidden: true }).getByRole("listitem", { includeHidden: true });
  await expect(retainedRows).toHaveText(["Unowned local", "A legacy local", "Created local"]);
  await page.evaluate(() => window.__membershipRefresh.finish());
  await expect(page.getByRole("menuitem", { name: "New cloud organization", exact: true })).toBeVisible();
  await expect(switcher).toHaveText("Local");
  await expect(retainedRows).toHaveText(["Unowned local", "A legacy local", "Created local"]);
  await page.evaluate(async () => {
    const { controlPlane } = await import("/apps/desktop/src/renderer/features/team/control-plane.ts");
    controlPlane.me = async () => { throw new Error("Harness organization service offline"); };
  });
  await page.keyboard.press("Escape");
  check("opening the switcher discovers new organizations while retaining Local selection and cached workspaces", true);

  await switcher.click();
  await page.getByRole("menuitem", { name: "Business A", exact: true }).click();
  await expect(rows).toHaveText(["Business A cloud"]);
  await expect(page.getByTestId("cloud-capability")).toHaveText("allowed");
  await page.getByRole("button", { name: "Use account B" }).click();
  await expect(switcher).toHaveText("Local");
  await expect(rows).toHaveText([
    "Unowned local",
    "A legacy local",
    "B legacy local",
    "Created local",
  ]);
  check(
    "account switch preserves Personal rows and drops the prior cloud organization",
    true,
  );

  await switcher.click();
  await expect(
    page.getByRole("menuitem", { name: "Local", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("menuitem", { name: "Business A", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("menuitem", { name: "Manage account", exact: true })
    .click();
  await expect(page.locator("#dashboard-link")).toContainText(
    "section=profile",
  );
  await expect(page.locator("#dashboard-link")).not.toContainText(
    "organization=",
  );
  check(
    "Personal account management never sends the local selection as a server tenant",
    true,
  );

  await switcher.click();
  await page.getByRole("menuitem", { name: "Log out", exact: true }).click();
  await expect(switcher).toHaveText("Local");
  await expect(rows).toHaveText([
    "Unowned local",
    "A legacy local",
    "B legacy local",
    "Created local",
  ]);
  await page.reload();
  await expect(switcher).toHaveText("Local");
  await expect(rows).toHaveText([
    "Unowned local",
    "A legacy local",
    "B legacy local",
  ]);
  check(
    "logout and reload retain Personal's legacy local collection without network access",
    true,
  );

  await page.setViewportSize({ width: 1000, height: 600 });
  await page.getByRole("button", { name: "Use many organizations" }).click();
  await switcher.click();
  const memberships = page.getByRole("menuitem", { name: /^Membership / });
  const names = Array.from({ length: 20 }, (_, index) => `Membership ${String(index + 1).padStart(2, "0")}`);
  await expect(memberships).toHaveText(names);
  const menu = page.getByRole("menu");
  expect(await menu.evaluate(node => getComputedStyle(node).overflowY)).toBe("auto");
  expect(await menu.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await page.getByRole("menuitem", { name: "Membership 19", exact: true }).click();
  await expect(switcher).toHaveText("Membership 19");
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  await page.mouse.move(950, 550);
  await switcher.focus();
  await page.keyboard.press("Enter");
  const active = page.getByRole("menuitem", { name: "Membership 19", exact: true });
  await expect(active).toHaveAttribute("aria-current", "true");
  await expect(active).toBeFocused();
  await expect(active).toBeInViewport();
  expect(await menu.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Membership 20", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(switcher).toBeFocused();
  check("all twenty memberships keep their order in one scroll surface with active-row focus and keyboard navigation", true);

  await page.reload();
  await expect(switcher).toHaveText("Membership 19");
  await switcher.click();
  await expect(memberships).toHaveText(names);
  await expect(active).toHaveAttribute("aria-current", "true");
  await expect(active).toBeInViewport();
  await expect(page.getByRole("menuitem", { name: "Sign in", exact: true })).toHaveCount(1);
  await expect(page.getByRole("menuitem", { name: "Manage organization", exact: true })).toHaveCount(0);
  expect(await page.evaluate(async () => {
    const { getTeamStoreState } = await import("/apps/desktop/src/renderer/features/team/team-store.ts");
    return getTeamStoreState().me === null;
  })).toBe(true);
  check("offline reload restores the selected organization and full list without account authority, retaining Sign in", true);
  await page.keyboard.press("Escape");

  await page.goto(`${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-app-sidebar.html?organizations`);
  await page.locator('[data-workspace-id="ws-boston"]').click();
  const destination = { page: "workspace", folder: "/fixture-workspaces/zeros/boston", chatId: "chat-ws-boston" };
  const selected = () => page.evaluate(() => window.appSidebarState());
  await expect.poll(selected).toMatchObject(destination);
  const selectOrganization = async name => {
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    await switcher.click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  };
  await selectOrganization("Membership 01");
  await expect.poll(selected).toMatchObject({ page: "dashboard" });
  await selectOrganization("Local");
  await expect.poll(selected).toMatchObject(destination);
  check("the real sidebar restores Local's workspace and chat after an organization round trip", true);
  await page.reload();
  await selectOrganization("Membership 01");
  await selectOrganization("Local");
  await expect.poll(selected).toMatchObject(destination);
  check("per-organization workspace and chat destinations survive reload", true);
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const port = await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
  const vite = spawn(
    "pnpm",
    [
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: root,
      env: { ...process.env, VITE_CONTROL_PLANE_URL: "https://api.example.test" },
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    },
  );
  vite.stderr.on("data", (data) => process.stderr.write(data));
  let browser;
  try {
    const url = `http://127.0.0.1:${port}/apps/desktop/src/renderer/harnesses/harness-personal-organization.html`;
    const deadline = Date.now() + 45_000;
    while (true) {
      try {
        if ((await fetch(url)).ok) break;
      } catch {
        /* starting */
      }
      if (Date.now() >= deadline)
        throw new Error("Personal harness server did not start");
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await runPersonalOrganizationSmoke({
      page,
      check: (name) => console.log(`[ok] ${name}`),
    });
    expect(errors).toEqual([]);
    console.log("Personal UI smoke: all checks passed");
  } finally {
    await browser?.close();
    try {
      process.kill(-vite.pid, "SIGTERM");
    } catch {
      vite.kill("SIGTERM");
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
