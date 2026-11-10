const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Alt+drag a frame by its label at a zoom where the label is full size: the
// original stays, a copy lands at the release point, nothing flashes.
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const file = "page-1/hero.html";
  const world = () => rawPage.evaluate((view) => [...document.querySelectorAll(`${view} [data-design-frame]`)].map((f) => ({ file: f.getAttribute("data-design-frame"), x: parseFloat(f.style.left), y: parseFloat(f.style.top), w: parseFloat(f.style.width), h: parseFloat(f.style.height) })), h.VIEW);
  // Select Hero and zoom to it, so its label is a full-size hit target.
  const g = await h.frameGeometry(ctx, file);
  await rawPage.mouse.move(g.x + g.width * 0.97, g.y + g.height * 0.97); await ctx.delay(60);
  await rawPage.mouse.click(g.x + g.width * 0.97, g.y + g.height * 0.97); await ctx.delay(500);
  await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  await rawPage.keyboard.press("Shift+2"); await ctx.delay(700);
  await rawPage.keyboard.press("Meta+minus"); await ctx.delay(700);
  const lb = await rawPage.locator(`${h.VIEW} [data-design-frame="${file}"] [data-design-frame-label]`).boundingBox();
  out.label = lb;
  if (!lb || lb.width < 8) throw new Error(`label too small: ${JSON.stringify(lb)}`);
  const before = await world();
  const g2 = await h.frameGeometry(ctx, file);
  const sx = lb.x + Math.min(10, lb.width / 2), sy = lb.y + lb.height / 2;
  const dy = Math.round(g2.height + 60);
  await rawPage.keyboard.down("Alt");
  const cast = await ctx.screencast("056-alt", async () => {
    await rawPage.mouse.move(sx, sy); await rawPage.mouse.down();
    for (let i = 1; i <= 15; i++) { await rawPage.mouse.move(sx, sy + dy * i / 15); await ctx.delay(16); }
    await ctx.delay(80);
    out.duringDrag = await world();
    await rawPage.mouse.up(); await ctx.delay(1500);
  }, { max: 70 });
  await rawPage.keyboard.up("Alt");
  const after = await world();
  out.added = after.filter((f) => !before.some((b) => b.file === f.file));
  out.originalBefore = before.find((f) => f.file === file); out.originalAfter = after.find((f) => f.file === file);
  out.expectedY = Math.round(out.originalBefore.y + dy / g2.zoom);
  out.state = await h.state(ctx);
  out.header = await rawPage.evaluate(() => document.querySelector("[data-design-inspector-header]")?.textContent?.trim().slice(0, 40));
  const sheet = await h.sheet(ctx, "056-alt-sheet", cast.frames, { clip: { x: 645, y: 110, width: 515, height: 700 }, columns: 8, width: 150 });
  out.spikes = sheet.diffs.map((d, i) => [cast.frames[i], d]).filter(([, d]) => d > 25);
  return out;
};
