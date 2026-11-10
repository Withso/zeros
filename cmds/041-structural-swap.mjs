const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Structural edits (duplicate, undo, redo) inside an auto-layout frame: does
// the document swap ever show a blank frame?
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const file = "page-1/card.html";
  const g = await h.frameGeometry(ctx, file);
  await rawPage.mouse.move(g.x + g.width / 2, g.y + g.height * 0.92); await ctx.delay(80);
  await rawPage.mouse.click(g.x + g.width / 2, g.y + g.height * 0.92); await ctx.delay(1500);
  // Select the primary button inside the auto-layout row: double-click goes
  // one level deeper per click, like Figma.
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = await h.hitPoint(ctx, file, '[data-oid="card-primary"]');
    await rawPage.mouse.dblclick(p.x, p.y); await ctx.delay(500);
    out.selected = (await h.state(ctx)).selectedLayers;
    if (out.selected.includes("card-primary")) break;
  }
  if (!out.selected.includes("card-primary")) throw new Error(`could not select card-primary: ${JSON.stringify(out.selected)}`);
  await rawPage.evaluate(({ view, file }) => {
    const store = globalThis.__sw = { log: [], last: "" };
    const sig = () => {
      const frame = document.querySelector(`${view} [data-design-frame="${CSS.escape(file)}"]`);
      if (!frame) return "absent";
      return [...frame.querySelectorAll("iframe[data-design-document-buffer], [data-design-source-surface], [data-design-frame-transition-cover]")].map((el) => {
        const s = getComputedStyle(el); const v = s.visibility === "hidden" ? "h" : "v";
        if (el.hasAttribute("data-design-document-buffer")) return `D${el.getAttribute("data-design-document-buffer")[0]}${el.getAttribute("data-design-document-source-version")?.slice(0, 4)}${el.hasAttribute("data-design-document-ready") ? "r" : "-"}${el.hasAttribute("data-design-document-presented") ? "p" : ""}${v}`;
        if (el.hasAttribute("data-design-frame-transition-cover")) return `C${v}`;
        return `${el.tagName === "IFRAME" ? "S" : "V"}${el.getAttribute("data-design-source-version")?.slice(0, 4)}${el.hasAttribute("data-design-source-ready") ? "r" : "-"}${v}`;
      }).join(",");
    };
    const tick = () => { const s = sig(); if (s !== store.last) { store.log.push([performance.timeOrigin + performance.now(), s]); store.last = s; } if (store.log.length < 300 && !store.stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }, { view: h.VIEW, file });
  const frames = [];
  const onFrame = async ({ data, sessionId, metadata }) => { frames.push({ data, at: metadata.timestamp * 1000 }); await ctx.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {}); };
  ctx.cdp.on("Page.screencastFrame", onFrame);
  await ctx.cdp.send("Page.startScreencast", { format: "jpeg", quality: 70 });
  await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  const t0 = await rawPage.evaluate(() => performance.timeOrigin + performance.now());
  const marks = [];
  for (const key of ["Meta+d", "Meta+z", "Meta+Shift+z", "Meta+z"]) {
    marks.push([Math.round(await rawPage.evaluate(() => performance.timeOrigin + performance.now()) - t0), key]);
    await rawPage.keyboard.press(key); await ctx.delay(1100);
  }
  await ctx.cdp.send("Page.stopScreencast").catch(() => {}); ctx.cdp.off("Page.screencastFrame", onFrame);
  const log = await rawPage.evaluate(() => { globalThis.__sw.stop = true; return globalThis.__sw.log; });
  const g2 = await h.frameGeometry(ctx, file);
  const clip = { x: g2.x + 3, y: g2.y + 3, width: g2.width - 6, height: g2.height - 6 };
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
  out.marks = marks;
  out.frames = frames.map((f, i) => [Math.round(f.at - t0), lum[i]]);
  out.dom = log.map(([t, s]) => [Math.round(t - t0), s]);
  out.minLum = Math.min(...lum); out.maxLum = Math.max(...lum);
  out.after = (await h.state(ctx)).selectedLayers;
  return out;
};
