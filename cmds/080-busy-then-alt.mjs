const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Make the session "busy" like the one that flashed: several edits inside the
// Card (each a new source generation whose old tiles retire), at a few zooms.
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const card = "page-1/card.html";
  const focus = () => rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  await rawPage.locator("[data-design-sidebar-panel]").getByText("Card", { exact: true }).first().click(); await ctx.delay(500);
  await focus(); await rawPage.keyboard.press("Shift+2"); await ctx.delay(900);
  await h.waitFor(() => rawPage.locator(h.live(card)).count(), 4000);
  for (let i = 0; i < 3; i++) { const p = await h.hitPoint(ctx, card, '[data-oid="card-primary"]'); await rawPage.mouse.dblclick(p.x, p.y); await ctx.delay(500); if ((await h.state(ctx)).selectedLayers.includes("card-primary")) break; }
  await focus();
  for (const key of ["Meta+d", "Meta+z", "Meta+Shift+z", "Meta+z", "Meta+Shift+z", "Backspace", "Meta+z", "Meta+d", "Meta+d", "Meta+z", "Meta+z"]) {
    await rawPage.keyboard.press(key); await ctx.delay(900);
    // Let the Card go passive at this generation, at a different zoom each time.
    await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Escape"); await ctx.delay(250);
    await rawPage.mouse.move(900, 450); await rawPage.keyboard.down("Control"); await rawPage.mouse.wheel(0, key.length % 2 ? 160 : -160); await rawPage.keyboard.up("Control"); await ctx.delay(700);
    for (let i = 0; i < 3; i++) { const p = await h.hitPoint(ctx, card, '[data-oid="card-primary"]').catch(() => null); if (!p) break; await rawPage.mouse.dblclick(p.x, p.y); await ctx.delay(450); if ((await h.state(ctx)).selectedLayers.some((id) => id.startsWith("card-primary"))) break; }
    await focus();
  }
  out.state = await h.state(ctx);
  return out;
};
