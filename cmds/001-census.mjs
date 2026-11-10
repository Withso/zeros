export default async (ctx) => {
  const { rawPage } = ctx;
  const shot = await ctx.shot("001-open");
  const census = await rawPage.evaluate(() => {
    const owner = document.querySelector('[data-design-retained-workspace][aria-hidden="false"]');
    const viewport = owner?.querySelector("[data-design-canvas-viewport]");
    const rect = (el) => { const r = el?.getBoundingClientRect(); return r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null; };
    return {
      viewport: rect(viewport),
      world: owner?.querySelector("[data-design-canvas-world]")?.style.transform,
      frames: [...(owner?.querySelectorAll("[data-design-frame]") ?? [])].map((f) => ({
        file: f.getAttribute("data-design-frame"), rect: rect(f),
        buffers: [...f.querySelectorAll("iframe[data-design-document-buffer]")].map((i) => `${i.getAttribute("data-design-document-buffer")}${i.hasAttribute("data-design-document-ready") ? "+ready" : ""}`),
        images: f.querySelectorAll("img").length, label: f.querySelector("[data-design-frame-label]")?.textContent })),
      tools: [...(owner?.querySelectorAll('[aria-label="Canvas tools"] button') ?? [])].map((b) => b.getAttribute("aria-label")),
      inspector: document.querySelector("[data-design-inspector-header]")?.getAttribute("data-design-selection-type"),
      layers: [...document.querySelectorAll("[data-design-sidebar-panel] [data-design-layer-id]")].slice(0, 30).map((r) => r.getAttribute("data-design-layer-id")),
      panels: [...document.querySelectorAll("[data-design-floating-panel]")].map(rect),
      gpu: !!owner?.querySelector("canvas[data-design-gpu-canvas], [data-design-gpu-canvas]"),
      focus: document.activeElement?.tagName + "." + (document.activeElement?.className ?? "").toString().slice(0, 60),
    };
  });
  return { shot, census, probe: await ctx.probe() };
};
