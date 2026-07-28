# Fly.io research notes — Machines, Sprites, Managed Postgres, backend hosting

Researched: 2026-07-02. Confidence tags: **[verified]** = 2+ sources or official docs fetched directly; **[likely]** = single credible source; **[unverified]** = could not confirm.

Zeros context anchor: the question is whether Fly.io could serve as (a) the sandbox layer instead of Daytona (via Sprites), and/or (b) "the cloud DB + backend" (control plane, auth, cloud_workspaces registry, realtime sync) instead of Supabase/Railway.

---

## 1. Fly Machines (the core compute primitive)

### What they are
- Firecracker microVMs — "the same fast-launching microVMs that back AWS Lambda." Booted from OCI/Docker images, per-second billing while started. **[verified — fly.io/machines, docs]**
- Machines have hardware-level VM isolation (not shared-kernel containers). This is the substrate under both regular Fly apps and Sprites. **[verified]**

### Sleep/wake mechanics (autostop/autostart)
- `auto_stop_machines` = `"off" | "stop" | "suspend"`; `auto_start_machines` boolean; `min_machines_running` (primary region only). Default for new apps: stop enabled, autostart enabled, min 0. Fly Proxy wakes Machines automatically when a request arrives and stops them when there's excess capacity ("stop loop runs every few minutes, stops at most one Machine per region per pass"). **[verified — fly.io/docs/launch/autostop-autostart/]**
- **Stopped/suspended Machines cost nothing for CPU/RAM** — you pay only rootfs storage ($0.15 per GB per 30 days stopped). **[verified — pricing docs]**
- **Suspend** (RAM snapshot): resume in "a few hundred ms" vs "~2+ seconds" cold start. Caveats: recommended only for Machines with **≤ 2 GB RAM** (larger = slow suspend; community reports performance-2x machines >2048MiB can't suspend); clock lags a few seconds after resume until NTP syncs (breaks JWT nbf validation, cron timing briefly); suspended Machines still **reserve capacity** in the region (you can't oversubscribe); no GPU, no swap, no scheduled Machines. Suspend available in all regions since July 2024. **[verified — fly.io/docs/reference/suspend-resume/ + community]**
- Note: Fly is deprecating GPUs — docs say "GPUs will be deprecated as of 08/01/26." **[likely — single docs mention, but explicit]**

### Pricing (fetched from fly.io/docs/about/pricing, July 2026)
- Pay-as-you-go, per-second, **no free tier** (removed for new orgs; trial credit only). Example (Amsterdam): `shared-cpu-1x` 256MB = $0.00000078/s ≈ **$2.02/mo** always-on; `performance-1x` 2GB ≈ **$32.19/mo**. Extra RAM ≈ $5/GB per 30 days, with regional multipliers. **[verified]**
- **Regional price differences exist**: same `shared-cpu-1x` 256MB ≈ **$3.14/mo in Mumbai (bom)** vs ≈ **$2.09/mo in Singapore (sin)** vs $2.02 in ams — Mumbai carries a ~50% markup. **[verified — pricing docs fetch]**
- Volumes: $0.15/GB/mo provisioned. Volume snapshots: $0.08/GB/mo, first 10GB free (snapshot billing began Jan 1, 2026). Dedicated IPv4: $2/mo. Static egress IP ~$3.60/mo. **[verified]**
- **Egress by region group**: North America/Europe **$0.02/GB**; Asia-Pacific/Oceania/South America **$0.04/GB**; **Africa & India $0.12/GB** (relevant if Zeros users in India pull lots of data from bom machines). Private cross-region: $0.006 / $0.015 / $0.05 per GB — and starting **February 2026 inter-region private network traffic is charged** (previously free). **[verified — pricing docs]**
- Machine reservations: 40% discount blocks — $36/year buys $5/mo of shared-CPU credit; $144/year buys $20/mo of performance credit. **[verified]**
- Support plans: $29/mo standard, $199/mo premium, enterprise from $2,500/mo. **[verified]**

### Regions
- 18 regions on 6 continents, **including Mumbai (bom) and Singapore (sin)**. bom has no WireGuard gateway (sin does). Full list: ams, arn, bom, cdg, dfw, ewr, fra, gru, iad, jnb, lax, lhr, nrt, ord, sin, sjc, syd, yyz. **[verified — fly.io/docs/reference/regions/]** (Marketing copy elsewhere says "35 datacenters"; the canonical deploy-region list is 18.)

---

## 2. Fly Sprites (sprites.dev) — persistent sandboxes for AI agents

### What it is
- Launched publicly **~Jan 9–13, 2026** (Fly blog "Code And Let Live" Jan 9; devclass coverage Jan 13; Simon Willison post Jan 9). A Sprite = "a hardware-isolated execution environment for arbitrary code: a persistent Linux computer." Firecracker-based, built on Fly Machines but with "an entirely new storage stack" and different orchestration; no Dockerfiles. Claude Code pre-installed by default (user logs in with their own Anthropic account — Fly doesn't cover tokens). **[verified — sprites.dev, fly.io blog, devclass, simonwillison.net]**
- Positioning (Kurt Mackey, Fly CEO): "The age of sandboxes is over… Ephemeral sandboxes are obsolete. Stop killing your sandboxes every time you use them." Sprites are "like BIC disposable cloud computers"; "Dev is prod, prod is dev." **[verified — Fly blog]**
- Direct competitor to Daytona/E2B/Modal/Vercel Sandbox/Cloudflare sandboxes. Per Ry Walker's analysis (Feb 2026, updated Jun 11, 2026): Sprites is the only offering combining instant creation + persistence + checkpoint/restore; Daytona = persistent dev environments, container isolation, no checkpoints; E2B = ephemeral Firecracker; Modal = gVisor serverless. **[likely — single analyst; author runs a competing company]**

### Mechanics
- Specs: up to **8 CPUs / 16 GB RAM** per run, dynamically allocated by actual usage (marketing earlier said ~8GB/8CPU; homepage now says up to 16GB). **100 GB durable ext4 root filesystem**. **[verified — sprites.dev]**
- Storage architecture (Fly engineering blog "The Design & Implementation of Sprites", Jan 14, 2026): JuiceFS-inspired — data chunks in S3-compatible object storage; metadata in SQLite made durable via Litestream; local NVMe is only a read-through cache, never the source of truth; billed only on written blocks, TRIM-aware. Orchestration is "inside-out" (runs inside the VM); global orchestrator is an Elixir/Phoenix app. **[verified — fly.io blog]**
- **Checkpoints: ~300ms**, copy-on-write metadata shuffle capturing entire disk + environment state; **restore < 1s**; last 5 checkpoints browsable from the filesystem. Sprite forking exists (fork a sprite from a checkpoint). **[verified — sprites.dev + Simon Willison]**
- Sleep/wake: sprite sleeps after **~30 seconds idle** (Willison); compute billing stops while asleep, data persists; wake on command or HTTP request in **< 1s** (new sprite creation 1–2s per Fly; devclass said "1–12 seconds" at launch). Each sprite gets a unique HTTPS URL (auth-token by default, can be public; `private_access` org setting added Apr 21, 2026); traffic auto-routes to port 8080 and wakes the sprite. **[verified]**
- Network egress policies: DNS-based allow/deny lists per sprite (useful for containing agents). **[verified — Willison/sprites.dev]**
- APIs: CLI (`sprite create/console/exec`), REST at api.sprites.dev/v1, SDKs for JavaScript (`@fly/sprites`), Go, Elixir (+ Python per Willison), and a native **MCP endpoint (sprites.dev/mcp, shipped ~Mar 2026)**. **[verified for CLI/REST/JS/Go/Elixir; Python + MCP likely]**
- Active development: release notes show weekly changes through at least Apr 30, 2026 (deleted-sprite recovery, private URL access control, Prometheus metrics, storage-sync redesign). **[verified — sprites.dev/release-notes]**

### Sprites pricing
- Usage rates (sprites.dev, July 2026): **CPU $0.07/CPU-hour** (min 6.25% utilization/sec), **RAM $0.04375/GB-hour** (min 0.25GB), hot NVMe cache $0.000683/GB-hr, cold object storage $0.000027/GB-hr (≈ **$0.02/GB-mo**). Worked examples: a 4-hour intensive Claude Code session ≈ **$0.44–0.46**; a low-traffic web app awake 30 hrs/mo ≈ **$4/mo**; 10GB cold storage ≈ $0.20/mo. **$30 trial credit** ("create, like, 500 Sprites for free"). Idle = $0 compute. **[verified — sprites.dev + Willison]**
- Subscription tiers exist on top of usage: ~8 plans from **"Adventurer" $20/mo (20 concurrent sprites) to "Mythic" $2,000/mo (2,000 concurrent)** plus custom "Guild"; overage bills at standard rates; plan names confirmed via Fly community ("Adventurer / Level 20"). **[likely — Ry Walker research + community thread; full ladder not independently verified]**
- **Regions: NOT selectable / not documented** — a real gap. Fly community threads literally ask "which fly.io region do sprites live in?" with no public answer; no region parameter in quickstart/API docs. Assume US-centric placement today. For Zeros users in India, this is a latency question Daytona (which has region choice) answers better right now. **[verified as "undocumented" — docs + community]**

### Who uses Sprites — and the Conductor question
- **No named customers found anywhere** (launch blog, docs, press, HN). Fly's blog cites internal/adjacent uses: Chris McCord's Phoenix.new and Kurt Mackey's personal vibe-coded MDM app running on a Sprite. **[verified absence]**
- **Conductor.build: the "Conductor runs on Fly/Sprites" claim did NOT check out.** Vercel's customer story (May 27, 2026) states Conductor built Cloud Workspaces **on Vercel Sandbox**: "When a developer opens a new workspace, agents spin up on a remote server instead of their local machine… To our users it feels just like the local version of Conductor." No source connects Conductor to Fly.io or Sprites for sandboxes or backend. **[verified for Vercel Sandbox; Fly/Sprites link unverified — treat as false until shown otherwise]**
- HN reception (Jan 2026 thread, 46561089): praise for the persistent-computer model and checkpoints; criticisms: "why not local sandboxes?", worries about "editing files in prod" FTP-era workflows, and the auth model (bring-your-own Anthropic account). Fly's tptacek: "We'll have an open-source local version of it relatively soon." **[verified — HN thread]**

---

## 3. Fly Managed Postgres (MPG)

- **Status: GA** (product page and docs present it as generally available, no beta label; built during 2025 on Percona's Kubernetes operator with Percona's backing; announced in Fly's Jan 2025 newsletter, matured through 2025). Supabase's earlier "Fly Postgres managed by Supabase" was deprecated Apr 11, 2025; legacy unmanaged "Fly Postgres" still exists separately. **[verified]**
- **Plans (monthly, from fly.io/mpg + docs, July 2026):** Basic $38 (shared-2x CPU, 1GB), Starter $72 (shared-2x, 2GB), Launch $282 (performance-2x, 8GB), Scale $962 (performance-4x, 32GB), Performance $1,922 (performance-8x, 64GB). Storage **$0.28/provisioned GB per 30 days**, max 1 TB (up to 500GB at creation), storage replicated across all cluster nodes. Mid-month plan changes prorated. **[verified]**
- **All plans include HA (multi-node cluster with automatic failover), automatic backups + recovery, connection pooling**, encryption at rest/in transit, monitoring, 24/7 support. **[verified — fly.io/mpg]** Backup retention window and PITR mechanics are **not documented publicly** — docs say "automatic backups and recovery" without retention numbers. **[verified gap]**
- **Regions: 12** — Amsterdam, Frankfurt, São Paulo, Ashburn, LA, London, Tokyo, Chicago, **Singapore**, San Jose, Sydney, Toronto. **No Mumbai.** **[verified — fly.io/mpg]**
- Still "under development" per docs: automated security patches / version upgrades, third-party extensions beyond pgvector/PostGIS (marketing page says "full catalog of trusted extensions" — docs contradict; trust the docs), customer-facing alerting, migration tooling. **[verified — fly.io/docs/mpg]**
- Cheapest real HA Postgres on Fly = **$38/mo + storage**. Compare: Supabase Pro $25/mo (bundled auth/realtime), Railway Postgres = container at compute rates (no managed HA).

---

## 4. Hosting a small always-on backend/API on Fly

### DX
- `fly launch` from a Dockerfile or auto-detected framework; flyctl CLI; anycast global load balancing; WebSockets supported natively through Fly Proxy (relevant: Zeros' WSS control plane); private WireGuard IPv6 mesh ("6PN") between Machines; `fly ssh console`. Generally regarded as excellent DX for Docker-shaped apps, more knobs (and more sharp edges) than Railway. **[verified mechanics; DX judgment = consensus of comparison articles]**
- Object storage: no first-party product; **Tigris** is the S3-compatible partner (billed through your Fly bill, ~$0.02/GB-mo standard, **zero egress fees**, first 5GB free). Directly relevant to Zeros' "cheap export blobs" durability plan. **[verified — fly.io/docs/tigris + tigrisdata.com]**

### Cost for a small control plane (Zeros-sized: auth + workspace registry + provisioning worker)
- 2× `shared-cpu-1x` 512MB–1GB Machines (HA pair) ≈ **$8–12/mo**; MPG Basic **$38/mo** + a few GB storage ≈ $1; dedicated IPv4 $2/mo; egress at $0.02/GB. Realistic floor ≈ **$50–55/mo with managed HA Postgres**, or ≈ $10/mo if you run SQLite/Litestream instead of MPG. **[computed from verified prices]**

### Reliability reputation (the big caveat)
- **No published SLA** on any standard plan — no uptime guarantee or credit policy. **[verified — pricing page absence, echoed by third parties]**
- Status-page-derived stats (via Kuberns, a competitor — bias flagged, but numbers trace to status.flyio.net): **609 incidents since June 2022 (~13/month)**; May 2026 had incidents on 20 of 31 days; average ~296 min resolution for platform-down events. StatusGator counts 1,808+ Fly.io outage events over ~6 years. **[likely — hostile source but consistent with public status history]**
- Notable incidents: **Feb 2025 — total ~3h outage of IAD**, Fly's primary API region (4:45–7:45 AM); Mar 2026 — multitenant Consul degradation affecting LiteFS + Postgres failover; May 28, 2026 — west-coast proxy overload; May 30, 2026 — billing/Corrosion schema bug blocking deploys; Jun 4, 2026 — stale 6PN mappings broke private networking. Recurring root cause pattern: **Consul → Corrosion** (their distributed-state migration) — "almost every significant Fly.io incident in 2025 and 2026 traces back to the same two systems." **[likely/verified mix — incidents corroborated by Fly's own infra-log at fly.io/infra-log]**
- Counterweight: Fly publishes an unusually candid public **infra-log** with postmortems; incidents are mostly regional/partial, not platform-wide; multi-region apps ride through most of them. Machines keep running during many control-plane incidents (data plane vs control plane separation).
- Company: ~60 employees (down from ~68 in 2023), **$110.5M raised total, $70M Series C (2023)**, revenue estimate ~$11.2M (2024, GetLatka). Big 2025–2026 strategic bet on AI-agent compute (Sprites, Phoenix.new, Litestream acquisition). Not a hyperscaler; platform-risk profile similar to Railway/Render. **[likely — Crunchbase/PitchBook/GetLatka estimates]**

---

## 5. Fit as "the cloud DB + backend" for Zeros (realtime-sync desktop app) + Railway comparison

### What Zeros actually needs from this layer
Auth, a `cloud_workspaces` registry DB, a thin provisioning worker (holds Daytona API key), and possibly a realtime channel for cross-device presence/sync. Chat DB stays in the sandbox (engine-owned SQLite) per the v2 plan — so the cloud DB is small and low-QPS.

### Fly.io as that layer
- **For:** cheap always-on Machines (~$2/mo each) with real per-second billing; WebSockets/anycast are first-class; Tigris zero-egress object storage fits the export-blob plan; Mumbai + Singapore compute regions (Daytona sandboxes + a nearby control plane); one bill if you later also use Sprites for sandboxes.
- **Against:** **no managed auth, no managed realtime/pubsub, no row-level security** — you build all of that yourself on Machines (vs Supabase giving auth + realtime + Postgres at $25/mo). MPG is GA but young (no patch automation, undocumented backup retention, no Mumbai). Reliability record is mediocre with no SLA; the control-plane incidents (API/deploys) matter less for a running backend but the Feb-2025-style region outages do.
- Net: Fly is a fine place to *host a backend you write*; it is not a "backend-as-a-service." For a non-technical-founder team shipping fast, Supabase (managed auth+DB+realtime) or Railway (simpler PaaS) reduce code surface; Fly maximizes control and minimizes always-on cost.

### Railway on the same axes (brief)
- **Pricing model:** seat subscription + usage — Free $0 / Hobby $5/mo / Pro $20/mo acting as included credit; usage billed per minute at **$10/GB RAM/mo + $20/vCPU/mo** (roughly 2–4× Fly's shared-CPU rates for always-on, but zero-config). **[verified — Railway docs/Northflank Jun 15, 2026]**
- **Regions: only 4**, all "Railway Metal": US-West (CA), US-East (VA), EU-West (Amsterdam), **Southeast Asia (Singapore)**. **No Mumbai/India.** **[verified — docs.railway.com/reference/regions]**
- **Postgres:** databases run as containers inside your project at compute rates — **no managed HA/failover, no PITR, no read replicas** (backups exist as snapshots). Fly MPG is strictly stronger on paper for a durable registry DB. **[verified — Railway docs + Northflank]**
- **Reliability:** **May 19–20, 2026: ~8-hour platform-wide outage** after Google Cloud incorrectly auto-suspended Railway's production GCP account; dashboard/API/network infra down, cascading beyond GCP to AWS + Railway Metal workloads; founder publicly blasted Google; postmortem published. Shows control-plane concentration risk and third-party dependency (they're mid-migration to their own Metal). **[verified — Railway blog, The Register, status page]**
- **DX:** consensus 2026 comparisons: Railway wins on zero-config simplicity/UI for small teams; Fly wins on regions, machine control, per-second economics, and edge/global patterns. Neither offers managed auth or realtime — on that axis both lose to Supabase.
- Notable irony for the decision memo: both candidate platforms had serious 2025–2026 outages (Fly: chronic small incidents + IAD region loss; Railway: one catastrophic 8-hour full-platform event caused by its own upstream cloud).

### Sprites vs Daytona (sandbox-layer angle, one paragraph)
Sprites is the closest philosophical match to Zeros' "persistent engine in a sandbox" model — persistent 100GB filesystem, sleep-on-idle with state, sub-second wake, ~300ms checkpoints, per-sprite HTTPS URL that can front a WSS endpoint, DNS egress policies, cheap idle economics (~$0.44/4h session). Gaps vs Daytona today: **no region selection (India latency unknown), young API surface, no named production customers, concurrency capped by subscription tier, and Fly platform-reliability history.** Worth a Phase-1-style spike only if Daytona disappoints; the checkpoint/fork primitives would map neatly onto Zeros' turn-snapshot model.

---

## Sources

- https://fly.io/docs/about/pricing/ — Machines/volumes/egress/support pricing (fetched 2026-07-02)
- https://fly.io/docs/launch/autostop-autostart/ — autostop/autostart mechanics
- https://fly.io/docs/reference/suspend-resume/ — suspend caveats (≤2GB RAM, clock lag, resume ms)
- https://fly.io/docs/reference/regions/ — 18 regions incl. bom/sin
- https://fly.io/docs/mpg/ — Managed Postgres docs (plans, limits, under-development list)
- https://fly.io/mpg/ — MPG product page (pricing tiers, 12 regions, included features)
- https://fly.io/blog/code-and-let-live/ — Sprites launch essay (Jan 9, 2026, Kurt Mackey)
- https://fly.io/blog/design-and-implementation/ — Sprites architecture deep-dive (Jan 14, 2026)
- https://sprites.dev/ — Sprites homepage (specs, usage pricing, $30 trial)
- https://sprites.dev/release-notes — active development through Apr 2026
- https://docs.sprites.dev/quickstart/ — CLI/URL/auth mechanics (no region parameter)
- https://simonwillison.net/2026/Jan/9/sprites-dev/ — independent analysis (checkpoints, 30s sleep, cost examples)
- https://www.devclass.com/ai-ml/2026/01/13/flyio-introduces-sprites-lightweight-persistent-vms-to-isolate-agentic-ai/4079557 — launch coverage (Firecracker, quotes)
- https://rywalker.com/research/sprites — analyst comparison + subscription tiers (Feb 12, 2026, updated Jun 11, 2026; author is a competitor CEO)
- https://news.ycombinator.com/item?id=46561089 — HN discussion of Sprites
- https://vercel.com/blog/how-conductor-moved-parallel-coding-agents-from-the-laptop-to-the-cloud-with-vercel-sandbox — Conductor Cloud Workspaces = Vercel Sandbox (May 27, 2026)
- https://kuberns.com/blogs/is-fly-io-good-for-production/ — incident statistics (Jun 13, 2026; competitor, bias flagged)
- https://status.flyio.net/history and https://fly.io/infra-log/ — Fly incident history/postmortems
- https://fly.io/docs/tigris/ and https://www.tigrisdata.com/pricing/ — Tigris object storage (zero egress)
- https://northflank.com/blog/railway-vs-flyio — Railway vs Fly comparison (Jun 15, 2026; competitor, bias flagged)
- https://docs.railway.com/reference/regions — Railway's 4 regions
- https://docs.railway.com/platform/compare-to-fly — Railway's own comparison doc
- https://blog.railway.com/p/incident-report-may-19-2026-gcp-account-outage — Railway May 2026 outage postmortem
- https://www.theregister.com/off-prem/2026/05/20/google-cloud-suspended-major-customer-railwaycom-without-cause-causing-outage/5243111 — independent coverage of Railway outage
- https://community.fly.io/t/where-do-sprites-dev-sprites-live-as-in-which-fly-io-region-is-it/26775 — Sprites region ambiguity
- https://community.fly.io/t/suspend-4096mib-machines-or-let-us-have-2-cpu-2048mib-perf-machines/26604/1 — suspend RAM limit
- https://www.crunchbase.com/organization/fly-io and https://getlatka.com/companies/flyio — funding/revenue estimates
