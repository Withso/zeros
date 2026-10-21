Looping content kept live Design frames repainting: the runtime cancelled CSS
animations at ready, but SVG SMIL timelines, marquees, media and CSS animations
started later (hover, `:checked`, a media query) ran on. Capture hosts removed
CSS animations only, so pictures and the canvas could disagree. The runtime
now stills all of them as they start. One definition,
`DESIGN_STILL_TIMELINES_SOURCE`, is embedded in the runtime and run by both
hosts as `DESIGN_STATIC_RENDER_SCRIPT` before capturing; two hand-written
copies would drift, and a frame would jump between moments as it swaps
between picture and document (`design-runtime.test.ts`,
`design-capture.test.ts`). When stilling motion, cover every looping source,
not just the Web Animations API, and share one definition between a picture
and its live document.
