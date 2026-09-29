import { expect } from "@playwright/test";

function computerSnapshots() {
  const id = "22222222-2222-4222-8222-222222222222";
  const now = new Date().toISOString();
  const original = {
    revision: 1,
    draftVersion: 1,
    activeVersion: null,
    imageBuilds: true,
    document: { repositories: [], installScript: "true", timeoutSeconds: 30 },
    canManage: true,
    configured: true,
    resources: { cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 70000 },
    history: [
      {
        id,
        version: 1,
        state: "building",
        cleanupState: "pending",
        repository: "",
        createdAt: now,
        completedAt: null,
        errorCode: null,
        artifact: {
          id,
          state: "creating",
          snapshotId: null,
          imageRef: null,
          buildSha256: null,
          baseImageRef: `boat:base@sha256:${"a".repeat(64)}`,
          sourceContract: null,
          createdAt: now,
          attestedAt: null,
        },
      },
    ],
  };
  const current = globalThis.structuredClone(original);
  Object.assign(current.history[0], {
    state: "succeeded",
    cleanupState: "complete",
    completedAt: now,
  });
  Object.assign(current.history[0].artifact, {
    state: "attested",
    snapshotId: "snapshot-fixture",
    imageRef: `boat:zeros-org-${id.replaceAll("-", "")}@sha256:${"b".repeat(64)}`,
    buildSha256: "b".repeat(64),
    sourceContract: "c".repeat(64),
    attestedAt: now,
  });
  return { original, current };
}

// Held network replies exercise the real panel/cache, including polling.
export async function runCloudComputerRefreshSmoke({
  page,
  check,
  harnessBase,
}) {
  await page.unroute("https://api.example.test/v1/**");
  await page.clock.install();
  const { original, current } = computerSnapshots();
  let count = 0,
    slowRoute;
  let notifySlow;
  const slowPending = new Promise((resolve) => {
    notifySlow = resolve;
  });
  await page.route("https://api.example.test/v1/**", async (route) => {
    let body = { credentials: [], connections: [] };
    if (new URL(route.request().url()).pathname.endsWith("/cloud-computer")) {
      count++;
      if (count === 2) {
        slowRoute = route;
        notifySlow();
        return;
      }
      body = count === 1 ? original : current;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.goto(`${harnessBase}/harness-cloud-settings.html`);
  await page
    .getByRole("button", { name: "Computer section", exact: true })
    .click();
  await expect(
    page.getByText("Version 1 · creating", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Refresh Cloud Computer", exact: true })
    .click();
  await slowPending;
  // Another consumer's explicit refresh/change signal must still fence the old
  // response. Polling itself should only join the pending request.
  await page.evaluate(async (key) => {
    const { refreshCloudComputer } = await import("/apps/desktop/src/renderer/features/settings/cloud-computer-client.ts");
    void refreshCloudComputer(key);
  }, JSON.stringify(["44444444-4444-4444-8444-444444444444", "11111111-1111-4111-8111-111111111111"]));
  await page.clock.runFor(5100);
  // Before the fix polling can publish a newer result alongside this held read.
  const concurrentReads = count;
  if (concurrentReads > 2)
    await expect(
      page.getByText("Version 1 · Attested", { exact: true }),
    ).toBeVisible();
  else
    await expect(
      page.getByText("Version 1 · creating", { exact: true }),
    ).toBeVisible();
  await slowRoute.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(original),
  });
  await expect(
    page.getByRole("button", { name: "Refresh Cloud Computer", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText("Version 1 · Attested", { exact: true }),
  ).toBeVisible({ timeout: 2000 });
  expect(concurrentReads).toBe(2);
  expect(count).toBe(3);
  check(
    "Cloud Computer refresh and polling share requests and retain the newest exact-key snapshot",
    true,
  );
}


// Port of V12b's real-renderer slow-response reproduction. Keep the build in
// progress for two replies so all three consecutive reads exceed the poll tick.
export async function runCloudComputerSlowRefreshSmoke({ page, check, harnessBase }) {
  await page.clock.install();
  const { original, current } = computerSnapshots();
  const pendingRoutes = [];
  let count = 0;
  await page.route("https://api.example.test/v1/**", async route => {
    let body = { credentials: [], connections: [] };
    if (new URL(route.request().url()).pathname.endsWith("/cloud-computer")) {
      count++;
      if (count > 1) { pendingRoutes.push(route); return; }
      body = original;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(`${harnessBase}/harness-cloud-settings.html`);
  await page.getByRole("button", { name: "Computer section", exact: true }).click();
  await expect(page.getByText("Version 1 · creating", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh Cloud Computer", exact: true }).click();
  for (const [step, phase] of ["installing", "verifying", "Attested"].entries()) {
    await expect.poll(() => pendingRoutes.length).toBe(1);
    await page.clock.runFor(7100);
    expect(pendingRoutes).toHaveLength(1);
    expect(count).toBe(step + 2);
    const body = phase === "Attested" ? current : globalThis.structuredClone(original);
    if (phase !== "Attested") body.history[0].artifact.state = phase;
    await pendingRoutes.shift().fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    await expect(page.getByText(`Version 1 · ${phase}`, { exact: true })).toBeVisible({ timeout: 2000 });
    console.log(`Slow shared refresh ${step + 1}: published ${phase} after at least 7.1 seconds`);
    await page.clock.runFor(5000);
  }
  await expect(page.getByRole("button", { name: "Build computer", exact: true })).toBeEnabled();
  await expect(page.getByText("Builder cleanup pending", { exact: false })).toHaveCount(0);
  await page.clock.runFor(10000);
  expect(count).toBe(4);
  expect(pendingRoutes).toHaveLength(0);
  check("Consecutive slow Cloud Computer reads publish progress and completion; polling then stops", true);
}
