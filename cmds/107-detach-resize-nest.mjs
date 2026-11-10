const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// The owner's flow: a frame with a fill and a child; drag the child out to the
// canvas (it becomes a frame); resize that frame; draw and drop frames into it; move it.
export default async (ctx) => {
  const { rawPage } = ctx, out = { steps: [] };
  const fsp = await import("node:fs/promises"); const path = await import("node:path");
  const focus = () => rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  const toasts = () => rawPage.evaluate(() => [...document.querySelectorAll('[data-sonner-toast]:not([data-removed="true"])')].map((t) => t.textContent?.slice(0, 140)));
  const header = () => rawPage.evaluate(() => document.querySelector("[data-design-inspector-header]")?.textContent?.trim().slice(0, 40));
  const world = () => rawPage.evaluate((view) => [...document.querySelectorAll(`${view} [data-design-frame]`)].map((f) => ({ file: f.getAttribute("data-design-frame"), x: parseFloat(f.style.left), y: parseFloat(f.style.top), w: parseFloat(f.style.width), h: parseFloat(f.style.height) })), h.VIEW);
  const doc = async (file) => {
    const handle = await rawPage.locator(`${h.VIEW} [data-design-frame="${file}"] iframe[data-design-document-buffer="displayed"]`).first().elementHandle({ timeout: 3000 }).catch(() => null);
    const inner = handle ? await handle.contentFrame() : null;
    if (!inner) return ["no live document"];
    return inner.evaluate(() => {
      const d = (el, depth) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); const st = el.getAttribute("style") ?? ""; const pick = (p) => (st.match(new RegExp(`(?:^|;)\\\\s*${p}\\\\s*:\\\\s*([^;]+)`)) ?? [])[1]?.trim() ?? "-"; return `${"  ".repeat(depth)}${el.tagName.toLowerCase()}#${(el.getAttribute("data-oid") ?? "").slice(0, 14)}${el.hasAttribute("data-zeros-frame-root") ? "[root]" : ""} at ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} bg=${s.backgroundColor.replace(/ /g, "")} w=${pick("width")} h=${pick("height")} pos=${s.position}`; };
      const lines = [`viewport ${innerWidth}x${innerHeight}`];
      const walk = (el, depth) => { for (const c of el.children) { if (["SCRIPT", "STYLE"].includes(c.tagName)) continue; lines.push(d(c, depth)); if (depth < 3) walk(c, depth + 1); } };
      walk(document.body, 0);
      return lines;
    }).catch((e) => [String(e).slice(0, 120)]);
  };
  const step = async (label, files = []) => { const s = await h.state(ctx); const docs = {}; for (const f of files) docs[f.split("/")[1]] = await doc(f); out.steps.push({ label, frames: (await world()).filter((f) => !/card|hero|list/.test(f.file)).map((f) => `${f.file.split("/")[1]}@${f.x},${f.y} ${f.w}x${f.h}`), header: await header(), selected: s.selectedLayers.map((id) => id.slice(0, 14)), docs, toasts: await toasts() }); };
  const shot = (name) => rawPage.screenshot({ path: `${ctx.outbox}/107-${name}.jpg`, type: "jpeg", quality: 55, clip: { x: 641, y: 100, width: 520, height: 760 } });
  const newFrame = async (before) => (await world()).find((f) => !before.some((b) => b.file === f.file));
  const draw = async (x, y, dx, dy) => { await focus(); await rawPage.keyboard.press("f"); await ctx.delay(200); await rawPage.mouse.move(x, y); await rawPage.mouse.down(); for (let i = 1; i <= 8; i++) { await rawPage.mouse.move(x + dx * i / 8, y + dy * i / 8); await ctx.delay(16); } await rawPage.mouse.up(); await ctx.delay(2200); };
  const dragFrom = async (x, y, dx, dy, steps = 14) => { await rawPage.mouse.move(x - 4, y - 4); await ctx.delay(60); await rawPage.mouse.move(x, y); await ctx.delay(100); await rawPage.mouse.down(); for (let i = 1; i <= steps; i++) { await rawPage.mouse.move(x + dx * i / steps, y + dy * i / steps); await ctx.delay(22); } await ctx.delay(250); await rawPage.mouse.up(); await ctx.delay(2200); };
  const setFill = async (hex) => { const fill = rawPage.getByLabel("Fill", { exact: true }).first(); if (await fill.isVisible().catch(() => false)) { await fill.click(); await fill.fill(hex); await fill.press("Enter"); await ctx.delay(1300); return true; } return false; };
  // Work on the left half of the canvas, away from the floating panels.
  await focus(); await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Shift+1"); await ctx.delay(1000);
  const e = await h.emptyPoint(ctx);
  const ox = Math.min(e.x, 700), oy = 560;
  // 1. Frame A with a fill.
  let before = await world();
  await draw(ox, oy, 200, 130);
  const a = await newFrame(before); if (!a) throw new Error("frame A not created");
  out.a = a.file; out.fillA = await setFill("8F5454");
  // 2. Child B inside A, with its own fill.
  let ga = await h.frameGeometry(ctx, a.file);
  await draw(ga.x + ga.width * 0.15, ga.y + ga.height * 0.2, ga.width * 0.4, ga.height * 0.45);
  out.fillB = await setFill("B47575");
  await step("A with child B", [a.file]);
  // 3. Drag B out of A onto empty canvas below.
  const child = await h.state(ctx);
  ga = await h.frameGeometry(ctx, a.file);
  before = await world();
  await dragFrom(ga.x + ga.width * 0.3, ga.y + ga.height * 0.4, 20, ga.height + 90);
  const c = await newFrame(before);
  out.c = c?.file ?? null;
  await step("dragged B out", [a.file, ...(c ? [c.file] : [])]); await shot("a-detached");
  if (!c) return out;
  // 4. Resize the detached frame from its bottom-right corner, bigger then smaller.
  const corner = async (dx, dy) => { const g = await h.frameGeometry(ctx, c.file); await dragFrom(g.x + g.width, g.y + g.height, dx, dy, 10); };
  await rawPage.locator(`${h.VIEW} [data-design-frame="${c.file}"] [data-design-frame-label]`).click().catch(() => {}); await ctx.delay(500);
  await corner(70, 50);
  await step("resized bigger", [c.file]); await shot("b-bigger");
  await corner(-40, -30);
  await step("resized smaller", [c.file]); await shot("c-smaller");
  await focus(); await rawPage.keyboard.press("Meta+z"); await ctx.delay(1500);
  await step("undo last resize", [c.file]);
  // 5. Draw a frame inside it.
  let gc = await h.frameGeometry(ctx, c.file);
  await draw(gc.x + gc.width * 0.55, gc.y + gc.height * 0.5, gc.width * 0.3, gc.height * 0.3);
  await step("drew inside the detached frame", [c.file]); await shot("d-drew-inside");
  // 6. Move the detached frame by its label; its contents come along.
  const lb = await rawPage.locator(`${h.VIEW} [data-design-frame="${c.file}"] [data-design-frame-label]`).boundingBox();
  if (lb) await dragFrom(lb.x + Math.min(8, lb.width / 2), lb.y + lb.height / 2, 60, 40);
  await step("moved the detached frame", [c.file]);
  // 7. Drag frame A onto the detached frame: it nests.
  const la = await rawPage.locator(`${h.VIEW} [data-design-frame="${a.file}"] [data-design-frame-label]`).boundingBox();
  gc = await h.frameGeometry(ctx, c.file);
  if (la) await dragFrom(la.x + Math.min(8, la.width / 2), la.y + la.height / 2, gc.x + gc.width * 0.3 - la.x, gc.y + gc.height * 0.7 - la.y, 20);
  await step("dropped frame A onto it", [c.file]); await shot("e-nested");
  // 8. A frame saved before this fix: its root has pixel sizes and is behind its frame.
  before = await world();
  await draw(ox + 30, 300, 120, 70);
  const l = await newFrame(before);
  if (l) {
    out.legacy = l.file;
    const file = path.join(ctx.design, l.file);
    const source = await fsp.readFile(file, "utf8");
    await fsp.writeFile(file, source.replace("width:100%; height:100vh;", "width:60px; height:30px; margin:0;").replace("background-color:#ffffff", "background-color:#8F5454"));
    await ctx.delay(3000);
    await rawPage.locator(`${h.VIEW} [data-design-frame="${l.file}"] [data-design-frame-label]`).click().catch(() => {}); await ctx.delay(900);
    await step("legacy frame: root behind its frame", [l.file]); await shot("f-legacy");
    const g = await h.frameGeometry(ctx, l.file);
    await dragFrom(g.x + g.width, g.y + g.height, 30, 24, 10);
    await step("legacy frame resized", [l.file]); await shot("g-legacy-resized");
  }
  return out;
};
