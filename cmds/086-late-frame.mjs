const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Theory: removing a visible live iframe flashes when the app's next frame is
// late. Deselect Hero (live -> passive) with and without an injected 50 ms
// main-thread stall right after its iframe is removed.
export default async (ctx) => {
  const { rawPage, cdp } = ctx, out = { trials: [] };
  const hero = "page-1/hero.html";
  const pick = async (name) => { await rawPage.locator("[data-design-sidebar-panel]").getByText(name, { exact: true }).first().click(); };
  await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Shift+1"); await ctx.delay(1200);
  for (let trial = 0; trial < 16; trial++) {
    const stall = trial % 2 === 1 ? 50 : 0;
    await pick("Hero"); await ctx.delay(1800);
    const fr = await h.frameGeometry(ctx, hero);
    await rawPage.evaluate(({ view, file, stall }) => {
      globalThis.__stallObserver?.disconnect();
      const frame = document.querySelector(`${view} [data-design-frame="${CSS.escape(file)}"]`);
      globalThis.__stalled = 0;
      if (!stall) return;
      const observer = globalThis.__stallObserver = new MutationObserver((records) => {
        if (!records.some((r) => [...r.removedNodes].some((n) => n instanceof Element && (n.matches("iframe[data-design-document-buffer]") || n.querySelector?.("iframe[data-design-document-buffer]"))))) return;
        observer.disconnect();
        const t = performance.now(); while (performance.now() - t < stall) { /* late frame */ }
        globalThis.__stalled = performance.now() - t;
      });
      observer.observe(frame, { subtree: true, childList: true });
    }, { view: h.VIEW, file: hero, stall });
    const frames = [];
    const onFrame = async ({ data, sessionId, metadata }) => { frames.push({ data, at: metadata.timestamp * 1000 }); await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {}); };
    cdp.on("Page.screencastFrame", onFrame);
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60 });
    await ctx.delay(120);
    await pick("List"); await ctx.delay(700);
    await cdp.send("Page.stopScreencast").catch(() => {}); cdp.off("Page.screencastFrame", onFrame);
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
    const base = lum[0];
    out.trials.push({ trial, stall, stalled: Math.round(await rawPage.evaluate(() => globalThis.__stalled)), frames: lum.length, flash: lum.filter((l) => Math.abs(l - base) > 40), lums: [...new Set(lum)].join(",") });
  }
  return out;
};
