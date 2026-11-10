const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Does drawing a frame's cached SVG image into a canvas come back blank the
// first time at a new size (the tile path), while the frame is live?
export default async (ctx) => {
  const { rawPage } = ctx;
  await rawPage.locator("[data-design-sidebar-panel]").getByText("List", { exact: true }).first().click(); await ctx.delay(1500);
  return rawPage.evaluate(async (view) => {
    const out = [];
    for (const file of ["page-1/list.html", "page-1/card.html", "page-1/hero.html"]) {
      const frame = document.querySelector(`${view} [data-design-frame="${file}"]`);
      const anchor = frame?.querySelector("[data-design-source-surface]");
      const img = frame?.querySelector("img[data-design-source-vector]") ?? anchor?.designSourceImage ?? null;
      if (!img) { out.push({ file, img: false, anchor: !!anchor }); continue; }
      const row = { file, connected: img.isConnected, complete: img.complete, natural: [img.naturalWidth, img.naturalHeight], vis: img.isConnected ? getComputedStyle(img).visibility : "detached", draws: [] };
      for (const scale of [0.137, 0.211, 0.333, 0.5, 0.137]) {
        const w = Math.max(1, Math.round(img.naturalWidth * scale)), hgt = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = new OffscreenCanvas(w, hgt), g = c.getContext("2d", { willReadFrequently: true });
        const t = performance.now();
        g.drawImage(img, 0, 0, w, hgt);
        const p = g.getImageData(0, 0, w, hgt).data;
        let alpha = 0, sum = 0; for (let i = 0; i < p.length; i += 4) { alpha += p[i + 3]; sum += p[i] + p[i + 1] + p[i + 2]; }
        row.draws.push({ scale, ms: Math.round((performance.now() - t) * 10) / 10, alpha: Math.round(alpha / (p.length / 4)), lum: Math.round(sum / (p.length / 4) / 3) });
      }
      out.push(row);
    }
    return out;
  }, h.VIEW);
};
