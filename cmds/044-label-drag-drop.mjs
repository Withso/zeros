const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Move a frame by dragging its body to empty canvas and watch the drop: the
// frame's pixels must never blank, and the selection must follow it.
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const file = "page-1/hero.html";
  const g = await h.frameGeometry(ctx, file);
  out.before = g;
  await rawPage.evaluate(({ view, file }) => {
    const store = globalThis.__dd = { log: [], last: "" };
    const sig = () => {
      const frame = document.querySelector(`${view} [data-design-frame="${CSS.escape(file)}"]`);
      if (!frame) return "absent";
      const docs = [...frame.querySelectorAll("iframe[data-design-document-buffer]")].map((el) => `D${el.hasAttribute("data-design-document-ready") ? "r" : "-"}${el.hasAttribute("data-design-document-presented") ? "p" : ""}${getComputedStyle(el).visibility[0]}`).join(",");
      const ghost = document.querySelectorAll(`${view} [data-design-drag-picture], ${view} [data-design-drag-ghost]`).length;
      return `L${Math.round(parseFloat(frame.style.left))} T${Math.round(parseFloat(frame.style.top))} vis=${getComputedStyle(frame).visibility[0]} op=${getComputedStyle(frame).opacity} ${frame.hasAttribute("data-design-frame-tiled") ? "TILED " : ""}[${docs}] ghosts=${ghost}`;
    };
    const tick = () => { const s = sig(); if (s !== store.last) { store.log.push([performance.timeOrigin + performance.now(), s]); store.last = s; } if (store.log.length < 400 && !store.stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }, { view: h.VIEW, file });
  const frames = [];
  const onFrame = async ({ data, sessionId, metadata }) => { frames.push({ data, at: metadata.timestamp * 1000 }); await ctx.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {}); };
  ctx.cdp.on("Page.screencastFrame", onFrame);
  await ctx.cdp.send("Page.startScreencast", { format: "jpeg", quality: 70 });
  const t0 = await rawPage.evaluate(() => performance.timeOrigin + performance.now());
  const lb = await rawPage.locator(`${h.VIEW} [data-design-frame="${file}"] [data-design-frame-label]`).boundingBox();
  out.label = lb;
  const sx = lb.x + Math.min(10, lb.width / 2), sy = lb.y + lb.height / 2, dx = 0, dy = 250;
  await rawPage.mouse.move(sx, sy); await ctx.delay(80); await rawPage.mouse.down();
  for (let i = 1; i <= 20; i++) { await rawPage.mouse.move(sx + dx * i / 20, sy + dy * i / 20); await ctx.delay(16); }
  await ctx.delay(100);
  const upAt = Math.round(await rawPage.evaluate(() => performance.timeOrigin + performance.now()) - t0);
  await rawPage.mouse.up(); await ctx.delay(1500);
  await ctx.cdp.send("Page.stopScreencast").catch(() => {}); ctx.cdp.off("Page.screencastFrame", onFrame);
  const log = await rawPage.evaluate(() => { globalThis.__dd.stop = true; return globalThis.__dd.log; });
  const g2 = await h.frameGeometry(ctx, file);
  out.after = g2; out.upAt = upAt;
  // Luminance of the frame's final rectangle (where it must stay painted after the drop).
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
  out.frames = frames.map((f, i) => [Math.round(f.at - t0), lum[i]]);
  out.dom = log.map(([t, s]) => [Math.round(t - t0), s]);
  out.state = await h.state(ctx);
  // Save the frames right after the drop for inspection.
  const fsp = await import("node:fs/promises");
  for (const [i, f] of frames.entries()) { const t = Math.round(f.at - t0); if (t > upAt - 40 && t < upAt + 400) await fsp.writeFile(`${ctx.outbox}/044-${String(i).padStart(3, "0")}-${t}ms.jpg`, Buffer.from(f.data, "base64")); }
  return out;
};
