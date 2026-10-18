# Coherent renderer catalog assembly

`DesignCatalogReadAdapter` is independent renderer preparation above the distinct
`design.catalog.read.v1` / `design.catalog.read` contract. It uses the real
`WorkspaceRuntimeClient` passive facade through `bridgeDesignCatalog`; it never
opens a peer, reconnects, wakes a VM, falls back to Local, requests a legacy full
snapshot, or prepares HTML. It has no shared canvas or selection consumer yet.
Authored v1/v2 and the current 256-frame production admission are unchanged.

## Caller lifetime and publication

Use one shared adapter pool, not one per frame or request. The caller supplies a
stable `DesignCatalogReadAuthority` object for one exact owner/root/account/
connection/directory lifetime. Its owner is the public semantic owner, including
placement and organization; cloud identity is never a VM-native path. Its abort
signal retires that lifetime. `isCurrent()` must compare captured monotonic
lifetime tokens, including A→B→A; checking only the currently displayed IDs is
insufficient. The adapter does not create a second canonical UI or selection
store. Rotate the authority object when that lifetime changes.

`read(authority, intent, signal?)` starts without a cursor and follows only opaque
server cursors. The caller owns the protocol's monotonically increasing read
intent within its connection/workspace lifetime. Identical active authority,
intent and cancellation-signal inputs share one promise. A different signal does
not acquire shared cancellation ownership; it is refused for that same intent.
A higher intent supersedes the earlier logical read but does not free its
executing resources. There is no automatic retry or waiting queue.

`peek(authority)` retains the last confirmed exact-key catalog during refresh or
failure. It is presentation data, not current membership authority. Before
pruning or whole-membership actions, require
`isAuthoritative(authority, catalog)`. This gate is false during revalidation,
after failure/cancellation, for replaced snapshots, or after lifetime retirement.
It checks the successful read's signal even if cancellation arrives after
assembly. Gesture, edit/send, role and mutation/CAS authority remain the caller's
and server's existing responsibility. A resolved promise cannot revoke values
already copied elsewhere; consumers must use the publication gate.

Physical root binding is pinned to the authority. A different binding retires
that lookup and requires a new lifetime rather than painting another root under
the old key. `retire(authority)` removes its lookup/confirmed-cache ownership and
settles its logical callers, while executing staging remains charged through
actual bridge-promise settlement.

## Coverage and coherent values

Each sequence must start at offset zero, visit contiguous descriptor ranges and
finish at the declared total. Owner, root binding, metadata revision, page
headers/order/counts and intent stay exact. Per-packet protocol validation plus
cross-packet ID/portable-source uniqueness and cursor-progress checks reject
malformed, mixed or incomplete sequences. The adapter never decodes a cursor or
manufactures a coverage proof from its contents.

The wire's `coverage: "complete"` means one packet covers the whole directory.
A terminal multi-packet fragment remains `partial` with `nextCursor: null`.
Only a complete validated chain produces `kind: "coherent-design-catalog"`;
that is a new assembled type, not a rewritten packet or legacy snapshot.
Descriptors remain `preparation: "unprepared"`, without a fabricated
`sourceVersion`. An unchanged revision cannot replace confirmed contents with
different descriptor/page data.

The catalog and its owned records/arrays are immutable. Safe unchanged frame and
page references are reused within the same authority/root, even when other
descriptors or the metadata revision change. Original catalog ordering is kept.
Each successful new intent gets a fresh catalog publication identity even when
its arrays are reused, so confirming identical data cannot revive an older
cancelled publication.

## Explicit bounded ownership

Configuration can lower, never raise, these defaults:

| Bound                                                             |                   Default |
| ----------------------------------------------------------------- | ------------------------: |
| Owned authority entries, including executing retired entries      |                         4 |
| Concurrent sequences / outstanding bridge callbacks               |                         4 |
| Descriptors per coherent catalog                                  | 10,000 (protocol ceiling) |
| Aggregate owned descriptors, including cache/staging/retired work |                    40,000 |
| Pages per packet/catalog                                          |     64 (protocol ceiling) |
| Per-sequence staged payload and remembered cursor estimate        |                     8 MiB |
| Shared owned payload estimate, including reservations             |                    32 MiB |
| Reserved incoming parsed-response allowance per active callback   |                     2 MiB |
| Cumulative serialized transfer per sequence                       |              32 MiB UTF-8 |
| Round trips per sequence                                          |                    10,000 |
| Deadline anchored at admission, never renewed                     |                60 seconds |

Requests ask for the protocol maximum of 256 descriptors; each packet still has
the existing 256-KiB producer/wire ceiling. A sparse legal sequence can hit a
consumer resource limit and is refused rather than partially installed.
Inactive cached authorities may be evicted for bounded admission; the authority
being refreshed keeps its confirmed presentation snapshot. Retired executing
stages retain descriptor, byte, owner and response-reservation charges until the
underlying awaited bridge callback settles. Abort and timeout are not disposal.

`getUsage()` reports those owned estimated payload costs and callback counts.
String estimates use two bytes per UTF-16 code unit, including serialized headers,
records and remembered opaque cursors. Descriptor/container counts are bounded
separately. These are not JS-heap, browser-process or driver-memory guarantees:
container overhead, caller-held returned values, authority callback closures and
temporary validation/transport allocations are not a measured whole-process
bound. Existing facade/transport limits and the producer's independent lifetime
ledger remain in force; this adapter cannot retire remote computation hidden
behind a settled transport timeout.

The synthetic 10k metadata tests measure assembly, coverage and pool accounting
only. They do not establish registered 10k admission, source preparation,
rendered performance, Mac/native or deployed-cloud parity. Shared scene wiring
still waits for the Captain-routed corrected selection→geometry integration.
