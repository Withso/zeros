const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Select passive frames by clicking their bodies (as a person does), count
// black frames on each passive -> live handoff, and align one with the DOM.
export default async (ctx) => {
  const { rawPage } = ctx, out = { trials: [] };
  const files = ["page-1/card.html", "page-1/list.html", "page-1/hero.html"];
  for (let index = 0; index < 9; index++) {
    const file = files[index % 3];
    await ctx.delay(2200);
    const g = await h.frameGeometry(ctx, file);
    const before = await rawPage.evaluate(({ view, file }) => document.querySelectorAll(`${view} [data-design-frame="${file}"] iframe[data-design-document-buffer]`).length, { view: h.VIEW, file });
    const x = g.x + g.width * 0.5, y = g.y + g.height * 0.92;
    await rawPage.mouse.move(x - 30, y - 30); await ctx.delay(60); await rawPage.mouse.move(x, y); await ctx.delay(60);
    const name = `039-${String(index).padStart(2, "0")}-${file.split("/")[1].replace(".html", "")}`;
    const cast = await ctx.screencast(name, async () => { await rawPage.mouse.down(); await rawPage.mouse.up(); await ctx.delay(600); }, { max: 30 });
    const sheet = await h.sheet(ctx, `${name}-sheet`, cast.frames, { clip: { x: g.x + 3, y: g.y + 3, width: g.width - 6, height: g.height - 6 }, columns: 8, width: 120 });
    const state = await h.state(ctx);
    out.trials.push({ name, wasLive: before > 0, frames: cast.frames.length, maxDiff: Math.max(...sheet.diffs), black: sheet.diffs.filter((d) => d > 60).length, selected: state.selectedLayers, inspector: state.inspector });
  }
  return out;
};
