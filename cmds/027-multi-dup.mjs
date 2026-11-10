const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx;
  const file = "page-1/card.html";
  const kids = () => rawPage.frameLocator(h.live(file)).locator('[data-oid="card-actions"]').evaluate((el) => [...el.children].map((c) => c.getAttribute("data-oid")));
  await rawPage.locator('[data-design-sidebar-panel] [data-design-layer-id="card-primary"]').first().click();
  await rawPage.locator('[data-design-sidebar-panel] [data-design-layer-id="card-secondary"]').first().click({ modifiers: ["Shift"] });
  await ctx.delay(300);
  const selected = (await h.state(ctx)).selectedLayers;
  const before = await kids();
  await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  await rawPage.keyboard.press("Meta+d");
  const timeline = [];
  for (const ms of [100, 300, 700, 1500]) { await ctx.delay(ms - (timeline.at(-1)?.[0] ?? 0)); timeline.push([ms, (await h.state(ctx)).selectedLayers.map((id) => id.split("-copy-")[0] + (id.includes("-copy-") ? "+copy" : ""))]); }
  return { selected, before, after: (await kids()).map((id) => id.split("-copy-")[0] + (id.includes("-copy-") ? "+copy" : "")), timeline };
};
