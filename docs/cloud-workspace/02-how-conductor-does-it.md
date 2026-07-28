# How Conductor Does It
*part 02 of the Zeros Cloud Workspaces Report · July 2026*

Conductor.build is the reference competitor: a Mac app for running many coding agents at once, made by Melty Labs (YC S24, ~7 people, $22M Series A announced March 30, 2026). In early May 2026 they announced **Conductor Cloud** — the same product, but the agents run on rented cloud computers. As of July 2, 2026 it is still invite-only early access with a waitlist and no published pricing.

This document is a teardown of how their cloud actually works. It is unusually well-sourced: on top of public blogs and changelogs, our research included first-hand inspection of a live Conductor install on July 2, 2026 — reading its local database (read-only), analyzing the app binary, and probing their production servers. Every claim below is tagged **verified** (2+ sources or direct observation), **likely** (strong but single-source), or **unverified**.

## The short version

- **Conductor Cloud is the same bet Zeros is making**: identical desktop app, agents running on a rented cloud computer, work continues when the laptop closes. Their CEO's pitch — "users can't tell the difference between local and cloud" — is exactly the bar Zeros should aim for.
- **The rented computer is Vercel Sandbox** (verified: Vercel's own May 27, 2026 customer blog, plus the Mac app's network allowlist). An earlier alpha provider codenamed **"sprite"** — almost certainly Fly.io's Sprites — sits in their data model, meaning they built a pluggable provider layer and **switched sandbox vendors mid-beta**.
- **They run a broker server in the middle**: `api.conductor.build`, hosted on Fly.io, with a cloud Postgres database and a sync engine (ElectricSQL). Every cloud workspace is registered through it. But the Mac app is also allowlisted to talk **directly** to the sandbox over WebSocket — so it is a hybrid, not a pure everything-through-the-middleman design.
- **Chat still lives in a local database on the Mac** — our July 2 inspection found 474,736 messages in the local `conductor.db`, including 81,188 from cloud workspaces — while their own docs still claim "none of it is stored on our servers." The collaboration plumbing (org IDs, permission levels, per-message sender IDs) shipped quietly, but the data model is still local-DB-first.
- **Their "fast as local" trick is a local file mirror**: cloud files are continuously copied to a folder on the Mac (`~/conductor/remote-workspace-sync`), so the editor reads files at disk speed. It is a homegrown sync engine, not an off-the-shelf tool. **This is the one thing Zeros should copy outright.**
- **Pricing: unannounced.** The app is free, users bring their own AI-model credentials, and The New Stack (May 14, 2026) confirmed no cloud pricing has been detailed. Their raw cost floor is roughly $0.13–0.34 per active hour per workspace at Vercel list prices.
- **Verdict for Zeros (updated 2026-07-02): adopt the mirror, skip the broker on the live path — and go their way on the database.** The founder decided on July 2, 2026 that Zeros will keep **the cloud record** — our cloud database that permanently stores your chats, sessions, and workspace history in your account: a cloud Postgres plus a sync engine, the same layer Conductor runs (theirs is ElectricSQL). The leapfrog: Conductor's data model is still local-DB-first with cloud sync retrofitted; Zeros makes the cloud record primary from day one, while the app still dials the sandbox directly with no broker on the live path.

## What their users experience

Walking through the flow as a Conductor Cloud user (all verified from their changelog, May–July 2026):

1. **You press Cmd+N** and get the "Dispatcher" — a prompt box for starting new work. You choose cloud instead of local.
2. **A setup flow runs**: you grant repo access through a GitHub App (a scoped, revocable way for an app to touch specific repositories, instead of a broad personal token), pick a setup script, review a "snapshot configuration" page, and optionally one-click-import your local agent API keys into the cloud machine. Then you hit Launch.
3. **You work exactly like local**: chat with agents, diff view, terminals, browser previews of dev servers. The interface does not change.
4. **You close the laptop.** The agents keep going on the cloud machine. When the workspace goes idle, it "sleeps" — its disk is photographed (a *snapshot* — a saved copy of the machine's files) and the machine shuts down, costing almost nothing until you come back.
5. **You come back** and the workspace wakes from its snapshot. If file sync is on, a full copy of the workspace's files sits in `~/conductor/remote-workspace-sync` on your Mac: **Cmd+O opens that local mirror** in your editor, **Cmd+Opt+O opens the remote machine**, and a menu item copies an SSH command for direct terminal access.
6. **You can share**: since July 1, 2026, Cmd+Shift+C copies a link to a workspace or a chat. Cloud workspaces are scoped to an organization, with per-workspace permission levels.

What users do **not** get yet: a phone app, a web version of workspaces, or visible multiplayer chat. The stated direction is "available everywhere from your phone to your VPC" (Series A letter), but as of July 2026 nothing beyond the Mac app has shipped. Cross-device sync between two Macs on one login is strongly implied by the architecture but has never been publicly demonstrated (**likely, unverified**).

## The verified stack, layer by layer

### The rented computer: Vercel Sandbox (verified)

A **sandbox** is a rented computer in a data center that can be created and thrown away in seconds. Conductor's sandboxes come from **Vercel Sandbox** — verified by Vercel's own customer story (May 27, 2026: "Cloud Workspaces, Conductor's remote execution layer built on Vercel Sandboxes") and by the Mac app binary itself, which allowlists `https://sb-*.vercel.run` and `wss://sb-*.vercel.run` — the address pattern of Vercel sandboxes.

Practical consequences of that choice (all verified from Vercel's docs, updated June 2026):

- Sandboxes run Amazon Linux and are **US-East only** (one region, `iad1`). A user in Europe or India is 80–250 ms away from their "computer."
- A session can run at most **24 hours**; long-lived workspaces are actually stop/resume cycles over snapshots, not one continuous machine. Snapshots capture the **files only** — running programs die on every stop and must restart on wake.
- Snapshots **expire 30 days after last use** by default. A workspace untouched for a month silently loses its saved state unless expiry is configured off. Conductor exposing a user-facing "snapshot configuration" page suggests they take this seriously.
- List pricing: $0.128 per CPU-hour of *active* CPU (waiting on the AI model is free), $0.0212/GB-hour of memory, $0.08/GB-month for stored snapshots.

### The plot twist: they already switched vendors once (verified fact, likely interpretation)

Inside the app binary, database migration #95 reads:

```sql
ALTER TABLE workspaces ADD COLUMN sandbox_provider TEXT;
UPDATE workspaces SET sandbox_provider = 'sprite' WHERE hosting_server_url IS NOT NULL;
```

Translation: when multi-provider support landed, every pre-existing cloud workspace was labeled provider **"sprite"** — matching **Fly.io's Sprites** product (persistent AI-agent sandboxes, launched January 9, 2026). The alpha backend literally lived at `conductor-cloud-alpha.fly.dev`. On the inspected machine, all 18 cloud workspaces are now `sandbox_provider='vercel'`.

So the earlier intel — "Conductor uses Vercel Sandbox + Fly Sprites + a Fly backend" — resolves cleanly with dates: **Sprites was (very likely) the alpha provider, Vercel Sandbox is the current default, and Fly hosts their backend either way.** The durable lesson for Zeros is not which vendor they picked; it is that they built a `sandbox_provider` column and a swappable provider layer, and it saved them when they changed horses mid-beta. Zeros' planned `CloudSandboxProvider` interface is the same insurance.

### The broker: api.conductor.build (verified)

A **broker** is a middleman server that sits between the app and the cloud machines — think of a hotel front desk: you don't get a key by walking to the room, you check in at the desk, and the desk knows which rooms exist and who is allowed in.

Every cloud workspace row in the local database carries `hosting_server_url = https://api.conductor.build` (verified by SQL on the live install). Probing that server directly (July 2, 2026) revealed:

- It runs on **Fly.io** (`via: 1.1 fly.io` response headers) behind Cloudflare, internal codename **"roundhouse"**, with a staging twin and the old alpha address still answering.
- Their privacy docs confirm account data lives in "an encrypted **Postgres database served by Fly**" (Postgres — a standard server-grade database).
- Login is **WorkOS** (a login-as-a-service vendor; `auth.conductor.build` points at WorkOS's servers), and a login-gated web app exists at `app.conductor.build`.
- The server exposes **ElectricSQL** protocol headers. Electric is a *sync engine* — software that automatically copies slices of a central Postgres database down to each client, like a mail room that photocopies every relevant memo into every employee's inbox. This means Conductor's backend streams server-side data down into each Mac's local database.

**Why have a broker at all?** Two honest reasons. First, somebody has to hold the Vercel account credentials and create sandboxes — you never put a provider API key inside a desktop app anyone can decompile. (Zeros' plan has the same thing: a thin worker holding the Daytona key.) Second — and this is where our two research passes disagree, so both are presented with dates — the June 2026 reverse-engineering concluded *"the Mac never dials Vercel directly,"* likely because Vercel lacked a clean documented WebSocket path; but the July 2, 2026 binary analysis found `wss://sb-*.vercel.run` **in the app's own connection allowlist**, meaning direct Mac-to-sandbox WebSocket connections (a WebSocket — a phone line kept open between two computers so either side can speak instantly) are at least part of the current design, probably for terminals and port-forwards. Best synthesis: **the broker owns the control plane** (registry, orgs, permissions, sync) **and at least the chat/data-of-record path, while some live traffic goes direct to the sandbox.** The exact split is not public (**likely, needs-testing** if it ever matters to us).

### Where the data lives — the most important finding (verified)

Our on-disk inspection (July 2, 2026, a live daily-driver install):

- `conductor.db` is a **1.7 GB SQLite file on the Mac** (SQLite — a database that lives in a single file inside an app, no server needed). It held **474,736 chat messages** — up from ~336k when the same machine was inspected in June 2026. Same model, still growing.
- **81,188 of those messages belong to cloud workspaces.** Even when the agent runs in the cloud, the full chat history lands in a local file on the Mac.
- Meanwhile Conductor's current public docs still say: *"Your chat history is saved locally… None of it is stored on our servers"* — and contain **no cloud-workspaces documentation at all**.

That is a genuine docs-versus-product contradiction, and honesty requires presenting both readings:

1. **The docs are stale.** The backend demonstrably runs a Postgres sync engine, the schema is multi-user (`organization_id`, `permission_level`, `creator_user_id`, `creator_client_id`, and a populated per-message `sender_id`), and shareable chat links (July 1, 2026) only make sense if the server can resolve a chat's identity. The most plausible synthesis (**likely**): the server-side Postgres holds at least the workspace registry, org membership, and permissions, Electric syncs relevant state down into each Mac's local SQLite — and they may have quietly moved (or be moving) chat content server-side too.
2. **Or chat really is still local-only-of-record**, with the server holding only registry/permissions — in which case their cross-device story has a hole: a second Mac could *attach* to your cloud workspace but would not have your chat history.

Either way, the architecture as observed in July 2026 is **local-database-first with a server sync layer being retrofitted**. That shape works beautifully for one person on one Mac. It gets awkward for teams: when every client keeps its own copy of record and edits flow through a central mail room, you inherit sync conflicts, partial histories, and "who has the truth?" questions. Zeros draws two lessons instead of one: adopt their *destination* — a cloud database of record with a sync engine, which is where their retrofit is headed and where Zeros now goes too (decided 2026-07-02; see the verdict below) — but skip their *journey*, by making the cloud record primary from day one instead of retrofitting it under a local-first model.

### The file mirror — the trick worth stealing (verified mechanics)

The reason cloud Conductor "feels local" is not magic networking; it is a **local file mirror**. Every cloud workspace's files are continuously copied to `~/conductor/remote-workspace-sync/<RepoName>/` on the Mac (verified on disk — two mirrored repos on the inspected machine). Your editor, file tree, and diffs read *local* files at disk speed; only the agent, terminal, and builds actually run in the cloud, where latency doesn't reach your eyes.

Analogy: instead of driving to the storage unit every time you need a document, you keep a photocopy of the whole cabinet at home, and a courier keeps both cabinets identical in the background.

Details from the binary and changelog (verified):

- It is **homegrown, not off-the-shelf** — zero traces of Mutagen (the open-source file-sync engine Zeros plans to use) in any Conductor binary. Their engine uses git references plus compressed archive downloads (gzip/zstd) with checksum verification.
- It took real iteration: an early version required the user's SSH config (dropped May 20, 2026); sync only became available for **all** cloud workspaces on June 12, 2026; recovery after restarts and missed file events shipped the same week. Budget for this pain.
- The payoff shipped July 1, 2026: Cmd+O opens the mirror locally, Cmd+Opt+O opens the remote, terminals are streamed via an internal mirror protocol.

## Teams and pricing

**Teams (as of July 2, 2026):** partially shipped, entirely unmarketed. Verified: org-scoped cloud workspaces, per-workspace permission levels (a "shared workspace access" permissions fix shipped May 21, 2026), per-message sender IDs, and workspace/chat share links (July 1, 2026). Not shipped: multiplayer chat UX, team dashboards. On the YC podcast (published June 4, 2026) the CEO was still speculating aloud about whether multiplayer agent chats should exist. **Real-time collaboration on agent chat is open ground.**

**Pricing:** the Mac app is free with bring-your-own model credentials. Conductor Cloud has **no published pricing** ("Conductor hasn't detailed pricing for Conductor Cloud" — The New Stack, May 14, 2026); their FAQ says monetization will come from collaboration/team features. For calibration: at Vercel list prices, one 2 vCPU/4 GB sandbox costs roughly **$0.13–0.34 per active hour**, and a stopped workspace costs pennies per month in snapshot storage. A third-party analyst guessed at $20/month individual, $40/user/month team pricing — **pure speculation, unverified**. The one dated business risk: on May 13, 2026 Anthropic moved to restrict Claude-subscription use inside third-party tools (which would push Conductor users onto costlier API pricing); the change was delayed indefinitely on June 15, 2026.

## Their architecture vs ours — the diagram

*(Description for the HTML page to draw: two side-by-side stacks.)*

**Left — Conductor (as observed July 2026).** Top: a Mac running the Conductor app **with a 1.7 GB `conductor.db` inside the Mac** and a mirror folder (`~/conductor/remote-workspace-sync`). From the Mac, **two arrows**: a thick one down to `api.conductor.build` (a box labeled "Broker — Fly.io · Postgres · ElectricSQL sync · WorkOS auth"), and a thinner direct arrow to a box labeled "Vercel Sandbox (iad1, US-East) — agents run here," annotated "direct WSS for live traffic." An arrow from broker to sandbox labeled "provisions." Crucially, the **database icon sits on the Mac**, with a two-way "sync engine" arrow between broker and Mac.

**Right — Zeros (planned, updated 2026-07-02).** Top: a Mac running Zeros with **no database icon on the Mac** — just a mirror folder (via Mutagen). **One thick arrow** straight from the Mac to a box labeled "Daytona sandbox (US/EU) — full Zeros engine + `zeros.db` live here (the working copy — one writer while it runs)," annotated "direct WSS + per-user token; no middleman on the live path." Below the sandbox, two destinations: a dotted arrow to "git remote — the vault (code)," and a **solid write-through arrow** labeled "streams every chat/state event" into a prominent box "🗂️ The cloud record — cloud Postgres (Supabase) + sync engine: chats, sessions & history, yours forever; survives sandbox deletion (decided 2026-07-02)." Off to the side, the control plane (off the live path), with dotted arrows: "thin worker (holds Daytona key — provisioning only)" and "Supabase (login + registry — its Postgres hosts the record)." A second Mac (teammate) connects to the **same sandbox box** with its own arrow — illustrating why collaboration is native. (The old "export blobs" durability node is gone: a periodic export survives only as an optional backup behind the record.)

Caption: *Conductor keeps the database of record on every Mac and syncs it through a middleman. Zeros keeps the working copy next to the agent, streams every event into the cloud record, and still lets every Mac dial the sandbox directly. The sandbox is the workbench; the cloud record is the filing cabinet; git is the vault.*

| | Conductor (observed, July 2026) | Zeros (planned, updated 2026-07-02) |
|---|---|---|
| Sandbox vendor | Vercel Sandbox (was "sprite"/Fly in alpha) | Daytona (swappable interface; Fly fallback) |
| Regions | US-East only | US + EU |
| Middleman on the live path | Yes — `api.conductor.build` (Fly), plus some direct WSS | No — direct WSS to sandbox; thin worker for provisioning only |
| Chat database | Local SQLite on every Mac + server sync layer | `zeros.db` in the sandbox as the working copy; **the cloud record** (cloud Postgres + sync engine) as the permanent home — decided 2026-07-02 |
| File speed trick | Homegrown local mirror (git refs + archives) | Local mirror via Mutagen (off-the-shelf) |
| Sleep/wake | Delegated to Vercel snapshots (24h cap, 30-day expiry) | Engine-owned idle logic; provider stop/start — with the record, sandboxes can even be deleted, not just stopped |
| Collaboration | Retrofit in progress (orgs, senders, links) | Native by design (N clients, one live engine + one cloud record) |
| Cloud pricing | Unannounced | TBD (cost floor ~$0.17/hr per 2vCPU box) |

*The Zeros column reflects the founder's 2026-07-02 decision to adopt the cloud record; the June v2 engineering plan predated that decision — its v3 revision (part 08, 2026-07-03) applies it.*

## Adopt / skip / adopt — the verdict

> **Updated 2026-07-02:** this section originally ended in "DIVERGE: the database." The founder has decided to go Conductor's way on the database — a cloud Postgres record plus a sync engine — while still skipping their broker on the live path. The third verdict below reflects that decision; everything reported about Conductor above is unchanged.

**ADOPT: the local file mirror.** This is Conductor's genuinely great idea and the whole reason cloud "feels local." Zeros should ship it — but with Mutagen (a maintained open-source sync engine) instead of building a homegrown one. Conductor spent roughly a month of changelog entries debugging SSH configs, missed file events, and restart recovery on theirs. Their pain, our shortcut.

**SKIP: the broker on the live path.** Conductor routes registry, permissions, and (at least historically) workspace traffic through `api.conductor.build` — likely because when they started, Vercel Sandbox had no clean documented way for an outside app to hold a WebSocket to a user's server inside the sandbox. Daytona documents exactly that (WebSocket over its preview URLs, per our internal plan), so Zeros can let the Mac dial the sandbox directly with a per-user token. Fewer moving parts, and no middleman to scale on the live path. We still keep the one piece of "front desk" that is genuinely necessary: a thin worker that holds the Daytona API key and does provisioning only. (To be plain: durable data — chats, sessions, history — *does* land in our cloud, in the cloud record, by design; that is the feature. What skips our servers is the live traffic while you work.)

**ADOPT (decided 2026-07-02): the database — we now go their way.** Conductor's backend runs a cloud Postgres with a sync engine (ElectricSQL) copying server-side data down to each client, and that destination is the right one: durable work cannot live only in a disposable sandbox, users must be able to get their data back years later, and cross-device sync needs a server-side record anyway. So Zeros adopts the same layer — **the cloud record**, a cloud Postgres in your account plus a sync engine (ElectricSQL, the very engine Conductor uses, is our named spike candidate; a periodic export survives only as an optional backup). The leapfrog that keeps our advantage: Conductor got here backwards — a database of record on every Mac, with cloud sync retrofitted, and their docs/product contradiction shows the strain. Zeros makes the cloud record primary from day one: the engine's `zeros.db` in the sandbox is just the working copy, and the engine streams every chat/session/state event up to the record. One writer while a workspace runs, one permanent truth in your account, and every teammate or device is a client of both. (See "Cross-Device Sync and Team Collaboration" for the full "live engine + cloud record" model, and "Platform Comparison" for the Daytona-vs-Vercel trade in depth.)

## What this means for Zeros

1. **The category is validated.** A funded, well-run competitor bet the company on "same desktop app, agents in a cloud sandbox, laptop closes, work continues" — and their users reportedly can't tell the difference. Zeros' plan is the same shape with three deliberate improvements (direct connection on the live path, a cloud record that is primary from day one rather than retrofitted, EU region option).
2. **Prioritize the mirror right after the connection works.** Conductor's experience says the mirror *is* the perceived-speed product. Our Phase 3 (Mutagen mirror) is correctly placed immediately after Phase 2 (basic cloud transport). Do not ship a GA where every file read crosses the ocean.
3. **Keep the provider swappable — they needed it.** Conductor changed sandbox vendors mid-beta and survived because of a humble `sandbox_provider` column. Our `CloudSandboxProvider` interface and the pinned SDK are the same discipline; keep them honest.
4. **Their two-month invite-only beta is the right playbook.** They iterated weekly behind a waitlist, shipped collaboration plumbing quietly before any team marketing, and still haven't announced pricing. Zeros can mirror that sequencing: feature-flagged cloud, small cohort, price later.
5. **Collaboration is the open flank.** As of July 2026 nobody — not Conductor, not Cursor, not Anthropic — has shipped real-time multiplayer agent chat. Conductor's local-DB-first architecture makes it hard for them; our live engine + cloud record makes it Phase 8, not a rewrite — the record already holds one shared history, and the engine already serves N clients. This is the differentiation to protect.
6. **Watch two things quarterly:** (a) whether Conductor publicly demonstrates two-Mac chat sync or announces that chat has moved server-side — that dates how fast they finish the retrofit Zeros is leapfrogging by starting cloud-record-first; (b) their cloud pricing, which will anchor customer expectations for ours.
7. **One caution flag for us, not them:** their sleep/wake is delegated to Vercel's snapshot primitive with a 24h session cap and 30-day snapshot expiry. Ours is engine-owned on Daytona (no hard runtime cap, `autoStopInterval: 0`) — more control, and with the cloud record a sandbox can even be *deleted*, not just stopped, then rebuilt from git plus the record with zero data loss. But the wake-up path (cold engine boot + client re-dial + mirror reset + rehydrating from the record) is ours to get right, and it is on the load-test checklist for good reason.

## Sources

- https://vercel.com/blog/how-conductor-moved-parallel-coding-agents-from-the-laptop-to-the-cloud-with-vercel-sandbox — Vercel customer story confirming Vercel Sandbox (May 27, 2026)
- https://thenewstack.io/conductor-cloud-ai-coding-agents/ — Conductor Cloud announcement coverage, pricing unannounced (May 14, 2026)
- https://www.conductor.build/cloud — early-access waitlist page (fetched 2026-07-02)
- https://www.conductor.build/blog/series-a — $22M Series A (March 30, 2026)
- https://www.conductor.build/blog/claude-subscription-update — Anthropic policy scare, delayed indefinitely (June 15, 2026)
- https://www.conductor.build/changelog — 0.54.0 through 0.71.0 (May 18 – July 1, 2026): cloud prep, sleep, file sync, snapshot config, share links
- https://www.conductor.build/docs/reference/privacy — "none of it is stored on our servers" + Fly Postgres disclosure (fetched 2026-07-02)
- https://www.conductor.build/enterprise — enterprise posture and customer claims
- https://vercel.com/docs/sandbox/pricing — Vercel Sandbox rates and limits (updated 2026-06-16)
- https://vercel.com/docs/sandbox/concepts/persistent-sandboxes — snapshot/sleep/resume semantics (updated 2026-05-29)
- https://simonwillison.net/2026/Jan/9/sprites-dev/ — Fly Sprites launch analysis (the likely "sprite" provider)
- https://electric-sql.com/ — ElectricSQL sync engine (identified via api.conductor.build response headers)
- https://news.ycombinator.com/item?id=44594584 — original Show HN launch (July 17, 2025)
- https://www.marvinvista.com/p/a-deep-dive-on-conductor-yc-s24 — third-party analyst deep dive incl. speculative pricing (February 21, 2026)
- https://finance.biggo.com/podcast/fe599900ba5c87ae — YC podcast summary, CEO on multiplayer chat (June 4, 2026)
- First-hand verification (2026-07-02, live Conductor v0.71.x install): read-only SQL on `~/Library/Application Support/com.conductor.app/conductor.db`; `strings` analysis of the app binaries; DNS lookups and HTTP probes of api/app/auth.conductor.build and conductor-cloud-alpha.fly.dev; inspection of `~/conductor/remote-workspace-sync/`
- Internal: the Zeros engineering plan (v2, 2026-06-24, incl. the June 2026 Conductor reverse-engineering) — consolidated into [08-engineering-reference.md](08-engineering-reference.md) (2026-07-03); original removed. The v3 applies the 2026-07-02 cloud-record decision
