const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Frame-level operations from a fitted view: Cmd+D, Alt+drag duplicate and
// a corner resize. Where do frames land, what is selected, any flash?
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const world = () => rawPage.evaluate((view) => [...document.querySelectorAll(`${view} [data-design-frame]`)].map((f) => ({ file: f.getAttribute("data-design-frame"), x: parseFloat(f.style.left), y: parseFloat(f.style.top), w: parseFloat(f.style.width), h: parseFloat(f.style.height) })), h.VIEW);
  const header = () => rawPage.evaluate(() => document.querySelector("[data-design-inspector-header]")?.textContent?.trim().slice(0, 40));
  await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Shift+1"); await ctx.delay(900);
  const label = async (file) => { const b = await rawPage.locator(`${h.VIEW} [data-design-frame="${file}"] [data-design-frame-label]`).boundingBox(); return b && b.width > 4 ? b : null; };
  // (b) Cmd+D on Hero.
  const hero = "page-1/hero.html";
  const hb = await label(hero);
  out.heroLabel = hb;
  await rawPage.mouse.click(hb.x + Math.min(10, hb.width / 2), hb.y + hb.height / 2); await ctx.delay(500);
  out.selectedBeforeDup = await header();
  const w0 = await world();
  await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  await rawPage.keyboard.press("Meta+d"); await ctx.delay(1500);
  const w1 = await world();
  out.dup = { added: w1.filter((f) => !w0.some((b) => b.file === f.file)), selected: await header() };
  // (c) Alt+drag duplicate of List by its label.
  const list = "page-1/list.html";
  await rawPage.keyboard.press("Shift+1"); await ctx.delay(900);
  const lb = await label(list);
  out.listLabel = lb;
  const w2 = await world();
  if (lb) {
    await rawPage.keyboard.down("Alt");
    const sx = lb.x + Math.min(10, lb.width / 2), sy = lb.y + lb.height / 2;
    await rawPage.mouse.move(sx, sy); await rawPage.mouse.down();
    for (let i = 1; i <= 15; i++) { await rawPage.mouse.move(sx + 10 * i, sy); await ctx.delay(16); }
    await rawPage.mouse.up(); await rawPage.keyboard.up("Alt"); await ctx.delay(1500);
  }
  const w3 = await world();
  out.altDrag = { added: w3.filter((f) => !w2.some((b) => b.file === f.file)), listAfter: w3.find((f) => f.file === list), listBefore: w2.find((f) => f.file === list), selected: await header() };
  await rawPage.screenshot({ path: `${ctx.outbox}/050-after.jpg`, type: "jpeg", quality: 50 });
  return out;
};
