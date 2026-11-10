const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const card = "page-1/card.html";
  const focus = () => rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  const header = () => rawPage.evaluate(() => document.querySelector("[data-design-inspector-header]")?.textContent?.trim().slice(0, 40));
  const toasts = () => rawPage.evaluate(() => [...document.querySelectorAll('[data-sonner-toast]:not([data-removed="true"])')].map((t) => t.textContent?.slice(0, 140)));
  const world = () => rawPage.evaluate((view) => [...document.querySelectorAll(`${view} [data-design-frame]`)].map((f) => `${f.getAttribute("data-design-frame").split("/")[1]}@${parseFloat(f.style.left)},${parseFloat(f.style.top)}`), h.VIEW);
  const kids = () => rawPage.frameLocator(h.live(card)).locator('[data-oid="card-actions"]').evaluate((el) => [...el.children].map((c) => (c.getAttribute("data-oid") ?? "").replace(/-copy-.*/, "+copy").replace(/^(?!card-).*/, "new"))).catch((e) => String(e).slice(0, 80));
  const short = (ids) => ids.map((id) => id.replace(/-copy-.*/, "+copy"));
  const step = async (label, fn, wait = 1200) => { await fn(); await ctx.delay(wait); const s = await h.state(ctx); return { label, kids: await kids(), selected: short(s.selectedLayers), header: await header(), toasts: await toasts() }; };
  // A. Layer copy, paste, delete, undo.
  await rawPage.locator("[data-design-sidebar-panel]").getByText("Card", { exact: true }).first().click(); await ctx.delay(500);
  await focus(); await rawPage.keyboard.press("Shift+2"); await ctx.delay(900);
  await h.waitFor(() => rawPage.locator(h.live(card)).count(), 4000);
  for (let i = 0; i < 3; i++) { const p = await h.hitPoint(ctx, card, '[data-oid="card-secondary"]'); await rawPage.mouse.dblclick(p.x, p.y); await ctx.delay(500); if ((await h.state(ctx)).selectedLayers.includes("card-secondary")) break; }
  await focus();
  out.layer = [];
  out.layer.push(await step("selected", async () => {}, 100));
  out.layer.push(await step("Cmd+C then Cmd+V", async () => { await rawPage.keyboard.press("Meta+c"); await ctx.delay(300); await rawPage.keyboard.press("Meta+v"); }));
  out.layer.push(await step("Backspace", async () => { await rawPage.keyboard.press("Backspace"); }));
  out.layer.push(await step("Cmd+Z", async () => { await rawPage.keyboard.press("Meta+z"); }));
  out.layer.push(await step("Cmd+Z again", async () => { await rawPage.keyboard.press("Meta+z"); }));
  // B. Frame copy and paste.
  out.framesBefore = await world();
  await rawPage.locator("[data-design-sidebar-panel]").getByText("List", { exact: true }).first().click(); await ctx.delay(500);
  await focus(); await rawPage.keyboard.press("Meta+c"); await ctx.delay(300); await rawPage.keyboard.press("Meta+v"); await ctx.delay(1800);
  out.framesAfterPaste = await world(); out.pasteHeader = await header(); out.pasteToasts = await toasts();
  await rawPage.keyboard.press("Meta+z"); await ctx.delay(1500);
  out.framesAfterUndo = await world();
  // C. Rename a frame from its label.
  await focus(); await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Shift+1"); await ctx.delay(1000);
  const lb = await rawPage.locator(`${h.VIEW} [data-design-frame="page-1/hero.html"] [data-design-frame-label]`).boundingBox();
  await rawPage.mouse.dblclick(lb.x + Math.min(8, lb.width / 2), lb.y + lb.height / 2); await ctx.delay(500);
  const rename = rawPage.locator(`${h.VIEW} input[aria-label^="Rename"]`).first();
  out.renameInput = await rename.isVisible().catch(() => false);
  if (out.renameInput) { await rename.fill("Landing hero"); await rename.press("Enter"); await ctx.delay(1500); }
  out.renamed = await rawPage.evaluate((view) => [...document.querySelectorAll(`${view} [data-design-frame-name]`)].map((n) => n.textContent), h.VIEW);
  out.layersHasName = await rawPage.locator("[data-design-sidebar-panel]").getByText("Landing hero", { exact: true }).count();
  await focus(); await rawPage.keyboard.press("Meta+z"); await ctx.delay(1500);
  out.renameUndo = await rawPage.evaluate((view) => [...document.querySelectorAll(`${view} [data-design-frame-name]`)].map((n) => n.textContent), h.VIEW);
  // D. Text tool: click empty canvas, type, click out.
  const before = await world();
  await focus(); await rawPage.keyboard.press("t"); await ctx.delay(200);
  out.tool = (await h.state(ctx)).tool;
  const empty = await h.emptyPoint(ctx);
  await rawPage.mouse.click(empty.x, empty.y - 60); await ctx.delay(500);
  out.textEditor = await rawPage.locator('[aria-label="New canvas text"]').isVisible().catch(() => false);
  await rawPage.keyboard.type("Hello canvas", { delay: 30 }); await ctx.delay(200);
  const empty2 = await h.emptyPoint(ctx);
  await rawPage.mouse.click(empty2.x + 200, empty2.y); await ctx.delay(2000);
  const after = await world();
  out.textFrames = after.filter((f) => !before.includes(f)); out.textState = await h.state(ctx); out.textToasts = await toasts();
  await rawPage.screenshot({ path: `${ctx.outbox}/076-after.jpg`, type: "jpeg", quality: 50 });
  return out;
};
