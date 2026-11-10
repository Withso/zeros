const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Alt+drag a frame by its label at a zoom where the label is full size: the
// original stays, a copy lands at the release point, nothing flashes.
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const file = "page-1/hero.html";
  const world = () => rawPage.evaluate((view) => [...document.querySelectorAll(`${view} [data-design-frame]`)].map((f) => ({ file: f.getAttribute("data-design-frame"), x: parseFloat(f.style.left), y: parseFloat(f.style.top), w: parseFloat(f.style.width), h: parseFloat(f.style.height) })), h.VIEW);
  // Select Hero and zoom to it, so its label is a full-size hit target.
  // Select Hero from its Layers row (never under a panel), then zoom to it.
  await rawPage.locator("[data-design-sidebar-panel] [role='treeitem'], [data-design-sidebar-panel] [data-design-layer-row]").filter({ hasText: /^Hero$/ }).first().click().catch(async () => {
    await rawPage.locator("[data-design-sidebar-panel]").getByText("Hero", { exact: true }).first().click();
  });
  await ctx.delay(500);
  out.selected = await rawPage.evaluate(() => document.querySelector("[data-design-inspector-header]")?.textContent?.trim().slice(0, 40));
  await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  await rawPage.keyboard.press("Shift+2"); await ctx.delay(700);
  await rawPage.keyboard.press("Meta+Minus"); await ctx.delay(700);
  const lb = await rawPage.locator(`${h.VIEW} [data-design-frame="${file}"] [data-design-frame-label]`).boundingBox();
  out.label = lb;
  if (!lb || lb.width < 8) throw new Error(`label too small: ${JSON.stringify(lb)}`);
  out.labelHit = await rawPage.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return !!e?.closest("[data-design-frame-label]"); }, { x: lb.x + Math.min(10, lb.width / 2), y: lb.y + lb.height / 2 });
  if (!out.labelHit) throw new Error(`label is covered at ${JSON.stringify(lb)}`);
  const before = await world();
  const g2 = await h.frameGeometry(ctx, file);
  const sx = lb.x + Math.min(10, lb.width / 2), sy = lb.y + lb.height / 2;
  const dy = Math.round(g2.height + 60);
  await rawPage.keyboard.down("Alt");
  const cast = await ctx.screencast("067-alt", async () => {
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
  const sheet = await h.sheet(ctx, "067-alt-sheet", cast.frames, { clip: { x: 645, y: 110, width: 515, height: 700 }, columns: 8, width: 150 });
  out.spikes = sheet.diffs.map((d, i) => [cast.frames[i], d]).filter(([, d]) => d > 25);
  return out;
};
