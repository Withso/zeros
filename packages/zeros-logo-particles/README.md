# `@zeros/logo-particles`

Canonical source for the live Zeros logo particle field (`packages/zeros-logo-particles`).

Desktop (`apps/desktop`) and marketing (`apps/marketing`) both import from here when they wire it. Neither app consumes this package yet.

This tree is the **p1300gr** field: 1080×1080 frame, two circle globes (occupancy × 1.18, 5 px nudges), occupancy-locked kidneys, outer circulating field.

| File | Role |
| --- | --- |
| `field-model.js` | Loop, occupancy mapping, globe/kidney poses |
| `field.js` | Canvas spawn and draw |
| `field-model.test.cjs` | Pose tests |
| `preview.html` | Standalone 1080×1080 preview |

Preview:

```sh
python3 -m http.server 8766 --bind 0.0.0.0 --directory packages/zeros-logo-particles
```

Then open `http://127.0.0.1:8766/preview.html`.
