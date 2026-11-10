const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Frame names at small sizes: visible with Play hidden; Play appears on hover;
// a label click still selects; below 40 px everything hides.
export default async (ctx) => {
  const { rawPage } = ctx, out = { zooms: [] };
  const focus = () => rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  const read = () => rawPage.evaluate((view) => {
    const zoom = new DOMMatrixReadOnly(getComputedStyle(document.querySelector(`${view} [data-design-canvas-world]`)).transform).a;
    return { zoom: Math.round(zoom * 1000) / 1000, frames: [...document.querySelectorAll(`${view} [data-design-frame]`)].map((f) => {
      const label = f.querySelector("[data-design-frame-label]"), play = f.querySelector("[data-design-frame-play-chrome] button, [data-design-frame-play-chrome]");
      const lb = label?.getBoundingClientRect(), pb = play?.getBoundingClientRect();
      const shown = (el, b) => !!el && b.width > 2 && b.height > 2 && getComputedStyle(el.closest("[data-design-frame-chrome]")).clip === "auto";
      return { file: f.getAttribute("data-design-frame").split("/")[1], screenWidth: Math.round(parseFloat(f.style.width) * zoom),
        compact: f.hasAttribute("data-design-frame-compact-controls"), compactPlay: f.hasAttribute("data-design-frame-compact-play"), tiled: f.hasAttribute("data-design-frame-tiled"),
        name: shown(label, lb) ? `${label.textContent}@${Math.round(lb.width)}px` : null, play: shown(play, pb) };
    }) };
  }, h.VIEW);
  await focus(); await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Shift+1"); await ctx.delay(1200);
  await rawPage.mouse.move(700, 850); await ctx.delay(300);
  out.zooms.push(await read());
  await rawPage.screenshot({ path: `${ctx.outbox}/074-fit.jpg`, type: "jpeg", quality: 55, clip: { x: 641, y: 100, width: 520, height: 700 } });
  for (let i = 0; i < 3; i++) { await rawPage.keyboard.press("Meta+Minus"); await ctx.delay(500); await rawPage.mouse.move(700, 850); await ctx.delay(200); out.zooms.push(await read()); }
  await rawPage.screenshot({ path: `${ctx.outbox}/074-small.jpg`, type: "jpeg", quality: 55, clip: { x: 641, y: 100, width: 520, height: 700 } });
  // Hover a small frame: Play appears. Click its name: the frame is selected.
  await rawPage.keyboard.press("Shift+1"); await ctx.delay(1000);
  const g = await h.frameGeometry(ctx, "page-1/list.html");
  await rawPage.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await ctx.delay(400);
  out.hover = (await read()).frames.find((f) => f.file === "list.html");
  await rawPage.mouse.move(700, 850); await ctx.delay(300);
  const lb = await rawPage.locator(`${h.VIEW} [data-design-frame="page-1/list.html"] [data-design-frame-label]`).boundingBox();
  await rawPage.mouse.click(lb.x + Math.min(8, lb.width / 2), lb.y + lb.height / 2); await ctx.delay(600);
  out.clicked = await rawPage.evaluate(() => document.querySelector("[data-design-inspector-header]")?.textContent?.trim().slice(0, 40));
  return out;
};
