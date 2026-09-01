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
  const switcher = page.getByRole("button", { name: "Switch organization" });
  const rows = page
    .getByRole("list", { name: "Visible workspaces" })
    .getByRole("listitem");
  await expect(switcher).toHaveText("Personal");
  await switcher.click();
  await expect(
    page.getByRole("menuitem", { name: "Personal", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("menuitem", { name: "Create organization", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  check("one existing Personal entry is available without an account", true);

  await page.getByRole("button", { name: "Use account A" }).click();
  await expect(switcher).toHaveText("Personal");
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

  await switcher.click();
  await page.getByRole("menuitem", { name: "Business A", exact: true }).click();
  await expect(rows).toHaveText(["Business A cloud"]);
  await expect(page.getByTestId("cloud-capability")).toHaveText("allowed");
  await page.getByRole("button", { name: "Use account B" }).click();
  await expect(switcher).toHaveText("Personal");
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
    page.getByRole("menuitem", { name: "Personal", exact: true }),
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
  await expect(switcher).toHaveText("Personal");
  await expect(rows).toHaveText([
    "Unowned local",
    "A legacy local",
    "B legacy local",
    "Created local",
  ]);
  await page.reload();
  await expect(switcher).toHaveText("Personal");
  await expect(rows).toHaveText([
    "Unowned local",
    "A legacy local",
    "B legacy local",
  ]);
  check(
    "logout and reload retain Personal's legacy local collection without network access",
    true,
  );
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
