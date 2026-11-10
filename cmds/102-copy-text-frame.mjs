const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const card = "page-1/card.html";
  const focus = () => rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  const header = () => rawPage.evaluate(() => document.querySelector("[data-design-inspector-header]")?.textContent?.trim().slice(0, 40));
  const toasts = () => rawPage.evaluate(() => [...document.querySelectorAll('[data-sonner-toast]:not([data-removed="true"])')].map((t) => t.textContent?.slice(0, 100)));
  const world = () => rawPage.evaluate((view) => [...document.querySelectorAll(`${view} [data-design-frame]`)].map((f) => `${f.getAttribute("data-design-frame").split("/")[1]}@${parseFloat(f.style.left)},${parseFloat(f.style.top)},${parseFloat(f.style.width)}x${parseFloat(f.style.height)}`), h.VIEW);
  const kids = () => rawPage.frameLocator(h.live(card)).locator('[data-oid="card-actions"]').evaluate((el) => [...el.children].map((c) => (c.getAttribute("data-oid") ?? "").replace(/-copy-.*/, "+copy"))).catch((e) => String(e).slice(0, 80));
  // A. Cmd+C on a selected layer copies it; no "Path copied".
  await rawPage.locator("[data-design-sidebar-panel]").getByText("Card", { exact: true }).first().click(); await ctx.delay(500);
  await focus(); await rawPage.keyboard.press("Shift+2"); await ctx.delay(900);
  await h.waitFor(() => rawPage.locator(h.live(card)).count(), 4000);
  for (let i = 0; i < 3; i++) { const p = await h.hitPoint(ctx, card, '[data-oid="card-secondary"]'); await rawPage.mouse.dblclick(p.x, p.y); await ctx.delay(500); if ((await h.state(ctx)).selectedLayers.includes("card-secondary")) break; }
  await focus(); await rawPage.keyboard.press("Meta+c"); await ctx.delay(1400);
  out.layerCopy = { kids: await kids(), selected: (await h.state(ctx)).selectedLayers.map((id) => id.replace(/-copy-.*/, "+copy")), toasts: await toasts() };
  await rawPage.keyboard.press("Meta+z"); await ctx.delay(1300);
  out.layerCopyUndo = { kids: await kids() };
  // B. Cmd+C on a selected frame copies the frame.
  await rawPage.locator("[data-design-sidebar-panel]").getByText("List", { exact: true }).first().click(); await ctx.delay(500);
  const before = await world();
  await focus(); await rawPage.keyboard.press("Meta+c"); await ctx.delay(1800);
  const after = await world();
  out.frameCopy = { added: after.filter((f) => !before.includes(f)), header: await header(), toasts: await toasts() };
  await rawPage.keyboard.press("Meta+z"); await ctx.delay(1500);
  // C. With nothing selected, Cmd+C still copies the workspace path.
  await focus(); await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Escape"); await ctx.delay(300);
  await ctx.delay(4500);
  await rawPage.keyboard.press("Meta+c"); await ctx.delay(500);
  out.nothingSelected = { header: await header(), toasts: await toasts() };
  // D. Text tool and Frame tool land on whole pixels at a fractional zoom.
  await focus(); await rawPage.keyboard.press("Shift+1"); await ctx.delay(900);
  await rawPage.mouse.move(900, 450); await rawPage.keyboard.down("Control"); await rawPage.mouse.wheel(0, 130); await rawPage.keyboard.up("Control"); await ctx.delay(900);
  out.zoom = await rawPage.evaluate((view) => new DOMMatrixReadOnly(getComputedStyle(document.querySelector(`${view} [data-design-canvas-world]`)).transform).a, h.VIEW);
  const w0 = await world();
  await focus(); await rawPage.keyboard.press("t"); await ctx.delay(200);
  const empty = await h.emptyPoint(ctx);
  await rawPage.mouse.click(empty.x + 3.3, empty.y - 61.7); await ctx.delay(500);
  await rawPage.keyboard.type("Whole pixels", { delay: 25 });
  await rawPage.keyboard.press("Escape"); await ctx.delay(2000);
  const w1 = await world();
  out.text = w1.filter((f) => !w0.includes(f));
  await focus(); await rawPage.keyboard.press("f"); await ctx.delay(200);
  const e2 = await h.emptyPoint(ctx);
  await rawPage.mouse.move(e2.x + 40.4, e2.y - 150.6); await rawPage.mouse.down();
  for (let i = 1; i <= 8; i++) { await rawPage.mouse.move(e2.x + 40.4 + i * 9.3, e2.y - 150.6 + i * 6.1); await ctx.delay(16); }
  await rawPage.mouse.up(); await ctx.delay(2000);
  const w2 = await world();
  out.frame = w2.filter((f) => !w1.includes(f)); out.frameHeader = await header();
  return out;
};
