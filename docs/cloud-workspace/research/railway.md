# Railway (railway.com) — Cloud DB + Backend Platform Evaluation

Research date: 2026-07-02. Focus: Railway as the control plane + cloud DB for Zeros cloud workspaces (auth, `cloud_workspaces` registry, thin Daytona-provisioning worker, export blobs), compared against Fly.io and Supabase.

Confidence labels: **verified** = confirmed on official docs/changelog or 2+ independent sources; **likely** = single credible source or slightly dated; **unverified** = could not confirm.

---

## 1. What Railway is (mid-2026)

- Railway is a usage-based PaaS ("the all-in-one intelligent cloud provider") that deploys containers from GitHub repos or Docker images; it now runs primarily on its own bare-metal fleet ("Railway Metal") after migrating off Google Cloud, with GCP/AWS still in the picture for control plane and burst capacity. (**verified** — railway.com, May 2026 incident report)
- Company scale (Jan 2026, Series B press): raised **$100M Series B led by TQ Ventures** (announced 2026-01-22; total funding $124M; FPV, Redpoint, Unusual participating). Metrics cited: 2M+ users, ~200k new developers/month, "tens of millions" ARR growing ~3.5x YoY / 15% MoM, ~30 employees, 10-12M+ monthly deploys, used by "31% of Fortune 500." (**verified** — Yahoo Finance/TechCompanyNews/VentureBeat, Jan 2026)
- Positioning: closer to Render/Fly.io than to serverless platforms; "strong when speed matters more than control" (srvrlss.io review, updated 2026-03-17). (**likely**)

## 2. Pricing model — hosting a small always-on backend/API

### Plans (docs.railway.com/pricing/plans, fetched 2026-07-02 — **verified**)

| Plan | Base fee | Included usage credit | Per-service limits |
|---|---|---|---|
| Trial (one-time) | $0 | $5 one-time (30 days) | 2 vCPU / 1 GB RAM, 0.5 GB volume |
| Free | $0/mo | $1/mo non-rollover credit | 1 vCPU / 0.5 GB RAM, 0.5 GB volume |
| Hobby | $5/mo (includes $5 usage) | — | 48 vCPU / 48 GB RAM cap, 5 GB volume |
| Pro | $20/mo (includes $20 usage) | — | 1,000 vCPU / 1 TB RAM cap, volumes self-serve to 1 TB |
| Enterprise | custom | custom | 2,400 vCPU / 2.4 TB RAM, 5 TB volumes |

- Pro is reportedly **$20/month per seat** (railway.com/pricing). (**likely** — from pricing-page snippet; docs plans page doesn't spell out seat pricing)
- Free plan history: free tier killed July 2023 after cryptominer abuse ("we were losing $16 for every $1 of topline revenue" — David Banys); **re-launched 2025-08-27** as $5/30-day trial then $1/month perpetual credit. (**verified** — blog.railway.com/p/free-plan, 2025-08-27)
- As of ~March 2026 Railway requires a post-paid card (no prepaid credits). (**likely** — docs plans page)

### Resource rates (usage-based, billed by the minute/second on ACTUAL consumption, not provisioned size — **verified**, docs.railway.com/pricing)

- **vCPU: $20/vCPU/month** ($0.000463/vCPU/min)
- **RAM: $10/GB/month** ($0.000231/GB/min)
- **Egress: $0.05/GB** (2.5x Fly's NA/EU rate)
- **Volume storage: $0.15/GB/month**
- **Buckets (object storage): $0.015/GB-month, egress + API operations free** (see §5)

Key mechanic: you pay for what the container actually uses, so a mostly-idle API costs much less than its limits. A container pegged at 1 vCPU / 1 GB 24/7 = $30/mo; a typical idle small Node/Go API averaging ~0.1 vCPU / 300 MB ≈ **$2 + $3 = ~$5/mo**, i.e. fits inside the Hobby plan's included $5. (**verified** mechanics; example arithmetic ours)

### Sleeping services ("Serverless", formerly App Sleeping — **verified**, docs.railway.com/reference/app-sleeping)

- Opt-in per service (Settings → Deploy → Serverless). If the service sends **no outbound packets for 10+ minutes** it sleeps; **zero compute charges while asleep**; woken by the next inbound request (public or private network) with a cold-start delay.
- Gotchas: open DB connections, telemetry, cron-like outbound calls all prevent sleep. Community threads report flakiness (services not sleeping / sleeping when disabled). For a control-plane API for a desktop app you'd likely keep it always-on anyway (WS presence, webhooks); at ~$5/mo idle cost that's fine.

## 3. Managed Postgres on Railway — template first, "managed" features arriving in 2026

This is the most nuanced axis. Two layers exist:

### 3a. The classic database offering = an UNMANAGED template (**verified**)

- Official docs (databases/postgresql): the one-click Postgres/MySQL/Mongo/Redis templates "are considered **unmanaged**, meaning you have total control over their configuration and maintenance." It's Railway's SSL-enabled image on top of the official Docker Hub Postgres image, on a Railway volume.
- No built-in HA by default; docs tell YOU to "automate regular backups"; extensions not included in the base image (PostGIS/Timescale via marketplace templates); version upgrades are your problem (only major versions supported, no minor-version pinning).
- Volume-level Backups feature exists (snapshot-style) but is not a DBA service.
- Failure mode documented in community analysis: automatic Postgres image updates have corrupted data directories (newer initdb vs older running version), leaving databases "unbootable," with some losses "irreversible" (Stack & Sails analysis of ~5,000 forum threads through 2026-02-21: 309 threads about data loss/corruption). (**likely** — single detailed analysis, but consistent with many Station threads)

### 3b. New in 2026: HA Postgres + PITR (moving toward first-class managed DB, but young)

- **HA Postgres** (changelog #0281, **2026-03-13** — **verified**): one-click conversion of a single Postgres into an HA cluster — 3 etcd (consensus) + 3 Postgres nodes managed by **Patroni** (streaming replication, automatic leader election) + HAProxy routing writes to primary, reads to replicas; sub-30s automatic failover claimed. **Explicitly labeled experimental and "not production-ready"** at launch; gated to Priority Boarding (early-access) users; you pay for all 7 services' resources.
- **Postgres PITR** (changelog #0290, **2026-05-15**; docs/volumes/point-in-time-recovery — **verified**): continuous WAL archiving via **pgBackRest** to Railway storage buckets; weekly full + daily incremental base backups, last 4 fulls retained (~4-week window, restore-to-the-second); opt-in from the Backups panel for **Pro users**; not retroactive (window starts at first post-enable backup); restore creates a NEW sibling service (manual cutover; HA restores come back as single-node). Billing = bucket storage + service egress on zstd-compressed data ("a few GB of compressed WAL per day under steady write load").
- Net assessment: as of mid-2026 Railway Postgres is **converging on managed-DB features (HA, PITR) but is not yet a mature managed database** like RDS/Supabase/Fly MPG — no automated minor-version patching story, HA experimental, PITR brand-new, and the underlying template remains user-operated (`railwayapp-templates/postgres` repo is literally tagged "🚧 Railway Postgres (alpha)"). (**verified** for the facts; assessment ours)

## 4. Regions (**verified** — docs.railway.com/reference/deployment-regions)

Four regions, all on Railway Metal:

| Region | Location | ID |
|---|---|---|
| US West Metal | California, USA | `us-west2` |
| US East Metal | Virginia, USA | `us-east4-eqdc4a` |
| EU West Metal | Amsterdam, NL | `europe-west4-drams3a` |
| Southeast Asia Metal | Singapore | `asia-southeast1-eqsg3a` |

- **No India region; Asia = Singapore only.** Region is selected per service and can be changed anytime (volume-attached services incur downtime when migrating). Buckets: region fixed at creation.
- Plan gating: historically non-US-West region selection was **Pro-only**; a March 2026 third-party review "observed no region gating," and current docs don't state one, but Railway's own feedback board still tracks "Regions for Hobby plan users." Treat as: **fully free region choice on Hobby is unverified** — assume Pro if region matters.

## 5. What Railway bundles vs what you must build

### Bundled (mid-2026)
- **Compute** (containers, replicas, private networking, TCP/gRPC/WebSocket/HTTP routing), cron, PR/preview environments, templates marketplace, CLI + API, iOS dashboard app (changelog 2026-05-15).
- **Object storage: Railway Buckets** (launched Sept 2025, GA; built on **Tigris**): private S3-compatible buckets, **$0.015/GB-month, unlimited free egress + free API ops** (matches R2 storage price, beats S3). Per-environment isolated credentials; presigned URLs, multipart, tagging supported; NO server-side encryption, versioning, object locks, lifecycle rules, public buckets, or automatic backups yet. (**verified** — docs.railway.com/storage-buckets)
- **Databases**: templates + emerging HA/PITR (§3).
- **WebSockets**: supported natively at the edge; per docs (SSE-vs-WebSockets guide): WebSocket connections "are exempt from request timeouts and can stay open indefinitely, even while idle" — but plain HTTP/SSE requests are capped at **15 minutes** (5 min if idle), and deploys still drop WS connections (client reconnection logic required). Community threads report silent WS drops (~50 min) in practice — keepalive pings every 10-30s recommended. (**verified** docs; drop reports **likely**)

### NOT provided — you build/bring your own (**verified** by absence in docs + community guidance)
- **End-user auth**: nothing built in. Railway's own guides point you at Clerk (frontend-auth guide) or self-hosting Supabase Auth on Railway. For Zeros you'd integrate Clerk/WorkOS/Auth0/Supabase Auth or roll your own.
- **Realtime/pub-sub as a service**: none. You run your own WS server (fine on Railway) or deploy NATS/soketi/Supabase Realtime templates yourself.
- **Row-level security / client-facing DB API**: none — your API is the only gate to Postgres.
- **Email, edge functions, vector, queues-as-a-service**: none first-class (templates only).
- So Railway = **compute + DB templates + object storage**; everything Supabase bundles (auth, realtime, RLS, storage API, client SDKs) is DIY on Railway except raw object storage.

### Self-hosting / BYOC
- **BYOC and dedicated VMs exist only on the Enterprise plan behind a sales contract** — no self-serve BYOC; no multi-cloud spanning of one workload. Railway itself is not open-source/self-hostable. (**verified** — Railway BYOC blog 2026 + Northflank comparison)

## 6. Reliability reputation (the weak axis right now)

Railway had a rough Nov 2025 – May 2026 stretch; at least five major postmortems (**verified** — status.railway.com, blog.railway.com, InfoQ, HN):

- **Dec 2025**: attackers exploited a Next.js vuln to deploy cryptominers across customer workloads → fleet-wide CPU starvation, ~4h Major Outage.
- **Feb 2026**: nine DDoS waves over four days + an upstream fiber cut + a Cloudflare BGP incident → intermittent multi-region disruption. Railway's own postmortem admitted a pattern of "tightly coupled systems with a large blast radius."
- **Mar 2026**: config change accidentally enabled CDN caching on opted-out domains → **authenticated data potentially served to the wrong users for 52 minutes** (a security incident, not just downtime).
- **2026-05-19/20 (the big one)**: **Google Cloud auto-suspended Railway's production account** (automated ToS action, no warning) → **~8-hour platform-wide outage** (22:20 UTC → 06:14 UTC) for ~3M users / ~10M services — dashboard, API, deploys, networking all down, including workloads on AWS and Railway Metal, because the network control plane (routing tables) lived solely on GCP and cached edge routes expired. Founder Jake Cooper "gobsmacked"; 150+ HN comments; remediation promised: demote GCP to backup-only, true mesh routing, HA DB shards across AWS+Metal. (**verified** — Railway incident report, InfoQ 2026-05, HN)
- Status-page uptime: Jan 2025 100.00%, Feb 2025 98.84%, **May 2026 99.26%, Jun 2026 99.87%** (June had degraded-storage, SEA private-networking, and deploy-delay incidents). (**verified** — status.railway.com/historical)
- Community-level audit ("Is Railway Production Ready in 2026?", Stack & Sails, Feb 2026, ~5,000 Station threads analyzed): 1,908 platform complaints, 57% build/deploy failures (hung deployments blocking hotfixes), 309 data-loss threads, SSL certs stuck "Validating," 5-minute hard timeout complaints, Pro support SLA 48h but 72h+ waits observed during outages. Verdict: great for side projects/MVPs/staging, "not production-ready" for paying-customer production. (**likely** — one analyst, but data-driven and consistent with incident record)
- **No public uptime SLA** on self-serve plans; SLOs for "Business Class," SLAs negotiated case-by-case on Enterprise. (**verified** — Station answer)
- Counterweight: Railway is well-funded (Jan 2026 $100M), migrating to owned metal, and shipping reliability work fast; the free-plan relaunch post cites improved margins/reliability from Metal. The trajectory is up, but mid-2026 track record is objectively bumpy.

## 7. Comparison: Railway vs Fly.io vs Supabase for "control plane + cloud DB for a desktop app with cross-device sync"

The Zeros job: small always-on API (auth gateway + `cloud_workspaces` registry + Daytona-provisioning worker holding the API key), a small Postgres, object storage for chat/artifact export blobs. The heavy realtime path (agent chat WS) is engine-owned in the Daytona sandbox per the execution plan, so the control plane's realtime needs are light.

### Pricing snapshot (mid-2026)

| | Railway | Fly.io | Supabase |
|---|---|---|---|
| Model | usage-based on actual consumption; $5 Hobby / $20 Pro base w/ same-size credit | pay-as-you-go per provisioned Machine; no base fee (support from $29/mo) | flat plans: Free / **Pro $25/mo** + usage overages |
| Small always-on API | ~0.1 vCPU + 0.3 GB avg ≈ **~$5/mo** (fits Hobby credit) | shared-cpu-1x 256MB ≈ **$2.02/mo**; 1GB ≈ ~$5-6/mo | Edge Functions or external; Supabase isn't a general app host |
| vCPU / RAM | $20/vCPU-mo, $10/GB-mo (used) | ~$0.0028/hr per shared vCPU tier; RAM ~$5/GB-mo (provisioned) | compute add-ons: Micro $10/mo (included in Pro) → 12XL $2,800/mo |
| Managed Postgres | template (unmanaged) ≈ compute cost (~$5-15/mo small); HA experimental; PITR new (Pro, pay storage+egress) | **Fly MPG: Basic $38/mo** (shared-2x, 1GB), Starter $72, Launch $282, Scale $962, Performance $1,922; storage $0.28/GB-mo; "all plans include HA, backups, connection pooling" | included: 8GB disk on Pro (then $0.125/GB); PITR add-on **$100/mo per 7-day window**; daily backups on Pro |
| Object storage | Buckets $0.015/GB-mo, **free egress/ops** (Tigris-backed) | Tigris (partner) — similar economics | 100 GB files included on Pro, then $0.0213/GB |
| Egress | $0.05/GB | $0.02/GB NA/EU, $0.04 APAC, $0.12 India/Africa | 250 GB incl. on Pro, then $0.09/GB |
| Scale-to-zero | Serverless sleep (10-min outbound-idle) | autostop/autostart Machines (volumes still billed) | Free tier pauses projects after 1 week inactivity (bad); Pro never sleeps |

### Feature/ops axes

| Axis | Railway | Fly.io | Supabase |
|---|---|---|---|
| Auth for end users | ✗ build/bring (Clerk/WorkOS/self-host) | ✗ build/bring | ✓ built-in (100k MAU incl., then $0.00325/MAU) |
| Realtime/WS infra | ✗ (run your own WS server; edge supports WS) | ✗ (run your own; good WS support, Anycast) | ✓ Realtime channels (500 concurrent incl., then $10/1k) |
| Postgres quality | template + experimental HA + new PITR; data-loss history | MPG fully managed (HA, backups, pooling) but pricey from $38/mo; upgrades/extensions still maturing | first-class managed PG w/ RLS, PITR add-on, branching ($0.01344/branch-hr) |
| RLS / client SDK to DB | ✗ | ✗ | ✓ (RLS + client libs = less backend code) |
| Regions | 4 (US-W, US-E/Virginia, Amsterdam, **Singapore**; no India) | 30+ regions incl. Singapore, Sydney, Tokyo, India (bom); MPG in 12 regions | AWS regions worldwide incl. Singapore/Mumbai (project pinned to one region) |
| Reliability rep (mid-2026) | bumpy: 8h GCP-suspension outage May 2026, cryptominer + DDoS + cache-leak incidents; no self-serve SLA | historically flaky (avg ~13 incidents/mo since 2022 per IsDown; May 2026: incidents on 20 of 31 days; recurring Consul/Corrosion root causes); no standard SLA | generally solid rep; occasional incidents; enterprise SLAs exist |
| Ops burden for our job | run API + own auth + own DB care (until HA/PITR mature) | run API + pay MPG to not think about DB | ~zero DB/auth/realtime ops; but no general app host (worker must live elsewhere — Fly/Railway/anywhere) |
| BYOC/self-host | Enterprise-only BYOC | ✗ (public cloud only) | ✓ fully open-source, self-hostable (incl. on Railway) |
| DX | best-in-class dashboard, canvas, templates, PR envs | CLI-first, more knobs (Machines API great for programmatic infra) | dashboard + client SDKs |

### What you'd still have to build yourself on Railway (for Zeros)
1. **User auth end-to-end** (signup, OAuth, tokens for the Mac app + sandbox WS tokens) — or wire in Clerk/WorkOS/Auth0/Supabase Auth as a separate vendor.
2. **Authorization layer** in the API (no RLS; every registry read/write goes through your code).
3. **Any control-plane realtime** (e.g., "workspace list changed on another device") — your own WS/SSE endpoint + client reconnect logic.
4. **DB operations discipline** until HA/PITR mature: enable the new PITR (Pro), plus your own pg_dump-to-Buckets cron as belt-and-braces given the platform's data-loss history.
5. **Billing/usage metering** for your own customers (all three platforms leave this to you).

### Bottom-line read for the Zeros control plane (assessment, not a source claim)
- **Cost at small scale**: all three are cheap. Railway ≈ $5-25/mo (Hobby/Pro + small usage); Fly ≈ $2-10/mo compute but **+$38/mo minimum for managed Postgres**; Supabase = $25/mo Pro flat with auth+DB+realtime+storage included. At Zeros' current scale, price is a non-factor; bundling and ops burden dominate.
- **Railway's honest fit**: excellent DX and a genuinely good worker/API host with cheap S3 storage (Buckets' free egress is great for export blobs), but for THIS job it is "plain compute + DB": you re-assemble auth + realtime + DB safety that Supabase gives you out of the box — and its 2026 reliability record (8h full-platform outage, data-loss threads, security cache leak) argues against making it the single point of failure for a desktop product's login path right now.
- The execution plan's current pencil (Supabase for auth + registry, thin worker anywhere) is the lower-ops path; Railway's strongest role would be **hosting the thin provisioning worker/API** (possibly alongside Supabase), not replacing the whole Supabase bundle. Fly is the middle option: real managed Postgres and more regions, but a worse reliability reputation than either on raw incident counts and nothing bundled for auth/realtime either.

---

## Sources

- https://docs.railway.com/pricing/plans — plans, credits, per-plan limits (fetched 2026-07-02)
- https://docs.railway.com/pricing — resource rates (via search snippets)
- https://railway.com/pricing — Pro $20/seat (via search snippet)
- https://docs.railway.com/reference/app-sleeping — Serverless/app sleeping
- https://docs.railway.com/databases/postgresql — Postgres template, "unmanaged" quote
- https://docs.railway.com/volumes/point-in-time-recovery — PITR mechanics (pgBackRest, ~4-week window, Pro opt-in)
- https://railway.com/changelog/2026-03-13-highly-available-postgres — HA Postgres launch (experimental), Buckets CLI
- https://railway.com/changelog/2026-05-15-railway-for-ios — changelog #0290 (PITR, iOS app)
- https://github.com/railwayapp-templates/postgres — "Railway Postgres (alpha)" template repo
- https://docs.railway.com/reference/deployment-regions — 4 Metal regions
- https://docs.railway.com/storage-buckets — Buckets pricing/limits/Tigris backing
- https://docs.railway.com/guides/sse-vs-websockets — WS exempt from timeouts; SSE 15-min cap
- https://docs.railway.com/guides/socketio — WS deployment guidance / connection-limit handling
- https://blog.railway.com/p/free-plan — free plan relaunch (2025-08-27), "$16 lost per $1 revenue" quote
- https://blog.railway.com/p/incident-report-may-19-2026-gcp-account-outage — 8h GCP suspension postmortem
- https://www.infoq.com/news/2026/05/railway-gcp-account-outage/ — independent coverage of the May 2026 outage
- https://news.ycombinator.com/item?id=48200827 and https://news.ycombinator.com/item?id=48201484 — HN threads on the outage
- https://status.railway.com/historical — uptime history (May 2026 99.26%, Jun 2026 99.87%)
- https://stackandsails.substack.com/p/is-railway-production-ready-in-2026 — 5,000-thread community audit (Feb 2026)
- https://station.railway.com/questions/railway-s-sl-as-b851c079 — SLA policy (SLOs Business Class, Enterprise case-by-case)
- https://blog.railway.com/p/what-is-byoc-developer-guide-2026 + https://northflank.com/blog/railway-alternatives — BYOC Enterprise-only
- https://station.railway.com/feedback/regions-for-hobby-plan-users-6e6d418d — region plan-gating feedback thread
- https://www.srvrlss.io/provider/railway/ — third-party pricing/regions review (updated 2026-03-17)
- https://finance.yahoo.com/news/railway-raises-100-million-series-140100124.html — Series B (2026-01-22)
- https://venturebeat.com/infrastructure/railway-secures-usd100-million-to-challenge-aws-with-ai-native-cloud — Series B coverage (fetch blocked, title/snippet only)
- https://fly.io/pricing/ and https://fly.io/docs/about/pricing/ — Fly machine/volume/egress prices
- https://fly.io/docs/mpg/ — Fly Managed Postgres plans ($38-$1,922/mo, 12 regions)
- https://kuberns.com/blogs/is-fly-io-good-for-production/ — Fly incident-frequency analysis (609 incidents since 2022, May 2026 20/31 days)
- https://news.ycombinator.com/item?id=42248279 — HN on Fly reliability reputation
- https://supabase.com/pricing — Supabase Free/Pro details (fetched 2026-07-02)
