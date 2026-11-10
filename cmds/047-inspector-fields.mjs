const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx;
  const file = "page-1/card.html";
  const g = await h.frameGeometry(ctx, file);
  await rawPage.mouse.move(g.x + g.width / 2, g.y + g.height * 0.95); await ctx.delay(60);
  await rawPage.mouse.click(g.x + g.width / 2, g.y + g.height * 0.95); await ctx.delay(800);
  const fields = await rawPage.evaluate(() => [...document.querySelectorAll("[data-design-inspector] input, [data-design-inspector] button[aria-label], [data-design-floating-panel] input")]
    .filter((el) => el.getBoundingClientRect().width > 0)
    .map((el) => `${el.tagName}|${el.getAttribute("aria-label") ?? ""}|${el.getAttribute("type") ?? ""}|${(el.value ?? "").slice(0, 20)}|${Math.round(el.getBoundingClientRect().x)},${Math.round(el.getBoundingClientRect().y)}`));
  return { state: await h.state(ctx), fields: fields.slice(0, 80) };
};
