// Smokes that share one harness page must leave it still: a fixture left
// streaming keeps growing the page and moves whatever the next
// smoke points at (a hover target slides out from under the pointer). This
// fails at the boundary, naming what is still active, instead of later as a
// flaky interaction.

/** Assert nothing on the page is still streaming or changing its height.
 * (A live message at rest may keep its reveal state; that is not motion.)
 * `after` names the smoke that just finished. */
export async function expectPageSettled(page, after, { quietMs = 500 } = {}) {
  const state = await page.evaluate(async (quietMs) => {
    const describe = (el) => el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(" ")[0]}` : ""}`;
    const active = [
      ...[...document.querySelectorAll("[data-streaming]")]
        .filter((el) => el.getAttribute("data-streaming"))
        .map((el) => `${describe(el)} still streaming (${el.getAttribute("data-streaming")})`),
    ];
    const heights = [document.documentElement.scrollHeight];
    const started = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        heights.push(document.documentElement.scrollHeight);
        if (performance.now() - started < quietMs) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    return { active, from: heights[0], to: heights.at(-1), changed: new Set(heights).size > 1 };
  }, quietMs);
  const problems = [...state.active];
  if (state.changed) problems.push(`page height changed ${state.from} → ${state.to}px within ${quietMs}ms`);
  if (problems.length)
    throw new Error(`Page not settled after ${after}: ${problems.join("; ")}. ` +
      "Leave fixtures idle before the next smoke on this page runs.");
}
