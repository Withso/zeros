const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx, log = [], t0 = Date.now();
  const mark = async (label, extra = {}) => log.push({ t: Date.now() - t0, label, ...(await h.state(ctx)), ...extra });
  await h.focusCanvas(ctx);
  // Fit everything, then zoom to Hero (a frame that isn't the page's first).
  await rawPage.keyboard.press("Shift+1"); await ctx.delay(500);
  await rawPage.locator(`${h.VIEW} [data-design-frame="page-1/hero.html"] [data-design-frame-label]`).click();
  await rawPage.keyboard.press("Shift+2"); await ctx.delay(700);
  await h.waitFor(() => rawPage.locator(h.live("page-1/hero.html")).count(), 5000);
  await mark("hero selected");
  const title = await h.box(ctx, "page-1/hero.html", '[data-oid="hero-title"]');
  const at = h.center(title);
  await rawPage.mouse.dblclick(at.x, at.y); await ctx.delay(300);
  if (!(await h.state(ctx)).editor) { await rawPage.mouse.dblclick(at.x, at.y); await ctx.delay(300); }
  await mark("editing");
  await rawPage.keyboard.press("End");
  await rawPage.keyboard.type(" now", { delay: 60 });
  await ctx.delay(200);
  await mark("typed");
  await h.focusCanvas(ctx);
  await ctx.delay(2500);
  await mark("clicked out +2.5s");
  const shot = await h.jpeg(ctx, "007-after");
  // Does an editor element linger (even hidden), and can a new click select?
  const lingering = await rawPage.evaluate(() => [...document.querySelectorAll("[data-design-inline-text-editor]")].map((e) => ({ visibility: getComputedStyle(e).visibility, pointer: getComputedStyle(e).pointerEvents, text: e.textContent })));
  const saved = await rawPage.frameLocator(h.live("page-1/hero.html")).locator('[data-oid="hero-title"]').textContent().catch((e) => String(e));
  return { log, shot, lingering, saved };
};
