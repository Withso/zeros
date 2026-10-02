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
  const accept = () =>
    page.getByRole("button", { name: "Accept", exact: true });
  const reject = () =>
    page.getByRole("button", { name: "Reject", exact: true });
  const dialog = () => page.getByRole("dialog");
  const save = () =>
    page.getByRole("button", { name: "Save resolution", exact: true });
  const conflict = (index) => page.locator("[data-conflict-id]").nth(index);
  const preview = () => page.locator("[data-resolution-preview]").textContent();

  await open("twins=1");
  await expect.poll(() => requests("list")).toHaveLength(1);
  await accept()
    .first()
    .evaluate((element) => {
      element.click();
      element.click();
    });
  await expect(
    page.getByRole("button", { name: "Accepted", exact: true }),
  ).toHaveCount(2);
  expect(await requests("review")).toHaveLength(1);
  expect(await page.evaluate(() => window.reviewActionsFixture.disk())).toBe(
    "before\nchanged\nend\n",
  );
  check(
    "Accept keeps source and shares the confirmed decision across hunk rows",
    true,
  );

  await open();
  await reject().click();
  await expect(dialog()).toBeVisible();
  await expect(
    dialog().getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog()).toBeHidden();
  await expect(reject()).toBeFocused();
  expect(await requests("review")).toHaveLength(0);
  await reject().click();
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await requests("review")).toHaveLength(0);
  check(
    "Reject requires confirmation; Cancel and Escape preserve source and keyboard focus",
    true,
  );

  await reject().click();
  await page.evaluate(() =>
    window.reviewActionsFixture.changeDisk("concurrent editor\n"),
  );
  await dialog()
    .getByRole("button", { name: "Reject hunk", exact: true })
    .click();
  await expect(dialog().getByRole("alert")).toContainText("file changed");
  expect(await page.evaluate(() => window.reviewActionsFixture.disk())).toBe(
    "concurrent editor\n",
  );
  expect((await requests("review"))[0].input).toMatchObject({
    decision: "rejected",
    confirm: true,
    expectedContent: "before\nchanged\nend\n",
  });
  check(
    "A stale confirmed Reject keeps concurrent source and displays the failure",
    true,
  );

  await open("hold=1");
  await accept().click();
  await expect.poll(() => requests("review")).toHaveLength(1);
  await page.evaluate(() => window.reviewActionsFixture.setShown(false));
  await expect(accept()).toHaveCount(0);
  await page.evaluate(() => window.reviewActionsFixture.release());
  await expect
    .poll(() =>
      page.evaluate(() => window.reviewActionsFixture.reviewed.length),
    )
    .toBe(0);
  // A later explicit mount observes the confirmed persisted decision.
  await page.evaluate(() => window.reviewActionsFixture.setShown(true));
  await expect(
    page.getByRole("button", { name: "Accepted", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => window.reviewActionsFixture.reviewed),
  ).toHaveLength(0);
  check(
    "Completion after owner unmount cannot call a stale viewer callback",
    true,
  );

  for (const gate of ["inactive", "readonly", "design", "historical"]) {
    await open(`${gate}=1`);
    await expect(accept()).toHaveCount(0);
    await expect(reject()).toHaveCount(0);
    expect(await requests("list")).toHaveLength(0);
  }
  check(
    "Historical, Design and hidden hunk surfaces expose no mutation controls or reads",
    true,
  );

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
