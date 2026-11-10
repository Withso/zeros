const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Align screencast frames (wall clock) with per-rAF DOM states of one frame.
export default async (ctx) => {
  const { rawPage, cdp } = ctx, out = { trials: [] };
  const files = ["page-1/card.html", "page-1/list.html", "page-1/card.html", "page-1/list.html"];
  for (const file of files) {
    await ctx.delay(2300);
    const fr = await h.frameRect(ctx, file);
    const lb = await rawPage.locator(`${h.VIEW} [data-design-frame="${file}"] [data-design-frame-label]`).boundingBox();
    await rawPage.evaluate(({ view, file }) => {
      const store = globalThis.__tl = { log: [], last: "" };
      const st = (el) => { const s = getComputedStyle(el); return `${s.display === "none" ? "N" : ""}${s.visibility === "hidden" ? "h" : "v"}${Number(s.opacity) < 1 ? "o" + s.opacity : ""}`; };
      const sig = () => {
        const frame = document.querySelector(`${view} [data-design-frame="${CSS.escape(file)}"]`);
        if (!frame) return "absent";
        const surface = frame.querySelector("[data-design-frame-render-surface]");
        const kids = surface ? [...surface.querySelectorAll("img, iframe, span[data-design-source-surface], [data-design-frame-pixel-cover]")].map((el) => {
          const tag = el.tagName === "IFRAME" ? (el.hasAttribute("data-design-document-buffer") ? "D" + el.getAttribute("data-design-document-buffer")[0] + (el.hasAttribute("data-design-document-ready") ? "r" : "-") : "S" + (el.hasAttribute("data-design-source-ready") ? "r" : "-"))
            : el.tagName === "IMG" ? (el.hasAttribute("data-design-source-vector") ? "V" : "P") + (el.isConnected ? "" : "x") : el.tagName === "SPAN" ? "A" : "C";
          return tag + st(el);
        }).join(",") : "nosurface";
        const planes = document.querySelectorAll(`${view} [data-design-source-plane]`).length;
        return `${frame.hasAttribute("data-design-frame-tiled") ? "TILED " : ""}bg=${getComputedStyle(frame).backgroundColor} planes=${planes} [${kids}]`;
      };
      const tick = () => { const s = sig(); if (s !== store.last) { store.log.push([performance.timeOrigin + performance.now(), s]); store.last = s; } if (store.log.length < 200 && !store.stop) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }, { view: h.VIEW, file });
    const frames = [];
    const onFrame = async ({ data, sessionId, metadata }) => { frames.push({ data, at: metadata.timestamp * 1000 }); await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {}); };
    cdp.on("Page.screencastFrame", onFrame);
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70 });
    await ctx.delay(120);
    const clickAt = await rawPage.evaluate(() => performance.timeOrigin + performance.now());
    await rawPage.mouse.click(lb.x + lb.width / 2, lb.y + lb.height / 2);
    await ctx.delay(700);
    await cdp.send("Page.stopScreencast").catch(() => {}); cdp.off("Page.screencastFrame", onFrame);
    const log = await rawPage.evaluate(() => { globalThis.__tl.stop = true; return globalThis.__tl.log; });
    const clip = { x: fr.x + 6, y: fr.y + 6, width: fr.width - 12, height: fr.height - 12 };
    const lum = await rawPage.evaluate(async ({ frames, clip }) => {
      const small = new OffscreenCanvas(32, 32), g = small.getContext("2d", { willReadFrequently: true });
      const out = [];
      for (const f of frames) {
        const raw = atob(f.data), bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const bm = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        const scale = bm.width / innerWidth;
        g.drawImage(bm, clip.x * scale, clip.y * scale, clip.width * scale, clip.height * scale, 0, 0, 32, 32); bm.close();
        const p = g.getImageData(0, 0, 32, 32).data; let s = 0; for (let i = 0; i < p.length; i += 4) s += p[i] + p[i + 1] + p[i + 2];
        out.push(Math.round(s / (p.length / 4) / 3));
      }
      return out;
    }, { frames, clip });
    out.trials.push({ file, frames: frames.map((f, i) => [Math.round(f.at - clickAt), lum[i]]), dom: log.map(([t, s]) => [Math.round(t - clickAt), s]) });
  }
  return out;
};
