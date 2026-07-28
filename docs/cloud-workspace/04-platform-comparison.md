# Platform Choice: Daytona + Railway vs Vercel + Fly.io
*part 04 of the Zeros Cloud Workspaces Report · July 2026*

> **Decision update — 2026-07-02.** The founder decided to adopt **the cloud record** — our cloud database that permanently stores your chats, sessions, and workspace history in your account. For this doc that changes the *weight* of Decision B, not its winner: the backend is no longer just a login desk plus a small registry; it now hosts an always-on Postgres (the record) and a sync layer as first-class requirements. Decision A (Daytona) is untouched. Sections below carry dated notes where the analysis moved.

## The short version

- **This is two separate decisions, not one.** Decision A: who rents us the computers the agents run on (the *sandbox provider*). Decision B: who hosts the front desk *and the filing cabinet* — login, **the cloud record** (the always-on database that permanently holds chats, sessions, and workspace history — decided 2026-07-02), the sync engine that feeds it, and backup storage (the *backend + cloud DB*). Conductor made them separately too: Vercel for sandboxes, Fly.io for the backend — with an always-on Postgres record and a sync engine (ElectricSQL) behind it.
- **Decision A verdict: stay on Daytona, run the Phase 1 spike, keep the escape hatch warm.** Daytona is the only contender with a documented WebSocket-over-preview-URL path (our direct Mac-to-sandbox connection), two regions (US + EU vs Vercel's US-only), the cheapest per-vCPU rate, and $200 free credit with a path to $10k–$50k startup credits. Its risks — closed-source move in June 2026, experimental fork/snapshot — don't touch anything v1 depends on.
- **Vercel Sandbox is the proven-but-caged option**: Conductor runs on it in production, its snapshot/fork features are GA while Daytona's are experimental, and its "Active CPU" billing is genuinely cheaper for agents that mostly wait on the model. But it's one US region, has a 24-hour session cap, and whether our engine's WebSocket works on its exposed ports is unconfirmed (needs a spike). Fly Sprites is the closest philosophical match to our design but is six months old with no named customers and no region selection.
- **Decision B is where the current confusion lives, so here's the nuance in one line: Railway is a great landlord, but the office comes unfurnished.** Zeros now needs five things from this layer — login (auth), **the cloud record** (an always-on Postgres holding the registry *and* every chat and session — upgraded from "a small registry database" on 2026-07-02), a **sync engine** to stream engine events into the record and out to your devices, a lightweight realtime channel, and object storage for backup exports. Supabase bundles four of the five for $25/month, and the fifth (the sync engine) runs on top of its Postgres. Railway and Fly give you compute + a Postgres database and *none of the rest* — you'd build or buy auth and realtime yourself.
- **Decision B verdict: Supabase, same as before — and the cloud record makes the case *stronger*, because Supabase's managed Postgres becomes the record itself.** Auth + the record + realtime on Supabase, a tiny worker on Cloudflare or Railway for provisioning, R2/Railway Buckets for backup blobs, and **ElectricSQL** as the named sync-engine spike (it's what Conductor runs in production, and it works on *any* Postgres — Supabase's or Railway's — so the sync choice doesn't lock the database host). Railway's honest best roles: hosting that thin worker, or hosting the record as plain Postgres later if we outgrow Supabase or prefer it — not replacing Supabase today.
- **Railway's 2026 reliability record argues against putting login on it**: an ~8-hour full-platform outage in May 2026 (Google Cloud auto-suspended their account), a 52-minute incident serving cached authenticated data to wrong users in March 2026, and 309 community data-loss threads about its Postgres. All verified from their own postmortems.
- **The money is all in Decision A, not B — even after adding the record.** At every scale we modeled, the control plane *including the always-on record* costs ~$0 (solo) → ~$25 (100 users) → ~$100–600/month (1,000 users), while sandbox compute runs $30 (solo) → ~$1.5k (100 users) → ~$15k (1,000 users) per month with sleep-when-idle. Optimize the sandbox choice; don't agonize over the backend bill.
- **Lock-in is manageable on A, real on B.** Swapping sandbox providers behind our `CloudSandboxProvider` interface is weeks of work because nothing irreplaceable lives in the box (code goes to git; chats and history go to the cloud record). Migrating thousands of user logins off an auth provider later is the genuinely painful move — which is another reason to pick the auth layer deliberately now. The record adds data gravity too, but ElectricSQL running on any Postgres means the *sync* choice never locks the *database host*.

---

## Two decisions, kept separate

When you launch a cloud workspace, two very different companies get involved:

1. **The sandbox provider** rents us the actual computer the agent works on. A *sandbox* is a rented computer in a data center that can be created and thrown away in seconds. Think of it as a **hotel room**: your agent checks in, works, and the room can be put to sleep cheaply when nobody's in it.
2. **The backend + cloud DB** is the **hotel's front desk — and, as of 2026-07-02, its filing cabinet too**: it checks your ID when you open the app (auth — the login system), keeps **the cloud record** (an always-on Postgres database that holds the guest ledger *and* permanently stores your chats, sessions, and workspace history in your account), pings your other devices when something changes (realtime — a "push notification" channel between our servers and your apps), and keeps a storage locker for periodic backup exports (object storage — cheap cloud space for files/blobs, now a safety net behind the record rather than the primary copy). Hotel rooms get cleared out between guests; the filing cabinet doesn't.

Conductor.build, our reference competitor, split these exactly this way: **Vercel Sandbox** for the rooms, a **Fly.io-hosted backend with Postgres** for the front desk (first-hand verified in our teardown — see the Conductor teardown doc: their API returns Fly headers and their privacy docs say account data lives in "an encrypted Postgres database served by Fly"), with **ElectricSQL** syncing that Postgres out to devices. Our current plan (v2, 2026-06-24 — written before the 2026-07-02 cloud-record decision; the v3 revision shipped 2026-07-03 as part 08) is **Daytona** for the rooms and **Supabase** pencilled in for the front desk. The founder question on the table is whether **Railway** should take some or all of the front-desk job — a question the cloud record makes *more* pointed, because this layer now holds the permanent copy of every chat. Let's take the two decisions in order.

---

## Decision A: Who rents us the computers?

### The contenders

- **Daytona** (our current pick) — a venture-backed sandbox specialist (~$31M raised, Series A Feb 2026). Went **closed-source June 11, 2026**; SDKs stay open (Apache-2.0). *Verified.*
- **Vercel Sandbox** (Conductor's pick) — Vercel's "computer per agent" API, GA since Jan 30, 2026, each sandbox a *microVM* (a tiny virtual machine with its own kernel — a stronger wall between tenants than a shared-kernel container). *Verified.*
- **Fly Sprites / Machines** (our named fallback) — Fly.io's persistent AI-agent computers, launched Jan 2026. Firecracker microVMs, 100 GB durable disk, sleeps ~30s after idle, wakes in under a second. *Verified mechanics; product is very young.*

### Capability, side by side (as of mid-2026)

| Capability | Daytona | Vercel Sandbox | Fly Sprites |
|---|---|---|---|
| **Direct Mac→sandbox WebSocket** (our whole connection design) | **Documented** — preview proxy explicitly forwards WebSocket upgrades *(verified)* | Works for Vercel's own infra, but **undocumented for user-run servers on exposed ports** *(needs a spike test)* | Per-sprite HTTPS URL with token auth; should front a WSS endpoint *(likely, untested)* |
| **Runtime caps** | No hard session cap; auto-stop configurable to 0 *(verified)* | **24-hour max session**; "not suitable for permanent hosting" per Vercel *(verified)* | No documented cap; sleeps after ~30s idle, wakes <1s *(verified)* |
| **Sleep/resume model** | Stop = full halt, disk persists; wake = cold engine boot (our engine already handles this) | Auto filesystem snapshot on stop, auto-resume on next call — **but snapshots expire 30 days after last use by default**, a data-loss footgun unless disabled *(verified)* | Sleep keeps state; wake <1s; ~300ms checkpoints, last 5 browsable *(verified)* |
| **Fork/snapshot maturity** | Shipped April 2026 but **explicitly `_experimental_`** *(verified)* | **GA** since Jan/May 2026 — fork, rollback, named sandboxes *(verified)* | Checkpoint/restore/fork shipped at launch *(verified)* |
| **Regions** | **US + EU** (Mumbai announced May 2025, absent from current docs) *(verified)* | **US East (iad1) only** *(verified)* | **Not selectable, not documented** — assume US *(verified absence)* |
| **Asia latency** | ~130 ms India→EU; our Mutagen file mirror exists precisely to hide this | Worse: everything crosses to US East (~200–250 ms from India) | Unknown — the region opacity is the gap |
| **Isolation** | Sysbox containers: **shared host kernel**, user-namespaced — fine for one-team-per-sandbox, weaker than a microVM *(verified)* | Firecracker microVM, dedicated kernel *(verified)* | Firecracker microVM *(verified)* |
| **Per-box size limits** | Default max **4 vCPU / 8 GB / 10 GB** (bigger = sales) — tight for engine + agent + builds *(verified)* | Up to 8 vCPU/16 GB (Pro), 32/64 (Enterprise); fixed 32 GB disk *(verified)* | Up to 8 CPU / 16 GB, 100 GB disk *(verified)* |
| **Egress control** | Tier-gated: T1/T2 allowlist-only — **Cursor agents effectively require Tier 3 ($500 top-up)** *(verified)* | Excellent: live firewall + credentials brokering (secrets never enter the VM) *(verified)* | DNS-based allow/deny per sprite *(verified)* |

Two Daytona details worth keeping in your head: its **auto-stop timer is not reset by a working agent** (only by API/SSH/preview traffic), so we must disable it and let our engine own sleep — this is the #1 correctness trap and it's already a locked decision in the plan. And its **preview tokens reset when a sandbox restarts**, so the app re-fetches on reconnect — plumbing, not a blocker.

### Price

All prices as of mid-2026, from official pricing pages.

| | Daytona | Vercel Sandbox | Fly Sprites |
|---|---|---|---|
| Billing model | Wall-clock while running | **Active CPU only** ($0.128/CPU-hr; waiting on the model is free) + memory while awake ($0.0212/GB-hr) | Actual usage ($0.07/CPU-hr, $0.04375/GB-hr) |
| A 2 vCPU / 4 GB box, awake, agent mostly waiting on the LLM | **~$0.17/hr** (flat) | ~$0.09–0.13/hr *(computed from official rates)* | ~$0.11/hr (Fly's own worked example: 4-hr Claude Code session ≈ $0.44) *(verified example)* |
| Same box, asleep | ~$0.40–0.80/month (disk only; archive is cheaper still) | ~$0.40/month (5 GB snapshot storage) | ≈ $0.20/month (10 GB cold storage) |
| Free credit | **$200, no card** + Startup Grid **$10k → $50k** on acceptance *(verified)* | Hobby allowances; $20/mo Pro plan | $30 trial credit |
| Scale gates | Prepaid tiers: T2 $25 → T3 $500 → T4 $2,000/30 days (these are *top-ups you spend*, not fees) | 2,000 concurrent sandboxes; 200 vCPU/min allocation on Pro | Subscription tiers ~$20/mo (20 concurrent) → $2,000/mo (2,000) *(likely — tier ladder not fully verified)* |

Read that middle row carefully: for agent workloads that spend most of their time waiting on Claude, **Vercel's Active-CPU billing and Sprites' usage billing are actually somewhat cheaper per awake-hour than Daytona's wall-clock rate**. Daytona wins on idle economics, free credit, and the raw vCPU rate. All three land in the same magnitude; **the real cost lever is sleep-when-idle, not the provider** (see the cost tables below — always-on is ~8× more expensive than slept). The cloud record sharpens that lever further: once chats and history live permanently in the record, an idle sandbox can be *deleted* outright — not just slept — and rebuilt on demand from git plus the record.

### Maturity and company risk

- **Daytona**: Series A stage, ~$31M raised, $1M forward run rate claimed, customers include LangChain and Writer, 99.98%+ measured uptime in 2026. The June 2026 **closed-source move removed the fork-and-self-host escape hatch** — the old AGPL repo is frozen and unmaintained. Mitigations Daytona itself sells: BYOC (run their runner nodes in our own cloud — sales-gated, early) and dedicated regions. *Verified.*
- **Vercel**: the safest company bet by far — large, profitable-scale platform, SOC 2 Type II / ISO 27001, and **Conductor has already proven this exact product shape on it**. *Verified.*
- **Fly.io**: ~60 people, $110M raised, betting the company on agent compute. Candid about incidents but has a lot of them (~13/month average since 2022 per third-party status tracking — *likely*, hostile source). Sprites has **no named production customers** we could find. *Verified absence.*

### Lock-in and the escape hatch

Our plan already contains the right insurance: a **`CloudSandboxProvider` interface** (one thin layer in our code that speaks "create/start/stop/connect a sandbox," so the provider behind it can be swapped — a universal power adapter), plus the durability rule that **nothing irreplaceable lives only in the box** (code → git; chats/sessions/history → the cloud record, with export blobs kept as a backup safety net). *Updated 2026-07-02: this rule used to lean on export blobs alone; the cloud record now carries it, which makes the insurance stronger — a deleted sandbox loses nothing.* Because of that, switching sandbox vendors is re-implementing one interface, re-baking a machine image, and re-testing the WebSocket path — realistically **a few weeks, not a rewrite**. That insurance is what makes choosing a Series-A vendor acceptable.

### Verdict A

**Keep Daytona.** It's the only provider where our load-bearing requirement — the Mac dialing the sandbox directly over a WebSocket, no broker in the middle — is documented rather than hoped for. Its weaknesses (experimental fork, closed source, 4-vCPU default cap) don't intersect with v1. **But make the Phase 1 spike the actual decision point**: it's built & merged (2026-06-25) and its exit run waits only on an API key — and that exit test (engine boots, WSS handshake, survives stop/start) is precisely the thing no amount of reading can verify. Keep **Fly Sprites as fallback #1** (closest model match, best Asia story *if* they ever expose regions) and **Vercel as fallback #2** (proven, but likely forces a Conductor-style broker if the WSS spike fails, and it's US-only).

---

## Decision B: Who runs the front desk?

> **Decision update — 2026-07-02.** The founder decided that all durable workspace data — chats, agent sessions, workspace metadata, memberships — lives in **the cloud record**: an always-on Postgres in the user's account, synced live to every signed-in device (part 05 covers the how). Decision B therefore now includes hosting the record and its sync engine as first-class requirements — this layer is no longer just a login desk with a small ledger. The verdict below was re-checked against the heavier job: **it doesn't change, it gets stronger.**

### What Zeros actually needs from this layer

*This section originally argued the front desk could stay deliberately small, because the heavy stuff (chat, files, the agent) lived only with the engine in the sandbox. **Updated 2026-07-02:** the live experience still runs in the sandbox, but the permanent copy of chats and history now lives here too. Six needs, two of them new or upgraded:*

1. **Auth** — users sign in; the Mac app and the sandbox both need to verify "this is really Arun."
2. **The cloud record** *(upgraded from "a small registry DB")* — an always-on Postgres that keeps the workspace registry (which workspaces exist, who may enter) *and* permanently stores every chat, agent session, and piece of workspace history in the user's account. (Postgres is the industry-standard relational database — the filing system behind most web apps.) The sandbox is the workbench; this is the filing cabinet. Workbenches get cleared; the filing cabinet doesn't.
3. **A sync engine** *(new)* — the layer that streams every chat/session event from a running engine into the record in near-real-time, and syncs the record back out to every signed-in device. Named spike candidate: **ElectricSQL** — it's what Conductor runs in production, and it works on *any* Postgres (Supabase's or Railway's), so picking it doesn't lock the database host. **Supabase Realtime** is the simpler starter if the spike disappoints.
4. **Realtime fan-out** — a lightweight "something changed, refresh" ping to your other devices when, say, a teammate shares a workspace. (The *live* chat stream still does not go through here — it stays on the direct Mac↔sandbox WebSocket, the live wire; the record gets its copy via the engine's write-through, server to server.)
5. **Object storage** — cheap durable blobs, now demoted to a *backup safety net* (periodic exports of the record) rather than the primary home of chat history.
6. **A provisioning worker** — a tiny server-side program that holds the Daytona API key and creates sandboxes on request, so the secret key never ships inside the Mac app.

### The gentle-but-critical nuance

Here's the thing to hold onto when comparing these three:

- **Supabase is a serviced office**: $25/month gets you the receptionist (auth, 100k monthly users included), the filing system (managed Postgres with row-level security — database-enforced rules like "users can only read their own rows"), the intercom (Realtime, 500 concurrent connections included), and 100 GB of storage. One vendor, four of the six needs met — and since 2026-07-02 its Postgres is **load-bearing: it becomes the cloud record**, the permanent home of every user's chats and history rather than a small registry table, with ElectricSQL able to run on top of it. *Verified pricing.*
- **Railway is excellent empty office space**: best-in-class developer experience, cheap usage-based compute (a small always-on API ≈ $5/month), and genuinely great object storage (Buckets: $0.015/GB-month with **free egress**). But **no auth, no realtime service, no row-level security** — Railway's own guides point you at Clerk or self-hosted Supabase for login. Its Postgres is officially an *unmanaged template* ("you have total control over their configuration and maintenance"); high-availability shipped March 2026 explicitly experimental, point-in-time recovery is weeks old. *Verified.* One new nuance since the cloud-record decision: because ElectricSQL runs on any Postgres, Railway *is* a technically viable host for the record — a legitimate scale-out or preference option later. But volunteering an unmanaged template with this reliability history (below) to hold the permanent copy of every user's chats is a deliberate future choice, not the default.
- **Fly.io is the same shape as Railway** — compute + a database, nothing above it — but with more regions (18, including Mumbai and Singapore), cheaper machines (~$2/month), and a genuinely **managed** Postgres (HA, backups, pooling on all plans) starting at $38/month. You still build auth and realtime yourself. *Verified.*

So "Railway vs Supabase" isn't apples to apples. If we chose Railway for the whole front desk, we would be signing up to **assemble and operate the pieces Supabase hands us on day one** — for a layer that costs ~$25/month at beta scale and roughly $100–600/month at 1,000 users either way, noise next to the sandbox bill.

### Reliability check (this matters for a login path)

- **Railway, Nov 2025–May 2026**: cryptominer fleet outage (Dec), 4-day DDoS disruption (Feb), a 52-minute incident where **cached authenticated data was served to the wrong users** (Mar), and the big one — **May 19, 2026, ~8 hours of full-platform downtime** when Google Cloud auto-suspended Railway's production account. May 2026 uptime: 99.26%. No self-serve SLA (a contractual uptime promise). *All verified from Railway's own postmortems and status page.*
- **Fly.io**: fewer catastrophic single events but chronic frequency — ~13 incidents/month since 2022, incidents on 20 of 31 days in May 2026 *(likely — competitor-sourced but consistent with Fly's own infra-log)*. No standard SLA.
- **Supabase**: generally solid reputation, occasional incidents, enterprise SLAs exist. *(Likely — we did not audit it as deeply as the other two.)*

If the front desk is down, **nobody can open a cloud workspace** — and now that this layer also holds the cloud record, it's the permanent home of every chat, not just the login path. That's a hard argument against putting login *or the record* on the platform with the freshest 8-hour total outage.

### The decision table

| Need | Best provider | Why | Runner-up / later |
|---|---|---|---|
| **Auth** | **Supabase Auth** | Free to 50k MAU, doubles as the record's database vendor; the sync-architecture doc reaches the same conclusion | WorkOS bolt-on when enterprise SSO deals appear (~$125/connection/mo) |
| **The cloud record** *(upgraded 2026-07-02 from "Registry DB" — now also every chat, session, and history)* | **Supabase Postgres** | Managed, RLS built in, included in the $25 Pro plan — and it now carries the permanent copy of every chat, which makes "managed" non-negotiable | **Railway Postgres** as a plain-Postgres record host at scale-out or by preference (ElectricSQL doesn't care where the database lives) or **Fly Managed Postgres ($38/mo)** — Railway's unmanaged template + data-loss history says: deliberately, later, not by default |
| **Sync engine** *(new 2026-07-02 — streams engine events into the record, syncs devices from it)* | **ElectricSQL** (the named spike candidate) | Conductor-proven in production; runs on any Postgres — Supabase or Railway — so it never locks the DB host | **Supabase Realtime** as the simpler starter; decide after the spike |
| **Realtime fan-out** | **Supabase Realtime** | Included; adequate as a "hint" channel (DB-as-record, broadcast-as-hint) | Ably ($29/mo) if delivery guarantees start to matter |
| **Object storage (backup exports)** | **Cloudflare R2 or Supabase Storage** (per current plan) | Cheap, zero/low egress — now a safety net behind the record, not the primary durability story | **Railway Buckets** ($0.015/GB-mo, free egress) or Tigris on Fly — all fine, pick whichever sits next to the worker |
| **Provisioning worker** | **Cloudflare Worker** (per current plan) | Effectively free at our scale, holds `DAYTONA_API_KEY`, minimal ops | **Railway** (~$5/mo) — this is Railway's genuinely good role, and its best-in-class DX makes iteration pleasant |

**The hybrid is the answer, and the record strengthens it**: Supabase for auth + the cloud record + realtime, **ElectricSQL** spiked on top as the sync engine, a thin worker on Cloudflare (or Railway if we prefer its DX), R2/Buckets for backup blobs. This is ~95% what the June engineering plan already pencils in — the difference is that Supabase's Postgres graduates from convenience registry to load-bearing record (the June plan predated the 2026-07-02 decision; its v3 revision — part 08, 2026-07-03 — makes this explicit). **Railway is not wrong — it's just the answer to a different question** ("where do I host a backend I wrote?" — and, since ElectricSQL is host-agnostic, "where could the record's plain Postgres live at scale-out?"). It's a strong candidate for those jobs the day we have a real backend to host, or outgrow Supabase's Postgres.

---

## Cost at three scales

Monthly, as of mid-2026, computed from official rates; assumes 2 vCPU/4 GB workspaces, ~3 hours/day active, **sleep-when-idle working** (Phase 5). *Arithmetic is ours — treat as planning numbers, not quotes.*

| | Solo beta (founder + friends) | 100 users | 1,000 users |
|---|---|---|---|
| **Sandbox compute — Daytona** | **~$33/mo** → ~6 months free on the $200 credit; $0 cash | **~$1.5k/mo** + ~$77 idle disk (vs ~$12k always-on — sleep is the whole ballgame) | **~$15k/mo** *(extrapolated)*; T4 pool (500 vCPU) should fit ~125 concurrent boxes but expect an enterprise conversation |
| **Sandbox compute — Vercel (for comparison)** | ~$20–30/mo | ~$800–1,100/mo (Active-CPU billing favors LLM-wait workloads) + $0.15/GB transfer on file sync | ~$8–11k/mo *(extrapolated)* |
| **Sandbox compute — Sprites (for comparison)** | ~$25/mo | ~$1k/mo + concurrency subscription tier | ~$10k/mo + tier *(tier ladder unverified)* |
| **Control plane — Supabase + CF worker (recommended)** | **$0** (free tiers) | **~$25–30** (Supabase Pro) | **~$35–75** (Pro + realtime/storage overages) |
| **The cloud record — always-on Postgres + sync** *(added 2026-07-02; on the recommended path this IS Supabase's Postgres, so at solo and 100-user scale it overlaps the row above rather than adding to it)* | **~$0** (rides the free tier) | **~$25** (inside the Supabase Pro plan) | **~$100–600** (larger database + sync/realtime egress as history accumulates) |
| **Control plane — Railway path** | ~$5, but auth vendor needed on top | ~$25–50 + Clerk/WorkOS bill + your own auth code | ~$50–100 + auth vendor + DB ops discipline |
| **Control plane — Fly path** | ~$40 (machines + $38 managed Postgres) | ~$50–55 | ~$60–100 |

Three takeaways. **First**, the control plane is noise even after it absorbs the cloud record — worst case at 1,000 users the record is a few hundred dollars against a ~$15k sandbox bill; the sandbox bill is the business model. (The record also sharpens the sleep lever: a sandbox whose history is safely in the record can be *deleted*, not just slept.) **Second**, Daytona's $200 + Startup Grid ($10k, path to $50k — we should apply this month) plausibly covers the entire beta's COGS. **Third**, one hidden line item: shipping **Cursor agents requires Daytona Tier 3** (a $500 prepaid top-up, spendable on compute) because Cursor's SDK dials hosts outside the lower tiers' egress allowlist. *Verified.*

---

## What this means for Zeros

1. **Sandbox: Daytona, confirmed — pending the spike.** Get a `DAYTONA_API_KEY` this week and run the Phase 1 harness; its exit test (WSS handshake + stop/start survival) is the real decision gate. If it fails, spike Fly Sprites before Vercel, because Sprites preserves our direct-connection, no-broker architecture and Vercel likely doesn't.
2. **Backend: Supabase + thin Cloudflare worker, as planned — and as of 2026-07-02 Supabase's Postgres is also the cloud record. Don't move the front desk to Railway.** Railway would mean assembling auth + realtime + DB safety ourselves, on the platform with 2026's worst single outage, to save roughly nothing — and it would hand the permanent home of every chat to an unmanaged database template. Decision needed from you: none — the plan's pencil becomes ink, and "confirm Supabase" now means "confirm Supabase as auth + the record's host."
3. **Spike ElectricSQL as the sync engine.** It's what Conductor runs in production, and it works on any Postgres — Supabase today, Railway later if ever — so trying it costs nothing in lock-in. Supabase Realtime stays the simpler fallback if the spike disappoints.
4. **Give Railway its real job (optional).** If the provisioning worker outgrows a Cloudflare Worker, or we build a fuller backend service, Railway is a great home for it — Railway Buckets is a legitimate contender for backup blobs, and its plain Postgres is a viable *later* home for the cloud record itself (ElectricSQL moves with the database) if we outgrow Supabase or prefer Railway's DX. Its reliability caveats stand. Revisit at Phase 7.
5. **Buy the insurance that's free**: keep `CloudSandboxProvider` honest (no Daytona-specific types leaking above it), keep durability outside the box (git + the cloud record, with export blobs as the backup safety net), and pin the SDK. That's what converts "Series-A vendor risk" into "a few weeks of migration if it ever goes wrong."
6. **Apply to Daytona's Startup Grid now** — $10k credits on acceptance, path to $50k, a 5-minute application. It directly subsidizes beta COGS.
7. **Book two enterprise conversations before 1,000 users**: Daytona (custom limits beyond the 4 vCPU/8 GB per-box default, T4+ pools, maybe BYOC) and, only if Asia demand materializes, Fly (Mumbai/Singapore).
8. **Watch three tripwires** that would reopen Decision A: Daytona drops its EU region or has a serious isolation incident; Sprites ships region selection + named customers; or "fork a dirty workspace into N parallel tries" becomes a marquee feature (Vercel's GA fork would then matter).

## Sources

- Zeros internal plan: [08-engineering-reference.md](08-engineering-reference.md) — the v3 consolidation (2026-07-03) of the June v2 (2026-06-24); original removed
- Zeros founder decision brief (2026-07-02): the cloud record + enterprise self-hosting — internal
- https://electric-sql.com — ElectricSQL sync engine (runs on any Postgres; used by Conductor)
- https://www.daytona.io/pricing — compute rates, $200 credit
- https://www.daytona.io/docs/en/limits/ — T1–T4 tier pools
- https://www.daytona.io/docs/en/network-limits/ — egress allowlist tiers
- https://www.daytona.io/docs/en/regions/ — US/EU shared regions
- https://www.daytona.io/docs/en/custom-preview-proxy/ and https://www.daytona.io/docs/en/architecture — WebSocket proxying
- https://www.daytona.io/dotfiles/daytona-is-going-closed-source — closed-source announcement (2026-06-11)
- https://www.daytona.io/startups — Startup Grid credits
- https://www.daytona.io/dotfiles/daytona-raises-24m-series-a-to-give-every-agent-a-computer — Series A (2026-02-05)
- https://vercel.com/docs/sandbox/pricing — Vercel Sandbox rates and limits
- https://vercel.com/docs/sandbox/concepts/persistent-sandboxes and https://vercel.com/docs/sandbox/concepts/snapshots — persistence, 30-day expiry
- https://vercel.com/changelog/vercel-sandbox-can-now-run-for-up-to-24-hours — 24h session cap (2026-06-16)
- https://vercel.com/blog/how-conductor-moved-parallel-coding-agents-from-the-laptop-to-the-cloud-with-vercel-sandbox — Conductor on Vercel Sandbox (2026-05-27)
- https://vercel.com/kb/guide/running-opencode-securely-with-the-vercel-sandbox — direct-connection pattern
- https://fly.io/docs/about/pricing/ and https://fly.io/docs/reference/regions/ — Fly Machines pricing, 18 regions
- https://fly.io/mpg/ and https://fly.io/docs/mpg/ — Fly Managed Postgres plans
- https://sprites.dev/ and https://fly.io/blog/code-and-let-live/ — Sprites specs, pricing, launch (Jan 2026)
- https://simonwillison.net/2026/Jan/9/sprites-dev/ — independent Sprites analysis
- https://docs.railway.com/pricing/plans and https://docs.railway.com/pricing — Railway plans and rates
- https://docs.railway.com/databases/postgresql — "unmanaged" Postgres template
- https://railway.com/changelog/2026-03-13-highly-available-postgres — experimental HA Postgres
- https://docs.railway.com/volumes/point-in-time-recovery — PITR (2026-05)
- https://docs.railway.com/storage-buckets — Railway Buckets pricing
- https://blog.railway.com/p/incident-report-may-19-2026-gcp-account-outage — 8-hour outage postmortem
- https://www.infoq.com/news/2026/05/railway-gcp-account-outage/ — independent outage coverage
- https://stackandsails.substack.com/p/is-railway-production-ready-in-2026 — community data-loss audit (Feb 2026)
- https://status.railway.com/historical and https://status.flyio.net/history — uptime records
- https://kuberns.com/blogs/is-fly-io-good-for-production/ — Fly incident statistics (competitor source, bias flagged)
- https://supabase.com/pricing — Supabase Pro bundle
- https://www.superagent.sh/blog/ai-code-sandbox-benchmark-2026 — cold-start comparisons (informal)
