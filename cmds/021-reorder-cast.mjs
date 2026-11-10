const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx;
  const file = "page-1/card.html";
  const kids = () => rawPage.frameLocator(h.live(file)).locator('[data-oid="card-tiles"]').evaluate((el) => [...el.children].map((c) => c.getAttribute("data-oid")));
  const order = await kids();
  const last = order.at(-1), first = order[0];
  await rawPage.locator(`[data-design-sidebar-panel] [data-design-layer-id="${last}"]`).first().click();
  await ctx.delay(300);
  const from = h.center(await h.box(ctx, file, `[data-oid="${last}"]`));
  const to = await h.box(ctx, file, `[data-oid="${first}"]`);
  const row = await h.box(ctx, file, '[data-oid="card-tiles"]');
  const events = [];
  const sample = async (label) => events.push([label, await rawPage.evaluate(() => {
    const el = document.querySelector("[data-design-drag-presentation], [data-design-drop-indicator], [data-design-insertion]");
    return { cursor: getComputedStyle(document.body).cursor, drag: !!document.querySelector("[data-design-drag-presentation]"),
      attrs: [...document.querySelectorAll("[data-design-layout-drop], [data-design-insertion-marker], [data-design-drag-target]")].length, el: el?.getAttribute("class")?.slice(0, 60) ?? null };
  })]);
  const cast = await ctx.screencast("021-drag", async () => {
    await rawPage.mouse.move(from.x, from.y); await rawPage.mouse.down();
    for (let i = 1; i <= 16; i++) { await rawPage.mouse.move(from.x + (to.x + 6 - from.x) * i / 16, from.y + (to.y + to.height / 2 - from.y) * i / 16); await ctx.delay(20); if (i === 8 || i === 16) await sample(`move ${i}`); }
    await ctx.delay(200); await sample("before up");
    await rawPage.mouse.up(); await ctx.delay(800); await sample("after up");
  }, { max: 60 });
  const clip = { x: Math.max(641, row.x - 20), y: Math.max(80, row.y - 60), width: Math.min(560, row.width + 40), height: Math.min(300, row.height + 120) };
  const sheet = await h.sheet(ctx, "021-drag-sheet", cast.frames, { clip, columns: 6, width: 220 });
  return { order, after: await kids(), events, sheet: sheet.sheet, diffs: sheet.diffs, state: await h.state(ctx) };
};
