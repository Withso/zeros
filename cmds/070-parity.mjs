const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Verify three Figma-parity behaviors: Escape keeps typed text, Shift+A adds
// auto layout (Shift+M opens motion), and X/Y follow a frame while dragged.
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const card = "page-1/card.html", hero = "page-1/hero.html";
  const focus = () => rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  const pick = async (name) => { await rawPage.locator("[data-design-sidebar-panel]").getByText(name, { exact: true }).first().click(); await ctx.delay(500); };
  // 1. Escape keeps typed text.
  await pick("Card"); await focus(); await rawPage.keyboard.press("Shift+2"); await ctx.delay(900);
  await h.waitFor(() => rawPage.locator(h.live(card)).count(), 4000);
  for (let i = 0; i < 5 && !(await h.state(ctx)).editor; i++) {
    const p = await h.hitPoint(ctx, card, '[data-oid="card-title"]');
    if ((await h.state(ctx)).selectedLayers[0] === "card-title") await rawPage.keyboard.press("Enter"); else await rawPage.mouse.dblclick(p.x, p.y);
    await ctx.delay(350);
  }
  await rawPage.keyboard.press("End"); await rawPage.keyboard.type(" plans", { delay: 40 });
  await rawPage.keyboard.press("Escape"); await ctx.delay(1500);
  out.escape = { text: await rawPage.frameLocator(h.live(card)).locator('[data-oid="card-title"]').textContent().catch(String), state: await h.state(ctx) };
  // Undo works straight after (focus returned to the canvas).
  await rawPage.keyboard.press("Meta+z"); await ctx.delay(1200);
  out.escapeUndo = await rawPage.frameLocator(h.live(card)).locator('[data-oid="card-title"]').textContent().catch(String);
  // 2. Shift+A on Hero (absolute layout, no auto layout).
  await pick("Hero"); await focus(); await rawPage.keyboard.press("Shift+2"); await ctx.delay(900);
  await h.waitFor(() => rawPage.locator(h.live(hero)).count(), 4000);
  const heroRoot = () => rawPage.frameLocator(h.live(hero)).locator("body > *").first().evaluate((el) => { const s = getComputedStyle(el); return { oid: el.getAttribute("data-oid"), display: s.display, direction: s.flexDirection, kids: el.children.length }; }).catch(String);
  out.heroBefore = await heroRoot();
  await rawPage.keyboard.press("Shift+A"); await ctx.delay(1500);
  out.heroAfter = await heroRoot();
  out.motionAfterShiftA = await rawPage.locator(`${h.VIEW} [data-design-motion-timeline]`).isVisible().catch(() => false);
  await rawPage.keyboard.press("Shift+A"); await ctx.delay(1000);
  out.heroAfterSecond = await heroRoot();
  await rawPage.keyboard.press("Meta+z"); await ctx.delay(1200);
  out.heroUndo = await heroRoot();
  await focus(); await rawPage.keyboard.press("Shift+M"); await ctx.delay(700);
  out.motionAfterShiftM = await rawPage.locator(`${h.VIEW} [data-design-motion-timeline]`).isVisible().catch(() => false);
  await rawPage.keyboard.press("Shift+M"); await ctx.delay(500);
  out.motionClosed = !(await rawPage.locator(`${h.VIEW} [data-design-motion-timeline]`).isVisible().catch(() => false));
  // 3. Live X/Y while dragging Hero by its label.
  await focus(); await rawPage.keyboard.press("Meta+Minus"); await ctx.delay(700);
  const lb = await rawPage.locator(`${h.VIEW} [data-design-frame="${hero}"] [data-design-frame-label]`).boundingBox();
  const xy = () => rawPage.evaluate(() => ["X", "Y"].map((l) => document.querySelector(`[data-design-inspector] input[aria-label="${l}"], input[aria-label="${l}"]`)?.value ?? null));
  out.xyBefore = await xy();
  const sx = lb.x + Math.min(10, lb.width / 2), sy = lb.y + lb.height / 2;
  await rawPage.mouse.move(sx, sy); await rawPage.mouse.down();
  const samples = [];
  for (let i = 1; i <= 12; i++) { await rawPage.mouse.move(sx + i * 6, sy + i * 12); await ctx.delay(60); samples.push((await xy()).join(",")); }
  await rawPage.mouse.up(); await ctx.delay(1500);
  out.xySamples = samples; out.xyAfter = await xy();
  await focus(); await rawPage.keyboard.press("Meta+z"); await ctx.delay(1200);
  out.xyUndo = await xy();
  return out;
};
