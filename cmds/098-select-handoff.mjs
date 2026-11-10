const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Selecting a passive frame: when does the live document say it painted, and
// when did its first pixels really reach the screen (paint timing)?
export default async (ctx) => {
  const { rawPage, cdp } = ctx, out = { trials: [] };
  {
    const card = "page-1/card.html";
    await rawPage.locator("[data-design-sidebar-panel]").getByText("Card", { exact: true }).first().click(); await ctx.delay(500);
    await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus(); await rawPage.keyboard.press("Shift+2"); await ctx.delay(900);
    await h.waitFor(() => rawPage.locator(h.live(card)).count(), 4000);
    for (let i = 0; i < 3; i++) { const p = await h.hitPoint(ctx, card, '[data-oid="card-primary"]'); await rawPage.mouse.dblclick(p.x, p.y); await ctx.delay(500); if ((await h.state(ctx)).selectedLayers.includes("card-primary")) break; }
    await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus(); await rawPage.keyboard.press("Shift+1"); await ctx.delay(1000);
  }
  const files = ["page-1/hero.html", "page-1/list.html"];
  for (let index = 0; index < 40; index++) {
    const file = files[index % 2];
    await ctx.delay(2000);
    const g = await h.frameGeometry(ctx, file);
    await rawPage.evaluate(({ view, file }) => {
      const store = globalThis.__sh = { log: [], last: "" };
      const sig = () => {
        const frame = document.querySelector(`${view} [data-design-frame="${CSS.escape(file)}"]`);
        if (!frame) return "absent";
        const vis = (el) => getComputedStyle(el).visibility === "hidden" ? "h" : Number(getComputedStyle(el).opacity) === 0 ? "o" : "v";
        const kids = [...frame.querySelectorAll("img[data-design-source-vector], span[data-design-source-surface], iframe")].map((el) =>
          el.tagName === "IFRAME" ? (el.hasAttribute("data-design-document-buffer") ? `D${el.hasAttribute("data-design-document-ready") ? "r" : "-"}${el.hasAttribute("data-design-document-presented") ? "p" : ""}` : `S${el.hasAttribute("data-design-source-ready") ? "r" : "-"}`) + vis(el) : (el.tagName === "IMG" ? "V" : "A") + vis(el)).join(",");
        return `${frame.hasAttribute("data-design-frame-tiled") ? "T " : ""}[${kids}]`;
      };
      const tick = () => { const s = sig(); if (s !== store.last) { store.log.push([performance.timeOrigin + performance.now(), s]); store.last = s; } if (store.log.length < 200 && !store.stop) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }, { view: h.VIEW, file });
    const frames = [];
    const onFrame = async ({ data, sessionId, metadata }) => { frames.push({ data, at: metadata.timestamp * 1000 }); await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {}); };
    cdp.on("Page.screencastFrame", onFrame);
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60 });
    const x = g.x + g.width * 0.5, y = g.y + g.height * 0.92;
    await rawPage.mouse.move(x - 30, y - 30); await ctx.delay(60); await rawPage.mouse.move(x, y); await ctx.delay(100);
    const t0 = await rawPage.evaluate(() => performance.timeOrigin + performance.now());
    await rawPage.mouse.down(); await rawPage.mouse.up(); await ctx.delay(700);
    await cdp.send("Page.stopScreencast").catch(() => {}); cdp.off("Page.screencastFrame", onFrame);
    const log = await rawPage.evaluate(() => { globalThis.__sh.stop = true; return globalThis.__sh.log; });
    // Paint timing inside the live document and the source surface (buffered entries).
    const paints = {};
    for (const [name, selector] of [["doc", `${h.VIEW} [data-design-frame="${file}"] iframe[data-design-document-buffer="displayed"]`], ["src", `${h.VIEW} [data-design-frame="${file}"] iframe[data-design-source-surface]`]]) {
      const handle = await rawPage.locator(selector).first().elementHandle({ timeout: 500 }).catch(() => null);
      const inner = handle ? await handle.contentFrame() : null;
      paints[name] = inner ? await inner.evaluate(() => new Promise((resolve) => {
        const entries = [];
        const done = () => resolve(entries.map((e) => [e.name === "first-paint" ? "fp" : "fcp", Math.round(performance.timeOrigin + e.startTime)]));
        try { new PerformanceObserver((list) => { entries.push(...list.getEntries()); }).observe({ type: "paint", buffered: true }); } catch { /* unsupported */ }
        setTimeout(done, 120);
      })).catch((e) => String(e).slice(0, 60)) : null;
    }
    const clip = { x: g.x + 3, y: g.y + 3, width: g.width - 6, height: g.height - 6 };
    const lum = await rawPage.evaluate(async ({ frames, clip }) => {
      const small = new OffscreenCanvas(32, 32), c = small.getContext("2d", { willReadFrequently: true }); const res = [];
      for (const f of frames) {
        const raw = atob(f.data), bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const bm = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" })); const scale = bm.width / innerWidth;
        c.drawImage(bm, clip.x * scale, clip.y * scale, clip.width * scale, clip.height * scale, 0, 0, 32, 32); bm.close();
        const p = c.getImageData(0, 0, 32, 32).data; let s = 0; for (let i = 0; i < p.length; i += 4) s += p[i] + p[i + 1] + p[i + 2]; res.push(Math.round(s / (p.length / 4) / 3));
      }
      return res;
    }, { frames, clip });
    const base = lum[0];
    const rel = (v) => Array.isArray(v) ? v.map(([n, t]) => [n, Math.round(t - t0)]) : v;
    out.trials.push({ index, file: file.slice(7, 11), flash: frames.map((f, i) => [Math.round(f.at - t0), lum[i]]).filter(([, l]) => Math.abs(l - base) > 12),
      dom: log.map(([t, s]) => [Math.round(t - t0), s]).filter(([t]) => t > -20), doc: rel(paints.doc), src: rel(paints.src) });
    // Deselect so the frame goes passive again.
    await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus(); await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Escape");
  }
  return out;
};
