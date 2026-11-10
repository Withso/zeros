const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Hypothesis: the first raster of a freshly loaded vector (SVG + foreignObject,
// .hero { height: 100vh }) draws the page background without its content.
export default async (ctx) => {
  const { rawPage } = ctx;
  await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Escape"); await rawPage.keyboard.press("Shift+1"); await ctx.delay(1500);
  return rawPage.evaluate(async (view) => {
    const frame = document.querySelector(`${view} [data-design-frame="page-1/hero.html"]`);
    const anchor = frame?.querySelector("[data-design-source-surface]");
    const img = frame?.querySelector("img[data-design-source-vector]") ?? anchor?.designSourceImage ?? null;
    if (!img) return { img: false };
    const src = img.src;
    const lum = (image, w, hgt) => { const c = new OffscreenCanvas(w, hgt), g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(image, 0, 0, w, hgt); const p = g.getImageData(0, 0, w, hgt).data; let s = 0, a = 0; for (let i = 0; i < p.length; i += 4) { s += p[i] + p[i + 1] + p[i + 2]; a += p[i + 3]; } return [Math.round(s / (p.length / 4) / 3), Math.round(a / (p.length / 4))]; };
    const out = { scheme: src.slice(0, 30), length: src.length, existing: lum(img, 180, 105), trials: [] };
    for (let i = 0; i < 6; i++) {
      const fresh = new Image(); fresh.decoding = "sync"; fresh.src = src;
      await new Promise((resolve, reject) => { fresh.onload = resolve; fresh.onerror = reject; });
      const row = { complete: fresh.complete, natural: [fresh.naturalWidth, fresh.naturalHeight], first: lum(fresh, 180, 105), second: lum(fresh, 180, 105) };
      await new Promise(requestAnimationFrame);
      row.afterFrame = lum(fresh, 360, 210);
      out.trials.push(row);
    }
    // And hidden-in-DOM first, like a live frame's covered vector.
    const hidden = new Image(); hidden.src = src; hidden.style.cssText = "position:fixed;left:0;top:0;visibility:hidden";
    document.body.append(hidden);
    await new Promise((resolve) => { hidden.onload = resolve; });
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    out.hiddenInDom = lum(hidden, 180, 105);
    hidden.remove();
    out.hiddenDetached = lum(hidden, 360, 210);
    return out;
  }, h.VIEW);
};
