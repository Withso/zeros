const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Inspector style edits on an auto-layout frame: time from commit to the
// canvas showing the value, flashes, and whether the source saved it.
export default async (ctx) => {
  const { rawPage } = ctx, out = { edits: [] };
  const file = "page-1/card.html";
  const g = await h.frameGeometry(ctx, file);
  await rawPage.mouse.move(g.x + g.width / 2, g.y + g.height * 0.95); await ctx.delay(60);
  await rawPage.mouse.click(g.x + g.width / 2, g.y + g.height * 0.95); await ctx.delay(800);
  const root = () => rawPage.frameLocator(h.live(file)).locator('[data-oid="card-root"]');
  const read = (prop) => root().evaluate((el, prop) => getComputedStyle(el)[prop], prop).catch(() => null);
  const edits = [
    ["Gap", "28", "rowGap", "28px"],
    ["Horizontal", "48", "paddingLeft", "48px"],
    ["Radius", "24", "borderTopLeftRadius", "24px"],
    ["Fill", "EEF4FF", "backgroundColor", "rgb(238, 244, 255)"],
    ["Opacity", "90", "opacity", "0.9"],
  ];
  for (const [label, value, prop, expected] of edits) {
    const input = rawPage.getByLabel(label, { exact: true }).first();
    const fr = await h.frameRect(ctx, file);
    const clip = { x: Math.max(fr.x, 645), y: Math.max(fr.y, 120), width: Math.min(fr.width, 500), height: Math.min(fr.height, 700) };
    const before = await read(prop);
    await input.click(); await input.fill(value);
    let applied = null, t0 = 0;
    const cast = await ctx.screencast(`048-${label}`, async () => {
      t0 = Date.now();
      await input.press("Enter");
      while (Date.now() - t0 < 3000) { if ((await read(prop)) === expected) { applied = Date.now() - t0; break; } await ctx.delay(4); }
      await ctx.delay(700);
    }, { max: 40 });
    const sheet = await h.sheet(ctx, `048-${label}-sheet`, cast.frames, { clip, columns: 8, width: 150 });
    out.edits.push({ label, before, after: await read(prop), appliedMs: applied, frames: cast.frames.length, spikes: sheet.diffs.map((d, i) => [cast.frames[i], d]).filter(([, d]) => d > 12), inputAfter: await input.inputValue().catch(() => null) });
  }
  out.source = await rawPage.evaluate(() => null);
  out.state = await h.state(ctx);
  return out;
};
