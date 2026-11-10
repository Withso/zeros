const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx;
  const errors = [];
  const onError = (error) => errors.push({ message: String(error.message).slice(0, 200), stack: String(error.stack).slice(0, 1500) });
  rawPage.on("pageerror", onError);
  const frames = () => rawPage.frames().map((f) => f.url().slice(0, 140));
  // Make Hero live (a document load), then List.
  for (const file of ["page-1/hero.html", "page-1/list.html"]) {
    await rawPage.locator(`[data-design-sidebar-panel] [data-design-layer-id]`).filter({ hasText: file.includes("hero") ? "Hero" : "List" }).first().click().catch(() => {});
    await ctx.delay(1200);
  }
  rawPage.off("pageerror", onError);
  return { errors, frames: frames() };
};
