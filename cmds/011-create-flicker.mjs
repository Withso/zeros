const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx;
  await h.focusCanvas(ctx); await rawPage.keyboard.press("Shift+1"); await ctx.delay(800);
  await h.focusCanvas(ctx); await ctx.delay(400);
  const card = await h.frameRect(ctx, "page-1/card.html");
  const before = (await h.state(ctx)).frames.length;
  const p = await h.emptyPoint(ctx);
  await ctx.resetProbe();
  const cast = await ctx.screencast("011-create", async () => {
    await rawPage.keyboard.press("f");
    await rawPage.mouse.move(p.x, p.y - 100); await rawPage.mouse.down();
    await rawPage.mouse.move(p.x + 90, p.y - 30, { steps: 6 }); await rawPage.mouse.up();
    await h.waitFor(async () => (await h.state(ctx)).frames.length > before, 4000);
    await ctx.delay(900);
  }, { max: 70 });
  const probe = (await ctx.probe()).events;
  const clip = { x: Math.max(0, card.x - 10), y: Math.max(0, card.y - 24), width: Math.min(560, card.width + 20), height: Math.min(420, card.height + 34) };
  const sheet = await h.sheet(ctx, "011-create-sheet", cast.frames, { clip, columns: 7, width: 180 });
  return { card, probe, sheet: sheet.sheet, diffs: sheet.diffs, frames: cast.frames.length };
};
