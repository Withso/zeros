import { chromium, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";

export async function runGitReviewActionsSmoke({ page, check = () => {}, harnessBase }) {
  const base = `${harnessBase ?? `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses`}/harness-git-review-actions.html`;
  const open = async (query = "") => {
    await page.goto(`${base}${query ? `?${query}` : ""}`);
    await expect
      .poll(() => page.evaluate(() => window.reviewActionsFixture?.ready))
      .toBe(true);
  };
  const requests = (op) =>
    page.evaluate(
      (op) =>
        window.reviewActionsFixture.requests.filter((item) => item.op === op),
      op,
    );
  const dialog = () => page.getByRole("dialog");
  const save = () =>
    page.getByRole("button", { name: "Save resolution", exact: true });
  const conflict = (index) => page.locator("[data-conflict-id]").nth(index);
  const preview = () => page.locator("[data-resolution-preview]").textContent();

  await open();
  await expect(
    page.getByRole("heading", { name: "Git review actions", exact: true }),
  ).toBeVisible();
  for (const name of ["Accept", "Reject", "Accepted", "Reject hunk"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(() => window.reviewActionsFixture.requests),
  ).toEqual([]);
  check("Hunk review is gone: no Accept or Reject and no decision reads", true);

  await open("conflicts=1");
  const initial = await preview();
  await expect(save()).toBeDisabled();
  await conflict(0)
    .getByRole("button", { name: "Current", exact: true })
    .click();
  expect(await preview()).toContain(
    "prefix\r\ncurrent one\r\nbetween\r\n<<<<<<< HEAD",
  );
  expect(await preview()).not.toContain("old one");
  await expect(save()).toBeDisabled();
  await conflict(0)
    .getByRole("button", { name: "Incoming", exact: true })
    .click();
  expect(await preview()).toContain("prefix\r\nincoming one\r\nbetween");
  await conflict(0).getByRole("button", { name: "Both", exact: true }).click();
  expect(await preview()).toContain(
    "prefix\r\ncurrent one\r\nincoming one\r\nbetween",
  );
  expect(await page.evaluate(() => window.reviewActionsFixture.disk())).toBe(
    initial,
  );
  await conflict(1)
    .getByRole("button", { name: "Incoming", exact: true })
    .click();
  const resolved =
    "prefix\r\ncurrent one\r\nincoming one\r\nbetween\r\nincoming two";
  expect(await preview()).toBe(resolved);
  await expect(save()).toBeEnabled();
  await save().evaluate((element) => {
    element.click();
    element.click();
  });
  await expect
    .poll(() => page.evaluate(() => window.reviewActionsFixture.saved))
    .toEqual([resolved]);
  expect(await requests("resolve")).toHaveLength(1);
  expect(await page.evaluate(() => window.reviewActionsFixture.disk())).toBe(
    resolved,
  );
  check(
    "Current, Incoming and Both preview immediately; only explicit Save writes the complete resolution",
    true,
  );

  await open("conflicts=1");
  await conflict(0)
    .getByRole("button", { name: "Current", exact: true })
    .click();
  await conflict(1).getByRole("button", { name: "Both", exact: true }).click();
  const draft = await preview();
  await page.evaluate(() =>
    window.reviewActionsFixture.refresh(
      window.reviewActionsFixture.initialConflict.replace(
        "current one",
        "external one",
      ),
    ),
  );
  await expect(page.locator("[data-conflict-stale=true]")).toBeVisible();
  expect(await preview()).toBe(draft);
  await save().click();
  await expect(page.getByRole("alert")).toContainText("file changed");
  expect(await preview()).toBe(draft);
  await expect(
    conflict(0).getByRole("button", { name: "Current", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(() => window.reviewActionsFixture.saved),
  ).toHaveLength(0);
  await page
    .getByRole("button", { name: "Reload latest", exact: true })
    .click();
  await expect(
    dialog().getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await preview()).toBe(draft);
  await page
    .getByRole("button", { name: "Reload latest", exact: true })
    .click();
  await dialog()
    .getByRole("button", { name: "Reload latest", exact: true })
    .click();
  expect(await preview()).toContain("external one");
  await expect(save()).toBeDisabled();
  check(
    "Concurrent refresh and failed save retain choices and preview until a confirmed Reload",
    true,
  );

  for (const gate of ["inactive", "readonly", "design", "historical"]) {
    await open(`conflicts=1&${gate}=1`);
    await expect(save()).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Current", exact: true }),
    ).toHaveCount(0);
    expect(await requests("resolve")).toHaveLength(0);
  }
  check(
    "Conflict mutation controls respect live owner, visibility and Design admission",
    true,
  );
}

// A dedicated run avoids editing the shared smoke dispatcher during parallel work.
// Usage: node scripts/ui-smoke-git-review-actions.mjs http://127.0.0.1:<vite-port>
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const origin = process.argv[2];
  if (!origin) throw new Error("Pass a running Vite server origin.");
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `${origin}/apps/desktop/src/renderer/harnesses/harness-git-review-actions.html`,
    );
    await runGitReviewActionsSmoke({
      page,
      check: (name) => console.log(`ok: ${name}`),
    });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}
