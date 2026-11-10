const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// A/B: runtime documents hidden by visibility (control) vs kept rendering at
// opacity 0 until ready (override). Count black frames on selection reveal.
const OVERRIDE = `iframe[data-design-document-buffer]{visibility:inherit!important}
iframe[data-design-document-buffer]:not([data-design-document-ready]),iframe[data-design-document-buffer="incoming"]{opacity:0!important}`;
export default async (ctx) => {
  const { rawPage } = ctx, out = { trials: [] };
  const card = "page-1/card.html", list = "page-1/list.html";
  const plan = [[card, 0], [list, 0], [card, 1], [list, 1], [card, 0], [list, 0], [card, 1], [list, 1], [card, 0], [list, 0], [card, 1], [list, 1]];
  for (const [index, [file, override]] of plan.entries()) {
    await rawPage.evaluate(({ on, css }) => {
      let s = document.getElementById("qa-override");
      if (on && !s) { s = document.createElement("style"); s.id = "qa-override"; s.textContent = css; document.head.append(s); }
      if (!on && s) s.remove();
    }, { on: !!override, css: OVERRIDE });
    await ctx.delay(2200);
    const before = await rawPage.evaluate(({ view, file }) => document.querySelectorAll(`${view} [data-design-frame="${file}"] iframe[data-design-document-buffer]`).length, { view: h.VIEW, file });
    const lb = await rawPage.locator(`${h.VIEW} [data-design-frame="${file}"] [data-design-frame-label]`).boundingBox();
    const fr = await h.frameRect(ctx, file);
    const name = `032-${String(index).padStart(2, "0")}-${override ? "ovr" : "ctl"}-${file.includes("card") ? "card" : "list"}`;
    const cast = await ctx.screencast(name, async () => {
      await rawPage.mouse.click(lb.x + lb.width / 2, lb.y + lb.height / 2); await ctx.delay(600);
    }, { max: 30 });
    const sheet = await h.sheet(ctx, `${name}-sheet`, cast.frames, { clip: { x: fr.x + 6, y: fr.y + 6, width: fr.width - 12, height: fr.height - 12 }, columns: 8, width: 120 });
    out.trials.push({ name, override, wasLive: before > 0, frames: cast.frames.length, maxDiff: Math.max(...sheet.diffs), black: sheet.diffs.filter((d) => d > 100).length });
  }
  await rawPage.evaluate(() => document.getElementById("qa-override")?.remove());
  return out;
};
