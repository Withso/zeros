const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const card = "page-1/card.html", list = "page-1/list.html";
  const kids = () => rawPage.frameLocator(h.live(card)).locator('[data-oid="card-root"]').evaluate((el) => [...el.children].map((c) => c.getAttribute("data-oid")));
  await h.focusCanvas(ctx); await rawPage.keyboard.press("Shift+1"); await ctx.delay(700);
  const label = rawPage.locator(`${h.VIEW} [data-design-frame="${list}"] [data-design-frame-label]`);
  const lb = await label.boundingBox();
  const cr = await h.frameRect(ctx, card);
  out.label = lb; out.card = cr;
  if (!lb || lb.width < 8) throw new Error("List label not visible");
  // Card must be live for its children to be read; select it first via its body.
  await rawPage.mouse.click(cr.x + cr.width / 2, cr.y + cr.height * 0.85); await ctx.delay(500);
  const before = await kids().catch((e) => String(e));
  const framesBefore = (await h.state(ctx)).frames;
  await ctx.resetProbe();
  const cast = await ctx.screencast("028-nest", async () => {
    await rawPage.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2); await rawPage.mouse.down();
    const tx = cr.x + cr.width / 2, ty = cr.y + cr.height * 0.75;
    for (let i = 1; i <= 20; i++) { await rawPage.mouse.move(lb.x + (tx - lb.x) * i / 20, lb.y + (ty - lb.y) * i / 20); await ctx.delay(20); }
    await ctx.delay(250);
    out.nestTarget = await rawPage.evaluate(() => [...document.querySelectorAll("[data-design-nest-target]")].map((e) => e.getAttribute("data-design-frame")));
    await rawPage.mouse.up(); await ctx.delay(1400);
  }, { max: 70 });
  out.framesAfter = (await h.state(ctx)).frames;
  out.before = before; out.after = await kids().catch((e) => String(e));
  out.probe = (await ctx.probe()).events.filter((e) => e[1] === "frame").slice(0, 12);
  out.state = await h.state(ctx);
  out.shot = await h.jpeg(ctx, "028-after-nest");
  const clip = { x: 641, y: 80, width: 520, height: 600 };
  const sheet = await h.sheet(ctx, "028-nest-sheet", cast.frames, { clip, columns: 7, width: 200 });
  out.diffs = sheet.diffs;
  return out;
};
