# Cloud runtime relay capacity

`CloudRuntimeBridgeRelay` forwards opaque live engine messages. It owns no
execution, durable stream history or command replay. Its limits apply to one
API process; adding Railway replicas does not create a distributed workspace
connection counter. This capacity policy is separate from Pro's ten assigned
writer slots and unlimited Read-only guest assignments.

## Memory envelope and compatibility

The two 64 MiB `ws` receivers per pair are **ceilings**, not eager allocations.
An idle pair is small. Previously eight pairs could hold 1 GiB of incomplete
payloads, with another 128 MiB of queued outbound payloads. Increasing only the
old instance/workspace counts would make the worst case grow linearly.

The relay retains the 64 MiB **message** ceiling in both directions, including
fragmented messages. `packages/protocol/src/schemas.ts` sets the engine's inbound
and desktop parser's limit to 16 MiB. The engine's `CloudClient.send` bounds
queued JSON output, not each message independently; replies such as Git diffs,
Design documents and media can exceed 16 MiB. The desktop ignores oversized
messages individually. Reducing the relay to 16 MiB would instead disconnect
the entire transport. This change does not alter any protocol schema or grant
token format.

Memory is constrained by:

- Each socket assembling at most one 64 MiB message, lazily as bytes arrive.
- A shared inbound reservation for messages over 64 KiB, acquired from their
  declared frame lengths **before** the `ws` receiver consumes a chunk. Partial
  fragments accumulate; completed reservations survive until `ws` emits the
  message. Both directions and all writers/readers share the budget.
- At most 64 KiB of uncharged small-message payload per socket: at 64 pairs,
  8 MiB; at 256 pairs, 32 MiB. This lets ordinary token/event traffic continue
  while large incomplete messages fill the shared budget.
- A 64 MiB `bufferedAmount` ceiling per target socket and a shared outbound
  reservation of `max(payloadBytes, 512)` per incomplete send. The minimum
  charges zero/tiny frames for queue metadata rather than making them free.
  Manual pong replies and periodic heartbeat pings use the same accounting;
  automatic `ws` pong replies must not bypass the budget.
- Refusal of a large inbound message that cannot reserve capacity; retirement
  of the largest outbound backlog when aggregate output is full. A tie yields
  the sender. Small healthy streams survive the measured adversarial mixes;
  a large healthy message is not guaranteed admission under pressure.
- Idempotent retirement releasing reservations, terminating both sockets and
  clearing handshake, authority and heartbeat timers. Existing five-second
  authority checks, ten-second deadlines and device/actor revocation remain.

These are live-payload/reservation budgets, **not hard RSS caps**. Allow for
masked upstream copies, receiver concatenation, fragments/buffer metadata,
GC/allocator high-water marks, TLS, kernel socket buffers and retiring sockets.
With the 2 GiB profile a useful envelope is 256 MiB inbound + 128 MiB outbound +
up to 128 MiB masking copies + a 64 MiB concatenation transient + 8 MiB small
payloads, before API baseline/metadata/GC. The measurements below include
resident high-water marks, not just V8 heap.

## Configuration

Cloud-disabled deployments ignore these variables. Unset/blank values use the
defaults. Other values must be decimal integers, not fractions, units, signs,
hex or exponent notation. Invalid values fail startup without echoing values.
Each explicit workspace ceiling must not exceed the instance ceiling; lowering
only the instance ceiling automatically clamps both workspace defaults.

| Environment variable | Default / 2 GiB recommendation | 8 GiB growth profile | Inclusive range |
| --- | ---: | ---: | ---: |
| `CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS` | 64 | 256 | 1–1024 |
| `CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS_PER_WORKSPACE` | 10 writers | 10 writers | 1–64 |
| `CLOUD_WORKSPACE_BRIDGE_MAX_READ_ONLY_CONNECTIONS_PER_WORKSPACE` | 10 readers | 10 readers | 1–64 |
| `CLOUD_WORKSPACE_BRIDGE_INBOUND_BUDGET_MIB` | 256 | 1024 | 64–16384 |
| `CLOUD_WORKSPACE_BRIDGE_OUTBOUND_BUDGET_MIB` | 128 | 512 | 64–16384 |

Both roles count toward `MAX_CONNECTIONS`. The 2 GiB default can serve six full
ten-writer workspaces (60 pairs), with four spare pairs. The 8 GiB profile can
serve 25 full ten-writer workspaces (250), with six spare pairs. Readers and
additional devices consume those same instance slots; these are not user-slot
guarantees. Workspace ceilings are independent, not reservations of instance
capacity. The pending-resolution ceiling stays 32; the sustained admission
bucket stays two lookups/second, with a reconnect burst of `max(32, instanceCap)`.

Use at least 2 GiB and retain roughly 1 GiB for the rest of the API on that
profile. The measured 8 GiB worst case leaves over 5 GiB outside the standalone
relay. Do not turn the range ceilings into production recommendations. The
8 GiB profile is memory-safe in this harness, not a promise of low latency
under maximum-frame floods. Retaining the smaller assembly/output budgets on
a larger instance is a valid choice for ordinary streaming workloads; memory
size alone does not solve synchronous large-frame masking/concatenation or
database admission/revalidation throughput.

## Read-only decision

Read-only actors **do open full relay pairs**: actor-session issuance and relay
authorization require the `read` capability; the desktop access broker opens
the same actor-aware bridge URL; the engine consumes the grant and returns its
authorized role. There is no existing observer-only wire transport to switch
to. Not opening terminals reduces traffic but not the two WebSocket receivers.

Use a separately configurable concurrent-reader ceiling (default ten), not a
new read-only protocol. This is a bounded resource policy, not a total guest or
invitation limit. Ten readers plus ten writers were measured in one workspace.
The role comes from the **existing recorded-actor authority check**, not a
client header or a second weaker lookup; owner-only legacy grants are writers.
Role/source/device changes revoke existing authority, and relay revalidation
also compares the read-only classification. Reader connections share the same
instance limits, assembly budget and outbound budget. A future multiplexed
observer path needs explicit engine/session/demultiplexing and authorization
work; merely skipping inbound commands would not make receiver memory cheaper.

## Opt-in local load harness

No provider, database, credentials or non-loopback connection is needed:

```sh
pnpm --dir apps/control-plane load:relay -- --help
pnpm --dir apps/control-plane load:relay -- --scenario sweep --duration-ms 5000
pnpm --dir apps/control-plane load:relay -- --scenario profiles --duration-ms 4000
pnpm --dir apps/control-plane load:relay -- --scenario realistic --pairs 60 --workspaces 6 --duration-ms 5000
pnpm --dir apps/control-plane load:relay -- --scenario realistic --pairs 20 --read-only-pairs 10 --workspaces 1 --duration-ms 5000
pnpm --dir apps/control-plane load:relay -- --scenario max-message --pairs 1 --adversarial 1 --message-mib 64 --duration-ms 1500
```

Use `--max-connections`, `--max-per-workspace`,
`--max-read-only-per-workspace`, `--inbound-mib`, `--outbound-mib` and
`--max-relay-rss-mib` to test another envelope; `--json` emits machine-readable
results. `sweep` explicitly tests an eight-pair override as well as larger
ceilings; it does not label the old eight-pair profile as the new default.

Fake clients/engines run in the driver, with the real relay isolated in a child
process. Only that child's RSS/heap/external memory and CPU are attributed to
the relay. An idle GC sample estimates per-pair cost. RSS peaks include the OS
resident high-water mark; heap/external peaks are sampled every 20 ms. Latency
is measured from engine emission to client receipt, with client read-request
round trips measured separately. Fairness is Jain's index of healthy delivery
ratios, excluding request replies, plus per-pair p99 and unexpected closes.

The deterministic per-pair realistic mix is 40 agent-token messages/second
(160–280 bytes), terminal output with 32 × 8 KiB bursts every 1.5–4.5 seconds,
600-byte file events each second, 32 KiB file batches every ten seconds, and
400-byte client reads with 2 KiB replies. Reader pairs omit terminal traffic.
Adversaries send exact 64 MiB binary messages in both directions, hold them
one byte short of completion, or stop reading while engines burst 64 KiB
messages. Raw adversarial peers discard payloads rather than assembling them
in the driver. Slow-reader traffic and admission are bounded.

The harness caps pairs at 512, traffic duration at 60 seconds and message size
at 64 MiB. Relay RSS defaults to a 3 GiB abort threshold (ceiling 6 GiB); driver
RSS is guarded at 3 GiB. A child lifetime limit, IPC disconnect handling and
awaited child termination prevent orphan load processes. Configuration is
validated before opening sockets; misspelled options fail. Only fast helper
unit tests run in the default suite, not the traffic scenarios.

### Local measurements

Measured October 1, 2026 on the shared Linux x86_64 VM, 8 logical CPUs,
16 GiB memory, Node 24.14.1 and `ws` 8.21.2. Profiles simulate their configured
envelopes, not actual 2/8 GiB cgroup deployments. Realistic rows run five seconds;
stress-profile rows run four seconds with one-quarter adversarial pairs. All
healthy delivery indices are 1.0000 and no healthy pair closes in those mixes.

| Pairs | Traffic/profile | Peak RSS MiB | Peak heap MiB | Healthy latency p50 / p99 ms |
| ---: | --- | ---: | ---: | ---: |
| 8 | realistic | 94.3 | 20.1 | 0.31 / 3.18 |
| 64 | realistic | 104.2 | 21.6 | 0.92 / 3.91 |
| 128 | realistic | 103.6 | 22.9 | 1.45 / 5.24 |
| 256 | realistic | 127.0 | 31.6 | 2.72 / 8.53 |
| 60 | six full writer workspaces | 100.8 | 21.5 | 0.97 / 4.37 |
| 20 | one workspace: 10 writers + 10 readers | 96.0 | 20.6 | 0.44 / 1.54 |
| 64 | 2 GiB: held assembly | 359.1 | 20.6 | 0.73 / 23.75 |
| 64 | 2 GiB: max messages | 663.8 | 15.5 | 1.42 / 1695.03 |
| 64 | 2 GiB: slow readers | 360.2 | 27.4 | 0.69 / 85.36 |
| 256 | 8 GiB: held assembly | 1185.4 | 45.6 | 2.57 / 80.64 |
| 256 | 8 GiB: max messages | 2202.2 | 34.8 | 764.96 / 2832.45 |
| 256 | 8 GiB: slow readers | 868.2 | 40.4 | 3.51 / 387.89 |

At 64–256 idle pairs the incremental heap is about 20–28 KiB/pair; incremental
RSS is allocator-sensitive (about 16–41 KiB/pair). At eight pairs initialization
cost inflates the per-pair heap estimate. The relay alone starts around 88 MiB
RSS. The old compatibility envelope's eight held pairs used 1118.5 MiB RSS and
1024 MiB inbound reservations; the new eight-pair held-assembly run peaks at
344.6 MiB RSS and 256 MiB reservations. Connection count is not the dominant
memory cost. Refusal sweeps admit exactly 8/9 and 64/65, with HTTP 429 for excess.
Realistic relay CPU is about 13% of one core at 64 pairs and 32% at 256 pairs.

Maximum-message stress deliberately retires competing large senders; measure
single-pair maximum-message delivery separately rather than interpreting
refused floods as successful bulk throughput. Large-message p99 spikes are
real, even when memory stays safe and small streams eventually all arrive.
The single-pair compatibility run completes four bidirectional 64 MiB transfers
without closure, with a 473 ms median transfer and 408.9 MiB peak RSS.

## Observability and deployment follow-up

Startup prints configured limits. `stats()` exposes admitted/rejected/retired
counters by fixed reason, writer/reader occupancy and current/peak reservations.
Pressure/refusal warnings are limited to once per reason per minute, with
suppressed repeats counted; five-minute activity summaries report deltas and
peak budget use. Output contains no tokens, identifiers, endpoints, addresses,
paths or payloads. These are process-local counters, not a public tenant API.

Not verified here: actual Railway cgroup limits, full API/worker/database memory,
production TLS/kernel buffer cost, live provider latency or credit behavior,
long-duration churn/allocator fragmentation, every pathological fragmentation
shape, multi-instance workspace ceilings/reader distribution and rollout
behavior. Per-process workspace limits are not entitlement enforcement and do
not provide a global ten-writer connection cap across replicas. Production
qualification must monitor RSS, CPU, rejection reasons and database latency
with these headroom allowances before increasing connection or memory budgets.
