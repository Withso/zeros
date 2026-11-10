const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx, log = [], t0 = Date.now();
  const mark = async (label, extra = {}) => log.push({ t: Date.now() - t0, label, ...(await h.state(ctx)), ...extra });
  const file = "page-1/hero.html";
  await h.waitFor(() => rawPage.locator(h.live(file)).count(), 5000);
  const title = await h.box(ctx, file, '[data-oid="hero-title"]');
  const at = h.center(title);
  await mark("start", { title });
  const shots = [];
  // Click the frame body first (selects Hero), then double-click the title.
  await rawPage.mouse.click(at.x, at.y); await ctx.delay(400); await mark("click");
  await rawPage.mouse.dblclick(at.x, at.y); await ctx.delay(600); await mark("dblclick 1");
  shots.push(await h.jpeg(ctx, "008-a-after-dbl1"));
  await rawPage.mouse.dblclick(at.x, at.y);
  const opened = await h.waitFor(async () => (await h.state(ctx)).editor, 1500);
  await mark("dblclick 2", { opened: !!opened });
  shots.push(await h.jpeg(ctx, "008-b-after-dbl2"));
  if (!opened) {
    // Is the editor blocked by something over the title?
    const hit = await rawPage.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName}.${String(e.className).slice(0, 60)} ${e.getAttribute("aria-label") ?? ""} ${[...e.attributes].map((a) => a.name).filter((n) => n.startsWith("data-")).join(",")}` : null; }, at);
    log.push({ hit });
    await rawPage.keyboard.press("Enter"); await ctx.delay(500); await mark("enter key");
  }
  if ((await h.state(ctx)).editor) { await rawPage.keyboard.press("Escape"); await ctx.delay(300); await mark("escape"); }
  return { log, shots };
};
