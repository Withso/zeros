const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Draw a frame with the Frame tool inside an auto-layout frame: does it nest
// (Figma) or land as a new top-level frame on top? Then switch the parent's
// auto layout Grid -> Horizontal and check leftover grid styles.
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const file = "page-1/card.html";
  const tools = await rawPage.evaluate((view) => [...document.querySelectorAll(`${view} [aria-label="Canvas tools"] button`)].map((b) => `${b.getAttribute("aria-label")}|${b.getAttribute("aria-keyshortcuts") ?? ""}|${b.title ?? ""}`), h.VIEW);
  out.tools = tools;
  const g = await h.frameGeometry(ctx, file);
  await rawPage.mouse.move(g.x + g.width * 0.97, g.y + g.height * 0.97); await ctx.delay(60);
  await rawPage.mouse.click(g.x + g.width * 0.97, g.y + g.height * 0.97); await ctx.delay(500);
  await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  await rawPage.keyboard.press("Shift+2"); await ctx.delay(900);
  const kids = () => rawPage.frameLocator(h.live(file)).locator('[data-oid="card-root"]').evaluate((el) => [...el.children].map((c) => `${c.getAttribute("data-oid")}:${c.tagName}`)).catch((e) => String(e).slice(0, 80));
  const frames = () => rawPage.evaluate((view) => [...document.querySelectorAll(`${view} [data-design-frame]`)].map((f) => f.getAttribute("data-design-frame")), h.VIEW);
  out.kidsBefore = await kids(); out.framesBefore = await frames();
  const frameTool = rawPage.locator(`${h.VIEW} [aria-label="Canvas tools"] button`).filter({ hasText: "" }).nth(1);
  await frameTool.click(); await ctx.delay(200);
  out.tool = (await h.state(ctx)).tool;
  const g2 = await h.frameGeometry(ctx, file);
  const sx = g2.x + g2.width * 0.2, sy = g2.y + g2.height * 0.7;
  await rawPage.mouse.move(sx, sy); await rawPage.mouse.down();
  for (let i = 1; i <= 10; i++) { await rawPage.mouse.move(sx + i * 12, sy + i * 6); await ctx.delay(16); }
  await rawPage.mouse.up(); await ctx.delay(1500);
  out.kidsAfter = await kids(); out.framesAfter = await frames();
  out.state = await h.state(ctx);
  await rawPage.screenshot({ path: `${ctx.outbox}/055-after.jpg`, type: "jpeg", quality: 50 });
  return out;
};
