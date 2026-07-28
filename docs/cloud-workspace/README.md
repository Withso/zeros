# Zeros — Cloud Workspaces Report

*The front door of a 9-part report pack · July 2026*

---

> ### ⚡ Decision update (2026-07-02)
>
> Two decisions, made **2026-07-02** after this research landed, now set the direction — decided, not under debate. Every document in the pack has been updated to match; where a page previously argued the other way, the original reasoning stays visible under a dated note.
>
> **1 — The cloud record: we go Conductor's way on the database.** All durable workspace data — chats, agent sessions, workspace history — now lives in **the cloud record** (our cloud database that permanently stores your chats, sessions, and workspace history in your account). The engine stays the **live hub** while a workspace runs — nothing changes about the live experience or the direct connection — but it now **writes through** every chat and state event to the record, near-real-time. The picture to keep: the sandbox is the **workbench**, the cloud record is the **filing cabinet**, GitHub is the **vault**. Workbenches get cleared; the filing cabinet doesn't — your history comes back anytime, even years later, even if every sandbox is gone. This replaces "export blobs to object storage" as the durability story (a periodic export stays as a safety-net backup), and it dissolves the pack's old "honest gap": **local workspaces can sync too** — a local engine writes through to the same record (a fast-follow after cloud workspaces ship, with a privacy opt-out). Honest cost: the write-through/sync layer is real engineering — v1 moves from ~3–5 to **~3.5–6 months**; the always-on database itself is cheap (free tier → $25/mo → ~$100–600/mo at 1k users). And privacy, stated openly: unlike Conductor's "none of it is stored on our servers", Zeros **does** store chat and history in your account in our cloud — that *is* the feature ("your work is always in your account"): encrypted at rest, exportable, deletable on demand. For companies that can't allow even that — decision 2.
>
> **2 — Enterprise: they host the record on their servers.** For enterprise customers, the *same* software runs with the cloud record and all workspace data on **their infrastructure** — their Postgres (the record), their object storage, their git remotes, optionally their sandbox runners. "Your data never lives in our cloud — it lives in yours." Decision 1 makes this cleaner, not harder: all durable data lives in exactly one well-defined place, so self-hosting = pointing Zeros at their database. Still built after v1 GA; the seams are designed now, starting with a **configurable record endpoint**.
>
> The June engineering plan (v2, 2026-06-24) predated these decisions; its v3 revision shipped 2026-07-03 as part 08 — [Engineering Reference](08-engineering-reference.md) — and the original file was removed. Part 07 lists exactly what changed from v2 to v3.

---

## What this pack is, and how to read it

This folder is a complete, founder-readable explanation of **cloud workspaces**: what they are, how the competition builds them, which platforms Zeros should build on, how sync / teams / enterprise fit in, and the full plan to execute.

Every document exists **twice**:

- **`.md` files** — the readable text versions (what you're reading now).
- **`.html` files** — the visual versions, with diagrams, story panels, comparison tables, and cost charts. **Start by opening `index.html` in your browser** and use the top navigation to move between pages.

Everything was researched fresh from the live web on **2026-07-02** and merged with the internal engineering plan (the June plan, v2, 2026-06-24). Raw research notes (with sources) live in the [`research/`](research/) folder inside this pack. **2026-07-03:** the June engineering plan (v2) was consolidated into part 08 — [Engineering Reference](08-engineering-reference.md) — and the original file deleted; this folder is now the single source of truth. Claims are marked **verified / likely / needs-testing** throughout.

---

## The whole story in one page

**What a cloud workspace is.** A normal Zeros workspace whose computer lives in a data center instead of under your keyboard. The whole Zeros "brain" (the engine — roughly 80% of the existing code, unchanged) moves into a rented cloud computer called a *sandbox*. Your Mac talks to it over one secure, always-open connection, and keeps a live local copy of the files so editing feels instant. Close the laptop — the agents keep working. Open Zeros on any Mac later — everything is exactly where you left it. A sleeping workspace costs ~$0.001/hour; a running one ~$0.17/hour (Daytona, mid-2026). **Sleep-when-idle is the entire business model** — it's the difference between ~$1.5k/month and ~$12k/month at 100 workspaces.

**How Conductor does it (part 02).** Conductor Cloud (announced May 2026, invite-only) is the same bet: Vercel Sandbox rents the computers, a broker server (`api.conductor.build`, hosted on Fly.io with a cloud Postgres + ElectricSQL sync engine) registers workspaces, and a homegrown **local file mirror** makes cloud files feel local. An earlier provider codenamed "sprite" — almost certainly Fly.io Sprites — sits in their data model, meaning they switched sandbox vendors mid-beta behind a pluggable provider layer (exactly the escape hatch our plan keeps). Surprise finding: **chat still lives in a local database on each Mac** (our July 2 inspection found 474k messages locally, including 81k from cloud workspaces) even though the collaboration plumbing (org IDs, sender IDs, permissions) has quietly shipped. **Verdict: adopt the file mirror, skip the broker on the live data path — and, updated 2026-07-02, we now go their way on the database:** a cloud Postgres record + sync engine (they use ElectricSQL), while keeping our direct connection. Their local-database-first design stays as reported fact — Zeros leapfrogs it by making the cloud record primary from day one.

**How Cursor & Claude Code do it (part 03).** Both ship *task-shaped* cloud agents: send a task, a disposable VM spins up, the result comes back as a pull request. That's a different product from Zeros' persistent workspaces — but the patterns worth stealing are clear: **PR-first output, "teleport" (pull a cloud session to your Mac in one command), mobile check-ins, environment snapshots, and Anthropic's credential-proxy security model** (real GitHub tokens never enter the sandbox). Their team features are shallow — live collaboration on an agent chat is the gap Zeros can exploit.

**Platform choice (part 04).** Two separate decisions. **(A) Sandbox provider: stay on Daytona** — only contender with documented WebSocket support for our direct Mac-to-sandbox connection, US + EU regions, cheapest vCPU, $200 free credit and a startup-credits path; its risks (closed-source move, experimental fork/snapshot) don't touch v1. Vercel Sandbox and Fly Sprites remain credible escape hatches behind the `CloudSandboxProvider` interface. **(B) Backend + cloud DB: keep Supabase, don't switch to Railway.** Zeros needs auth + a small registry DB + realtime + object storage; Supabase bundles all four for ~$25/mo. Railway is a great landlord but the office comes unfurnished (no auth, no realtime — you'd build them), and its 2026 reliability record (an ~8-hour full-platform outage in May, a cached-auth-data incident in March) argues against putting login on it. Railway's honest best role: hosting the thin provisioning worker.

**Sync, teams & collaboration (part 05).** Two architectures: a central cloud database of record (Conductor's direction) vs **the workspace as the meeting point** (everyone connects to the same live engine in the sandbox). The comparison stands; the verdict changed. **Updated 2026-07-02 — the answer is a hybrid named "live engine + cloud record"**, weighted to the first model: the cloud record is the source of durable truth, sync, and discovery, while the live engine stays the realtime meeting point whenever a workspace is running (still the named industry pattern — "session backends", how Figma runs one server per document; presence still flows through the live engine). Agent chat still needs **no CRDT** — one engine per workspace is one referee that orders messages, and numbering every chat event ("give me everything after №X") survives intact as the write-through and catch-up mechanism. The old honest gap — local (non-cloud) workspaces don't sync across devices — is now **solved by design**: a local engine writes through to the same cloud record (shipped as a fast-follow after cloud workspaces, with a privacy opt-out). The pitch upgrades from "cloud = synced" to **"everything in your account"** — cloud workspaces first, local fast-follow.

**Enterprise (part 06).** Now a **committed product direction (decided 2026-07-02)**, still built after v1 GA: enterprises run the same software with the record and all workspace data on **their servers** — their Postgres (the record), their object storage, their git remotes, optionally their sandbox runners. The four-rung ladder stands: SaaS → BYOC (our control plane orchestrates; their data plane holds all the data) → self-host → air-gapped. The industry pattern is the **control-plane / data-plane split** — and decision 1 makes Zeros *cleaner* here, not harder: all durable data now lives in exactly one well-defined place, so **self-hosting = pointing Zeros at their database**. Enterprise still means buying (not building) SSO/SCIM/audit (~$125/connection/mo, WorkOS-style). Pricing norms: $20k–$100k+/yr enterprise tiers. **Build none of it before v1 GA — design the four cheap seams now**, the first upgraded to a **configurable record endpoint** (the database address is configuration, never hard-coded).

**The execution plan (part 07).** Phase 0 shipped 2026-06-25 (1,429 tests green). Phase 1 is ✅ **built & merged** (2026-06-25) — the env-gated engine CloudTransport, the full spike harness in `scripts/cloud-spike/`, and 10 unit tests (suite 1,439 green). ⏳ Its **exit run is still pending**: no Daytona API key yet, so the measured numbers are unrecorded. The engineering is executed; the hands-on validation against a real Daytona sandbox is the remaining step — and **a Daytona API key** is the single blocker. The phases were re-scoped on 2026-07-02 for the cloud record: Phase 4 (control plane) grows the **record schema** (chats, messages, sessions), and Phase 7 turns from "durability export" into **cloud-record write-through & restore** — the engine streams every event up as it happens, a fresh sandbox rehydrates from git + the record, a nightly export stays as backup — and it can start right after Phase 4. Phase 8 collaboration rides the record + the live wire (the direct WebSocket). v1 (Phases 0–7, single-user cloud workspace that feels local) is a realistic **3.5–6 months** for a tiny team from the day the spike runs (+2–4 weeks vs the June plan — the price of permanent history); collaboration (Phase 8) and design canvas (Phase 9) follow on an architecture that supports them from day one.

---

## The eight documents

| # | Document | One-line promise | Read |
|---|----------|------------------|------|
| 01 | **Cloud Workspaces, Explained** | What a cloud workspace is, from the user's chair — every concept in plain language | [md](01-cloud-workspaces-explained.md) · [html](01-cloud-workspaces-explained.html) |
| 02 | **How Conductor Does It** | Teardown of the reference competitor: Vercel Sandbox, the Fly.io broker, the file mirror, where data really lives | [md](02-how-conductor-does-it.md) · [html](02-how-conductor-does-it.html) |
| 03 | **How Cursor & Claude Code Do Cloud** | The two biggest agent vendors' cloud designs, and exactly what to copy | [md](03-cursor-and-claude-code-cloud.md) · [html](03-cursor-and-claude-code-cloud.html) |
| 04 | **Platform Choice: Daytona + Railway vs Vercel + Fly.io** | The two platform decisions, compared honestly, with costs at three scales and a verdict | [md](04-platform-comparison.md) · [html](04-platform-comparison.html) |
| 05 | **Sync, Teams & Collaboration** | How "everything in sync on all my devices, and my team works together" actually gets built — verdict updated 2026-07-02: **live engine + cloud record** | [md](05-sync-teams-and-collaboration.md) · [html](05-sync-teams-and-collaboration.html) |
| 06 | **Enterprise: Their Servers, Their Data** | Now a committed direction (2026-07-02): they host the record — the ladder, the control-plane/data-plane split, and the seams to design now | [md](06-enterprise-self-hosting.md) · [html](06-enterprise-self-hosting.html) |
| 07 | **The Execution Plan** | The consolidated, stand-alone plan, re-scoped 2026-07-02: write-through phases, the 3.5–6-month timeline, costs, risks, and this month's decisions | [md](07-execution-plan.md) · [html](07-execution-plan.html) |
| 08 | **Engineering Reference** | The technical companion — the full v3 engineering plan, every fact and file:line preserved | [md](08-engineering-reference.md) · [html](08-engineering-reference.html) |

> **Related (2026-07-04, moved to the implementation track; renamed 2026-07-25):** **Teams** — how Linear/Figma/OpenAI/Anthropic model tenancy, the default-container verdict (since reversed — teams are created explicitly, and the nested sub-team level was retired), the full schema + security design, Supabase-auth-only + Railway-as-record, and the O0–O6 build plan. It applies to all of Zeros (not just cloud), so it lives one level up: [../teams.md](../teams.md) · [../teams.html](../teams.html).

---

## Key decisions

### Locked (engineering plan, reconfirmed by this research — two rows updated by the 2026-07-02 decisions)

| Decision | What it means |
|----------|---------------|
| **Daytona** rents the computers | Cheapest vCPU, US+EU, documented WebSocket path; kept swappable behind `CloudSandboxProvider` |
| **Direct connection**, no broker | The Mac dials the sandbox straight over an encrypted WebSocket; our worker only provisions |
| **Engine stays the live hub; the cloud record permanently stores history** (decided 2026-07-02) | Chat/state live with the engine while a workspace runs — and stream through to the cloud record, the permanent copy in your account. Team workspaces stay natural; history now outlives every sandbox |
| **Local file mirror** (Mutagen) | The "fast as local" trick — the editor reads local files at disk speed |
| **Sleep-when-idle**, engine-owned | Awake only when an agent runs or you're working; the ~8× cost lever — now sandboxes can even be deleted, not just stopped |
| **Durability = git + the cloud record** (updated 2026-07-02) | Code → GitHub (the vault); chats, sessions & history → the cloud record (the filing cabinet); the sandbox stays disposable. A periodic export remains as a safety-net backup |

### Recommended by this report

| Recommendation | Where argued |
|----------------|--------------|
| ~~Keep Supabase for auth + registry + realtime; its Postgres becomes the record's home~~ **Revised 2026-07-04 (teams doc):** Supabase = **auth only** (asymmetric-JWT/JWKS verification, swappable issuer); **Railway Postgres = the record + team store** — with guard-rails: Pro plan, PITR from day one, pinned image, nightly off-platform dumps | part 04 → ../teams.md |
| Railway's role (updated 2026-07-04): hosts the **control-plane backend + the record's Postgres**; the thin provisioning worker lives in the same service | part 04 → ../teams.md |
| ~~Chat journal~~ **Absorbed (2026-07-02)** into the cloud-record write-through — the event stream to the record *is* the journal, upgraded from "lose seconds, not hours" to "lose ~nothing, forever" | part 05 |
| "**Everything in your account**" positioning (updated 2026-07-02) — cloud workspaces sync first; local workspaces follow fast via write-through, with a privacy opt-out | part 05 |
| Design **four enterprise seams** now (**configurable record endpoint** — upgraded from "exportable data" — provider interface, no hard-coded vendor URLs, engine runs on plain Linux); build enterprise later | part 06 |
| Steal from vendors: **PR-first output, teleport, mobile check-ins, env snapshots, credential proxy** | part 03 |

### For the founder to decide this month

1. **Get a Daytona API key and run the Phase 1 spike** — the single item blocking everything.
2. ~~Confirm Supabase as auth + the cloud record's host~~ **Decided 2026-07-04 (teams doc): Supabase = auth only; Railway Postgres = the record + team store** (ElectricSQL runs on either, so the sync-engine choice never locked the host).
3. **Apply to Daytona Startup Grid** ($10k credits, path to $50k).
4. **Cursor-in-cloud for v1?** Needs a $500 Daytona Tier-3 top-up for network access — recommendation: defer.

---

*Generated 2026-07-02 by a multi-agent research workflow: 10 web-research agents + 1 plan summarizer → 7 writers → 7 visual designers → review. Sources cited at the end of every document; raw notes in [`research/`](research/). 2026-07-03: consolidated the engineering plan into part 08; research materials moved into `research/`.*
