import { expect } from "@playwright/test";
import { runTextRevealSmoke } from "./ui-smoke-text-reveal.mjs";

export async function runStreamingTextSmoke({ page, check }) {
  const fixture = page.locator("#streaming-text-fixture");
  const probe = fixture.locator("#streaming-text-probe");
  const reset = () =>
    fixture
      .getByRole("button", { name: "Reset assistant text", exact: true })
      .click();
  // Render first, then reveal: click Append (then optionally another action)
  // and read every frame: the laid-out text, whether it is being revealed,
  // and how far it is shown (its clip).
  const samples = async (action) =>
    fixture.evaluate(async (root, after) => {
      const probe = root.querySelector("#streaming-text-probe");
      const seen = [];
      const started = performance.now();
      const click = (label) =>
        [...root.querySelectorAll("button")]
          .find((button) => button.textContent === label)
          .click();
      click("Append assistant text");
      let clickedAt = null;
      if (after) setTimeout(() => { click(after); clickedAt = performance.now() - started; }, 120);
      await new Promise((resolve) => {
        const tick = () => {
          const prose = probe.querySelector(".zeros-agent-md");
          seen.push({
            at: performance.now() - started,
            text: prose.textContent.trim(),
            revealing: prose.dataset.revealing !== undefined,
            full: !prose.style.maxHeight || parseFloat(prose.style.maxHeight) >= prose.scrollHeight - 1,
            clip: prose.style.maxHeight,
            mask: getComputedStyle(prose).maskImage,
          });
          if (performance.now() - started < 1_600) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      return { seen, source: probe.dataset.source, clickedAt };
    }, action);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const burst = await samples(null);
  // A phase-less message whose only paragraph is still being written is laid
  // out at once and held (it takes no space) until its first unit completes:
  // it may yet be an in-between message. Line steps are measured on the long
  // reply (ui-smoke-text-reveal.mjs).
  const held = burst.seen.filter((sample) => sample.revealing);
  check(
    "A phase-less paragraph still being written is laid out at once and held until its first unit completes",
    burst.seen[0].text === burst.source.trim() && held.length > 20 && held.every((sample) => sample.clip === "0px"),
    JSON.stringify({ frames: held.length, clips: [...new Set(held.map((sample) => sample.clip))] }),
  );

  for (const action of [
    "Stop assistant text",
    "Advance assistant activity",
    "Correct assistant text",
    "Toggle text surface",
  ]) {
    await reset();
    const result = await samples(action);
    const after = result.seen.filter((sample) => sample.at > result.clickedAt + 20);
    if (action === "Correct assistant text") {
      // Still live: what the correction left is shown in full at once.
      check("A correction shows in full at once, with nothing revealing afterwards",
        after.length > 3 && after.every((sample) => sample.full && sample.mask === "none"),
        JSON.stringify({ frames: after.length, hidden: after.filter((sample) => !sample.full).length }));
    } else {
      check(`${action}: everything shows at once, with no mask or clip`,
        after.length > 3 && after.every((sample) => !sample.revealing && !sample.clip && sample.mask === "none"),
        JSON.stringify({ frames: after.length, revealing: after.filter((sample) => sample.revealing).length }));
    }
    await expect(probe.locator(".zeros-agent-md")).toHaveText(result.source.trim());
    if (action === "Toggle text surface")
      await fixture.getByRole("button", { name: action, exact: true }).click();
  }

  await reset();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await samples(null);
  check(
    "Reduced motion shows text as it arrives, unrevealed",
    !reduced.seen.some((sample) => sample.revealing) &&
      reduced.seen.at(-1).text === reduced.source.trim(),
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });

  const settle = fixture.locator("#settle-probe");
  const between = settle.locator(".zeros-agent-md");
  await settle.getByRole("button", { name: "Append in-between text", exact: true }).click();
  await expect(between).toHaveText((await settle.getAttribute("data-source")).trim());
  // While live the in-between message sits outside its (closed) group.
  expect(await between.evaluate((element) => !element.closest(".zeros-working-feed"))).toBe(true);
  await settle.getByRole("button", { name: "Append in-between text", exact: true }).click();
  await settle.getByRole("button", { name: "Settle with in-between messages folded", exact: true }).click();
  await expect(settle.locator("[data-working-group]")).toHaveAttribute("data-working-group", "closed");
  await expect(between).toHaveCount(0);
  const opened = await settle.evaluate(async (root) => {
    const seen = [];
    const source = root.dataset.source.trim();
    let done;
    const mounted = new Promise((resolve) => { done = resolve; });
    // Every state the message passes through until the opened group holds it
    // complete and unrevealed (a replay would show partial or revealing text).
    const observer = new MutationObserver(() => {
      const prose = root.querySelector(".zeros-agent-md");
      if (!prose) return;
      seen.push({ text: prose.textContent.trim(), edge: prose.dataset.revealing !== undefined });
      if (prose.textContent.trim() === source && prose.dataset.revealing === undefined) done();
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    root.querySelector("[data-working-group]").click();
    await Promise.race([mounted, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    observer.disconnect();
    return { seen, source };
  });
  check(
    "Settled with the setting off, the streamed message remounts in its group complete, without replaying",
    opened.seen.length > 0 && opened.seen.every((sample) => sample.text === opened.source && !sample.edge),
    JSON.stringify({ samples: opened.seen.length }),
  );
  await settle.getByRole("button", { name: "Reset settle probe", exact: true }).click();

  const reports = fixture.locator("#multiple-report-probe");
  const first = reports.getByText("The first confirmed report stays visible.", {
    exact: true,
  });
  const second = reports.getByText(
    "The second confirmed report stays visible too.",
    { exact: true },
  );
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  // One call before each report: plain rows, not groups.
  const groups = reports.getByRole("button", { name: /^Read.* (?:first|second)\.ts$/ });
  await expect(groups).toHaveCount(2);
  const positions = await Promise.all(
    [groups.nth(0), first, groups.nth(1), second].map((node) =>
      node.boundingBox(),
    ),
  );
  check(
    "Both confirmed reports stay visible with later work between them",
    positions.every(
      (box, index) => box && (index === 0 || box.y > positions[index - 1].y),
    ),
  );
  await runTextRevealSmoke({ page, check });
}
