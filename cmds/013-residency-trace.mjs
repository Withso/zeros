const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx;
  await h.focusCanvas(ctx); await rawPage.keyboard.press("Shift+1"); await ctx.delay(800);
  // Open Card's layers the way editing does: select its heading, then deselect.
  await rawPage.locator(`${h.VIEW} [data-design-frame="page-1/card.html"]`).click({ position: { x: 30, y: 20 } });
  await ctx.delay(400);
  await h.focusCanvas(ctx); await ctx.delay(500);
  await rawPage.evaluate(() => { window.__qaResidency = []; });
  await ctx.resetProbe();
  const before = (await h.state(ctx)).frames.length;
  const p = await h.emptyPoint(ctx);
  await rawPage.keyboard.press("f");
  await rawPage.mouse.move(p.x, p.y - 100); await rawPage.mouse.down();
  await rawPage.mouse.move(p.x + 90, p.y - 30, { steps: 6 }); await rawPage.mouse.up();
  await h.waitFor(async () => (await h.state(ctx)).frames.length > before, 4000);
  await ctx.delay(900);
  const residency = await rawPage.evaluate(() => window.__qaResidency);
  const probe = (await ctx.probe()).events;
  // Then a plain select/deselect cycle on another frame.
  await rawPage.evaluate(() => { window.__qaResidency = []; });
  await ctx.resetProbe();
  await rawPage.locator(`${h.VIEW} [data-design-frame="page-1/hero.html"]`).click({ position: { x: 40, y: 40 } });
  await ctx.delay(600);
  await h.focusCanvas(ctx); await ctx.delay(600);
  const cycle = await rawPage.evaluate(() => window.__qaResidency);
  return { residency, probe, cycle, cycleProbe: (await ctx.probe()).events };
};
