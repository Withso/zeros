import { expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { runLiveTailMotionSmoke } from "./ui-smoke-live-tail-motion.mjs";

// Working groups, in-between messages and the live loader line in the real
// renderer (harness-working-groups). Linux Chrome proof, not native macOS.
export async function runWorkingGroupsSmoke({ page, check, origin }) {
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 1440, height: 2400 });
  try {
    await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-working-groups.html`);
    await runLiveSmoke({ page, check });
    await runLiveTailMotionSmoke({ page, check });
    await runThinkingSmoke({ page, check });
    await runBurstSmoke({ page, check });
    await runDoneSmoke({ page, check });
    await captureStates({ page });
  } finally {
    if (viewport) await page.setViewportSize(viewport);
  }
}

// The loader line's live region (its spinner is a status of its own).
const loader = (frame) => frame.locator('div[role="status"][aria-live="polite"]');
const TICKING = /^Working for (?:\d+m )?\d+\.\ds$/;
const header = (frame) => frame.locator("[data-working-group]");
const rows = (frame) => frame.locator(".zeros-working-feed [data-list-row-disclosure]");

async function runLiveSmoke({ page, check }) {
  const script = page.locator("#live-script");
  await expect(loader(script)).toContainText("Read");
  await expect(loader(script)).toContainText("package.json");
  await expect(header(script)).toHaveCount(0);
  await expect(rows(script)).toHaveCount(0);
  // The label is not announced: only "Agent working" is.
  await expect(loader(script).locator('[aria-live="off"]').first()).toContainText("Read");
  check("A lone live call sits on the loader line and is not also a row", true);

  await script.getByRole("button", { name: "Next call", exact: true }).click();
  await expect(header(script)).toHaveAttribute("data-working-group", "live");
  await expect(header(script)).toHaveAttribute("aria-expanded", "false");
  await expect(header(script)).toContainText(TICKING);
  await expect(loader(script)).toContainText("partitionTurnSequence");
  await expect(rows(script)).toHaveCount(0);
  await expect(loader(script).locator('[data-loader-tick="in"]')).toContainText("partitionTurnSequence");
  check("The second call makes a collapsed live group; the loader line slides to the new call", true);

  await script.getByRole("button", { name: "Next call", exact: true }).click();
  await expect(loader(script)).toContainText("pnpm vitest run features/agent");
  await expect(loader(script)).not.toContainText("partitionTurnSequence");
  await header(script).click();
  await expect(header(script)).toHaveAttribute("aria-expanded", "true");
  await expect(rows(script)).toHaveCount(3);
  await expect(loader(script).locator('[aria-live="off"]')).toHaveCount(0);
  await expect(loader(script).getByLabel("Agent working", { exact: true })).toBeVisible();
  check("Opening the live group shows its rows; the loader line drops its label", true);
  await header(script).click();
  await expect(rows(script)).toHaveCount(0);
  await expect(loader(script)).toContainText("pnpm vitest run features/agent");

  await script.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(header(script)).toHaveAttribute("data-working-group", "closed");
  await expect(header(script)).toContainText(/^Worked for \d+s$/);
  const message = script.getByText(/^The partition already separates answers from work\./);
  await expect(message).toBeVisible();
  expect(await message.evaluate((element) => !element.closest(".zeros-working-feed"))).toBe(true);
  await expect(loader(script)).toContainText(/^(?:\d+m )?\d+\.\ds$/);
  check("An in-between message closes the group above it and the loader line returns to its timer", true);
  await script.getByRole("button", { name: "Finish turn", exact: true }).click();
  await expect(loader(script)).toHaveCount(0);

  const lone = page.locator("#live-lone");
  await expect(loader(lone)).toContainText("package.json");
  await expect(rows(lone)).toHaveCount(0);
  await lone.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(lone.getByRole("button", { name: /^Read.* package\.json$/ })).toBeVisible();
  await expect(header(lone)).toHaveCount(0);
  check("A lone call becomes a plain row once a message closes its run", true);

  const reduced = page.locator("#live-reduced");
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    await reduced.getByRole("button", { name: "Next call", exact: true }).click();
    await expect(loader(reduced)).toContainText("partitionTurnSequence");
    // Reduced motion: at most a short opacity fade, never travel or blur.
    const motion = await loader(reduced).evaluate((element) =>
      [...element.querySelectorAll("[data-loader-tick]")].flatMap((node) => node.getAnimations().map((animation) =>
        Object.keys(animation.effect.getKeyframes()[0]).filter((key) => ["transform", "filter", "translate"].includes(key)))).flat());
    check("Reduced motion swaps the loader line without travel or blur", motion.length === 0, JSON.stringify(motion));
  } finally {
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }

  const permission = page.locator("#live-permission");
  await expect(header(permission)).toHaveAttribute("aria-expanded", "false");
  await expect(rows(permission)).toHaveCount(1);
  await expect(permission.getByRole("button", { name: "Bash git push origin feature/working-groups", exact: true })).toBeVisible();
  await expect(loader(permission)).toHaveCount(0);
  await expect(header(permission)).toContainText(TICKING);
  check("A pending permission shows only its row under the collapsed group; the loader hides while the group keeps counting", true);
}

async function runThinkingSmoke({ page, check }) {
  const done = page.locator("#done-thinking");
  await expect(header(done)).toHaveCount(1);
  await expect(header(done)).toHaveAttribute("aria-expanded", "false");
  await expect(header(done)).toHaveAttribute("aria-label", /^Worked for \d+s, 1 tool call, 2 messages$/);
  await expect(rows(done)).toHaveCount(0);
  await expect(done.getByText("Thinking rows now count toward a working group.")).toBeVisible();
  check("Thinking, Bash, Thinking settles as one collapsed group", true);

  for (const [id, preview] of [["#live-thinking", "Comparing the loader line subject"], ["#live-thought", "Reading the partition rules"]]) {
    const frame = page.locator(id);
    await expect(loader(frame)).toContainText("Thinking");
    await expect(loader(frame).locator("[data-tool-preview]")).toContainText(preview);
    await expect(rows(frame)).toHaveCount(0);
  }
  await expect(header(page.locator("#live-thinking"))).toHaveAttribute("data-working-group", "live");
  await expect(header(page.locator("#live-thought"))).toHaveCount(0);
  check("The loader line shows a streaming thought with its description; a lone thought is not also a row", true);
}

/** The loader line's minimum dwell (shared/ui/loading/loader-ticker.ts
 * LOADER_TICK_DWELL_MS). */
const DWELL_MS = 550;

async function runBurstSmoke({ page, check }) {
  const burst = page.locator("#live-burst");
  await expect(loader(burst)).toContainText("package.json");
  const seen = await burst.evaluate(async (root) => {
    const line = root.querySelector('div[role="status"][aria-live="polite"]');
    const log = [];
    let delivered = null;
    let done;
    const finished = new Promise((resolve) => { done = resolve; });
    const sample = () => {
      const now = performance.now();
      // The fixture's third call has arrived once the group counts four.
      if (delivered === null && /, 4 tool calls/.test(root.querySelector("[data-working-group]")?.getAttribute("aria-label") ?? "")) delivered = now;
      const current = line.querySelector('[data-loader-tick="in"]')?.textContent ?? "";
      if (log.at(-1)?.text !== current) log.push({ text: current, at: now });
      if (current.includes("burst-three.ts")) done();
    };
    const observer = new MutationObserver(sample);
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    [...root.querySelectorAll("button")].find((button) => button.textContent === "Three quick calls").click();
    // Until the newest call is on the line; a hang fails the check below.
    await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    observer.disconnect();
    return { log, delivered };
  });
  const shown = seen.log.map((entry) => entry.text);
  const one = seen.log.find((entry) => entry.text.includes("burst-one.ts"));
  const three = seen.log.find((entry) => entry.text.includes("burst-three.ts"));
  // The race window: the newer calls arrived while the first still dwelt.
  const windowOpen = !!one && seen.delivered !== null && seen.delivered < one.at + DWELL_MS;
  const due = one && seen.delivered !== null ? Math.max(one.at + DWELL_MS, seen.delivered) : null;
  check(
    "Calls faster than the hand-off skip the middle one and dwell before the newest",
    windowOpen && !!three && !shown.some((text) => text.includes("burst-two.ts")) &&
      three.at - one.at >= DWELL_MS - 50 && three.at - due <= 200,
    JSON.stringify({ windowOpen, delivered: seen.delivered && one ? Math.round(seen.delivered - one.at) : null,
      log: shown.map((text, index) => `${Math.round(seen.log[index].at - (one?.at ?? 0))}ms ${text}`) }),
  );
}

const fg = (locator) => locator.evaluate((element) => getComputedStyle(element).color);

async function runDoneSmoke({ page, check }) {
  const done = page.locator("#done");
  const groups = header(done);
  await expect(groups).toHaveCount(2);
  await expect(groups.first()).toHaveText(/^Worked for 48s$/);
  await expect(groups.first()).toHaveAttribute("aria-label", "Worked for 48s, 4 tool calls");
  await expect(groups.last()).toHaveAttribute("aria-label", /^Worked for 2m 10s, 2 tool calls, 1 agent, with a failed tool call$/);
  await expect(groups.last().locator(".lucide-circle-x")).toHaveCount(1);
  await expect(done.getByRole("button", { name: "Bash pnpm vitest run features/agent", exact: true })).toBeVisible();
  await expect(done.getByText(/^Typecheck passes\./)).toBeVisible();
  check("Done, setting on: each group reads Worked for its own span, messages stay between, a lone call is a row", true);

  await groups.first().hover();
  await expect(page.getByRole("tooltip")).toHaveText("4 tool calls");
  await page.mouse.move(0, 0, { steps: 5 });
  check("The old summary moved to the header's tooltip", true);

  await page.getByRole("button", { name: "Turn the setting off", exact: true }).click();
  await expect(groups).toHaveCount(1);
  await expect(groups).toHaveAttribute("aria-label", /^Worked for 4m 59s, 7 tool calls, 2 messages, 1 agent, with a failed tool call$/);
  await expect(done.getByText(/^Typecheck passes\./)).toHaveCount(0);
  await expect(done.getByText(/^In-between messages now sit/)).toBeVisible();
  const open = page.locator("#done-open");
  await header(open).click();
  const folded = open.locator("[data-in-between] .zeros-agent-md").first();
  const answer = open.getByText(/^In-between messages now sit/);
  await expect(folded).toBeVisible();
  expect(await fg(folded)).toBe(await fg(answer));
  check("Setting off: one group folds the messages; opened, they read at the answer's fg1", true);
  await header(open).click();
  // A run with no calls folds too: commentary followed directly by the
  // answer reads as one group with its time and no tool icons.
  const prose = page.locator("#done-prose");
  const proseGroup = prose.locator("[data-working-group]");
  await expect(proseGroup).toHaveCount(1);
  await expect(proseGroup).toHaveAttribute("aria-label", /^Worked for \d+s, 1 message$/);
  await expect(proseGroup.locator("svg")).toHaveCount(1);
  await expect(prose.getByText(/^Typecheck passes\./)).toHaveCount(0);
  await expect(prose.getByText(/^In-between messages now sit/)).toBeVisible();
  await page.getByRole("button", { name: "Turn the setting on", exact: true }).click();
  await expect(proseGroup).toHaveCount(0);
  await expect(prose.getByText(/^Typecheck passes\./)).toBeVisible();
  await page.getByRole("button", { name: "Turn the setting off", exact: true }).click();
  check("Setting off: a prose-only run folds as a group with its time and no icons; on, the message stays visible", true);
  await page.getByRole("button", { name: "Turn the setting on", exact: true }).click();
  await expect(groups).toHaveCount(2);
}

async function captureStates({ page }) {
  const out = ".context/working-groups";
  await mkdir(out, { recursive: true });
  const initialTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  const shot = async (id, name) => {
    await page.mouse.move(0, 0);
    await page.locator(`#${id}`).screenshot({ path: `${out}/${name}`, animations: "disabled" });
  };
  await page.locator("#live-open [data-working-group]").click();
  await page.locator("#done-open [data-working-group]").nth(1).click();
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const id of ["live-one", "live-group", "live-between", "live-open", "live-permission", "live-thinking", "live-thought", "done", "done-open", "done-thinking"])
      await shot(id, `${id}-setting-on-${theme}.png`);
    await page.getByRole("button", { name: "Turn the setting off", exact: true }).click();
    await page.locator("#done-open [data-working-group]").first().click();
    await shot("done", `done-setting-off-${theme}.png`);
    await shot("done-open", `done-open-setting-off-${theme}.png`);
    await page.locator("#done-open [data-working-group]").first().click();
    await page.getByRole("button", { name: "Turn the setting on", exact: true }).click();
  }
  await page.evaluate((value) => {
    if (value === undefined) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
  }, initialTheme);
}
