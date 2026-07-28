# Cross-device sync + team collaboration architectures — research notes

Researched: 2026-07-02. For: Zeros cloud workspaces (Daytona sandboxes run the full Zeros engine; zeros.db SQLite lives WITH the engine in the sandbox; Mac app connects over WSS; Supabase pencilled in for auth + registry).

Confidence labels: **[verified]** = read from primary source (fetched page); **[likely]** = secondary source or search-result summary, consistent across sources; **[unverified]** = single/secondary source, could not confirm.

---

## 0. TL;DR — the three architectures and where Zeros fits

There are three mainstream architectures (2025–2026) for "same-login cross-device sync + shared team workspaces + live collaborative feeds":

1. **Central DB of record (Postgres) + realtime fan-out** — server writes to Postgres, pushes change events to all connected clients (Supabase Realtime, Ably, Pusher, or a plain WebSocket server). Simple, durable, easy membership. Chat apps and dashboards live here. Slack is the giant-scale version.
2. **Sync engines** — client keeps a real local database (IndexedDB/SQLite) that syncs against server Postgres: Linear's custom engine, Rocicorp Zero (1.0 stable June 2026), ElectricSQL (read-path), PowerSync (bidirectional), Replicache (legacy). Gives instant local reads/writes + offline. Server stays authoritative; **none of these use CRDTs**.
3. **Engine-owned DB / "session backend"** — one live server process per workspace/document that all clients connect to; it holds authoritative state in memory/local DB and persists asynchronously to blob storage. Figma multiplayer, Jamsocket/Plane, and (host-local variant) VS Code Live Share. **This is exactly Zeros' current plan** (engine + zeros.db in the Daytona sandbox).

Headline conclusion for Zeros: the engine-owned-DB plan is a **validated, named industry pattern** ("session backends", Figma's process-per-document). Its two known weaknesses — durability of the in-sandbox DB, and workspace discovery/membership — are solved in practice by (a) checkpoint + journal persistence (Figma's exact playbook, numbers below; Zeros' "export blobs" = checkpoints) and (b) a **small central Postgres control plane** for identity, workspace registry, and membership (Figma does the same: sharded Postgres for metadata, live process for the document). Agent chat needs **no CRDT** — it is an append-only, server-ordered stream; the one engine per workspace is the single writer that assigns sequence numbers, and the 2025-standard resumable-stream pattern (monotonic offsets, "give me everything after offset X") gives reconnection, multi-device tailing, and shared team feeds for free.

---

## 1. Pattern A: Central Postgres + realtime fan-out

### 1.1 Supabase Realtime (the pencilled-in option)

Mechanics **[verified — supabase docs]**:
- Elixir/Phoenix service offering three primitives: **Broadcast** (ephemeral client↔client messages), **Presence** (shared online-state sync), **Postgres Changes** (stream DB changes to authorized clients).
- **Postgres Changes does not scale well**: every change event must be access-checked per subscriber. Supabase's own docs say at scale you should either use a public table without RLS, or consume changes server-side and re-broadcast ("Broadcast from Database" is the recommended newer pattern — trigger-based, lets you pick actions/columns).
- Critical caveat, direct from docs: "**The server does not guarantee that every message will be delivered to your clients**" — i.e., Supabase Realtime is a *hint channel*, not a message bus of record. Pattern: write chat/state to Postgres (record), broadcast (hint), client refetches to reconcile.
- Broadcast replay retention: 72 hours, max 25 messages per replay request **[verified]**.

Limits by plan **[verified — supabase.com/docs/guides/realtime/limits, 2026]**:

| Metric | Free | Pro | Pro (no spend cap) / Team | Enterprise |
|---|---|---|---|---|
| Concurrent connections | 200 | 500 | 10,000 | 10,000+ |
| Messages/sec | 100 | 500 | 2,500 | 2,500+ |
| Channels per connection | 100 | 100 | 100 | 100+ |
| Presence keys per object | 10 | 10 | 10 | 10+ |
| Presence messages/sec | 20 | 50 | 1,000 | 1,000+ |
| Broadcast payload | 256 KB | 3 MB | 3 MB | 3 MB+ |

Presence calls are throttled to 5 per client per 30 seconds on all plans **[verified]**.

Pricing **[verified — supabase.com/pricing, 2026-07]**: Free $0; Pro $25/mo; Team $599/mo. Realtime usage on Pro/Team: 500 peak concurrent connections included, then **$10 per 1,000**; 5M messages/mo included, then **$2.50 per million**. Auth MAU: Free 50k; Pro/Team 100k included then **$0.00325/MAU**.

Scale note **[likely — supabase benchmarks page]**: Supabase publishes k6 benchmarks of Realtime clusters (2–6 nodes) reaching tens of thousands of concurrent users for database-change subscriptions.

### 1.2 Managed realtime: Ably vs Pusher

Ably pricing **[verified — ably.com/pricing, 2026-07]**:
- Free: 6M messages/mo, 200 concurrent connections, 500 msg/s, 1-day message storage.
- Standard: **$29/mo base** + $2.50/M messages + $1.00/M connection-minutes; 10k concurrent connections; **30-day message history**.
- Pro: $399/mo base, 50k connections, 365-day history. Volume discounts to $0.50/M messages.
- Ably's differentiators: guaranteed ordering, exactly-once delivery, **history/rewind so clients can replay missed messages after reconnect** — which is precisely the primitive an agent-chat feed needs. Multi-region (<65 ms claimed) **[likely]**.

Pusher **[likely — comparison pages, 2025]**: Startup plan ~$49/mo for 500 concurrent connections and 1M messages/day; quota-based (pay for the tier, not usage); single-datacenter routing per app. Simpler but weaker guarantees (no history/replay tier comparable to Ably). Consensus in 2025 comparisons: Pusher for simple ephemeral events, Ably when delivery guarantees matter.

### 1.3 Plain WebSocket server

Still the default at scale — Slack's architecture **[likely — slack.engineering "Real-time Messaging" + InfoQ 2023]**:
- Stateful in-memory **Channel Servers** (consistent-hashed per channel, hold recent history) + stateful **Gateway Servers** (hold each user's WebSocket + channel subscriptions, deployed multi-region) + Envoy for load balancing millions of concurrent sockets.
- Message flow: client → Webapp API → Admin Servers → Channel Server (assigns order) → all subscribed Gateway Servers worldwide → clients. I.e., **Slack chat is server-ordered fan-out over an in-memory per-channel process — not a CRDT** — with MySQL/Vitess as the durable store behind it.
- Lesson for Zeros: the world's biggest chat product uses exactly the "single ordering authority per channel + fan-out + durable store behind" shape that Zeros' per-workspace engine gives naturally.

---

## 2. Pattern B: Sync engines (client-side DB synced to server Postgres)

### 2.1 Linear's sync engine — the reference implementation

Source: reverse-engineering repo endorsed by Linear's CTO (github.com/wzhudev/reverse-linear-sync-engine) **[verified — fetched]**:

- **Client model**: IndexedDB as a real local database (per-workspace `linear_<hash>` DB) + in-memory object pool (`modelLookup`, MobX-observable models). UI reads/writes are pure local operations → ~50 ms page loads.
- **Writes**: "client-side operations will never directly modify the tables in the local database" — changes go through a **transaction queue** (created → queued → executing), persisted to a `_transaction` table so offline mutations survive restarts; sent as batched GraphQL mutations.
- **Ordering**: the server assigns a **globally monotonically increasing `lastSyncId`** ("the version number of the database" — one counter across all of Linear, not per workspace). Clients compare local vs server `lastSyncId` to detect gaps and run incremental sync.
- **Fan-out**: WebSocket **delta packets** (Insert/Update/Archive/Delete/…) each tagged with `lastSyncId`; `applyDelta` updates memory + IndexedDB.
- **Conflicts**: **no CRDTs**. Last-write-wins on simple properties; server-authoritative ordering; rejected mutations roll back on the client.
- **Big-workspace strategy**: full vs **partial bootstrap** (per sync group, e.g. per team), lazy hydration via partial indexes, `/sync/batch` on-demand fetch.
- **Permissions**: `subscribedSyncGroups` (user IDs, team IDs, roles) — the server only sends deltas for groups you can access. Sync groups = the permission boundary of the sync protocol.

### 2.2 Rocicorp Zero

- **Zero 1.0 shipped June 8, 2026** — first stable release after ~2 years, 50+ releases **[verified — InfoQ, 2026-06]**. (Note: zero.rocicorp.dev/docs/roadmap still served a stale "pre-beta, beta late 2025/early 2026" page when fetched — trust the dated InfoQ report.)
- Architecture: `zero-client` (in-app, IndexedDB cache) + `zero-cache` (server service maintaining a read-only Postgres replica); queries in **ZQL** run against local cache instantly while authoritative results sync in the background. Server-authoritative writes ("custom mutators"), rebase-on-conflict, server-run permission model.
- **Apache-2 licensed, fully self-hostable** (client and server) **[verified — zero.rocicorp.dev/docs/open-source]**; Rocicorp monetizes via a managed service (invite-only SaaS as of Q4 2025 roadmap).
- 1.0 limitations **[verified — InfoQ]**: Postgres only; no views; some column types unsupported (arrays); no SSR; client bundle 718 KB uncompressed / 232 KB gzipped; client API lacks rejected-update handling.

### 2.3 ElectricSQL

- **Read-path only** sync engine: streams "Shapes" (filtered table subsets) from Postgres to clients over HTTP; **writes go through your own API** — deliberate, avoids bidirectional-sync complexity **[verified — electric docs + comparisons]**.
- Scales through CDN caching (claims of millions of concurrent clients on read path) **[likely]**.
- **Durable Streams** (announced 2025-12-09, Apache 2.0) **[verified — electric blog]**: a standalone persistent-stream primitive + HTTP protocol extracted from Electric — "reliable, resumable, real-time data streaming into client applications." Mechanics: streams are append-only; clients resume with **opaque monotonic offsets** ("everything after offset X"); server is stateless per-client; offset-based GETs are CDN/browser-cacheable; explicitly pitched for **AI/LLM token streaming and agentic applications**. This is the clearest public statement of the exact protocol shape Zeros' agent-chat feed should speak. It's the transport foundation of Electric 2.0.
- **Electric Cloud pricing (self-serve, announced April 2026)** **[verified via search summary of electric-sql.com/blog 2026-04-02]**: $1 per million writes (10 KB per write unit), $0.10/GB-month retention; bills under $5/mo waived (≈5M writes free); Pro $249/mo and Scale $1,999/mo act as prepaid credits with 10%/20% discounts. **"Egress, fan-out, concurrent users and data delivery are unlimited... costs scale with writes, not users."**

### 2.4 PowerSync

- Full **bidirectional** sync: Postgres (also MongoDB/MySQL/SQL Server) → client SQLite via Sync Rules/buckets; client writes go into a persistent upload queue that replays through *your* backend API. Strongest true-offline story of the three; most mature for mobile **[likely — multiple comparisons]**.
- Pricing **[verified — powersync.com/pricing, 2026]**: Free: 2 GB synced/mo, 500 MB storage, 50 peak connections (free projects deactivate after 1 week idle). **Pro $49/mo**: 30 GB synced incl ($1/GB after), 1,000 connections incl ($30/1,000 after). Team $599/mo (SLA, SOC 2/HIPAA). **Open Edition: free, source-available, self-hosted, same core functionality.**

### 2.5 Convex's framing: "object sync engine" (useful mental model)

From stack.convex.dev/object-sync-engine **[verified — fetched]**:
- Linear-style sync = an **object graph** synced between clients and a centralized server (small objects, rich relationships) — distinct from *document* sync (Figma file, text doc).
- "**Anything less than serializability is way too hard of a programming model for most apps**" — argument for a strongly-ordered, server-authoritative core.
- Convex itself uses "server reconciliation," not CRDTs: mutations are self-contained and rebased on the server; the central server removes the need for peer-to-peer merge.
- Practical envelope for object sync: **~100 MB local storage, ~1 Hz update rates** for interactive UI; anything higher-frequency (Figma-style multiplayer cursors/drawing) belongs in a **separate specialized channel**. → For Zeros: workspace/registry metadata sync and agent-token streaming should be two different mechanisms.

---

## 3. CRDTs: when they're actually needed (and when not)

- **Figma explicitly rejected both OT and true CRDTs** **[verified — figma.com/blog/how-figmas-multiplayer-technology-works]**: documents are trees of objects (`Map<ObjectID, Map<Property, Value>>`); conflict resolution is **last-writer-wins at the property level**; the server is "the central authority," which allows "a faster and leaner implementation" than a real CRDT; OT was "unnecessarily complex for our problem space." Client-side trick: unacknowledged local changes take display precedence over server updates ("our best prediction of what the eventually-consistent value will be"). Fractional indexing for child order; server rejects reparenting that would create cycles.
- Rule of thumb across sources **[likely]**: CRDTs earn their complexity only when there is **no single ordering authority** — peer-to-peer, true offline-first multi-writer, or character-level concurrent text editing. If a server (or single engine process) exists and can order events, server-ordered LWW/append-only is simpler, smaller, and semantically predictable. CRDT costs: per-character/op metadata, memory, and "technically consistent but semantically surprising" merges.
- **Chat specifically**: an append-only, server-ordered log. Every major precedent (Slack, Linear's comment streams, Ably's AI transport, Electric's Durable Streams) models chat/feeds as a sequence-numbered log, not a CRDT.
- **CRDT libraries for the later design-canvas need**: **Yjs** — most production adoption; **Automerge 3.0 (Aug 2025)** — rearchitected to use its compressed representation at runtime, **>10x memory reduction** (Moby-Dick-sized doc: 700 MB in v2 → **1.3 MB** in v3) **[verified — automerge.org/blog/automerge-3 via search + HN 2025-08]**. Both are viable in 2026; Yjs for maturity/ecosystem (y-sweet et al.), Automerge for richer history semantics.

**Zeros implication**: agent chat = append-only ordered stream with one writer (the workspace engine) → **no CRDT, full stop**. A future collaborative design canvas is the only Zeros surface where Yjs/Automerge would enter, and even then Figma's property-LWW-with-central-server is the lighter option since Zeros workspaces already have a central engine.

---

## 4. Pattern C: Engine-owned DB / session backends (Zeros' chosen topology)

### 4.1 The pattern, named

- **Figma multiplayer** **[verified — figma blog]**: "our servers currently spin up a **separate process for each multiplayer document** which everyone editing that document connects to" over WebSockets. The process is the single authority for that document's live state.
- **Jamsocket/Plane** productized this as "**session backends**" **[verified — github.com/jamsocket/plane + plane blog via search]**: "an API for running ephemeral processes across a cluster... each process gets its own hostname... when all connections drop, Plane shuts it down." **"Plane guarantees that only one process will be running for each key at any given time, allowing that process to act as an authoritative source of document state."** Explicit use cases: authoritative multiplayer backends, and **isolated code environments (REPLs, notebooks, LLM sandboxes)**. Example: design tool Rayon shares one backend process among all clients of a document as the "shared server-side in-memory source of truth... for conflict resolution." Rust, ~2k stars. (Jamsocket's infra reportedly "got a new home with Modal" per The New Stack — article paywalled, **[unverified]**.)
- **VS Code Live Share** is the *host-local* variant **[verified — Microsoft Learn]**: one host + N guests; direct P2P when possible, Microsoft cloud relay otherwise; SSH/E2E-encrypted; **all content stays on the host machine, nothing synced to the cloud** — which means the session dies when the host closes the laptop. Zeros' cloud engine is precisely "a Live Share host that never sleeps."

### 4.2 Durability — the pattern's known weakness, and Figma's exact fix

**[verified — figma.com/blog/making-multiplayer-more-reliable, 2022-10-20]**:
- Original scheme: **checkpoint every 30–60 s** — whole file encoded to binary, compressed, uploaded to **S3**. Data-loss window on crash: up to 60 s.
- Fix: **write-ahead journal in DynamoDB** alongside checkpoints. Journal entries are the same deltas clients send (orders of magnitude smaller than snapshots), batched, each with per-file incrementing sequence numbers. Result: "**95% of edits to a Figma file get saved within 600 ms**"; data-loss window **<1 second**. Recovery = load latest checkpoint + replay journal entries with higher sequence numbers. Scale: journal handles **>2.2B changes/day**. DynamoDB chosen over Postgres for write volume.
- Figma's overall storage split: S3 for file checkpoints, DynamoDB for WAL, **horizontally sharded Postgres for metadata** (users, teams, file registry, permissions).

**Zeros mapping**: zeros.db in the sandbox = Figma's in-memory doc; the planned "cheap export blobs to object storage" = checkpoints. The gap in the current Zeros plan is the **journal**: to get sub-second durability for chat, append each chat event (or small batches) to object storage / a cheap append store between exports, keyed by the same sequence numbers the stream already needs. Since agent chat is low-rate (tokens can be journaled per message-part, not per token), even a 5–15 s chat-journal flush would beat "last export blob" by a wide margin.

### 4.3 Tradeoffs: engine-owned vs central-DB (summary table)

| Dimension | Engine-owned DB (session backend) | Central Postgres + fan-out |
|---|---|---|
| Latency/authority | Best — single writer next to the agent; no cross-region DB hop; ordering is trivial | Extra hop; ordering via DB or channel server |
| Collaboration | Native — everyone connects to the same live process (Figma/Rayon precedent) | Native, but server must re-implement per-workspace ordering/rooms |
| Durability | **Weakest by default** — must add checkpoint+journal (Figma playbook) | Postgres = durable by default |
| Read access when engine is asleep/dead | Needs wake-on-connect or read-from-last-export path | Always readable |
| Offline (client) | Client caches what it saw; resume via offsets | Same, or full sync engine |
| Membership/discovery | **Cannot live in the engine** — a workspace you can't find/can't authorize into is useless; needs central registry | Native |
| Cost | Pay per live workspace (idle-suspend critical — cf. Sprites/Daytona auto-stop) | Pay per DB + channel volume |
| Ops | Process lifecycle, one-process-per-key guarantee, reconnect logic | Boring, well-trodden |

Consensus across Figma/Plane/Convex sources: **hybrid is the norm** — live/hot state in the per-workspace process, identity + registry + membership + billing in central Postgres, snapshots in object storage. Nobody serious runs "engine-owned only."

---

## 5. Agent-chat streaming: the resumable-stream pattern (2025–26 standard)

Two independent primary sources converge on the same design:

**Ably "Reliable, resumable token streaming" [verified — ably.com/blog/token-streaming-for-ai-ux]**:
- Raw SSE/HTTP streaming is fragile: "if you're streaming an AI response over a standard HTTP connection and it drops, that request is gone"; backends often treat streams as fire-and-forget and discard tokens after emission.
- Fix #1 — **decouple generation from delivery**: generation runs in its own process and *publishes* to a channel; the client connection is merely a consumer. Client disconnects never kill the agent turn. (Zeros already has this by construction: the engine keeps running in the sandbox.)
- Fix #2 — **server-side buffering + replay**: persist every token/part at least until safely delivered; on reconnect the client presents a resume token / last-seen sequence ID and the server replays only the gap, then goes live.
- Fix #3 — **sequence IDs on every chunk** → ordered, exactly-once, no gaps/dupes.
- Multi-device continuity falls out for free: same session ID from a second device replays the backlog then tails live — this is also exactly the "teammate opens the shared workspace mid-turn" case.

**ElectricSQL Durable Streams (2025-12-09, Apache 2.0) [verified]**: same pattern as an open HTTP protocol — append-only streams, **opaque monotonic offsets**, resume = GET after-offset, stateless server, CDN-cacheable reads, explicitly aimed at "AI/LLM token streaming" and "agentic applications." Node reference server + TS clients shipped; a self-hostable option if Zeros ever wants a standard protocol instead of a bespoke WSS framing.

Supporting patterns **[likely]**: Vercel AI SDK "resume streams", LibreChat resumable streams, and Redis-Streams-buffer architectures all implement the same offset/replay idea — it is now table stakes for AI chat UX.

**Zeros implication**: give every workspace chat stream a per-workspace monotonic sequence (zeros.db rowid works); the WSS protocol should support `subscribe(stream, after_seq)`; the Mac app stores `last_seq` per workspace. That one design choice simultaneously delivers: reconnect-without-loss, laptop-lid-close resume, second-device catch-up, teammate live-tail, and the journal keys for durability (section 4.2).

---

## 6. Identity & auth for multi-device + teams

### Pricing/facts (all fetched 2026-07)

**Supabase Auth [verified — supabase.com/pricing]**: Free 50,000 MAU; Pro ($25/mo) 100,000 MAU included, then $0.00325/MAU. Auth is bundled with the DB/Realtime; RLS integration. No SAML SSO/SCIM story worth relying on for enterprise (consensus of 2026 comparisons: "rule Supabase out if you need SSO/SCIM" **[likely]**).

**Clerk [verified — clerk.com/pricing]**: Free 50,000 MRU ("monthly retained users" — new 2026 pricing unit); Pro $25/mo ($20 annual) with overages from $0.02/user; **B2B orgs**: 100 MROs (retained organizations) included, B2B add-on $100/mo with additional MROs from $1; **1 enterprise SSO connection (SAML/OIDC) included, $75/mo each after** (volume to $15 **[likely]**); SCIM bundled free on enterprise connections **[likely — Clerk articles]**. Strength: prebuilt UI components incl. `<OrganizationSwitcher>`, org invitations, roles — fastest path to polished multi-tenant UX.

**WorkOS [verified — workos.com/pricing]**: User management **free to 1,000,000 MAU** (then $2,500/mo per additional 1M); **SSO $125/connection/mo** (tiered: $100 at 16–30, $80 at 31–50, $65 at 51–100, $50 at 101–200); **Directory Sync (SCIM) same per-connection tiers**; Audit Logs: $125/mo per SIEM stream + $99 per 1M events retained. Positioning: enterprise-readiness (SSO, SCIM, Admin Portal) as an add-on layer, priced per enterprise customer rather than per seat — costs align with closed enterprise deals **[verified — workos blog + pricing]**.

### Recommendation shape for Zeros

- Now: **Supabase Auth is sufficient and free at Zeros' scale**, and it double-serves as the control-plane DB + Realtime provider — smallest surface area. Multi-device same-login is trivial with any of these (JWT per device; sandbox WSS tokens minted by the control plane).
- The per-user sandbox token in the current Daytona plan is an app-level concern regardless of IdP — keep tokens short-lived and minted by the thin worker/control plane, not baked into the app.
- Later, when the first "we need Okta" deal appears: **add WorkOS for SSO/SCIM only** ($125/connection — charge it to the enterprise plan) without replacing the base identity layer; this is WorkOS's designed use. Choose Clerk instead only if Zeros wants its prebuilt org-management UI badly enough to swap identity providers.

---

## 7. Workspace membership & roles: Slack / Notion / Linear / Figma

From WorkOS's analysis (fetched) + product docs **[verified — workos.com/blog/multi-tenant-permissions-slack-notion-linear]**:

- **Slack**: Primary Owner / Owners / Admins / Members / **Guests**; Enterprise adds narrow "system roles" (Channels Admin, User Admin, Compliance Admin, Roles Admin) and custom roles scoped to specific workspaces in a Grid org; IdP group mapping for automated assignment.
- **Notion**: workspace roles = Workspace Owner, Membership Admin (Enterprise), Member, Guest; the real unit is the **teamspace** (sub-container with own membership + permission levels; workspace settings are the baseline, teamspaces tighten/loosen); per-page access levels (Full access / Can edit / Can edit content / Can comment / Can view); SCIM-synced permission groups on Enterprise.
- **Linear**: deliberately minimal — **Admin, Member, Guest** (Owner added on Enterprise); **no custom workspace roles**; instead **team owners** get delegated control of team settings, and **private teams** (Business/Enterprise plans) act as "a first-class access control primitive." Team-scoped roles solve the admin bottleneck without role sprawl.
- Figma: org → teams → projects → files with viewer/editor per level (not covered in the fetched article; **[likely]** from product docs).

Four convergent principles (article's synthesis, all three products):
1. **Scoped customization** — keep the global role list tiny; push variation to the team/teamspace boundary.
2. **Progressive complexity** — sensible defaults, opt-in complexity; nobody configures permissions on day one.
3. **IdP group mapping** is the enterprise scaling mechanism for role assignment.
4. **Structural boundaries beat permission flags** — private teams/teamspaces control access by containment, which is easier to audit.

**Zeros recommendation**: copy Linear. Org (team) → workspaces; roles = Admin / Member (+ Guest for external collaborators later); a workspace is **private by default to its members**, shareable to the org — privacy by containment, not by ACL matrix. Membership lives in the central control-plane Postgres (it must — the engine can't authorize connections to itself without an external authority). The engine enforces at connection time: control plane mints a WSS token asserting {user, workspace, role}; engine validates and scopes capabilities (e.g., Guest = read-only chat tail). This mirrors Linear's sync groups: the permission boundary lives in the token/subscription, not in every message.

---

## 8. Competitor + adjacent context (checked while researching)

- **Conductor Cloud Workspaces run on Vercel Sandbox** **[verified — vercel.com blog, 2026-05-27]**: "remote execution layer built on Vercel Sandboxes"; agents spin up on remote servers; "close the lid without interrupting work"; UI identical to local ("They don't know the difference" — Charlie Holtz, CEO). Chose Vercel for spin-up speed, snapshot support, longevity, support. Used by teams at Notion, Linear, Ramp, Life360. **The founder-context claim that Conductor uses Fly.io (Sprites) + Fly-hosted backend/cloud DB could NOT be confirmed by any public source found** — treat as unverified; the only public infra fact is Vercel Sandbox.
- **Fly.io Sprites** (launched ~Jan 9–13, 2026) **[verified — multiple reports + sprites.dev]**: hardware-isolated persistent Linux VMs for agents; ~1–2 s creation; checkpoint/restore; auto-idle stops billing while preserving state; $0.07/CPU-hr, $0.04375/GB-hr RAM; a 4-hour Claude Code session ≈ $0.44. Relevant to Zeros as (a) the durability model to emulate on Daytona (auto-stop + object-storage-backed state) and (b) a fallback sandbox vendor.
- **Daytona** (Zeros' chosen vendor) has auto-stop/auto-archive semantics — pairs naturally with the wake-on-connect requirement in section 4.3 (covered in the separate Daytona research; not re-verified here).

---

## 9. Concrete recommendations for Zeros (synthesis)

1. **Keep the engine-owned zeros.db plan** — it is the session-backend pattern with strong precedent (Figma, Rayon/Plane, Live Share). One live engine per workspace = single writer = trivial ordering for chat and collab-native fan-out.
2. **Add the Figma durability pair**: periodic full export blobs (already planned = checkpoints) **plus a lightweight append journal** of chat events (sequence-keyed) flushed every few seconds to object storage. Target: <10 s data-loss window now, <1 s later; recovery = latest export + journal replay. Without the journal, a sandbox crash loses everything since the last export.
3. **Model agent chat as an append-only, server-ordered log with per-workspace monotonic sequence numbers.** No CRDTs. Implement `subscribe(after_seq)` resume in the WSS protocol (Durable-Streams-style offsets). This one primitive delivers reconnect, cross-device catch-up, teammate live-tail, and journal keys.
4. **Decouple generation from delivery** (already true: engine keeps running when the Mac disconnects) and **buffer + replay** on the engine side (Ably pattern) — never treat a client socket as the stream owner.
5. **Keep a small central control plane in Postgres** (Supabase as pencilled): users, orgs, workspace registry, membership/roles, sandbox pointers, token minting. This is Figma's "sharded Postgres for metadata" role. Use Supabase Realtime broadcast only as a *hint* channel for registry changes (workspace created/renamed/member added) — DB is record, broadcast is hint, client refetches; remember Supabase does not guarantee delivery.
6. **Presence = ephemeral in-engine state** over the existing WSS (who's connected to this workspace, who's typing) — Figma does presence in the multiplayer process; never persist it. Supabase Presence is an option for the *app-level* "which teammates are online" indicator but is throttled (5 calls/30 s, 10 keys) — engine-side is cleaner for per-workspace presence.
7. **Don't adopt a general sync engine (Zero/Electric/PowerSync) for v1.** Chat lives in the engine; the registry is small enough for fetch+hint. Revisit Zero (1.0, Apache-2, June 2026) or Electric if Zeros later wants Linear-grade instant/offline metadata UX across hundreds of workspaces; Linear's mechanics (IndexedDB cache, transaction queue, lastSyncId, sync-group permissions) are the blueprint if built by hand.
8. **Roles: Linear-minimal.** Admin/Member (+Guest later), workspace privacy by containment, roles asserted in the WSS token, engine enforces. No custom roles until enterprise demands them.
9. **Auth: stay on Supabase Auth now (free ≤50k MAU); bolt on WorkOS per-connection ($125/mo/connection SSO + same for SCIM) when the first enterprise deal lands.** Clerk ($25/mo, orgs add-on $100/mo) only if prebuilt org UI is worth a provider swap.
10. **If Zeros ever adds a design canvas**: start from Figma's property-level LWW-with-central-engine (cheap, fits the existing single-writer engine) before reaching for Yjs/Automerge; if true CRDT is needed, Automerge 3.0 (Aug 2025) removed the historical memory objection (10x reduction; 700 MB → 1.3 MB case).

---

## 10. Open questions / could not verify

- Conductor's alleged Fly.io Sprites usage + Fly-hosted backend/cloud DB and how its cross-device sync/shared-team-workspace data layer actually works — no public sources; only Vercel Sandbox is confirmed (Vercel blog, 2026-05-27).
- Jamsocket/Plane current maintenance status after the reported Modal transition (The New Stack article inaccessible); Plane repo shows activity but license type wasn't confirmed on-page.
- Zero's managed-SaaS pricing (invite-only as of the Q4-2025 roadmap; no public price found); also its roadmap page appears stale vs the 1.0 release.
- Clerk's "SCIM free on every enterprise connection" claim comes from Clerk's own marketing articles, not the pricing page fetch.
- Pusher's exact current pricing tiers (taken from 2025 comparison pages, not pusher.com directly).
- Supabase Realtime real-world ceiling for the "broadcast from database" pattern at Zeros-like scale (benchmarks exist but are vendor-run).
- Linear details are from a CTO-endorsed reverse-engineering, not first-party docs — mechanics are credible but versions/internals may have moved.

---

## Sources

- https://www.figma.com/blog/how-figmas-multiplayer-technology-works/ — Figma multiplayer architecture, process-per-document, LWW, OT/CRDT rejection (fetched)
- https://www.figma.com/blog/making-multiplayer-more-reliable/ — checkpoints to S3 (30–60 s), DynamoDB journal, 600 ms/95%, <1 s loss window, 2.2B changes/day (fetched)
- https://github.com/wzhudev/reverse-linear-sync-engine — Linear sync engine mechanics (CTO-endorsed reverse engineering) (fetched)
- https://stack.convex.dev/object-sync-engine — object sync engine design space, serializability quote, 100 MB/1 Hz envelope (fetched)
- https://www.infoq.com/news/2026/06/zero-version-1/ — Zero 1.0 release facts, 2026-06-08 (fetched)
- https://zero.rocicorp.dev/docs/roadmap — Zero roadmap (stale content when fetched; noted) (fetched)
- https://zero.rocicorp.dev/docs/open-source — Zero Apache-2 licensing, self-hosting (search)
- https://electric.ax/docs/reference/alternatives — Electric positioning vs alternatives (fetched)
- https://electric.ax/blog/2025/12/09/announcing-durable-streams — Durable Streams protocol, offsets, AI token streaming, Apache 2.0 (fetched)
- https://electric-sql.com/blog/2026/04/02/electric-cloud-pricing — Electric Cloud pricing ($1/M writes, unlimited fan-out) (search summary)
- https://powersync.com/pricing — PowerSync plans and usage rates (fetched)
- https://www.powersync.com/blog/new-open-era-for-powersync — Open Edition (search)
- https://supabase.com/docs/guides/realtime/limits — Realtime limits by plan (fetched)
- https://supabase.com/pricing — Supabase plan + Realtime/Auth usage pricing (fetched)
- https://supabase.com/docs/guides/realtime/concepts and /postgres-changes and /benchmarks — Realtime primitives, Postgres Changes scaling caveats, delivery non-guarantee (search)
- https://supabase.com/blog/realtime-broadcast-from-database — broadcast-from-database pattern (search)
- https://ably.com/pricing — Ably free/Standard/Pro pricing, history retention (fetched)
- https://ably.com/blog/token-streaming-for-ai-ux — resumable AI token streaming architecture (fetched)
- https://ably.com/compare/ably-vs-pusher and https://ably.com/topic/pusher-pricing — Pusher comparison/pricing (search)
- https://jamsocket.com/blog/session-backends and https://plane.dev/concepts/session-backends — session backends concept (fetch blocked 402; facts via search summaries)
- https://github.com/jamsocket/plane — Plane one-process-per-key guarantees, use cases (fetched)
- https://thenewstack.io/jamsockets-session-lived-infra-gets-a-new-home-with-modal/ — Jamsocket→Modal (inaccessible; headline only)
- https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/connectivity and /reference/security — Live Share host/relay/P2P, E2E encryption, content stays on host (search)
- https://workos.com/blog/multi-tenant-permissions-slack-notion-linear — Slack/Notion/Linear membership + roles analysis (fetched)
- https://workos.com/pricing — WorkOS free 1M MAU, SSO/SCIM per-connection tiers, audit logs (fetched)
- https://clerk.com/pricing — Clerk MRU pricing, B2B orgs, enterprise connections (fetched)
- https://automerge.org/blog/automerge-3/ and https://news.ycombinator.com/item?id=44777086 — Automerge 3.0 memory facts (search)
- https://slack.engineering/real-time-messaging/ and https://www.infoq.com/news/2023/04/real-time-messaging-slack/ — Slack channel/gateway server architecture (search)
- https://vercel.com/blog/how-conductor-moved-parallel-coding-agents-from-the-laptop-to-the-cloud-with-vercel-sandbox — Conductor Cloud Workspaces on Vercel Sandbox, 2026-05-27 (fetched)
- https://sprites.dev/ + https://simonwillison.net/2026/Jan/9/sprites-dev/ + https://devclass.com/2026/01/13/fly-io-introduces-sprites-lightweight-persistent-vms-to-isolate-agentic-ai/ — Fly Sprites launch, pricing, checkpoint/restore (search)
- https://trybuildpilot.com/648-electric-sql-vs-powersync-vs-zero-2026 and https://queryplane.com/blog/electricsql-vs-powersync-vs-replicache/ and https://merginit.com/blog/24082025-sync-engines-guide-electricsql-convex-zero — sync engine comparisons (search)
- https://byteiota.com/local-first-architecture-linears-50ms-page-load-secret/ and https://bytemash.net/posts/i-went-down-the-linear-rabbit-hole/ — Linear local-first analyses (search)
