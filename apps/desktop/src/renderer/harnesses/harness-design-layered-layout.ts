// A CSS-authored composition: its full-frame decoration must stay out of flow
// when the content container becomes flex/grid. Entrance animation starts at
// zero opacity, but the passive editor must show the unanimated content.
export const LAYERED_LAYOUT_SOURCE = `<!doctype html>
<html><head><style>
  * { box-sizing: border-box }
  body { margin: 0; color: white; font-family: sans-serif }
  .board {
    position: relative; width: 100%; height: 100vh; overflow: hidden;
    padding: 104px 72px 64px 88px; background: darkslategray;
    border: 1px solid tomato;
  }
  .field { position: absolute; inset: 0; overflow: hidden; pointer-events: none }
  .orb { position: absolute; width: 440px; height: 440px; border-radius: 50%; background: darkseagreen }
  .orb:first-child { right: -120px; top: -100px }
  .orb:last-child { left: -180px; bottom: -200px }
  .copy { position: relative; z-index: 1; width: 80%; max-width: 520px }
  h1 { margin: 0; font: 80px/1.1 Georgia, serif; animation: arrive 8s .18s infinite both }
  p { margin: 24px 0 0; animation: arrive 8s .42s infinite both }
  .marks { display: flex; gap: 8px; margin-top: 28px; animation: arrive 8s .62s infinite both }
  .marks span { display: block; width: 52px; height: 6px; background: peachpuff }
  .marks span:last-child { width: 26px }
  .fixed { position: fixed; right: 16px; top: 16px }
  .badge { position: absolute; right: 40px; top: 40px; width: 80px; height: 24px }
  @keyframes arrive {
    0% { opacity: 0; transform: translateY(22px) }
    16%, 78% { opacity: 1; transform: translateY(0) }
    100% { opacity: 0; transform: translateY(-14px) }
  }
  @media (prefers-reduced-motion: reduce) { h1, p, .marks { animation: none } }
</style></head><body>
  <main class="board" data-oid="home-main" data-zeros-frame-root>
    <div class="field" data-oid="home-field" aria-hidden="true">
      <div class="orb" data-oid="home-orb-a"></div><div class="orb" data-oid="home-orb-b"></div>
    </div>
    <div class="copy" data-oid="home-hero">
      <h1 data-oid="home-heading">Hello, HTML</h1>
      <p data-oid="home-copy">A starting artboard. Its content stays inside the frame.</p>
      <div class="marks" data-oid="home-marks" aria-hidden="true">
        <span data-oid="home-mark-a"></span><span data-oid="home-mark-b"></span>
      </div>
    </div>
    <div class="fixed" data-oid="home-fixed">Preview</div>
    <div class="badge" data-oid="home-badge">Decoration</div>
    <div data-oid="home-hidden" style="display:none">Hidden content</div>
  </main>
</body></html>`;
