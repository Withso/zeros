import { expect } from "@playwright/test";

export async function runCloudRepositorySetupSmoke({ page, check }) {
  const origin = new URL(page.url()).origin, records = new Map(), writes = [];
  const endpoint = "https://api.example.test/v1/cloud-v2/organizations/*/computer**";
  let release, held;
  const handle = async route => {
    const request = route.request(), parts = new URL(request.url()).pathname.split("/"), organization = parts[4];
    const account = request.headers().authorization?.includes("55555555-") ? "b" : "a", key = `${account}:${organization}`;
    let row = records.get(key) ?? { activeBuildId: null, snapshotName: null, builds: [], recipeRevision: 0,
      recipe: { repositories: [{ repository: "fixture/repo", setup: "pnpm install", ...(account === "b" ? { setupScript: "scripts/account-b.sh" } : {}) }] } };
    if (request.method() === "PUT") {
      const input = request.postDataJSON();
      writes.push({ key, input });
      if (held) { const waiting = held; held = undefined; await waiting; }
      if (input.revision !== row.recipeRevision) return route.fulfill({ status: 409, json: { error: { code: "computer_recipe_changed", message: "Changed elsewhere" } } });
      row = { ...row, recipeRevision: row.recipeRevision + 1, recipe: { repositories: input.repositories } };
      records.set(key, row);
      return route.fulfill({ json: { recipe: row.recipe, recipeRevision: row.recipeRevision } });
    }
    return route.fulfill({ json: row });
  };
  await page.route(endpoint, handle);
  try {
    await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-cloud-environment.html?computer`);
    const field = page.getByLabel("fixture/repo workspace setup script", { exact: true });
    await expect(field).toBeVisible();
    for (const theme of ["dark", "light"]) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      const path = `scripts/${theme}.sh`;
      await field.fill(path);
      await expect.poll(() => writes.at(-1)?.input.repositories[0].setupScript).toBe(path);
      await expect(field).toHaveValue(path);
      expect(writes.at(-1).input.repositories[0].setup).toBe("pnpm install");
      check(`A Cloud Computer repository's Environment saves the selected script without replacing build validation in ${theme}`, true);
    }
    held = new Promise(done => { release = done; });
    await field.fill("scripts/held-owner-a.sh");
    await expect.poll(() => writes.at(-1)?.input.repositories[0].setupScript).toBe("scripts/held-owner-a.sh");
    await page.getByRole("button", { name: "Organization B", exact: true }).click();
    await expect(field).toHaveValue("");
    await field.fill("scripts/owner-b.sh");
    await expect.poll(() => writes.at(-1)?.input.repositories[0].setupScript).toBe("scripts/owner-b.sh");
    release(); release = undefined;
    await expect(field).toHaveValue("scripts/owner-b.sh");
    await page.getByRole("button", { name: "Organization A", exact: true }).click();
    await expect(field).toHaveValue("scripts/held-owner-a.sh");
    check("A held recipe save cannot replace another owner's script selection", true);

    await field.fill("scripts/retired-account.sh");
    await page.getByRole("button", { name: "Account B", exact: true }).click();
    await expect(field).toHaveValue("scripts/account-b.sh");
    await field.fill("scripts/new-account.sh");
    await expect.poll(() => writes.at(-1)?.input.repositories[0].setupScript).toBe("scripts/new-account.sh");
    expect(writes.some(write => write.input.repositories[0].setupScript === "scripts/retired-account.sh")).toBe(false);
    await expect(field).toHaveValue("scripts/new-account.sh");
    check("Account replacement cancels unsent script edits and keeps caches separate", true);

    await field.fill("");
    await expect.poll(() => writes.at(-1)?.input.repositories[0].setupScript).toBeUndefined();
    expect(writes.at(-1).input.repositories[0].setup).toBe("pnpm install");
    await page.getByRole("button", { name: "Member", exact: true }).click();
    await expect(field).toHaveCount(0);
    await expect(page.getByText("Only owners and admins manage it.", { exact: true })).toBeVisible();
    const before = writes.length;
    await page.getByRole("button", { name: "Local owner", exact: true }).click();
    await expect(field).toHaveCount(0);
    expect(writes.length).toBe(before);
    check("Removing the selection restores inline setup; members and Local owners cannot edit cloud scripts", true);
  } finally { release?.(); await page.unroute(endpoint, handle); }
}
