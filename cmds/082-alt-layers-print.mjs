const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Alt+drag a frame by its label at a zoom where the label is full size: the
// original stays, a copy lands at the release point, nothing flashes.
export default async (ctx) => {
  const runs = [];
  for (let trial = 0; trial < 2; trial++) {
    const out = {};
    const { rawPage } = ctx;
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
    // A different zoom tier each trial: the passive handoff then needs tiles
    // at a density it has not drawn yet.
    for (let step = 0; step < [1, 2, 1, 3, 2, 1, 1, 2][trial]; step++) { await rawPage.keyboard.press("Meta+Minus"); await ctx.delay(350); }
    await ctx.delay(400);
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
      const frame0 = document.querySelector(`${view} [data-design-frame="${CSS.escape(file)}"]`);
      const describe = (el) => {
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        let tag = el.tagName.toLowerCase();
        for (const a of el.attributes) if (a.name.startsWith("data-design-") && !["data-design-source-version", "data-design-document-source-version", "data-design-tile-key"].includes(a.name)) tag += `[${a.name.slice(12)}${a.value ? "=" + a.value.slice(0, 12) : ""}]`;
        if (el.tagName === "IMG") tag += `{${el.complete ? "c" : "-"}${el.naturalWidth}x${el.naturalHeight},src${(el.currentSrc || el.src).length}}`;
        return `${tag}#${id(el)} ${s.visibility === "hidden" ? "H" : "V"}${s.display === "none" ? "N" : ""} op${s.opacity} bg=${s.backgroundColor.replace(/ /g, "")} ${Math.round(r.width)}x${Math.round(r.height)}`;
      };
      const sig = () => {
        const frame = document.querySelector(`${view} [data-design-frame="${CSS.escape(file)}"]`);
        if (!frame) return "absent";
        const r = frame.getBoundingClientRect();
        const stack = document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2).slice(0, 7).map(describe);
        const media = [...frame.querySelectorAll("img, iframe, canvas")].map(describe);
        const world = frame.parentElement;
        const others = [...world.children].filter((c) => c !== frame && !c.hasAttribute("data-design-frame")).map(describe);
        return JSON.stringify({ same: frame === frame0, attrs: [...frame.attributes].filter((a) => a.name.startsWith("data-design-frame-") || a.name === "data-design-nest-target").map((a) => a.name.slice(18)).join(","), stack, media, others });
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


    const lums = (out.timeline ?? []).filter(([t, e]) => e.startsWith("FRAME") && t > out.upAt - 50 && t < out.upAt + 600).map(([t, e]) => [t, Number(e.split("=")[1])]);
    const base = lums.length ? lums[0][1] : null;
    out.flash = lums.filter(([, l]) => base !== null && Math.abs(l - base) > 40);
    out.domAround = (out.timeline ?? []).filter(([t, e]) => e.startsWith("DOM") && t > out.upAt - 50 && t < out.upAt + 600);
    const all = (out.timeline ?? []).filter(([t, e]) => e.startsWith("DOM") && t > out.upAt - 400 && t < out.upAt + 700).map(([t, e]) => [t, e.slice(4)]);
    runs.push({ trial, upAt: out.upAt, flash: out.flash, dom: (out.flash.length || trial === 0) ? all : all.length });
    if (out.flash.length) {
      const fsp = await import("node:fs/promises");
      const hit = frames.find((f) => Math.round(f.at - t0) === out.flash[0][0]);
      if (hit) await fsp.writeFile(`${ctx.outbox}/082-flash-${trial}.jpg`, Buffer.from(hit.data, "base64"));
      const prev = frames[frames.indexOf(hit) - 1];
      if (prev) await fsp.writeFile(`${ctx.outbox}/082-before-${trial}.jpg`, Buffer.from(prev.data, "base64"));
    }
    await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
    await rawPage.keyboard.press("Meta+z"); await ctx.delay(1500);
  }
  return { runs };
};
