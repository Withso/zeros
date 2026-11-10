const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Multi-select align on absolutely placed layers, rotation, and moving a turned layer.
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const hero = "page-1/hero.html";
  const focus = () => rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  const toasts = () => rawPage.evaluate(() => [...document.querySelectorAll('[data-sonner-toast]:not([data-removed="true"])')].map((t) => t.textContent?.slice(0, 120)));
  const inner = async () => { const handle = await rawPage.locator(`${h.VIEW} [data-design-frame="${hero}"] iframe[data-design-document-buffer="displayed"]`).first().elementHandle({ timeout: 4000 }).catch(() => null); return handle ? handle.contentFrame() : null; };
  const kids = async () => { const f = await inner(); return f ? f.evaluate(() => [...document.querySelector('[data-oid="hero-root"]').children].map((c) => { const r = c.getBoundingClientRect(); const s = c.getAttribute("style") ?? ""; return `${c.getAttribute("data-oid")}:${Math.round(r.x * 10) / 10},${Math.round(r.y * 10) / 10} ${Math.round(r.width)}x${Math.round(r.height)} [${(s.match(/(?:left|top|inset|transform|rotate)[^;]*/g) ?? []).join("; ")}]`; })).catch((e) => String(e).slice(0, 100)) : "no document"; };
  const point = async (oid, fx = 0.5, fy = 0.5) => { const f = await inner(); const r = await f.evaluate((oid) => { const b = document.querySelector(`[data-oid="${oid}"]`).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, oid); const g = await h.frameGeometry(ctx, hero); return [g.x + (r.x + r.w * fx) * g.zoom, g.y + (r.y + r.h * fy) * g.zoom]; };
  const sel = async () => (await h.state(ctx)).selectedLayers;
  const undo = async () => { await focus(); await rawPage.keyboard.press("Meta+z"); await ctx.delay(1500); };
  await focus(); await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Shift+1"); await ctx.delay(1000);
  await rawPage.locator(`${h.VIEW} [data-design-frame="${hero}"] [data-design-frame-label]`).click(); await ctx.delay(700);
  out.geometry = await h.frameGeometry(ctx, hero);
  out.before = await kids();
  // 1. Descend to the title, then Shift-click the other two.
  let p = await point("hero-title", 0.3, 0.5);
  await rawPage.mouse.dblclick(p[0], p[1]); await ctx.delay(900);
  if ((await sel())[0] !== "hero-title") { await rawPage.mouse.dblclick(p[0], p[1]); await ctx.delay(900); }
  out.afterDescend = await sel();
  for (const oid of ["hero-sub", "hero-badge"]) { p = await point(oid, 0.3, 0.5); await rawPage.keyboard.down("Shift"); await rawPage.mouse.click(p[0], p[1]); await rawPage.keyboard.up("Shift"); await ctx.delay(600); }
  out.multi = await sel();
  // Drag the three together: the right-pinned badge keeps its size.
  p = await point("hero-sub", 0.3, 0.5);
  await rawPage.mouse.move(p[0], p[1]); await ctx.delay(120); await rawPage.mouse.down();
  for (let i = 1; i <= 8; i++) { await rawPage.mouse.move(p[0] + i * 2.3, p[1] + i * 1.7); await ctx.delay(22); }
  await ctx.delay(200); await rawPage.mouse.up(); await ctx.delay(2000);
  out.groupDrag = { kids: await kids(), selected: (await sel()).length, toasts: await toasts() };
  await undo();
  out.groupDragUndo = await kids();
  // Nudge the badge alone with the arrow keys.
  await focus(); await rawPage.keyboard.press("Escape"); await ctx.delay(300);
  p = await point("hero-badge");
  await rawPage.mouse.dblclick(p[0], p[1]); await ctx.delay(900);
  if ((await sel())[0] !== "hero-badge") { await rawPage.mouse.dblclick(p[0], p[1]); await ctx.delay(900); }
  out.badgeSelected = await sel();
  await focus();
  for (const key of ["ArrowLeft", "ArrowLeft", "ArrowDown", "Shift+ArrowLeft"]) { await rawPage.keyboard.press(key); await ctx.delay(250); }
  await ctx.delay(1500);
  out.nudged = await kids();
  // X field: type a position for the right-pinned badge.
  const xField = rawPage.getByLabel("X", { exact: true }).first();
  if (await xField.isVisible().catch(() => false)) { out.xBefore = await xField.inputValue(); await xField.click(); await xField.fill("500"); await xField.press("Enter"); await ctx.delay(1400); out.xTyped = await kids(); }
  for (let i = 0; i < 6; i++) await undo();
  out.restored = await kids();
  return out;
};
