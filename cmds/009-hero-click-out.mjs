const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx, log = [], t0 = Date.now();
  const mark = async (label, extra = {}) => log.push({ t: Date.now() - t0, label, ...(await h.state(ctx)), ...extra });
  const file = "page-1/hero.html";
  // hero-title is selected from 008; open the editor with Enter.
  if ((await h.state(ctx)).selectedLayers[0] !== "hero-title") throw new Error("hero-title not selected");
  await rawPage.keyboard.press("Enter");
  await h.waitFor(async () => (await h.state(ctx)).editor, 1500);
  await rawPage.keyboard.press("End");
  await rawPage.keyboard.type(" now", { delay: 60 });
  await mark("typed");
  await h.focusCanvas(ctx);
  for (const wait of [150, 400, 1000, 2500]) { await ctx.delay(wait - (Date.now() - t0 - log.at(-1).t)); await mark(`+${wait}ms`); }
  const lingering = await rawPage.evaluate(() => [...document.querySelectorAll("[data-design-inline-text-editor]")].map((e) => ({ visibility: getComputedStyle(e).visibility, pointer: getComputedStyle(e).pointerEvents, text: e.textContent })));
  const saved = await rawPage.frameLocator(h.live(file)).locator('[data-oid="hero-title"]').evaluate((el) => ({ text: el.textContent, fill: getComputedStyle(el).webkitTextFillColor })).catch((e) => String(e));
  return { log, lingering, saved, shot: await h.jpeg(ctx, "009-after") };
};
