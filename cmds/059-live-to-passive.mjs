const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Live -> passive handoff: select a frame (live), then select another so the
// first goes passive. Align its per-frame luminance with its DOM layers.
export default async (ctx) => {
  const { rawPage, cdp } = ctx, out = { trials: [] };
  const pick = async (name) => {
    await rawPage.locator("[data-design-sidebar-panel]").getByText(name, { exact: true }).first().click(); await ctx.delay(150);
  };
  await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Shift+1"); await ctx.delay(1200);
  for (const [watched, first, then] of [["page-1/hero.html", "Hero", "Card"], ["page-1/hero.html", "Hero", "List"], ["page-1/card.html", "Card", "Hero"], ["page-1/list.html", "List", "Card"]]) {
    await pick(first); await ctx.delay(2000);
    const fr = await h.frameGeometry(ctx, watched);
    await rawPage.evaluate(({ view, file }) => {
      const store = globalThis.__lp = { log: [], last: "" };
      const st = (el) => { const s = getComputedStyle(el); return `${s.display === "none" ? "N" : ""}${s.visibility === "hidden" ? "h" : "v"}${Number(s.opacity) < 1 ? "o" : ""}`; };
      const sig = () => {
        const frame = document.querySelector(`${view} [data-design-frame="${CSS.escape(file)}"]`);
        if (!frame) return "absent";
        const kids = [...frame.querySelectorAll("img[data-design-source-vector], span[data-design-source-surface], iframe")].map((el) => {
          const tag = el.tagName === "IFRAME" ? (el.hasAttribute("data-design-document-buffer") ? "D" + (el.hasAttribute("data-design-document-ready") ? "r" : "-") + (el.hasAttribute("data-design-document-presented") ? "p" : "") : "S" + (el.hasAttribute("data-design-source-ready") ? "r" : "-")) : el.tagName === "IMG" ? "V" : "A";
          return tag + st(el);
        }).join(",");
        return `${frame.hasAttribute("data-design-frame-tiled") ? "TILED " : ""}bg=${getComputedStyle(frame).backgroundColor} [${kids}]`;
      };
      const tick = () => { const s = sig(); if (s !== store.last) { store.log.push([performance.timeOrigin + performance.now(), s]); store.last = s; } if (store.log.length < 200 && !store.stop) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }, { view: h.VIEW, file: watched });
    const frames = [];
    const onFrame = async ({ data, sessionId, metadata }) => { frames.push({ data, at: metadata.timestamp * 1000 }); await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {}); };
    cdp.on("Page.screencastFrame", onFrame);
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70 });
    await ctx.delay(100);
    const t0 = await rawPage.evaluate(() => performance.timeOrigin + performance.now());
    await pick(then); await ctx.delay(900);
    await cdp.send("Page.stopScreencast").catch(() => {}); cdp.off("Page.screencastFrame", onFrame);
    const log = await rawPage.evaluate(() => { globalThis.__lp.stop = true; return globalThis.__lp.log; });
    const clip = { x: fr.x + 3, y: fr.y + 3, width: fr.width - 6, height: fr.height - 6 };
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
    out.trials.push({ watched, first, then, frames: frames.map((f, i) => [Math.round(f.at - t0), lum[i]]), dom: log.map(([t, s]) => [Math.round(t - t0), s]) });
  }
  return out;
};
