const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Canvas spacing handles on an auto-layout frame: drag the gap, drag a
// padding band, click-to-type a gap. Live preview per move, committed value,
// no flash.
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const file = "page-1/card.html";
  await rawPage.locator("[data-design-sidebar-panel]").getByText("Card", { exact: true }).first().click(); await ctx.delay(500);
  await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  await rawPage.keyboard.press("Shift+2"); await ctx.delay(1000);
  const root = () => rawPage.frameLocator(h.live(file)).locator('[data-oid="card-root"]');
  const read = () => root().evaluate((el) => { const s = getComputedStyle(el); return { gap: s.rowGap, top: s.paddingTop, left: s.paddingLeft }; }).catch(() => null);
  out.before = await read();
  const handles = () => rawPage.evaluate((view) => [...document.querySelectorAll(`${view} [data-design-inline-spacing]`)].map((el) => {
    const r = el.getBoundingClientRect();
    return { property: el.getAttribute("data-design-inline-spacing"), axis: el.getAttribute("data-design-inline-spacing-axis"), gap: el.hasAttribute("data-design-inline-gap-region"), label: el.getAttribute("aria-label"), x: r.x, y: r.y, w: r.width, h: r.height };
  }), h.VIEW);
  out.handles = await handles();
  const drag = async (name, handle, dx, dy) => {
    const cx = handle.x + handle.w / 2, cy = handle.y + handle.h / 2;
    const fr = await h.frameRect(ctx, file);
    const clip = { x: Math.max(fr.x, 645), y: Math.max(fr.y, 120), width: Math.min(fr.width, 500), height: Math.min(fr.height, 700) };
    const samples = [];
    const cast = await ctx.screencast(`068-${name}`, async () => {
      await rawPage.mouse.move(cx, cy); await ctx.delay(80); await rawPage.mouse.down();
      for (let i = 1; i <= 10; i++) { await rawPage.mouse.move(cx + dx * i / 10, cy + dy * i / 10); await ctx.delay(30); samples.push(await read()); }
      await rawPage.mouse.up(); await ctx.delay(1200);
    }, { max: 60 });
    const sheet = await h.sheet(ctx, `068-${name}-sheet`, cast.frames, { clip, columns: 8, width: 150 });
    return { samples: samples.map((s) => s && `${s.gap}/${s.top}`), after: await read(), spikes: sheet.diffs.map((d, i) => [cast.frames[i], d]).filter(([, d]) => d > 25), state: (await h.state(ctx)).inspector };
  };
  const gap = out.handles.find((x) => x.gap);
  if (gap) out.gapDrag = await drag("gap", gap, gap.axis === "x" ? 30 : 0, gap.axis === "y" ? 30 : 0);
  const pad = (await handles()).find((x) => !x.gap && /top/i.test(`${x.property} ${x.label}`));
  if (pad) out.padDrag = await drag("pad", pad, 0, 24);
  // Click-to-type a gap.
  const gap2 = (await handles()).find((x) => x.gap);
  if (gap2) {
    await rawPage.mouse.click(gap2.x + gap2.w / 2, gap2.y + gap2.h / 2); await ctx.delay(300);
    const input = rawPage.locator(`${h.VIEW} [data-design-inline-spacing-input]`).first();
    out.inputVisible = await input.isVisible().catch(() => false);
    if (out.inputVisible) { await input.fill("24"); await input.press("Enter"); await ctx.delay(1200); }
    out.typed = await read();
  }
  return out;
};
