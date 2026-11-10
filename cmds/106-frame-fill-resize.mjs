const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// The owner's report: draw a frame, give it a fill, resize it, draw a frame inside it.
export default async (ctx) => {
  const { rawPage } = ctx, out = { steps: [] };
  const focus = () => rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  const toasts = () => rawPage.evaluate(() => [...document.querySelectorAll('[data-sonner-toast]:not([data-removed="true"])')].map((t) => t.textContent?.slice(0, 140)));
  const header = () => rawPage.evaluate(() => document.querySelector("[data-design-inspector-header]")?.textContent?.trim().slice(0, 40));
  const world = () => rawPage.evaluate((view) => [...document.querySelectorAll(`${view} [data-design-frame]`)].map((f) => ({ file: f.getAttribute("data-design-frame").split("/")[1], x: parseFloat(f.style.left), y: parseFloat(f.style.top), w: parseFloat(f.style.width), h: parseFloat(f.style.height) })), h.VIEW);
  const doc = async (file) => {
    const handle = await rawPage.locator(`${h.VIEW} [data-design-frame="${file}"] iframe[data-design-document-buffer="displayed"]`).first().elementHandle({ timeout: 2500 }).catch(() => null);
    const inner = handle ? await handle.contentFrame() : null;
    if (!inner) return "no live document";
    return inner.evaluate(() => {
      const d = (el, depth) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return `${"  ".repeat(depth)}${el.tagName.toLowerCase()}#${el.getAttribute("data-oid") ?? ""}${el.hasAttribute("data-zeros-frame-root") ? "[root]" : ""} ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} pos=${s.position} disp=${s.display} bg=${s.backgroundColor.replace(/ /g, "")} style="${(el.getAttribute("style") ?? "").slice(0, 160)}"`; };
      const lines = [`viewport ${innerWidth}x${innerHeight}`, d(document.body, 0)];
      const walk = (el, depth) => { for (const c of el.children) { if (["SCRIPT", "STYLE"].includes(c.tagName)) continue; lines.push(d(c, depth)); if (depth < 3) walk(c, depth + 1); } };
      walk(document.body, 1);
      return lines;
    }).catch((e) => String(e).slice(0, 120));
  };
  const step = async (label, file) => { const s = await h.state(ctx); out.steps.push({ label, world: await world(), header: await header(), selected: s.selectedLayers, doc: file ? await doc(file) : undefined, toasts: await toasts() }); };
  const shot = (name) => rawPage.screenshot({ path: `${ctx.outbox}/106-${name}.jpg`, type: "jpeg", quality: 55, clip: { x: 641, y: 100, width: 520, height: 760 } });
  await focus(); await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Shift+1"); await ctx.delay(1000);
  // 1. Draw a frame on empty canvas.
  const before = await world();
  await rawPage.keyboard.press("f"); await ctx.delay(200);
  const e = await h.emptyPoint(ctx);
  const sx = e.x + 30, sy = e.y - 260;
  await rawPage.mouse.move(sx, sy); await rawPage.mouse.down();
  for (let i = 1; i <= 8; i++) { await rawPage.mouse.move(sx + i * 12, sy + i * 8); await ctx.delay(16); }
  await rawPage.mouse.up(); await ctx.delay(2200);
  const created = (await world()).find((f) => !before.some((b) => b.file === f.file));
  if (!created) throw new Error("no frame created");
  const file = `page-1/${created.file}`;
  out.created = created;
  await focus(); await rawPage.keyboard.press("Shift+2"); await ctx.delay(1000);
  await step("drawn", file);
  // 2. Give it a fill.
  out.fillFields = await rawPage.evaluate(() => [...document.querySelectorAll('input[aria-label="Fill"], button[aria-label="Add fill"], button[aria-label^="Add Fill"], [data-design-inspector] button')].filter((el) => el.getBoundingClientRect().width > 0).map((el) => `${el.tagName}|${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 20)}|${el.value ?? ""}`).filter((t) => /fill/i.test(t)));
  const fill = rawPage.getByLabel("Fill", { exact: true }).first();
  if (await fill.isVisible().catch(() => false)) { await fill.click(); await fill.fill("8F5454"); await fill.press("Enter"); await ctx.delay(1300); }
  await step("filled", file); await shot("a-filled");
  // 3. Resize bigger from a corner.
  await rawPage.locator(`${h.VIEW} [data-design-frame="${file}"] [data-design-frame-label]`).click().catch(() => {}); await ctx.delay(500);
  out.handles = await rawPage.evaluate((view) => [...document.querySelectorAll(`${view} [aria-label^="Resize "]`)].map((n) => { const r = n.getBoundingClientRect(); return `${n.getAttribute("aria-label")}@${Math.round(r.x)},${Math.round(r.y)}`; }), h.VIEW);
  const dragHandle = async (dx, dy) => {
    const g = await h.frameGeometry(ctx, file);
    const x = g.x + g.width, y = g.y + g.height;
    await rawPage.mouse.move(x - 12, y - 12); await ctx.delay(60); await rawPage.mouse.move(x, y); await ctx.delay(120);
    out.cursorTarget = await rawPage.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return el ? `${el.tagName}|${el.getAttribute("aria-label") ?? el.className}`.slice(0, 120) : null; }, { x, y });
    await rawPage.mouse.down();
    for (let i = 1; i <= 10; i++) { await rawPage.mouse.move(x + dx * i / 10, y + dy * i / 10); await ctx.delay(25); }
    await rawPage.mouse.up(); await ctx.delay(1800);
  };
  await dragHandle(70, 110);
  await step("resized bigger", file); await shot("b-bigger");
  await dragHandle(-150, -160);
  await step("resized smaller", file); await shot("c-smaller");
  await dragHandle(120, 140);
  await step("resized bigger again", file); await shot("d-bigger-again");
  // 4. Draw a frame inside it.
  const g = await h.frameGeometry(ctx, file);
  await focus(); await rawPage.keyboard.press("f"); await ctx.delay(200);
  const ix = g.x + g.width * 0.35, iy = g.y + g.height * 0.3;
  await rawPage.mouse.move(ix, iy); await rawPage.mouse.down();
  for (let i = 1; i <= 8; i++) { await rawPage.mouse.move(ix + i * g.width * 0.06, iy + i * g.height * 0.06); await ctx.delay(16); }
  await rawPage.mouse.up(); await ctx.delay(2200);
  await step("drew inside", file); await shot("e-inside");
  return out;
};
