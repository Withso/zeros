const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const card = "page-1/card.html", list = "page-1/list.html";
  // 1. Undo the nest from 028.
  await h.focusCanvas(ctx); await ctx.delay(200);
  await rawPage.keyboard.press("Meta+z"); await ctx.delay(1500);
  out.afterUndo = await h.state(ctx);
  out.cardKids = await rawPage.frameLocator(h.live(card)).locator('[data-oid="card-root"]').evaluate((el) => [...el.children].map((c) => c.getAttribute("data-oid"))).catch((e) => String(e).slice(0, 120));
  // 2. Deselect and let List go passive.
  await h.focusCanvas(ctx); await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Shift+1"); await ctx.delay(2500);
  await h.surfaceProbe(ctx, [list, card]);
  await ctx.delay(150);
  const label = rawPage.locator(`${h.VIEW} [data-design-frame="${list}"] [data-design-frame-label]`);
  const lb = await label.boundingBox();
  out.label = lb;
  if (!lb) throw new Error("no List label");
  await ctx.resetProbe();
  const cast = await ctx.screencast("029-drag", async () => {
    await rawPage.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2); await rawPage.mouse.down();
    for (let i = 1; i <= 16; i++) { await rawPage.mouse.move(lb.x + lb.width / 2 + i * 2, lb.y + lb.height / 2 + i * 10); await ctx.delay(20); }
    await rawPage.mouse.up(); await ctx.delay(1200);
  }, { max: 60 });
  out.surf = await h.surfaceLog(ctx);
  out.probe = (await ctx.probe()).events.filter((e) => e[1] === "frame").slice(0, 16);
  out.state = await h.state(ctx);
  const sheet = await h.sheet(ctx, "029-drag-sheet", cast.frames, { clip: { x: 641, y: 300, width: 520, height: 500 }, columns: 7, width: 200 });
  out.diffs = sheet.diffs; out.times = cast.frames.map((f) => f.t ?? f.time ?? null).slice(0, 40);
  return out;
};
