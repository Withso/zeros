import { expect } from "@playwright/test";

function computerSnapshots() {
  const now = new Date().toISOString();
  const build = {
    id: "22222222-2222-4222-8222-222222222222", version: 1,
    configId: "77777777-7777-4777-8777-777777777777", acceptedRevision: 1,
    state: "running", stage: "allocating", errorCode: null, rebuiltFromBuildId: null,
    templateState: "pending", createdAt: now, startedAt: now, completedAt: null, cancelRequestedAt: null,
  };
  const original = {
    state: "building", revision: 1,
    draft: { configId: build.configId, repositories: [], installScript: "true", timeoutSeconds: 30, environment: [] },
    active: null, activeRepositories: [], previous: null, latestBuild: build, unbuiltChanges: false,
    history: { builds: [build], nextCursor: null }, canManage: true,
  };
  const current = structuredClone(original);
  Object.assign(current.latestBuild, { state: "succeeded", stage: "done", templateState: "ready", completedAt: now });
  current.state = "active";
  current.active = current.latestBuild;
  current.history.builds = [current.latestBuild];
  return { original, current };
}
function auxiliaryResponse(path, snapshot) {
  if (path.endsWith("/logs")) return { entries: [], nextCursor: null, truncated: false };
  if (/\/builds\/[a-f0-9-]+$/.test(path)) return { build: snapshot.latestBuild };
  if (path.endsWith("/builds")) return snapshot.history;
  return { credentials: [], connections: [] };
}
const progress = page => page.getByText("Building v1", { exact: false });
const active = page => page.getByText("Active v1", { exact: true });

// Held replies exercise the shipped v2 panel/cache and its polling boundary.
export async function runCloudComputerRefreshSmoke({ page, check, harnessBase }) {
  await page.unroute("https://api.example.test/v1/**");
  await page.clock.install();
  const { original, current } = computerSnapshots();
  let count = 0, slowRoute, notifySlow;
  const slowPending = new Promise(resolve => { notifySlow = resolve; });
  await page.route("https://api.example.test/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let body;
    if (path.endsWith("/cloud-computer/v2")) {
      count++;
      if (count === 2) { slowRoute = route; notifySlow(); return; }
      body = count === 1 ? original : current;
    } else body = auxiliaryResponse(path, count > 2 ? current : original);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(`${harnessBase}/harness-cloud-settings.html`);
  await page.getByRole("button", { name: "Computer section", exact: true }).click();
  await expect(progress(page)).toBeVisible();
  await page.getByRole("button", { name: "Refresh Cloud Computer", exact: true }).click();
  await slowPending;
  await page.evaluate(async key => {
    const { refreshCloudComputerV2 } = await import("/apps/desktop/src/renderer/features/settings/cloud-computer-v2-client.ts");
    void refreshCloudComputerV2(key);
  }, JSON.stringify(["44444444-4444-4444-8444-444444444444", "11111111-1111-4111-8111-111111111111"]));
  await page.clock.runFor(5100);
  expect(count).toBe(2);
  await expect(progress(page)).toBeVisible();
  await slowRoute.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(original) });
  await expect(active(page)).toBeVisible({ timeout: 2000 });
  expect(count).toBe(3);
  check("Cloud Computer v2 refresh/polling share requests and retain the newest exact-key snapshot", true);
}

export async function runCloudComputerSlowRefreshSmoke({ page, check, harnessBase }) {
  await page.clock.install();
  const { original, current } = computerSnapshots(), pendingRoutes = [];
  let count = 0;
  await page.route("https://api.example.test/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let body;
    if (path.endsWith("/cloud-computer/v2")) {
      count++;
      if (count > 1) { pendingRoutes.push(route); return; }
      body = original;
    } else body = auxiliaryResponse(path, count >= 4 ? current : original);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(`${harnessBase}/harness-cloud-settings.html`);
  await page.getByRole("button", { name: "Computer section", exact: true }).click();
  await expect(progress(page)).toBeVisible();
  await page.getByRole("button", { name: "Refresh Cloud Computer", exact: true }).click();
  for (const [step, stage] of ["runtime", "install", "done"].entries()) {
    await expect.poll(() => pendingRoutes.length).toBe(1);
    await page.clock.runFor(7100);
    expect(pendingRoutes).toHaveLength(1);
    expect(count).toBe(step + 2);
    const body = stage === "done" ? current : structuredClone(original);
    if (stage !== "done") { body.latestBuild.stage = stage; body.history.builds = [body.latestBuild]; }
    await pendingRoutes.shift().fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (stage === "done") await expect(active(page)).toBeVisible({ timeout: 2000 });
    else await expect(progress(page)).toContainText(stage === "runtime" ? "Installing Zeros runtime" : "Installing software");
    await page.clock.runFor(5000);
  }
  await page.clock.runFor(10000);
  expect(count).toBe(4);
  expect(pendingRoutes).toHaveLength(0);
  check("Consecutive slow v2 reads publish progress/completion and polling stops", true);
}
