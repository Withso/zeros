# Bounded Design rendering primitives

These renderer-side helpers are preparation for representation integration, not
10,000-frame workspace support. The engine still admits at most 256 frames.
The preview cache and spatial index have no canvas consumer yet. Strict
latest-in-flight scheduling is opt-in; legacy queue callers and PNG export
keep their existing result behavior.

## Preview retention

`DesignPreviewCache` retains immutable PNG metadata independently of runtime
trees. The caller supplies an exact opaque paint key. The helper does not
construct owner identity, invent paint epochs or publish selection state.
Integration must include owner/placement/workspace/root/directory/frame,
source/dependencies, theme/fonts and representation identity, with a separate
admission epoch supplied by the canonical intent owner.

Each cache instance bounds entries, encoded string/key bytes and decoded/texture
estimates separately. Defaults are 10,000 entries, 32 MiB encoded and 128 MiB
decoded estimate; configuration may lower but not exceed them. PNG IHDR sizes
must match declared raster-pixel dimensions, not a frame's logical CSS viewport.
The decoded estimate reserves two RGBA backings
(more for 16-bit input); it is not a driver, GPU or process-memory guarantee.
Inputs are static capture PNGs, not arbitrary animated assets. The helper does
not fully decode or validate PNG contents. Use one shared pool for retained
owner surfaces rather than an instance per frame.

`put` takes ownership of an optional `ImageBitmap` only on success. `acquire`
returns a shown-image lease; release it after the consumer stops using the
image. LRU eviction skips pinned entries. Replacement and invalidation keep old
pins charged until their final release, then close owned bitmaps once. If pins
fill a budget, optional admission fails without evicting valid pixels. Oversized
or invalid input is rejected before collateral eviction. A bitmap cannot be
owned by two keys.

`clear` removes lookups but does not conceal outstanding leases from accounting.
Callers must not use a bitmap after releasing its lease or close a transferred
bitmap themselves. Encoded values or decoded resources retained by unrelated
callers are outside this pool's accounting.

## Optional work

`DesignBackgroundWorkQueue` keeps one producer callback outstanding and at most
32 queued families. Queued work retains its existing replacement behavior.
When both running and admitted incoming requests opt into `{ latest: true }`, a newer
same-family request also settles the obsolete running caller with `null`.
Legacy callers are protected because explicit PNG export shares the queue.
Opted-in background work is refused instead of replacing queued legacy work;
legacy-to-legacy queued replacement keeps its existing behavior.
At capacity, background admission evicts the oldest optional family only;
if every slot holds legacy work, the incoming background request returns `null`.
The original callback occupies its slot until its promise settles, including
across `reset`. Retired pause leases and idle callbacks cannot admit a new owner.

The queue cannot preempt browser cloning/encoding, and a parent request timeout
does not prove native work retired. Production integration must observe
completion/disposal or quarantine the producer. Decode PNGs only after accepting
a current result; the generic queue does not own discarded decoded resources.
Hidden/owner retirement and real paint/admission identity remain consumer work.

## Spatial queries

`DesignFrameSpatialIndex` is an immutable catalog-revision index of at most
10,000 frame rectangles. It supports inclusive overlap in original catalog
order and center-nearest queries, optionally constrained by an overlap region,
with file-name tie order. Queries match brute force; the index does not sort or
mutate caller arrays. Rebuild on confirmed membership/geometry changes and
discard obsolete instances. Frame records must remain immutable.

Candidate and node-bound distances use the same underflow-safe Euclidean
metric, including accepted subnormal coordinates. Equal-distance names use
locale collation, then original catalog order when distinct names collate
equally; tree traversal cannot choose a different tied membership.

Pass conservative world rectangles supplied by the geometry owner, not DOM
pixels, raster crops or unprojected nested-node coordinates. Rotated/overflowing
content needs that owner's conservative bounds before any culling integration.
Selection, camera projection, gesture hit-testing and host ordering are unchanged.

`getStats().bufferBytes` reports owned typed-array allocation, not retained frame
objects, Map/array overhead, transient build allocations or complete process
memory. Sparse queries can avoid a full-scene scan; dense all-visible queries
still materialize and sort the full result, and nearest ties/large overlaps
may visit the whole index.
This helper alone cannot make a dense overview cheap.

## Integration gates

Shared scene/paint/culling consumers use the Captain-routed ZERO-7 geometry
integration layer, retaining ZERO-6's canonical selection/intent ancestry and
these helpers. Do not start a competing canvas writer directly on selection.
ZERO-7 owns geometry/index publication, lifecycle and recovery; ZERO-10 owns the
distinct negotiated metadata catalog and bounded mutation receipts. Preserve
authored canvas v2 and current source/Foundation/journal limits. Pagination is
not an optional field on the legacy complete-snapshot response.

Local Personal, organization-local and cloud use the same pure primitives, but
authority remains at their existing owner/bridge boundaries. Helpers perform no
I/O, permission change, cloud wake, source migration or admission increase.
Real heterogeneous source/theme/font invalidation, hidden/incoming/draft context
accounting and actual Local/cloud 10k directories remain end-to-end acceptance
work; pure helper tests and metadata/PNG microbenchmarks cannot satisfy it.
