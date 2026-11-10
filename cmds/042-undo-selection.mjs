const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Which layer is selected after duplicate, undo and redo (Figma restores the
// selection that each history step had).
export default async (ctx) => {
  const { rawPage } = ctx, out = { steps: [] };
  const file = "page-1/card.html";
  const kids = () => rawPage.frameLocator(h.live(file)).locator('[data-oid="card-actions"]').evaluate((el) => [...el.children].map((c) => c.getAttribute("data-oid"))).catch((e) => String(e).slice(0, 80));
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = await h.hitPoint(ctx, file, '[data-oid="card-primary"]');
    await rawPage.mouse.dblclick(p.x, p.y); await ctx.delay(500);
    if ((await h.state(ctx)).selectedLayers.includes("card-primary")) break;
  }
  const record = async (label) => { const s = await h.state(ctx); out.steps.push({ label, selected: s.selectedLayers, inspector: s.inspector, header: await rawPage.evaluate(() => document.querySelector("[data-design-inspector-header]")?.textContent?.trim().slice(0, 60)), kids: await kids() }); };
  await record("start");
  await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  for (const key of ["Meta+d", "Meta+z", "Meta+Shift+z", "Meta+z"]) { await rawPage.keyboard.press(key); await ctx.delay(1000); await record(key); }
  return out;
};
