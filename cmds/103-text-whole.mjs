const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const focus = () => rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  const world = () => rawPage.evaluate((view) => [...document.querySelectorAll(`${view} [data-design-frame]`)].map((f) => `${f.getAttribute("data-design-frame").split("/")[1]}@${parseFloat(f.style.left)},${parseFloat(f.style.top)},${parseFloat(f.style.width)}x${parseFloat(f.style.height)}`), h.VIEW);
  out.zoom = await rawPage.evaluate((view) => new DOMMatrixReadOnly(getComputedStyle(document.querySelector(`${view} [data-design-canvas-world]`)).transform).a, h.VIEW);
  for (const drag of [false, true]) {
    const w0 = await world();
    await focus(); await rawPage.keyboard.press("t"); await ctx.delay(200);
    const empty = await h.emptyPoint(ctx);
    const x = empty.x + 3.3 + (drag ? 120 : 0), y = empty.y - 61.7 - (drag ? 80 : 0);
    if (drag) { await rawPage.mouse.move(x, y); await rawPage.mouse.down(); for (let i = 1; i <= 6; i++) { await rawPage.mouse.move(x + i * 7.7, y + i * 3.3); await ctx.delay(16); } await rawPage.mouse.up(); }
    else await rawPage.mouse.click(x, y);
    await ctx.delay(500);
    await rawPage.keyboard.type(drag ? "Sized text" : "Whole pixels", { delay: 25 });
    await rawPage.keyboard.press("Meta+Enter"); await ctx.delay(2200);
    const w1 = await world();
    out[drag ? "dragText" : "clickText"] = w1.filter((f) => !w0.includes(f));
  }
  return out;
};
