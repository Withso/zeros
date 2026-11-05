import { chromium, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";

// Git conflicts resolve in place in the real Files editor: each block's
// accept row rewrites it as an ordinary edit (⌘Z undoes it), the navigator
// steps between blocks, the file saves through the ordinary file write, and
// nothing calls a separate resolution operation. Hunk review stays retired.
const TWO_BLOCKS = [
  "prefix",
  "<<<<<<< HEAD",
  "current one",
  "||||||| base",
  "old one",
  "=======",
  "incoming one",
  ">>>>>>> topic",
  "between",
  "<<<<<<< HEAD",
  "current two",
  "=======",
  "incoming two",
  ">>>>>>> topic",
  "",
].join("\n");

export async function runGitReviewActionsSmoke({ page, check = () => {}, harnessBase }) {
  const base = `${harnessBase ?? `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses`}/harness-file-editor.html`;
  const source = () => page.locator(".cm-content[contenteditable=true]:visible");
  const navigator = () => page.getByRole("group", { name: "Conflicts", exact: true });
  const accept = (block, name) =>
    page
      .getByRole("group", { name: new RegExp(`^Conflict ${block} of \\d+$`) })
      .getByRole("button", { name, exact: true });
  const disk = () =>
    page.evaluate(() => window.__fileEditor.disk("conflict.ts"));
  const open = async (content) => {
    await page.goto(`${base}?owner=personal&reset`);
    await expect.poll(() => page.evaluate(() => Boolean(window.__fileEditor))).toBe(true);
    await page.evaluate((text) => window.__fileEditor.external("conflict.ts", text), content);
    await page.evaluate(() => window.__fileEditor.open("conflict.ts"));
    await expect(source()).toBeVisible();
  };

  await open(TWO_BLOCKS);
  for (const name of ["Accept", "Reject", "Accepted", "Reject hunk", "Save resolution", "Resolve conflicts"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  check("Hunk review and the Resolve conflicts panel are gone", true);

  const step = (name) =>
    navigator().getByRole("button", { name, exact: true }).click();
  const caretLine = () => page.locator(".cm-activeLine:visible").textContent();
  // Above every block, 1 is the next block below; Next goes there first, so
  // no block is ever skipped.
  await expect(navigator()).toHaveText("1 / 2");
  await step("Next conflict");
  await expect(navigator()).toHaveText("1 / 2");
  await expect.poll(caretLine).toContain("<<<<<<< HEAD");
  await step("Next conflict");
  await expect(navigator()).toHaveText("2 / 2");
  await step("Next conflict");
  await expect(navigator()).toHaveText("1 / 2");
  await step("Previous conflict");
  await expect(navigator()).toHaveText("2 / 2");
  check("The navigator steps between blocks and wraps", true);

  await accept(1, "Accept incoming change").click();
  await expect(source()).not.toContainText("current one");
  await expect(navigator()).toHaveText("1 / 1");
  await source().press("ControlOrMeta+z");
  await expect(source()).toContainText("current one");
  await expect(navigator()).toHaveText(/\/ 2$/);
  check("Accepting is an ordinary edit that ⌘Z undoes", true);

  await accept(1, "Accept both").click();
  await accept(1, "Accept current change").click();
  const resolved = "prefix\ncurrent one\nincoming one\nbetween\ncurrent two\n";
  await expect.poll(disk).toBe(resolved);
  await expect(navigator()).toHaveCount(0);
  const requests = await page.evaluate(() =>
    window.__fileEditor.requests().map((request) => request.op),
  );
  expect(requests).toContain("file.write");
  expect(requests).not.toContain("git.resolveConflict");
  check("A resolved file saves through the ordinary file write", true);

  await page.getByRole("button", { name: "File options", exact: true }).click();
  const options = page.getByRole("dialog", { name: "File options" });
  await expect(options.getByRole("switch", { name: /Diff view/ })).toBeDisabled();
  await expect(options).toContainText("Resolve conflicts first");
  await page.keyboard.press("Escape");
  check("Diff view waits while Git lists the file as conflicted", true);

  await open("<<<<<<< ours\na\n=======\nb\n");
  await expect(page.getByRole("status").filter({ hasText: "Line 1 has no separator or closing marker. Fix it by hand." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept current change", exact: true })).toHaveCount(0);
  await expect(navigator()).toHaveCount(0);
  check("Unpaired markers show one notice and no accept actions", true);
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
    const page = await browser.newPage({ viewport: { width: 1100, height: 780 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await runGitReviewActionsSmoke({
      page,
      check: (name) => console.log(`ok: ${name}`),
      harnessBase: `${origin}/apps/desktop/src/renderer/harnesses`,
    });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}
