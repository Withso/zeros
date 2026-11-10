const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx;
  // Select Card through Layers (its label may be compact), zoom to 100%.
  await rawPage.locator('[data-design-sidebar-panel] [data-design-layer-id]').first().waitFor().catch(() => {});
  await rawPage.locator(`${h.VIEW} [data-design-frame="page-1/card.html"]`).click({ position: { x: 20, y: 12 } });
  await ctx.delay(300);
  await rawPage.keyboard.press("Shift+2"); await ctx.delay(500);
  await rawPage.keyboard.press("Shift+0"); await ctx.delay(700);
  await h.waitFor(() => rawPage.locator(h.live("page-1/card.html")).count(), 4000);
  const card = await h.frameRect(ctx, "page-1/card.html");
  // Duplicate Card's tiles row (a structural mutation in Card) is a swap; to
  // isolate churn, mutate another frame: duplicate Hero through the keyboard.
  await rawPage.evaluate(() => { window.__qaResidency = []; });
  await ctx.resetProbe();
  const cast = await ctx.screencast("014-churn", async () => {
    // Select Hero from Layers and duplicate it; Card stays on screen.
    await rawPage.locator('[data-design-sidebar-panel] [data-design-layer-id]').filter({ hasText: "Hero" }).first().click().catch(() => {});
    await ctx.delay(250);
    await rawPage.keyboard.press("Meta+d");
    await ctx.delay(1200);
  }, { max: 80 });
  const clip = { x: Math.max(641, card.x), y: Math.max(80, card.y), width: Math.min(500, card.width), height: Math.min(480, card.height) };
  const sheet = await h.sheet(ctx, "014-churn-sheet", cast.frames, { clip, columns: 8, width: 160 });
  return { card, probe: (await ctx.probe()).events, residency: await rawPage.evaluate(() => window.__qaResidency), sheet: sheet.sheet, diffs: sheet.diffs, state: await h.state(ctx) };
};
