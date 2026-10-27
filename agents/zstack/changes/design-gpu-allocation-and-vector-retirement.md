# Measure graphics allocation and retire temporary documents

Symptom: the 256-frame Mac overview exceeded 16 GB of physical app memory,
mostly in the GPU process, despite small RSS and bounded source/image counters.

Cause: fixed iframe CSS zoom of eight raised a Retina child's DPR from two to
sixteen, multiplying backing pixel area by 64. Retaining all ordinary-density
HTML browsing contexts also exceeded the native memory guard. A retained DOM
identity and stable layout are not evidence of bounded graphics allocation.

Rule: keep authored layout at ordinary display density and bound concurrent
HTML layout work. A passive frame can retain a decoded SVG source and retire
its temporary browsing context; active editing keeps responsive HTML. Preserve
the vector object through camera movement, budget its encoded bytes separately,
and use the bounded preview path when fidelity or decoding cannot be assured.
Neither byte budgets nor RSS establish a physical GPU-memory bound.

Native qualification must sample macOS physical footprint during cold loading,
fractional zoom, captures, hidden retirement and owner switching. Record peak
GPU and whole app/engine footprints separately. Fail on missing live readings;
only a temporary renderer/utility confirmed exited by the OS may disappear
between process enumeration and the memory sample. A sampling guard is not an
OS allocation quota and may miss peaks between samples.

Native children can load at a zero-size viewport without a subsequent resize
event. Their readiness must wait for real geometry; request one exact-parent,
exact-source/theme layout delivery and let the parent paint before retrying
measurement. Do not use child animation callbacks as a readiness prerequisite.
Keep unready layout transparent and inert while revealing each completed frame.

An owner can retire inside a readiness event before React commits a pending
image effect. Release allocations from the owning component's unconditional
cleanup as well as committed-effect cleanup; both releases must be idempotent.
Failed vector decoding must retire the temporary HTML and release its URL.

A vector snapshot must preserve the HTML root's authored sizing. Forcing its
width/height to the capture viewport changes percentage descendants, grid
alignment and absolute positioning. Paint a solid page canvas separately from
the HTML root; keep inherited backgrounds and root opacity semantics. Reset
the snapshot's own SVG containers so authored SVG paint rules cannot affect
them. Pixel comparisons must include automatic roots, not only full-height
fixture pages.

Evidence is encoded in the source-surface browser smoke (density, 256 vectors,
fractional layout, resize, decode failure, same-event retirement), the protocol
vector compositor tests (pixel fidelity, root selectors and native viewport
delivery), and native physical-footprint/sampler regression tests. Never claim
that these establish arbitrary HTML/SVG equivalence or zero GPU cost.
