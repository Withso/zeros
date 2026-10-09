# Cloud workspace warm pool — follow-up design

Status: proposed, disabled by default. The current overhaul implements faster
handoffs and optimistic creation; it does not allocate a pool. See
[wake performance](wake-performance.md) for evidence and endpoint definitions.

The negotiated VM-local queue/FULL mirror outbox and exact warm conversations
are separate implemented contracts, described in
[data and sync](data-and-sync.md#negotiated-local-queue-and-compact-history) and
[warm conversations](agent-authentication-and-language-tools.md#warm-conversations-and-stop).
They do not allocate prebooted unassigned VMs or qualify the pool proposed here.

Conductor's observed create path claims an already booted VM with the repository,
toolchain and agent binaries present. Zeros could prepare equivalent unassigned
slots from immutable Cloud Computer builds. This targets cold create, not true
stopped-workspace wake. A pool hit still needs required checkout/setup, fresh
attestation, engine registration, durable sync and authenticated attachment.

## Allocation and claim

Key each slot by organization, immutable active build/source snapshot, compatible
runtime/manifest/base/profile, provider account/wallet, architecture and resource
class. Finish boot/hydration and sanitize before marking ready. Do not enroll a
user engine or place user credentials, messages or actor grants in an unassigned
slot. Retention must account for pool references to builds and runtimes.

Claim one slot under the organization head and workspace/idempotency authority
with CAS or `SKIP LOCKED`. Recheck the accepted source/runtime, membership,
entitlement, generation, wallet and credit eligibility. Commit the slot's
workspace/allocation binding before issuing authority; keep provider I/O outside
locks. A build change drains old unclaimed slots without redirecting an already
accepted create. Never refresh/reset a slot after assignment to user data.

Use a durable journal: creating, unknown, ready, claiming, assigned, draining,
erased. Persist provider attempt/request identity before dispatch. Lost responses
and ambiguous claims reconcile the same attempt; they cannot return a possibly
assigned VM to ready or justify a duplicate allocation. A miss uses the existing
cold path with accurate provisioning status. Different revisions or required
hooks can dominate a hit, so report eligible hits and misses separately.

## Bounds and accounting

Suggested first experiment: Alpha staff only, one ready unassigned slot per
organization/active template, global cap four, ten-minute idle TTL and an explicit
daily infrastructure spend cap. These are proposals requiring owner approval.
Creating, cleanup-unknown and deletion-pending allocations count against the cap.
Refill at most one pending replacement per missing slot with rate limits.

Existing compute leases belong to concrete workspace/user/generation identities.
Preclaim usage needs an infrastructure-purpose ledger and budget. Claim needs a
reviewed allocation transfer and meter cursor so usage is neither charged twice
nor silently billed to a customer. Preserve funded TTL, positive stop and final
usage settlement. Compute release and snapshot-storage erasure are separate
confirmations; keep cleanup receipts until both finish.

Bound daily compute by `global cap × 24 × highest allowed hourly rate`, plus
billing minimums and measured storage/API charges. Under linear prorating, a
ten-minute idle interval costs hourly rate/6; repeated refill still needs the
daily cap. No current provider price or saving is established here.

Required tests: concurrent/idempotent claim, changed head/runtime/wallet,
funding transfer, unknown dispatch/claim, expiration, revocation, cleanup capacity,
dirty-slot isolation, miss fallback and failure after assignment. Qualification
reuse and hydration tuning need separate reviewed integrity contracts. The
protected-persistence hydration barrier and fresh proof consumption remain.

## Current transcript cache and reliability follow-ups

Desktop now implements a bounded durable presentation cache: account/org/workspace/
chat identity, server-confirmed revision and tail message ID, at most 512 windows/
64 MiB total and 200 rows/512 KiB per window. It stores sanitized presentation
fields outside engine SQLite. Exact read authority/account epoch gates exposure;
sign-out, role/catalog denial and tombstones retire it. Cached initial paint does
not satisfy send/completion or establish a running engine. Native streams and
confirmed reads supersede it. Completion/chat-departure checkpoints use existing
passive history, at most once per semantic key/30 seconds, without a timer or
VM wake. See [client/runtime contract](client-runtime-contract.md).
New-mode current-head metadata additionally fences older visible/memory/disk
windows on deletion, repair or incomplete coverage; an error cannot keep an old
transcript presented as current. The generic Local transient-error cache remains
unchanged.

Conductor's observed VM session state persists indexed notification batches
before send, removes them on backend acknowledgement and deduplicates inbox IDs.
Its Mac client keeps feed offsets/local SQLite and an acknowledged composer
outbox behind one multiplexed backend WebSocket. These observations motivate
separate proposals; they do not establish that Zeros has the same transport.

| Follow-up | Required boundary and acceptance |
| --- | --- |
| **VM durable outbox/inbox — broader recovery** | New mode already has a FULL local queue and immutable mirror outbox with exact ACK before pruning. Extend cross-allocation recovery only with authenticated writer/seal/native-retirement proof; inherited uncertain work never becomes another dispatcher or automatic replay. Legacy event outbox and broader inbox coverage remain separate. |
| **Resident outbound VM transport** | Replace measured relay/provider hops only after an authenticated reconnect/resume design. Scope engine/control/event and PTY/preview/capture lanes separately; preserve device/actor revocation, bounds and exact pin authority. Current engine outbound HTTP and per-attachment relay remain the baseline. |
| **One multiplexed client↔backend channel** | Fan workspace/chat topics over one device connection with authenticated topic admission, ordered resumable cursors, per-topic/connection budgets and independent revocation. Keep it distinct from the VM uplink; do not add a second command queue. |
| **Incremental durable transcript feed** | Existing history exposes revision plus bounded tail/older windows, not a forward after-offset feed. Add an approved cursor/watermark/tombstone contract and coherent rows/cursor persistence before claiming restart-safe incremental catch-up. Cache text is never runtime authority. |
| **Mac send outbox with acks** | Persist stable prompt/operation/generation identity before dispatch; overlay pending presentation, retry the same ID, retire on explicit server acceptance. Distinguish accepted, handed-off and settled/uncertain outcomes; protect account/workspace retirement and bound queue storage. It is separate from the read cache. |
| **Qualification reuse / hydration tuning** | Authenticate exact artifact/base/profile and restored bytes with root-controlled/signed evidence, revocation/invalidation and expiry. Measure before removing duplicate work; never reuse namespace/launch/grant proof or bypass the protected hydration barrier. |

Delivery acknowledgement alone cannot prove exactly-once arbitrary tool effects
across a crash between native handoff and recording it. Preserve uncertainty
without automatic native replay or fabricated success. Personal Local and
organization Local retain their existing engine/credentials/offline state;
cloud pool/cache/transport selection remains exact-owner and placement scoped.
