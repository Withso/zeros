import { expect } from "@playwright/test";

export async function runStreamingTextSmoke({ page, check }) {
  const fixture = page.locator("#streaming-text-fixture");
  const probe = fixture.locator("#streaming-text-probe");
  const reset = () =>
    fixture
      .getByRole("button", { name: "Reset assistant text", exact: true })
      .click();
  const samples = async (action) =>
    fixture.evaluate(async (root, after) => {
      const probe = root.querySelector("#streaming-text-probe");
      const seen = [];
      const sample = () => {
        const prose = probe.querySelector(".zeros-agent-md");
        seen.push({
          text: prose.textContent.trim(),
          edge: prose.dataset.streamingEdge === "true",
          mask: getComputedStyle(prose).maskImage,
        });
      };
      const observer = new MutationObserver(sample);
      observer.observe(probe, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      const click = (label) =>
        [...root.querySelectorAll("button")]
          .find((button) => button.textContent === label)
          .click();
      click("Append assistant text");
      if (after) setTimeout(() => click(after), 45);
      await new Promise((resolve) => setTimeout(resolve, 350));
      sample();
      observer.disconnect();
      return { seen, source: probe.dataset.source };
    }, action);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const burst = await samples(null);
  const intermediate = burst.seen.filter(
    (sample) =>
      sample.text.length > 40 &&
      sample.text.length < burst.source.trim().length,
  );
  check(
    "Assistant bursts reveal progressively with a subtle edge mask",
    intermediate.length > 1 &&
      intermediate.some((sample) => sample.edge && sample.mask !== "none"),
  );
  await expect(probe.locator(".zeros-agent-md")).toHaveText(
    burst.source.trim(),
  );
  await expect(probe.locator("[data-streaming-edge]")).toHaveCount(0);

  for (const action of [
    "Stop assistant text",
    "Advance assistant activity",
    "Correct assistant text",
    "Toggle text surface",
  ]) {
    await reset();
    const result = await samples(action);
    await expect(probe.locator(".zeros-agent-md")).toHaveText(
      result.source.trim(),
    );
    await expect(probe.locator("[data-streaming-edge]")).toHaveCount(0);
    if (action === "Toggle text surface") {
      await fixture.getByRole("button", { name: action, exact: true }).click();
      await expect(probe.locator(".zeros-agent-md")).toHaveText(
        result.source.trim(),
      );
    }
  }
  check(
    "Stop, later activity, corrections and hidden surfaces flush visual buffering",
    true,
  );

  await reset();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await samples(null);
  check(
    "Reduced motion bypasses text pacing and edge effects",
    !reduced.seen.some((sample) => sample.edge) &&
      reduced.seen.at(-1).text === reduced.source.trim(),
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });

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
  const groups = reports.getByRole("button", { name: /tool call/ });
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
}
