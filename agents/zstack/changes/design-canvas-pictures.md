Zoomed out, most Design frames painted a blank card: a frame had a picture
only as a by-product of being one of the 12 live iframes, and the runtime store
evicted those base64 captures after 24 frames. Frames now paint saved pictures
from the capture host (`design.preview`, `state/design-frame-previews.ts`):
exact-key, theme- and level-aware Blobs in a 16 MiB memory LRU and a 48 MiB
IndexedDB store, rendered one at a time after input settles; cloud pictures are
account-scoped and render only while the VM runs.

A bounded cache that re-renders whatever it evicts loops forever once a page
outgrows the budget; the first test hung on exactly that. Render each key at
most once per session and read evicted pictures back from disk
(`design-frame-previews.test.ts`). A fractional canvas size makes a whole-pixel
render's own generation differ from the canvas's, so only then does the engine
re-read the frame identity after rendering; a whole-pixel frame is proven by
the generation its artifact reports (`workspace-preview.test.ts`).

Review found the background producer competing with foreground work. Previews
took the single capture slot that agent captures need, so `design_capture`
failed with 429; a preview now yields a busy slot and explicit captures wait
with bounded backoff (`capture-client.test.ts`). Layout was clamped to 8,192 px
and the pixel budget charged layout instead of the raster, so tall frames were
cut and stretched (`api.test.ts`, `workspace-preview.test.ts`). Cloud canvases
started a VM browser per picture for the whole page; they now render only
frames near the screen, two seconds apart. Live frames also captured
themselves in-frame although a picture already held their pixels, and the
pictured-set hook re-rendered every canvas, hidden ones included, for each
batch (`design-frame-previews.test.ts`). The memory tier duplicated
`DesignPreviewCache` and the IndexedDB store duplicated the transcript store;
neither reopened a connection the browser closed (`indexeddb-record-store.test.ts`).

Rule: background production must yield every shared resource (capture slot,
VM CPU, main-thread renders) to foreground work, and must reuse the existing
retention and storage primitives instead of copying them.
