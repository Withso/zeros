# Shape Shimmer — shape-first five-story loader

Open `index.html` directly. It is a self-contained lab: no server, package install, or
application wiring is required.

## What changed

The reference loader is not a cloud of independently moving points. It is a small dot-matrix
glyph with fixed centers:

1. the complete silhouette is always drawn with `--fg2`;
2. a narrow diagonal group of those same dots is overdrawn with `--fg1`;
3. the highlight moves, but the underlying object does not deform;
4. only a few semantic landmarks animate between poses.

This keeps the story readable before motion or shimmer is added.

## The one combined loop

The 8-second loader contains five connected stories:

1. **A — Cat + mouse** — the cat's eared silhouette stays fixed while its legs sprint after a
   fleeing mouse.
2. **B — Rolling eyes** — two eye outlines hold still while oversized pupils roll left and
   right.
3. **C — Rower + boat** — the rower and hull remain fixed while the oar changes angle.
4. **D — Train + steam** — the locomotive stays fixed while steam puffs drift left.
5. **E — Mountain sunrise** — two mountains stay rooted while the sun climbs out of the
   valley and rays appear.

Each scene has 16 interpolated action frames followed by a four-frame diagonal relay wipe into
the next scene. That produces 100 authored frames, with display-rate blending between them.

## 24px-first construction

- The logical view is `12 × 12`, authored so the story reads at a true `24 × 24` canvas.
- Every dot sits on a fixed 12-column matrix: at 24px that is an exact 2px dot pitch
  (4 physical pixels on a 2× display), so dots stay distinct instead of blurring into noise.
- Fewer, bolder dots per silhouette: decorative dust speckles were removed and the base dot
  radius raised so each shape reads as one object at icon size.
- Regular dots, small support dots, and slightly larger landmark dots share the same grid.
- The cat's paws, the mouse's ear, the pupils, wheels, the oar tip, and the sun use the
  landmark size.
- Dot centers snap to the physical-pixel grid in the 16px and 24px audit modes.
- The 24px canvas is backed by `48 × 48` physical pixels on a 2× display.
- The magnifier is a nearest-neighbor enlargement of the same tiny canvas, not a separate
  illustration.
- No glow, blur, gradient, blue tint, or random glitter is added to the animation.

## Controls

- The five story buttons seek inside the one continuous timeline.
- Stage, Agent, 16 px, and 24 px change only the preview scale.
- Play/Pause, previous/next frame, scrubber, Space, and arrow keys inspect playback.
- Loop speed, dot size, shimmer toggle/strength, and frame blending tune the renderer.
- Dark and Light update the renderer from the live `--fg2` and `--fg1` tokens.
- Reset returns to the first cat-and-mouse frame at true 16 px.

The preview respects `prefers-reduced-motion` and starts paused when that preference is set.

## Files

- `index.html` — complete self-contained preview.
- `story-poses.js` — dot-matrix masks, detailed action frames, scene metadata, and relay wipes.
- `story-shimmer.js` — high-DPI canvas renderer and public control API.
- `preview.js` — lab controls, theme token updates, scene seeking, and pixel inspector.
- `shape-shimmer.css` — repository-token preview styling.
- `bundle-index.mjs` — embeds the source CSS and JavaScript into `index.html`.
- `horse-poses.js` and `shape-shimmer.js` — the original dense horse experiment retained for
  comparison; it was not removed.

After changing a source file, refresh the standalone page with:

```sh
node "shape shimmer/bundle-index.mjs"
```

## Reuse

```html
<canvas id="thinking-story" width="24" height="24"></canvas>
<script src="story-poses.js"></script>
<script src="story-shimmer.js"></script>
<script>
  const style = getComputedStyle(document.documentElement);
  const loader = new StoryShimmer(document.querySelector("#thinking-story"), {
    baseColor: style.getPropertyValue("--fg2").trim(),
    dotScale: 1,
    frameBlend: true,
    shimmer: true,
    shimmerColor: style.getPropertyValue("--fg1").trim(),
    shimmerIntensity: 0.9,
    speed: 1,
    story: "five-story-journey",
  });
</script>
```

The application renders this exact loop in one place only — the agent "thinking"
tail indicator next to the live timer (`src/loaders/activity-shimmer.tsx`), via
`src/loaders/story-shimmer.tsx` + `story-shimmer-motion.ts`, a TypeScript port
verified frame-identical to `story-poses.js`. This folder remains the standalone
design lab; no other loading surface uses the animation.

## Research and audit basis

- [Apple's icon guidance](https://developer.apple.com/design/human-interface-guidelines/icons)
  emphasizes simplified, immediately understandable shapes and removing detail at small sizes.
- [Material's icon grid guidance](https://m1.material.io/style/icons.html) recommends designing at
  the target pixel size, using a consistent grid and live area.
- [MDN's canvas gradient reference](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/createLinearGradient)
  informed the initial investigation, but the final implementation uses discrete `--fg1` dot
  overdrawing because it matches the supplied frames more closely than a blurred gradient.
- [W3C Media Queries Level 5](https://www.w3.org/TR/mediaqueries-5/#prefers-reduced-motion)
  defines the reduced-motion behavior used by the renderer.

Generated audit artifacts are stored in `.context/`, including true-size contact sheets rendered
with the renderer's exact 2× snapping math (`story-shimmer-24px-audit.png`,
`story-shimmer-16px-audit.png`, produced by `audit-24px.mjs`).
