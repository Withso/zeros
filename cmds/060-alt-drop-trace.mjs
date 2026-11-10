const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Alt+drag a frame by its label at a zoom where the label is full size: the
// original stays, a copy lands at the release point, nothing flashes.
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const file = "page-1/hero.html";
  const world = () => rawPage.evaluate((view) => [...document.querySelectorAll(`${view} [data-design-frame]`)].map((f) => ({ file: f.getAttribute("data-design-frame"), x: parseFloat(f.style.left), y: parseFloat(f.style.top), w: parseFloat(f.style.width), h: parseFloat(f.style.height) })), h.VIEW);
  // Select Hero and zoom to it, so its label is a full-size hit target.
  // Select Hero from its Layers row (never under a panel), then zoom to it.
  await rawPage.locator("[data-design-sidebar-panel] [role='treeitem'], [data-design-sidebar-panel] [data-design-layer-row]").filter({ hasText: /^Hero$/ }).first().click().catch(async () => {
    await rawPage.locator("[data-design-sidebar-panel]").getByText("Hero", { exact: true }).first().click();
  });
  await ctx.delay(500);
  out.selected = await rawPage.evaluate(() => document.querySelector("[data-design-inspector-header]")?.textContent?.trim().slice(0, 40));
  await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  await rawPage.keyboard.press("Shift+2"); await ctx.delay(700);
  await rawPage.keyboard.press("Meta+Minus"); await ctx.delay(700);
  const lb = await rawPage.locator(`${h.VIEW} [data-design-frame="${file}"] [data-design-frame-label]`).boundingBox();
  out.label = lb;
  if (!lb || lb.width < 8) throw new Error(`label too small: ${JSON.stringify(lb)}`);
  out.labelHit = await rawPage.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return !!e?.closest("[data-design-frame-label]"); }, { x: lb.x + Math.min(10, lb.width / 2), y: lb.y + lb.height / 2 });
  if (!out.labelHit) throw new Error(`label is covered at ${JSON.stringify(lb)}`);
  const before = await world();
  const g2 = await h.frameGeometry(ctx, file);
  const sx = lb.x + Math.min(10, lb.width / 2), sy = lb.y + lb.height / 2;
  const dy = Math.round(g2.height + 60);
  await rawPage.evaluate(({ view, file }) => {
    const store = globalThis.__ad = { log: [], last: "", ids: new WeakMap(), next: 1 };
    const id = (el) => { if (!store.ids.has(el)) store.ids.set(el, store.next++); return store.ids.get(el); };
    const st = (el) => { const s = getComputedStyle(el); return `${s.display === "none" ? "N" : ""}${s.visibility === "hidden" ? "h" : "v"}`; };
    const sig = () => {
      const frame = document.querySelector(`${view} [data-design-frame="${CSS.escape(file)}"]`);
      if (!frame) return "absent";
      const kids = [...frame.querySelectorAll("img[data-design-source-vector], span[data-design-source-surface], iframe, [data-design-frame-pixel-cover]")].map((el) => {
        const tag = el.tagName === "IFRAME" ? (el.hasAttribute("data-design-document-buffer") ? "D" + id(el) + el.getAttribute("data-design-document-buffer")[0] + (el.hasAttribute("data-design-document-ready") ? "r" : "-") + (el.hasAttribute("data-design-document-presented") ? "p" : "") : "S" + id(el) + (el.hasAttribute("data-design-source-ready") ? "r" : "-")) : el.tagName === "IMG" ? "V" + id(el) : el.tagName === "SPAN" ? "A" : "P";
        return tag + st(el);
      }).join(",");
      const prep = /Preparing/.test(frame.textContent ?? "") ? " PREP" : "";
      return `F${id(frame)} ${st(frame)} ${frame.hasAttribute("data-design-frame-tiled") ? "TILED " : ""}[${kids}]${prep}`;
    };
    const tick = () => { const s = sig(); if (s !== store.last) { store.log.push([performance.timeOrigin + performance.now(), s]); store.last = s; } if (store.log.length < 300 && !store.stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }, { view: h.VIEW, file });
  const frames = [];
  const onFrame = async ({ data, sessionId, metadata }) => { frames.push({ data, at: metadata.timestamp * 1000 }); await ctx.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {}); };
  ctx.cdp.on("Page.screencastFrame", onFrame);
  await ctx.cdp.send("Page.startScreencast", { format: "jpeg", quality: 60 });
  const t0 = await rawPage.evaluate(() => performance.timeOrigin + performance.now());
  await rawPage.keyboard.down("Alt");
  const cast = await ctx.screencast("060-alt-unused", async () => {
    await rawPage.mouse.move(sx, sy); await rawPage.mouse.down();
    for (let i = 1; i <= 15; i++) { await rawPage.mouse.move(sx, sy + dy * i / 15); await ctx.delay(16); }
    await ctx.delay(80);
    out.duringDrag = await world();
    out.upAt = Math.round(await rawPage.evaluate(() => performance.timeOrigin + performance.now()) - t0);
    await rawPage.mouse.up(); await ctx.delay(1500);
  }, { max: 1 });
  await rawPage.keyboard.up("Alt");
  await ctx.cdp.send("Page.stopScreencast").catch(() => {}); ctx.cdp.off("Page.screencastFrame", onFrame);
  const log = await rawPage.evaluate(() => { globalThis.__ad.stop = true; return globalThis.__ad.log; });
  const clip = { x: g2.x + 4, y: g2.y + 4, width: g2.width - 8, height: g2.height - 8 };
  const lum = await rawPage.evaluate(async ({ frames, clip }) => {
    const small = new OffscreenCanvas(32, 32), g = small.getContext("2d", { willReadFrequently: true }); const res = [];
    for (const f of frames) {
      const raw = atob(f.data), bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const bm = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" })); const scale = bm.width / innerWidth;
      g.drawImage(bm, clip.x * scale, clip.y * scale, clip.width * scale, clip.height * scale, 0, 0, 32, 32); bm.close();
      const p = g.getImageData(0, 0, 32, 32).data; let s = 0; for (let i = 0; i < p.length; i += 4) s += p[i] + p[i + 1] + p[i + 2]; res.push(Math.round(s / (p.length / 4) / 3));
    }
    return res;
  }, { frames, clip });
  out.timeline = [...frames.map((f, i) => [Math.round(f.at - t0), `FRAME lum=${lum[i]}`]), ...log.map(([t, s]) => [Math.round(t - t0), `DOM ${s}`])].sort((a, b) => a[0] - b[0]);
  const after = await world();
  out.added = after.filter((f) => !before.some((b) => b.file === f.file));
  out.originalBefore = before.find((f) => f.file === file); out.originalAfter = after.find((f) => f.file === file);
  out.expectedY = Math.round(out.originalBefore.y + dy / g2.zoom);
  out.state = await h.state(ctx);
  out.header = await rawPage.evaluate(() => document.querySelector("[data-design-inspector-header]")?.textContent?.trim().slice(0, 40));

  return out;
};
