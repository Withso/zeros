// QA helpers shared by command files.
import path from "node:path";
export const VIEW = '[data-design-retained-workspace][aria-hidden="false"]';
export const live = (file) => `${VIEW} [data-design-frame="${file}"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]`;
export async function waitFor(fn, timeout = 8000, step = 50) {
  const until = Date.now() + timeout;
  for (;;) { const value = await fn().catch(() => null); if (value) return value; if (Date.now() > until) return null; await new Promise((r) => setTimeout(r, step)); }
}
// On-screen box of an element inside a frame's live document.
export async function box(ctx, file, selector) {
  const { rawPage } = ctx;
  const iframe = rawPage.locator(live(file));
  const element = rawPage.frameLocator(live(file)).locator(selector).first();
  const local = await element.evaluate((node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight }; });
  const outer = await iframe.evaluate((node) => node.getBoundingClientRect().toJSON());
  const sx = outer.width / local.vw, sy = outer.height / local.vh;
  return { x: outer.x + local.x * sx, y: outer.y + local.y * sy, width: local.width * sx, height: local.height * sy };
}
export const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
export async function frameRect(ctx, file) {
  return ctx.rawPage.evaluate(({ view, file }) => document.querySelector(`${view} [data-design-frame="${file}"]`)?.getBoundingClientRect().toJSON(), { view: VIEW, file });
}
export async function camera(ctx) {
  return ctx.rawPage.evaluate((view) => document.querySelector(`${view} [data-design-canvas-world]`)?.style.transform, VIEW);
}
// An empty canvas point (no frame, no chrome), for deselecting and focus.
export async function emptyPoint(ctx) {
  return ctx.rawPage.evaluate((view) => {
    const canvas = document.querySelector(`${view} [data-design-canvas-viewport]`);
    const b = canvas.getBoundingClientRect();
    for (let y = b.bottom - 40; y > b.top + 40; y -= 37) for (let x = b.left + 80; x < b.right - 300; x += 41) {
      const hit = document.elementFromPoint(x, y);
      if (hit && canvas.contains(hit) && !hit.closest("[data-design-frame], [data-design-controls], [data-design-floating-panel], [aria-label='Canvas tools'], [data-design-motion-timeline]")) return { x, y };
    }
    return null;
  }, VIEW);
}
export async function focusCanvas(ctx) {
  const p = await emptyPoint(ctx);
  await ctx.rawPage.mouse.click(p.x, p.y);
  return p;
}
export async function jpeg(ctx, name, clip = { x: 641, y: 40, width: 799, height: 860 }) {
  const file = path.join(ctx.outbox, `${name}.jpg`);
  await ctx.rawPage.screenshot({ path: file, type: "jpeg", quality: 60, clip });
  return path.basename(file);
}
export async function state(ctx) {
  return ctx.rawPage.evaluate((view) => {
    const owner = document.querySelector(view);
    return {
      inspector: document.querySelector("[data-design-inspector-header]")?.getAttribute("data-design-selection-type"),
      selectedLayers: [...document.querySelectorAll("[data-design-sidebar-panel] [data-design-layer-id][aria-selected='true']")].map((r) => r.getAttribute("data-design-layer-id")),
      editor: !!document.querySelector('[aria-label^="Edit text for "]'),
      editorText: document.querySelector('[aria-label^="Edit text for "]')?.textContent ?? null,
      frames: [...(owner?.querySelectorAll("[data-design-frame]") ?? [])].map((f) => f.getAttribute("data-design-frame")),
      focus: (document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? "").slice(0, 60),
      tool: owner?.querySelector('[aria-label="Canvas tools"] button[aria-pressed="true"]')?.getAttribute("aria-label") ?? null,
    };
  }, VIEW);
}
export async function sourceVersion(ctx, file) {
  return ctx.rawPage.frameLocator(live(file)).locator("body").evaluate(() => globalThis.__zerosDesignSourceVersion ?? null).catch(() => null);
}
// A contact sheet of screencast frames cropped to `clip` (CSS px of a 1440x900
// page, frames at 2x), each labelled with its time and its mean change from the
// previous frame (0-255): a flash or a swap shows as a spike. Drawn in the app
// page on an OffscreenCanvas; nothing is shown or navigated.
export async function sheet(ctx, name, files, { clip, columns = 6, width = 300 } = {}) {
  const fsp = await import("node:fs/promises");
  const frames = [];
  for (const file of files) frames.push({ name: file, data: (await fsp.readFile(path.join(ctx.outbox, file))).toString("base64") });
  const out = await ctx.rawPage.evaluate(async ({ frames, clip, columns, width }) => {
    const sx = clip.x * 2, sy = clip.y * 2, sw = clip.width * 2, sh = clip.height * 2;
    const cell = { w: width, h: Math.round(width * sh / sw) + 18 };
    const rows = Math.ceil(frames.length / columns);
    const canvas = new OffscreenCanvas(columns * cell.w, rows * cell.h);
    const g = canvas.getContext("2d");
    g.fillStyle = "#000"; g.fillRect(0, 0, canvas.width, canvas.height);
    const small = new OffscreenCanvas(48, 48), sg = small.getContext("2d", { willReadFrequently: true });
    let previous = null; const diffs = [];
    for (const [index, frame] of frames.entries()) {
      const raw = atob(frame.data), bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const blob = new Blob([bytes], { type: "image/jpeg" });
      const bitmap = await createImageBitmap(blob);
      const x = (index % columns) * cell.w, y = Math.floor(index / columns) * cell.h;
      g.drawImage(bitmap, sx, sy, sw, sh, x, y + 18, cell.w, cell.h - 18);
      sg.drawImage(bitmap, sx, sy, sw, sh, 0, 0, 48, 48);
      const pixels = sg.getImageData(0, 0, 48, 48).data;
      let diff = 0;
      if (previous) { for (let i = 0; i < pixels.length; i += 4) diff += Math.abs(pixels[i] - previous[i]) + Math.abs(pixels[i + 1] - previous[i + 1]) + Math.abs(pixels[i + 2] - previous[i + 2]); diff /= (pixels.length / 4) * 3; }
      previous = pixels.slice();
      diffs.push(Math.round(diff * 10) / 10);
      g.fillStyle = diff > 8 ? "#ff5050" : "#bbbbbb"; g.font = "13px sans-serif";
      g.fillText(`${index} ${frame.name.match(/-(\d+)ms/)?.[1] ?? "?"}ms Δ${diff.toFixed(1)}`, x + 4, y + 13);
      bitmap.close();
    }
    const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
    const bytes = new Uint8Array(await jpeg.arrayBuffer());
    let binary = ""; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { image: btoa(binary), diffs };
  }, { frames, clip, columns, width });
  const target = path.join(ctx.outbox, `${name}.jpg`);
  await fsp.writeFile(target, Buffer.from(out.image, "base64"));
  return { sheet: path.basename(target), diffs: out.diffs };
}
// A point inside an element of a frame's document that the pointer would
// actually hit on the canvas (not under a panel, toolbar or label).
export async function hitPoint(ctx, file, selector) {
  const b = await box(ctx, file, selector);
  for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7], [0.2, 0.2], [0.8, 0.8]]) {
    const x = b.x + b.width * fx, y = b.y + b.height * fy;
    const ok = await ctx.rawPage.evaluate(({ x, y, file }) => {
      const hit = document.elementFromPoint(x, y);
      return !!hit && !!hit.closest(`[data-design-frame="${file}"]`) && !hit.closest("[data-design-floating-panel], [aria-label='Canvas tools'], [data-design-frame-chrome]");
    }, { x, y, file });
    if (ok) return { x, y, box: b };
  }
  throw new Error(`${selector} in ${file} is not under the pointer anywhere (covered or off-canvas)`);
}
// Per-rAF signature of one frame's painted layers, logged on change into
// window.__surf[file]: source surfaces, picture cover, live documents, covers.
export async function surfaceProbe(ctx, files) {
  await ctx.rawPage.evaluate(({ view, files }) => {
    const store = globalThis.__surf = { started: performance.now(), log: Object.fromEntries(files.map((f) => [f, []])), last: {} };
    const vis = (el) => { const s = getComputedStyle(el); return s.visibility === "hidden" ? "h" : Number(s.opacity) === 0 ? "o" : "v"; };
    const sig = (file) => {
      const frame = document.querySelector(`${view} [data-design-frame="${CSS.escape(file)}"]`);
      if (!frame) return "absent";
      const src = [...frame.querySelectorAll("[data-design-source-surface]")].map((el) =>
        `${el.tagName === "IFRAME" ? "I" : "V"}${(el.getAttribute("data-design-source-buffer") ?? "?")[0]}${el.hasAttribute("data-design-source-ready") ? "r" : "-"}${vis(el)}`).join(",");
      const pic = [...frame.querySelectorAll("[data-design-frame-pixel-cover]")].map((el) =>
        `${el.querySelector("img") ? "img" : "none"}${el.hasAttribute("data-design-frame-pixels-ready") ? "r" : "-"}${el.querySelector("img") ? vis(el.querySelector("img")) : ""}`).join(",");
      const doc = [...frame.querySelectorAll("iframe[data-design-document-buffer]")].map((el) =>
        `${el.getAttribute("data-design-document-buffer")[0]}${el.hasAttribute("data-design-document-ready") ? "r" : "-"}${vis(el)}`).join(",");
      const cover = frame.querySelectorAll("[data-design-frame-transition-cover]").length;
      const hold = /Preparing/.test(frame.textContent ?? "") ? " PREP" : "";
      return `src[${src}] pic[${pic}] doc[${doc}] cov${cover}${hold}`;
    };
    const tick = () => {
      for (const file of files) {
        const s = sig(file);
        if (s !== store.last[file]) { store.log[file].push([Math.round(performance.now() - store.started), s]); store.last[file] = s; }
      }
      if (performance.now() - store.started < 20000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { view: VIEW, files });
}
export const surfaceLog = (ctx) => ctx.rawPage.evaluate(() => globalThis.__surf?.log ?? null);
// A frame's on-screen rectangle from its world geometry and the camera, valid
// even when a passive compact frame's own DOM box is collapsed to 0x0.
export async function frameGeometry(ctx, file) {
  return ctx.rawPage.evaluate(({ view, file }) => {
    const frame = document.querySelector(`${view} [data-design-frame="${CSS.escape(file)}"]`);
    const world = frame?.parentElement;
    if (!frame || !world) return null;
    const m = new DOMMatrix(getComputedStyle(world).transform);
    const origin = world.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const left = parseFloat(frame.style.left), top = parseFloat(frame.style.top), width = parseFloat(frame.style.width), height = parseFloat(frame.style.height);
    return { x: origin.left + m.e + left * m.a, y: origin.top + m.f + top * m.d, width: width * m.a, height: height * m.d, zoom: m.a };
  }, { view: VIEW, file });
}
