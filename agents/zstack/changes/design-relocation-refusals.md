Moving a frame into another, or a layer between frames, failed on almost every
real frame. The runtime copied every inherited custom property into a 64-entry
payload, and a directory's ~300 imported tokens always overflowed it
("inherited style size"). The engine refused any frame whose CSS used `@media`,
a compound selector or `vh`, and any pair of frames whose inlined styles
differed, which per-frame Tailwind output always does. Relocation now carries
only what the layer's own context sets beyond its frame's base, measures the
destination base across frames, and refuses only a component instance inside
the layer or a box it cannot place (`relocation.test.ts`,
`design-runtime-relocation.test.ts`, `design-layout-transfer.test.ts`).

Rule: test a safety refusal against realistic fixtures (token stylesheets, SVG
icons, imported Tailwind) before tightening it; a refusal that ordinary input
always trips is a broken feature, not safety.

Carrying only context-set values then compared them with the wrong reference.
Each value was compared with a frame body, but a layer inherits from its drop
parent. A label taking the body's dark text, dropped into `.card { color:
white }`, carried nothing and turned white. Relocation now carries every value
the measured drop parent would not give the layer, and the runtime records the
root's value for each custom property it carries. A same-frame drag previews
with every value and settles against the parent measured at release
(`design-relocation.test.ts`, `design-movement-geometry.test.ts`,
`design-layout-transfer.test.ts`).

Rule: diff inherited state against the element it will inherit from, measured
when the destination is final.
