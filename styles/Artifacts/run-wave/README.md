# Run loader — Audio Wave

A pure-vector, five-stroke audio waveform for active Run states. Every lower
endpoint stays on one baseline while a smooth upper contour travels across the
five strokes without a beat or rhythmic pulse.

Like the rest of `styles/Artifacts/`, this is a standalone design study. It uses
one authored script, no dependencies, no fetches, and works directly from
`file://`.

## How it works

- `run-wave.js` mounts a compact SVG into each `[data-run-wave]` host.
- Five round-capped lines use non-scaling strokes calculated for their rendered
  size: exactly 1 px at 14 px and 1.2 px at 16 px.
- At the production 14 px size, each line's geometric height moves between
  3.43 px and 9.8 px while its lower endpoint remains fixed.
- Stroke centers are 2.625 px apart at 14 px, leaving a 1.625 px visible gap
  between the 1 px strokes.
- One traveling pass runs for 1500 ms, a 33% speed increase over the reference
  GIF's visible pass. Twenty phase poses roll one rounded crest across five
  distinct upper endpoints without moving the lower baseline.
- Periodic Catmull–Rom interpolation is sampled into dense CSS keyframes. Every
  stroke changes direction smoothly, and the first and final frame meet with a
  continuous tangent.
- The strokes use `currentColor`; the preview host resolves that to `--fg2` in
  both light and dark themes.
- `prefers-reduced-motion` stops the waveform in a balanced wave pose.

## Reuse

```html
<span class="run-wave" data-run-wave data-wave-size="16"></span>
<style>
  .run-wave {
    display: inline-flex;
    color: var(--fg2);
  }
</style>
<script src="run-wave.js"></script>
```

## Promoting to production

This remains an exploration study. A production port would live under
`apps/desktop/src/renderer/shared/ui/loading/`, preserve the same SVG strokes and CSS-only motion, and expose
size, label, and class-name props like the existing loader primitives.
