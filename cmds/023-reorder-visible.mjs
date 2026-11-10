const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx;
  const file = "page-1/card.html";
  const kids = () => rawPage.frameLocator(h.live(file)).locator('[data-oid="card-tiles"]').evaluate((el) => [...el.children].map((c) => c.getAttribute("data-oid")));
  // Fit the card into the uncovered canvas.
  await rawPage.locator(`[data-design-sidebar-panel] [data-design-layer-id="card-tiles"]`).first().click().catch(() => {});
  await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  await rawPage.keyboard.press("Shift+2"); await ctx.delay(700);
  const order = await kids();
  const last = order[1], first = order[0];
  await rawPage.locator(`[data-design-sidebar-panel] [data-design-layer-id="${last}"]`).first().click();
  await ctx.delay(300);
  const from = await h.hitPoint(ctx, file, `[data-oid="${last}"]`);
  const to = await h.hitPoint(ctx, file, `[data-oid="${first}"]`);
  const row = await h.box(ctx, file, '[data-oid="card-tiles"]');
  const cast = await ctx.screencast("023-drag", async () => {
    await rawPage.mouse.move(from.x, from.y); await rawPage.mouse.down();
    for (let i = 1; i <= 16; i++) { await rawPage.mouse.move(from.x + (to.box.x + 3 - from.x) * i / 16, from.y + (to.y - from.y) * i / 16); await ctx.delay(20); }
    await ctx.delay(200);
    await rawPage.mouse.up(); await ctx.delay(900);
  }, { max: 60 });
  const clip = { x: Math.max(641, row.x - 20), y: Math.max(80, row.y - 40), width: Math.min(520, row.width + 40), height: Math.min(260, row.height + 80) };
  const sheet = await h.sheet(ctx, "023-drag-sheet", cast.frames, { clip, columns: 6, width: 220 });
  return { order, after: await kids(), from, to, sheet: sheet.sheet, diffs: sheet.diffs, state: await h.state(ctx), probe: (await ctx.probe()).events.filter((e) => e[1] === "frame") };
};
