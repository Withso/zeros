# Stable document geometry and individual first paint

Symptom: fractional camera zoom shifted text in a retained HTML document, and
cold frame borders appeared before their content.

Cause: changing iframe CSS zoom changes internal font metrics and rounding;
stable iframe identity alone does not establish visual continuity. Frame
chrome also treated prepared metadata or an assigned image URL as painted
content.

Rule: keep the document's layout density stable throughout the supported
camera range. Compare authored element geometry at fractional zooms as well
as document identity, including offscreen return and editor handoff. Reveal
cold frame chrome with ready content; keep confirmed content during refresh
and preserve actionable errors. A native performance sample must verify its
workspace and connected-document count at every stage; discard interrupted
workloads instead of counting a partial run as acceptance.

Encoded in `scripts/ui-smoke-design-source-surfaces.mjs` (held first response,
fractional geometry, retained identity, resize and handoff),
`scripts/ui-smoke-design-lazy-preparation.mjs` (hidden metadata navigation and
individual reveal), and the Design camera/UI-memory unit suites (800% limits,
pointer anchoring and legacy camera restoration). Geometry assertions require
actual authored elements so an empty selector cannot pass vacuously.

Native probes must assert that the painted camera matches the requested
camera. A Vite hot update can leave a bare dynamic import pointing to a
different store instance than the component's timestamped import. Recover
the existing run and restart only its dev server/profile when that mismatch
is established. After editor activation, measure the visible editor, not
the retained hidden passive buffer: hidden documents can stop animation
callbacks and defer viewport delivery by design.

Playwright's cross-frame boundingBox can apply iframe CSS zoom twice. Map
the child getBoundingClientRect through its innerWidth/innerHeight and the
outer iframe's painted rectangle. iframe.clientWidth is not the authored
viewport under CSS zoom. The shared designFrameElementBox smoke helper
keeps real pointer, overlay alignment, and drag assertions in screen pixels.
Map native control clicks and hover points the same way; forcing a checked
state would bypass the interaction being tested. Inspect hidden lifecycle
state through DOM hooks, since role locators intentionally omit hidden chrome.
