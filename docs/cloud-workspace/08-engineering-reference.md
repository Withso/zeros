# Engineering Reference — Cloud Workspaces (v3)

*part 08 of the Zeros Cloud Workspaces Report · consolidated 2026-07-03 from docs/cloud-workspaces-daytona-execution-plan.md (v2, 2026-06-24; original removed)*

Parts 01–07 of this report are the founder narrative — plain language, user workflows, decision framing. **This document is the precise technical companion**: the canonical engineering plan, at full file:line fidelity, for whoever builds it. **v3 = v2 + the 2026-07-02 founder decision update (the cloud record + enterprise hosts the record) + the verified Phase 1 status (confirmed on disk 2026-07-03).** Nothing from v2 was dropped; where the 2026-07-02 decisions changed a verdict, the old text is retained under a dated supersession note rather than silently rewritten.

> **Status:** Canonical engineering plan. **Major revision 2026-07-03 (v3)** — consolidates the v2 plan (2026-06-24) into the report pack, applies the **2026-07-02 founder decisions** (the **cloud record** as the durable home of chats/sessions + the **enterprise self-host commitment**), and records the **verified Phase 1 status**. v2 itself was the major revision that added the **two-plane data architecture** (engine-owned DB + local file-mirror), **multi-user collaboration**, **design-mode**, and a **durability model**, plus fact corrections from a fresh research + 5-agent codebase audit. Replaces `docs/roadmap/cloud-workspaces.md` and (as of this consolidation) `docs/cloud-workspaces-daytona-execution-plan.md`.
> **Authoring note (v2, retained):** Synthesised from (1) the running design conversation, (2) reverse-engineering Conductor.build from local disk, (3) fresh web research (Daytona re-verify, Mutagen file-sync, CRDT/collaboration), and (4) five file-precise codebase audits. Confidence marked per claim; load-bearing-but-unverified items live in **§14 Load-test checklist** and must be hands-on-verified before the code they gate. v3 adds (5) the founder decision brief `research/decision-update-2026-07-02.md` and (6) the 2026-07-02 research sweep consolidated in parts 01–07.
>
> **✅ PHASE 0 IMPLEMENTED (2026-06-25).** Relay + web app fully removed; the app is desktop-only and green (`tsc` baseline, `build:ui`/`build:engine`/`electron:compile`, **1429 tests pass**). Desktop social-OAuth moved to a **static `app.zeros.build/auth/return` bounce** (Cloudflare Pages, **no worker** — see §6). `"cloud"` kind + a **`CloudTransport` stub** (`src/engine/transport/cloud.ts`) landed; **LocalTransport untouched**. **Cleanup update 2026-06-30:** the deferred `isWebTarget()` call sites, `web-target.ts`, web folder/workspace pickers, and local pairing module were removed because only Phase 1 CloudTransport is implemented today; no remote-workspace UI was kept unless wired.
>
> **✅ PHASE 1 BUILT & MERGED (2026-06-25) · ⏳ EXIT RUN PENDING (verified on disk 2026-07-03).** The stub grew into a working env-gated engine `CloudTransport` + the full spike harness in `scripts/cloud-spike/` + 10 unit tests (suite **1,439 green**). The hands-on exit run against a real Daytona sandbox has **not** happened: no `DAYTONA_API_KEY` has been provided, `.context/cloud-spike/state.json` does not exist (`provision.ts` writes it on success), and §14's measured numbers are unrecorded. The engineering is executed; hands-on validation is the remaining step and **the single blocker**. Detail in §11 Phase 1.

**Terminology (used throughout, per the 2026-07-02 brief):** "**the cloud record**" = our cloud database (Postgres, per-user account) that permanently stores your chats, sessions, and workspace history in your account. "**The live wire**" = the direct WebSocket between the app and the engine (elsewhere in this doc called the bridge / `CloudTransport` — same thing; the record-vs-live-wire distinction is the load-bearing one).

---

## 0. Revision notes (read me first)

### 0.1 What changed in v3 (2026-07-02 decisions + 2026-07-03 consolidation)

If you read the v2 plan, here is the delta:

1. **DECIDED (2026-07-02) — the cloud record (Decision 1).** All durable workspace data — chats, agent transcripts/sessions, workspace metadata, memberships — is stored in **our cloud database** (Postgres, per-user account). Every device with the same login syncs from it, live. This **replaces "export blobs to object storage" as the primary durability story** (a cheap periodic backup export remains as a safety net, but the DB is the record). The engine (in the sandbox, or local) stays the **live hub** for a running workspace — nothing changes about the live experience — but it now **writes through** every chat/session/state event to the record (streamed, near-real-time). The in-sandbox `zeros.db` becomes the **working copy**; the cloud record is the permanent one. Restore path: a new/woken sandbox rehydrates code from git + chat/state from the record, so sandboxes can be **deleted** aggressively (cost win) with zero data loss. Local (non-cloud) workspaces write through to the same record as a fast-follow (privacy opt-out). Full detail + supersession notes in §8.3/§9.
2. **DECIDED (2026-07-02) — enterprise = they host the record (Decision 2).** Same software, with the cloud record + workspace data on **customer infrastructure**: their Postgres (the record) + their object storage (backups/artifacts) + their git remotes + optionally their sandbox runners. Delivered as Docker Compose/Helm + license key; two rungs (**BYOC** and **full self-host**); SSO/SAML/SCIM/audit bought (WorkOS-style), not built. Four seams to design now, build after v1 GA — seam #1 upgraded from "exportable data" to a **configurable record endpoint** (the record's DB URL is config, never hard-coded). Detail in §9.
3. **Phase plan re-scoped (§11, §13).** Phase 4 (control plane) **expands** to include the cloud-record schema (`chats`/`messages`/`sessions` tables + RLS) beside workspaces/teams (+a few days). Phase 7 is **rewritten** from "durability export" to "**cloud record write-through & restore**" (effort 1–2 weeks → **3–5 weeks**) and **pulled forward**: it starts right after Phase 4 and runs in parallel with Phases 5–6 instead of trailing Phase 6. Phase 8 collaboration now **rides the record + the live wire** (history/membership from the record; presence/live-tail from the engine; no journal-based catch-up). Timeline: v1 ≈ 3–5 months → **~3.5–6 months** from spike day (+2–4 weeks — the write-through/sync layer is real engineering, only partly absorbed by the parallelism).
4. **Load-test checklist grows #12 (§14):** the **ElectricSQL sync-engine spike** — the one item that needs **no Daytona key** and can start immediately. Gates Phase 7's sync-layer choice (ElectricSQL, which Conductor uses and which runs on any Postgres, vs the simpler Supabase Realtime starter).
5. **Risk register grows (§12):** cloud-record **availability/privacy** risk, mitigated by **async write-through + local buffering** (an outage never blocks live work) + the nightly backup export + open privacy positioning (encrypted at rest, exportable, deletable; enterprises host it themselves).
6. **Cost model grows the record line (§15.1):** ~$0 (free tier) → $25/mo (Supabase Pro) → ~$100–600/mo at 1,000 users — the cheapest line on the sheet, and it *strengthens* the sleep lever (the janitor can delete long-idle sandboxes outright).
7. **Phase 1 status verified on disk (2026-07-03; §11 Phase 1):** ✅ built & merged 2026-06-25 (env-gated engine CloudTransport + full `scripts/cloud-spike/` harness + 10 unit tests, suite 1,439 green); ⏳ exit run pending — no `DAYTONA_API_KEY`, no `.context/cloud-spike/state.json`, §14 numbers unrecorded. The key is the single blocker.
8. **What does NOT change (2026-07-02 brief, verbatim commitments):** Daytona as the sandbox provider (+ the Phase 1 spike + Startup Grid application); **direct WebSocket** app↔engine with no broker on the live data path; the **Mutagen local file mirror**; **sleep-when-idle** economics (~8× lever — now stronger: delete, not just stop); **git remains the vault for code**; the **Supabase recommendation** (now stronger: its Postgres becomes load-bearing as the record; Railway stays the fallback Postgres/worker host; ElectricSQL runs on any Postgres, so the sync-engine choice doesn't lock the DB host).

### 0.2 What changed in v2 (2026-06-24) — retained

If you read the v1 plan, here is the delta:

1. **NEW — Two-plane data architecture (§8).** A cloud workspace is split into two independent planes:
   - **DB/chat plane:** the engine in the sandbox owns `zeros.db` (already cloud-ready); clients are thin synced views. This is **collaboration-native**.
   - **File plane:** the sandbox working tree is **mirrored to a local folder** (Mutagen) so the editor/file-tree/diffs read **local** files — this is the "fast as local" trick, the same one Conductor uses.
2. **NEW — Collaboration & multi-user (§10).** Shared workspaces are a first-class goal. Chat collab needs **no CRDT**; design-canvas collab needs **Yjs**. This **breaks the v1 "Option A single-owner" auth** — we need per-user identity.
3. **NEW — Durability model (§9).** "Treat chat/artifacts like code": live in the sandbox, durably backed by git (code) + a cheap **export** to object storage (chat/artifacts). No always-live cloud database. *(**Superseded 2026-07-02** — the cloud record replaces the export as the primary durability story; see §0.1 item 1 and §9. Retained here as v2 history.)*
4. **FACT CORRECTIONS** (all verified in the v2 revision):
   - `@daytona/sdk` is **Apache-2.0**, _not_ AGPL-3.0 (the AGPL applies only to the frozen core platform repo). The "hide the SDK in the worker for AGPL reasons" rationale is dropped — keep it server-side for **API-key security**, not licensing.
   - **No India/Asia region** in Daytona's current docs (only `us`/`eu`). Plan **~130 ms RTT to EU** for an India-based user — which is exactly why the **local file-mirror matters** (files read locally, not over that 130 ms hop).
   - **Cursor agents likely need Tier 3** — `*.cursor.sh` (the `api2/api3/agent.api5.cursor.sh` hosts `@cursor/sdk` dials) is **not** in the T1/T2 egress allowlist. Anthropic/OpenAI/GitHub/Supabase/npm **are** allowlisted on all tiers.
   - `ssh -L` is **undocumented but source-confirmed-yes** (Daytona's gateway is a transparent channel proxy; the daemon registers `direct-tcpip`). Still **not** the bridge transport — preview-URL WSS is primary; SSH is for "Open in Cursor/VS Code".
   - Per-second pricing is **not published**; cite **per-hour** as canonical.
   - **Fork & runtime-snapshot DO exist on Daytona** (`_experimental_fork()` / `_experimental_createSnapshot()`) — but **`_experimental_`-prefixed**, vs **Vercel's GA `fork()`/`snapshot()`**. A _maturity_ gap, **not** a capability gap; used by **none** of Phases 0–9. The "checkpoint" users actually value (turn-by-turn revert) is **app-level git** (§3), not a provider primitive — so it ports to any provider unchanged. Detail in §2.2, §12, §14.
5. **ARCHITECTURE CORRECTION — do NOT relax LocalTransport.** v1 said "LocalTransport token-only mode (relax loopback/Origin gate)". The audit shows relaxing it re-opens the DNS-rebinding hole its loopback gate exists to close. Instead, the in-sandbox engine runs a **separate `CloudTransport`** (`kind:"cloud"`) that authenticates by per-user token + account-binding and accepts the preview Host. This also gives collaboration its per-user identity seam for free.
6. **STALE-MEMORY CORRECTION.** The audit found `chat_messages` sync is **already built** end-to-end on the engine + transport (`db.pull` includes messages; `rev` is stamped from `nextRev()`). The real remaining gap is narrow and **renderer-side** (live deltas for _unopened_ chats no-op). The `project_web_sync_gaps` memory note is stale.

---

## 1. TL;DR

A **cloud workspace = the _same_ Zeros engine running inside a Daytona sandbox.** It behaves identically to a local workspace; it just runs remotely. Two planes make it work and make it feel local:

- **DB/chat plane** — the engine owns `zeros.db` _in the sandbox_. The Mac renderer is a thin client over a **new `CloudTransport`** (Daytona preview-URL **WSS** + per-user token — "the live wire"). Chats/sessions/agents/git-metadata all sync over the bridge, exactly as the web/relay target already did. Because the engine is the single shared writer, **collaboration is natural** — multiple users are multiple authenticated clients on the one engine. **Updated 2026-07-02:** the engine additionally **writes every chat/session/state event through to the cloud record** — the sandbox `zeros.db` is the working copy; the record is the permanent one (§9).
- **File plane** — the sandbox working tree is **mirrored to a local folder via Mutagen** (two-way-safe). The editor, file tree, and diffs read **local files at disk speed**, so the workspace _feels local_ even though the engine is ~130 ms away. Only the agent, terminal, builds, and tests run server-side (where their latency doesn't reach the user).

**Durability (updated 2026-07-02):** code lives in the **git remote** (the vault); chat/sessions/artifacts live durably in **the cloud record**, written through by the engine as events happen; the sandbox disk is a disposable working copy; periodic exports to object storage are demoted to an optional nightly **backup**. The sandbox is disposable — now even *deletable* — and nothing irreplaceable lives only inside it. *(v2 said: "chat/artifacts live in the sandbox disk backed by a cheap export to object storage; no always-live cloud database" — superseded by the founder's 2026-07-02 decision; §9 keeps the old model for reference.)* Analogy used across the report pack: the sandbox is the **workbench**, the cloud record is the **filing cabinet**, GitHub is the **vault**. Workbenches get cleared; the filing cabinet doesn't.

This mirrors Conductor.build's model (which we reverse-engineered: Vercel Sandbox + local file-mirror + local chat DB, brokered through `api.conductor.build`) — but on Daytona, going **direct** to the sandbox over documented WSS (no broker hub needed), and keeping the **engine-owned DB** as the live hub so we get collaboration that Conductor's local-DB model can't do natively. **Updated 2026-07-02:** on the *database of record* we now **go Conductor's way too** — a cloud Postgres record + sync engine (they use ElectricSQL) — while still skipping their broker on the live data path (§3).

### Decisions locked

- **Provider:** **Daytona** for v1 ($200 no-card credit, ~2.5× cheaper vCPU, no hard runtime cap, near-free idle, documented WS-over-proxy), kept swappable behind a `CloudSandboxProvider` interface. (Fly.io Sprites / Northflank are the credible alternates if company-risk or a nearer region ever forces a move.)
- **Remove** the web app and the relay entirely; **keep** the ~80% (engine + bridge + transport seam + WorkspaceService + PtyService + 3 agent adapters + ReliableStream + desktop auth + Mac build/release). *(✅ executed — Phase 0, 2026-06-25.)*
- **Connection:** Mac renderer dials the sandbox **directly** over `CloudTransport` (preview-URL WSS + per-user bearer token). A thin worker holds the Daytona API key for **provisioning only** — it is _not_ on the data hot path.
- **Engine transport:** a **separate `CloudTransport`** in the sandbox engine (`kind:"cloud"`), authenticated per-user (Supabase JWT in the WS handshake) + account/workspace binding. **Do not relax LocalTransport.**
- **DB:** engine-owned `zeros.db` in the sandbox (`ZEROS_DATA_DIR`), single writer, thin synced clients. **Already cloud-ready** in code. **Updated 2026-07-02:** the sandbox copy is the **working copy**; the **cloud record** is the permanent one — the engine writes through.
- **Files:** **local mirror via Mutagen** (two-way-safe), working-tree-only (exclude `.git`, `node_modules`, build dirs), seeded by git-clone on both ends, deps/builds run server-side.
- **Idle:** engine-owned. Awake if (an agent is running) **OR** (the user is actively working); sleep via Daytona `stop()` only when **both** quiet 60 min. **Daytona native auto-stop DISABLED** (`autoStopInterval: 0`).
- **Durability *(updated 2026-07-02)*:** code → git remote; chat/sessions/artifacts → **the cloud record** (engine write-through, near-real-time) + an optional nightly export **backup** to object storage (R2 / Supabase Storage). *(v2: "chat/artifacts → sandbox disk + cheap periodic export to object store. No live cloud DB." — superseded.)*
- **NEW — The cloud record (DECIDED 2026-07-02).** Our cloud Postgres, per-user account, permanently stores chats/transcripts/sessions/workspace metadata/memberships; every device with the same login syncs from it live; sandboxes rehydrate from it; local workspaces write through to it as a fast-follow (privacy opt-out).
- **NEW — Enterprise self-host (DECIDED 2026-07-02).** Enterprise = the same software with the record + data plane on **their** servers (their Postgres + storage + git + optionally runners; Compose/Helm + license key; BYOC and full self-host rungs). Design the four seams now (configurable record endpoint; swappable `CloudSandboxProvider`; no hard-coded vendor URLs; engine on plain Linux); build after v1 GA.
- **Collaboration:** first-class future goal. Chat = no CRDT (server-ordered, per-user author, presence). Code editing = soft-lock first, Yjs later if needed. Design canvas = Yjs + Hocuspocus. **Updated 2026-07-02:** collaboration rides **the record + the live wire** (history/membership from the record; presence/live-tail from the engine).
- **Control plane:** Supabase (auth + `cloud_workspaces` registry, RLS) + a thin worker holding `DAYTONA_API_KEY`. **Updated 2026-07-02:** the same Supabase Postgres also hosts **the record tables** (`chats`/`messages`/`sessions`, RLS) — the Postgres is now load-bearing. Sync layer: **ElectricSQL** (Conductor-proven; runs on any Postgres incl. Supabase/Railway, so it doesn't lock the DB host) vs **Supabase Realtime** (simpler starter) — spike #12 (§14) decides. Railway stays the fallback record host.
- **Agent auth:** Codex device-code / `OPENAI_API_KEY`; Claude **API key or gateway** (subscription OAuth is a banned gray area for the Agent SDK); Cursor `CURSOR_API_KEY` (**needs Tier 3 egress**). GitHub = Zeros GitHub App or PAT.
- **SDK:** `@daytona/sdk` v0.190.1 (Apache-2.0; old `@daytonaio/sdk` deprecated → same API). Pin the version.

### Freshness / confidence note

Daytona moved its **core platform to closed source on 2026-06-11** (the public AGPL repo stays up, unmaintained; **the SDKs are Apache-2.0 and actively maintained**). Trust **`daytona.io/docs` + the published npm `.d.ts`** over the GitHub repo, **pin the exact SDK version** (it ships near-daily; had a breaking `v0.21` + a package rename), and treat Daytona as a managed SaaS dependency kept swappable (§12). Confidence conventions in this doc: **verified** = confirmed against docs/source/disk; **likely** = source-inferred, not contract-guaranteed; **needs-testing** = gated on a §14 hands-on run.

---

## 2. How Daytona works (verified 2026-06-24)

### 2.1 Lifecycle & state

States: `started` → `stopped` → `archived` → `destroyed` (plus `creating/starting/restoring`). Persistence:

| Transition                        | Filesystem                  | In-RAM (process / socket / PTY) |
| --------------------------------- | --------------------------- | ------------------------------- |
| `stop()` → `start()`              | ✓ persists                  | ✗ cleared                       |
| `archive()` → `start()` (restore) | ✓ persists (object storage) | ✗ cleared                       |

`stop()` is a **full process halt**, not a memory freeze — every wake is a **cold engine boot that rehydrates from on-disk SQLite + git**, which Zeros already does. (Daytona has an _experimental_, VM-runner-only `pause()` that claims to preserve RAM, but it's unreliable — **design for a cold boot every wake.**)

Three TTL timers (minutes), set at create or via setters:

| Param                 | Default  | `0` means                 | Zeros setting                |
| --------------------- | -------- | ------------------------- | ---------------------------- |
| `autoStopInterval`    | 15       | **disable** (run forever) | **`0`** (engine owns sleep)  |
| `autoArchiveInterval` | 7 days   | max (30 days)             | a few days (cheap janitor)   |
| `autoDeleteInterval`  | -1 (off) | delete-on-stop            | **`-1`** (never auto-delete) |

> ⚠️ `0` semantics differ **per field** (open issue #3354). Use explicit values.

**Auto-stop is the #1 correctness trap (confirmed, high confidence).** The inactivity timer is reset **only** by lifecycle changes, **preview requests**, **SSH connections**, and **Toolbox SDK calls** — **NOT** by background processes. Docs are explicit: _"Background scripts (e.g. `npm run dev` run as fire-and-forget) … do not reset the timer."_ A running agent is exactly that. ⇒ **`autoStopInterval: 0` is mandatory**; the engine owns sleep (§5, §11 Phase 5).

### 2.2 Images & snapshots

- **Image** = declarative build spec (`Image.base()/.fromDockerfile()/.runCommands()/.env()/.addLocalDir()/.entrypoint()`).
- **Snapshot** = a named, registered template → warm pools + instant repeat creates.

> **"Snapshot" is overloaded here.** The _Snapshot_ above = a **declarative image/build template** (bake + register for warm pools), **not** a runtime capture of a _used_ sandbox's disk. Daytona _also_ exposes **runtime fork + filesystem-checkpoint** — `_experimental_fork()` (copy-on-write clone of a live box) and `_experimental_createSnapshot()` (capture a running box's filesystem) — both **`_experimental_`-prefixed** (pre-release; API may break), unlike **Vercel's GA `Sandbox.fork()`/`snapshot()`** (note: Vercel's snapshot is **filesystem + packages, no memory**). Neither is used in Phases 0–9 (§12 explains why it's a non-blocker). ⚠️ Daytona's docs **self-contradict on whether fork/`pause()` preserve memory** ("filesystem only" vs "filesystem + memory") — **verify hands-on (§14)** before relying on it; **design for filesystem-only / cold-boot** (§2.1) until proven otherwise.

Bake a `zeros-engine-vX` snapshot (bun + node + the 3 agent CLIs + **linux-x64-prebuilt** `node-pty`/`better-sqlite3` + Mutagen agent), register once, then `daytona.create({ snapshot })`. **Warm-pool create can hit sub-90 ms** — but **only** on an exact match of snapshot+region+CPU+mem+disk+OS-user+env and an **empty `volumes` array**. Default entrypoint is `sleep infinity`; run the engine as a managed process after create (so an engine crash ≠ container death). **Only _create_ latency is published — stopped-start and archived-restore latency are NOT** (load-test §14).

### 2.3 Networking (how `CloudTransport` reaches the engine)

- **Preview URL** (primary): `getPreviewLink(port)` → `{ url, token }`, format `https://{port}-{sandboxId}.proxy.daytona.work[s]`. **Never hardcode the apex; read `.url`.** Any HTTP port 1–65535; `22222` reserved.
- **WebSocket over the preview proxy is EXPLICITLY DOCUMENTED** (confirmed): the proxy auto-detects `Upgrade: websocket` and proxies it. This is the load-bearing enabler — the Zeros bridge rides it directly. ⚠️ **Idle-reset risk is real & open** (#3846: 400 after idle, root cause = daemon pool TTL vs Node's 5 s `keepAliveTimeout`; mitigate by raising `keepAliveTimeout`/`headersTimeout` on the engine WS server + app-level pings). ⚠️ **A preview hit does NOT wake a stopped sandbox** (#2270, open) — the control plane must `start()` first.
- **Auth:** header `x-daytona-preview-token: <token>` (token rotates on restart → re-fetch after wake), **or** a signed preview URL (`getSignedPreviewUrl(port, s)`, token-in-URL, max 24 h). The Electron renderer can set WS headers; a signed URL is the cleaner reconnect story.
- **SSH:** `createSshAccess(min)` → `ssh <token>@ssh.app.daytona.io` (60-min token). Full shell. **`ssh -L` local-forward works** (source-confirmed: gateway is a transparent channel proxy + daemon registers `direct-tcpip` w/ allow-all callback; docs are silent → not contract-guaranteed; `-R` reverse-forward likely blocked by the gateway). **Do NOT carry the bridge over SSH** — preview-URL WSS is primary. SSH is only for the later "Open in Cursor/VS Code via Remote-SSH" hand-off. There is **no `daytona forward`** for sandboxes; preview URLs are HTTP-only.

### 2.4 Pricing & idle economics (per-hour is canonical)

Pay-as-you-go: **vCPU $0.0504/h, RAM $0.0162/GiB-h, disk $0.000108/GiB-h** (first 5 GiB free). **$200 free credit, no card.** Startup Grid up to $50k (Zeros qualifies — apply).

| State        | Compute | Disk                        | Counts vs quota pool |
| ------------ | ------- | --------------------------- | -------------------- |
| started      | yes     | yes                         | yes                  |
| **stopped**  | no      | **yes (disk only)**         | **yes (storage)**    |
| **archived** | no      | reduced-rate object storage | **no (frees pool)**  |

A 2 vCPU / 4 GiB / 10 GiB box ≈ **$0.167/h running**, **~$0.001/h stopped**. Sleep-when-idle is the whole ballgame: 100 always-on ≈ **$12k/mo**; 100 at ~3 h/day active ≈ **~$1.5k/mo** + ~$77/mo idle disk. **Tiers gate a shared resource POOL, not a sandbox count**: T1(email) 10 vCPU/10 GiB/30 GiB · T2(card+$25) 100/200/300 · **T3($500) 250/500/2000** · T4($2000) 500/1000/5000. A single user can own **many** sandboxes, limited only by their tier's pool (and stopped/archived boxes barely consume it). **Updated 2026-07-02:** the cloud record makes the idle lever *stronger* — long-idle boxes can be **deleted** outright (disk cost → $0) because the record already holds the chat/state (§9).

### 2.5 Egress (the load-bearing constraint for agents)

- **T1 & T2 = allowlist-only egress, NOT overridable at the sandbox level. T3 & T4 = full internet.**
- Allowlisted on **all tiers**: **Anthropic** (`*.anthropic.com`, `api.anthropic.com` ✓), **OpenAI** (`*.openai.com` ✓), **GitHub** (`github.com`, `*.githubusercontent.com`, `ghcr.io` ✓), **Supabase** (`*.supabase.co` ✓), **npm** (`registry.npmjs.org` ✓).
- ⚠️ **Cursor is the landmine:** only `*.cursor.com` is allowlisted; `@cursor/sdk` dials **`api2.cursor.sh` / `api3.cursor.sh` / `agent.api5.cursor.sh`** — the `.sh` hosts are **NOT** allowlisted, and T1/T2 can't override. ⇒ **Cursor agents effectively require Tier 3+.** Confirm the exact host your SDK version dials (§14).

### 2.6 Isolation & security (accurate, not marketing)

Each sandbox is a **Sysbox (`sysbox-runc`) user-namespace OCI container on a SHARED host kernel** (root-in-box → unprivileged host UID; stronger than plain Docker, weaker than a microVM). Daytona's "dedicated kernel" marketing is false; there's no configurable Kata/gVisor on the managed offering. **For Zeros this is fine — one user (or one trusted _team_) per sandbox, never co-tenant _different_ trust boundaries.** A microVM only matters when you co-locate _mutually-distrusting_ tenants in one box, which we never do — and it wouldn't even help collaboration (everyone inside one box shares it regardless). Controls that exist: per-sandbox egress firewall, org RBAC + scoped API keys, audit log, SOC 2 Type I, AES-256-at-rest / TLS-1.2+, **us/eu residency only**.

> **License note (corrected in v2):** the `@daytona/sdk` is **Apache-2.0**. The **AGPL-3.0** applies to the now-frozen public _core platform_ repo, not the SDK. Keep all Daytona API calls in the server-side worker for **API-key secrecy**, not licensing.

### 2.7 Regions & latency (matters for "fast as local")

Daytona shared regions today: **`us` and `eu` only** (GPU pins `us-east-1`). A Mumbai/Asia-South region was announced May 2025 but is **not in current docs** — do not assume it. For an **India-based** user/developer, the closest is **EU ≈ ~130 ms RTT** (US-East ≈ ~200–250 ms). **This is the single most important reason the local file-mirror exists** (§8.2): the editor reads local files, so the 130 ms hop only affects the agent stream and terminal, not file browsing/editing. If a true-local feel for Asian _users_ ever becomes a hard requirement, **Fly.io Machines** (Mumbai/Singapore microVMs) is the provider to revisit — but it doesn't block v1.

### 2.8 SDK/CLI quick-reference (`@daytona/sdk` v0.190.1)

```ts
import { Daytona, Image } from '@daytona/sdk'
const daytona = new Daytona({ apiKey, apiUrl: 'https://app.daytona.io/api', target: 'eu' })
daytona.create(params, opts)        // env, labels, autoStopInterval:0, resources{cpu,memory,disk}, snapshot
sandbox.start() / stop() / archive() / delete() / resize({cpu,memory,disk})
sandbox.setAutostopInterval(0) / setAutoArchiveInterval(n) / setAutoDeleteInterval(-1)
sandbox.getPreviewLink(port) -> { url, token }      // header x-daytona-preview-token
sandbox.getSignedPreviewUrl(port, seconds)          // token-in-URL, max 86400s, survives restart
sandbox.createSshAccess(minutes) -> { token, sshCommand }
sandbox.process.createSession(id); executeSessionCommand(id, { command, runAsync: true })
sandbox.fs.* ; sandbox.git.clone(url, path, branch?, commit?, 'x-access-token', TOKEN)
daytona.snapshot.create({ name, image, resources }, { onLogs })
```

**REST** (worker): base `https://app.daytona.io/api`, `Authorization: Bearer <KEY>`. `POST /sandbox`, `…/{id}/start|stop|archive`, `DELETE /sandbox/{id}`, `POST /sandbox/{id}/autostop/{interval}`, `GET /sandbox/{id}/ports/{port}/preview-url`.

---

## 3. Conductor.build — reverse-engineered (the model to learn from)

We inspected a live Conductor install (`~/Library/Application Support/com.conductor.app` + `~/conductor/remote-workspace-sync`). Findings (empirical):

- **Conductor = Rust/sqlx**, `conductor.db` 1.3 GB WAL. **Two-plane model:**
  - **CHAT/agent data → LOCAL `conductor.db`** (`sessions` + `session_messages`, a `full_message TEXT` column; ~336k msgs). **Proven: cloud-workspace chat is stored locally** — 2,970 messages across 2 `vercel` workspaces live in the local DB, _not_ the cloud.
  - **FILES → bidirectional MIRROR** to a local full checkout `~/conductor/remote-workspace-sync/<repo>/<uuid>/` (4.3 GB incl. `node_modules` + `.git`; named workspaces are **symlinks** to UUID dirs) via a **homegrown manifest sync** (`.sync/<uuid>/baseline.json` = `{path:{mtime_ms,size}}` + `fresh-baseline-mtime-cutoff-ms` + a `watchexec` watcher binary). Git checkpoints via `checkpointer.sh` (private refs) + `archive_commit`.
- **Provider = Vercel Sandbox** (`workspaces.sandbox_provider='vercel'`). **Reached via `api.conductor.build`** (`hosting_server_url`) — Conductor's **own server brokers** Mac↔sandbox; the Mac never dials Vercel directly (almost certainly because Vercel has **no clean direct WS endpoint** — the exact gap our provider research found).
- **Multi-user schema exists but is sparse** (`session_messages.sender_id`, `workspaces.creator_user_id`/`creator_client_id`/`permission_level='write'`) → they're building collaboration, routed through their server.

**Lessons we adopt / diverge on:**

1. **Adopt the local file-mirror** — it's _the_ "fast as local" trick (the editor reads local files). We use **Mutagen** instead of homegrown (§8.2).
2. **Go direct, skip the broker** — Daytona's documented preview-URL WSS lets the Mac dial the sandbox directly, so we don't need an `api.conductor.build`-style relay on the data path. (Our thin worker is provisioning-only.) **Unchanged by 2026-07-02** — the record is not a broker; the live wire stays direct.
3. **Diverge on the DB** *(v2 verdict — **updated 2026-07-02**)*. v2 reasoned: Conductor's _local-DB-of-record_ is simple but **single-user-shaped** (two users need a server to sync chat; hence their `api.conductor.build` + `sender_id`); we keep the **engine-owned DB in the sandbox** so collaboration is native (one shared engine = one shared conversation), with durability via export (old §9). **The founder decided 2026-07-02 that on the *database of record* we now go Conductor's way**: a **cloud Postgres record + sync engine** (Conductor uses **ElectricSQL**) — while *still* keeping the engine-owned in-sandbox DB as the live hub (our collaboration advantage) and *still* skipping their broker on the live path. Conductor's local-DB-first finding above stays as reported fact; Zeros leapfrogs it by making the cloud record primary from day one. Their model is the proof the sync-engine layer works in production.

---

## 4. Target architecture

*(Updated 2026-07-02: adds **the cloud record** in the control plane + the engine's write-through arrow (6) and the record's realtime-sync/restore path (7). Everything else is v2 verbatim.)*

```
                         ┌──────────────────────── Mac app (Electron) ──────────────────────────┐
                         │  renderer (one src/)                                                  │
                         │   ├─ AuthGate (Supabase email-OTP + OAuth (bounce))                   │
                         │   ├─ RuntimeClient (bridge, "the live wire") ─ per-workspace ─┬─ local ws://127.0.0.1
                         │   │                                            transport     └─ CloudTransport (WSS+token)
                         │   ├─ record sync client (history / offline & asleep-workspace reads) ◄────────────┐
                         │   └─ Mutagen client  ──────── local file mirror ◄──────────────────────┐          │
                         └─────────────────┬──────────────────────┬───────────────────────────────│──────────│──┘
                                           │ (1) launch/start ws   │ (4) bridge RPC + ReliableStream │        │
                                           ▼                       │      (chat/sessions/agents/git) │ (5) two-way file sync
            ┌────────── Control plane + THE CLOUD RECORD ───────┐  │                                 │     (working tree only)
            │  Supabase: auth.users + cloud_workspaces (RLS)    │  │                                 │        │
            │           + workspace_members (collab)            │  │                                 │        │
            │   + record tables: chats / messages / sessions ───┼──┼── (7) realtime sync + restore ──┼────────┘
            │     (RLS; durable home — added 2026-07-02)        │  │                                 │
            │  Thin worker (holds DAYTONA_API_KEY):             │  │                                 │
            │    verify Supabase JWT (verify-jwt.ts)            │  │                                 │
            │    Daytona create/start/stop ── (2) ──────────────┼──► Daytona API                     │
            │    inject agent creds + GitHub token              │  │                                 │
            │    return { previewUrl, connToken } ── (3) ───────┘  │                                 │
            └──────────────▲────────────────────────────────────┘  │                                 │
                           │ (6) write-through: every chat/session/state event                       │
                           │     (async, near-real-time, buffered in zeros.db)                       │
                    ┌──────┴────────────────────────▼────────────── Daytona sandbox ─────────────────▼───────┐
                    │  Zeros engine (bun) + Node-host PTY + Cursor host                                      │
                    │   CloudTransport (kind:"cloud", per-user JWT)  ◄── preview WSS                         │
                    │   zeros.db (ZEROS_DATA_DIR) = the WORKING COPY · git worktrees (ZEROS_WORKSPACES_DIR)  │
                    │   3 agents as child procs (env-injected creds)                                         │
                    │   Mutagen agent (working-tree sync) · record write-through (6) · nightly export backup │
                    └────────────────────────────────────────────────────────────────────────────────────────┘
```

**Idle/wake (engine-owned):** awake if `agentRunning OR (now-lastActivity)<60min`; else worker `stop()`. Wake on reopen / agent-dispatch → worker `start()` → engine cold-boots from SQLite+git → client re-dials signed URL → **Mutagen re-syncs** (reset baseline on resume to avoid the offline-edit trap). After a few days stopped → `autoArchive`; `autoDelete=-1`. **Updated 2026-07-02:** once the record write-through lands (Phase 7), the janitor may go one step further and **`delete()`** long-abandoned boxes outright — a fresh sandbox rehydrates code from git + chat/state from the record. Devices/teammates **not** connected to a live engine read history and asleep-workspace state straight from the record via realtime sync (arrow 7).

**Why this reuses the seam (audit-confirmed, §6):** the engine treats transports uniformly (`this.transports[]` + `client.kind`); the renderer's `RuntimeClient` already multiplexes local + relay behind one `connect()` branch; the engine already supports **N simultaneous clients** (multiplayer broadcast) and **transport-agnostic PTY**; `WorkspaceService.resolveCwd` resolves cwd server-side from `workspaceId`. Cloud adds a **third transport** + a **per-workspace** selection — not a rewrite.

---

## 5. Reusable foundation (the ~80%) vs net-new — audit-grounded

### KEEP — exercised in production today (file:line)

| Area                                       | Files                                                                                                                                                                                                 | Audit verdict                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Engine-owned DB, **already cloud-ready**   | `db/paths.ts:33-65` (honors `ZEROS_DATA_DIR`/`ZEROS_WORKSPACES_DIR`, comments name "cloud sandboxes"), `db/sqlite.ts:91-132` (bun vs better-sqlite3), `db/index.ts:41-58` (engine = sole writer, WAL) | **Built. No change to run the DB in a sandbox.**                                             |
| Single-writer dispatch                     | `workspace/service.ts:823` (`handle()` — **102 case arms**), `index.ts:1931,1976`                                                                                                                     | Built. Electron no longer opens the DB.                                                      |
| **Chat/message delta sync**                | `db.pull` includes messages `service.ts:1270,1286-1292`; `rev` from `nextRev()` `messages.ts:65,74`/`chats.ts:283,309`; tombstones `db/sync.ts`                                                       | **Built (MEMORY note stale).** Engine + transport are ready.                                 |
| Files-over-RPC (the cloud read/write path) | `native/files.ts:54-69` (read), `:108-118` (write), `:76-85` (desktop known-root), `native/git.ts:406-422` (tree)                                                                                     | Built — transport-agnostic; a cloud workspace uses this until the mirror lands.              |
| Server-side cwd resolution                 | `workspace/service.ts:658-661` (`resolveCwd`)                                                                                                                                                         | Built — the indirection a cloud workspace needs.                                             |
| Transport seam                             | `transport/{types,local,router}.ts`, `ws-client.ts:378-382`                                                                                                                                           | Built — uniform `transports[]`, `client.kind` dispatch, renderer multiplex.                  |
| **Multi-client / multiplayer substrate**   | `router.ts:24-104` (broadcast/`clientsOfKind`), `routeToSession` fans to **every** client `:68-71`, shared terminals `pty-bridge.ts:189-220`                                                          | **Built** — N-users-one-engine routing exists; only the multi-_user_ trust model is missing. |
| PTY/terminal                               | `PtyService`, `pty-bridge.ts:54-249`, cwd via `resolveCwd`                                                                                                                                            | **Built — streams from an in-sandbox engine unchanged.**                                     |
| Resume layer                               | `packages/core/src/reliable.ts`, `crypto/{channel,primitives}.ts`                                                                                                                                     | Keep — reused over any reconnecting WS.                                                      |
| Agent adapters                             | `agents/adapters/{claude-sdk,codex,cursor-sdk}/`, `pty/*`, `shared/*`                                                                                                                                 | 100% transport-agnostic; only credential _source_ + host-runtime _path_ change in cloud.     |
| Engine + desktop auth                      | `auth/verify-jwt.ts`, `src/zeros/auth/*` (email-OTP, keychain)                                                                                                                                        | Reused by the broker worker **and** for "my account, my sandbox".                            |

### BUILD — net-new (where it plugs in)

| New piece                                                                | Where / note                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`CloudTransport`** (renderer `connectCloud()` + engine `kind:"cloud"`) | sibling of `connectRelay()` at `ws-client.ts:378-382` + the 4 arbitration points (`isOpen:804`, `rawSend:813`, `forceReconnect:758`, `dispose:796`); engine = a 3rd `Transport` in `this.transports[]`. **Simpler than relay** (direct `new WebSocket(previewUrl)` + token; no pairing handshake). **Do NOT relax LocalTransport** (`local.ts:39-51,226-230` loopback/Origin gate stays — DNS-rebinding defense). *(Engine side ✅ built Phase 1, env-gated; renderer side = Phase 2.)* |
| **Per-workspace runtime transport selection**                            | desktop currently always uses the local loopback bridge; cloud needs one renderer to hold **both** local and cloud workspaces and pick per `workspace.location`.                                                                                                                                                                                                                                                                          |
| **`Workspace.location` + sandbox coords**                                | re-add (v7 dropped the idealized columns) via guarded `ALTER TABLE workspaces ADD COLUMN location TEXT DEFAULT 'local'` + sandbox-id/preview-url; thread through `git/types.ts:24-51`, `git/state.ts:122-187` (row mapper + INSERT), `native/git.ts:106-126`, `redactWorkspaceForRemote` `service.ts:743`. Decisive: `createWorkspace`/`resolveCwd` get a `location` branch (cloud = provision in sandbox, not local `git worktree add`). |
| **Local file-mirror (Mutagen)**                                          | **100% greenfield** — no file cache/mirror exists. New layer beside `readWorkspaceFile`/`bridgeFileRead`; embed an MIT-built Mutagen binary; two-way-safe; exclude `.git`/`node_modules`/build; seed from git; install server-side (§8.2).                                                                                                                                                                                                |
| **Per-user identity / attribution / presence**                           | net-new — add `author_user_id` to `chat_messages` (`migrations.ts:263-276`) + `chats`; thread from spawn/prompt → `persistUserPrompt`/`persistSessionUpdate` (`index.ts:1858`) → wire (`PersistedMessageWire`) → UI; presence channel. **Breaks v1 single-owner trust** (`index.ts:411-419`).                                                                                                                                             |
| **Renderer live-delta gap fix**                                          | `reconcileChatMessages` no-ops for unopened chats (`sessions-provider.tsx:1756`); `app-shell.tsx:646-681` discards `delta.messages`/`messageResets`. Needed so multiple users see live transcript updates for chats they don't have open.                                                                                                                                                                                                 |
| **Supabase `cloud_workspaces` + `workspace_members` (RLS)**              | record of truth for which sandbox belongs to whom + state + members. **Expanded 2026-07-02:** the same Postgres also gets **the cloud-record tables** — `chats`/`messages`/`sessions` (+ RLS) — beside workspaces/teams (Phase 4, +a few days).                                                                                                                                                                                            |
| **Cloud record write-through & restore** *(re-scoped 2026-07-02; was "Durable export")* | engine streams every chat/session/state event to the record (async, buffered, sequence-numbered catch-up); new/woken sandboxes rehydrate from the record; sync layer = ElectricSQL vs Supabase Realtime (spike #12); optional nightly export backup retained (§9, Phase 7).                                                                                                                                                |
| **Thin Daytona broker worker**                                           | new CF Worker (reuse `auth-worker`/`feedback` deploy pattern + `verify-jwt.ts`); holds `DAYTONA_API_KEY`.                                                                                                                                                                                                                                                                                                                                 |
| **`zeros-engine-vX` snapshot + bootstrap**                               | replaces `electron/sidecar.ts` for cloud; bun + Node host + linux-x64 prebuilt natives + Mutagen agent. *(✅ v0 build spec landed Phase 1: `scripts/cloud-spike/image.ts` + `Dockerfile`.)*                                                                                                                                                                                                                                                |
| **Engine-owned idle controller**                                         | reads busy-marker (`index.ts:2786`) + "any agent running" + `lastActivity`; drives worker `stop()`/`start()`; pauses/resets Mutagen on sleep/wake.                                                                                                                                                                                                                                                                                        |
| **Collaboration surfaces**                                               | presence, soft-lock code editing, Yjs design canvas (§10).                                                                                                                                                                                                                                                                                                                                                                                |
| Cloud setup UI                                                           | new Settings panel (replaces `remote-access-panel.tsx`).                                                                                                                                                                                                                                                                                                                                                                                  |

---

## 6. Removal Plan A — the web app — ✅ EXECUTED (Phase 0, 2026-06-25; cleanup 2026-06-30) — retained as reference history

> **This section is history, not a to-do.** It was executed in Phase 0 and superseded by the 2026-06-30 cleanup. The concrete file lists below are retained as planning context (they document *what* was removed and *why* the `isRemote()` distinction matters for Phase 2+). The implemented direction was stricter than planned: delete the retired web/relay picker and pairing surfaces, keep only the env-gated `CloudTransport`, and defer any future remote-workspace UI until it is wired to the cloud-workspace flow.

The web app was the **same renderer** switched on by `VITE_ZEROS_TARGET=web` → `isWebTarget()` (`src/zeros/bridge/web-target.ts:20`), gated in ~23 files / ~50 call-sites.

**Critical distinction (confirmed):** most `isWebTarget()` call-sites are **"remote engine" logic**, not "web-app" logic (route file/git/workspace ops over the bridge, force a `workspaceId` on remote spawn, hydrate chats/projects over the bridge). **`CloudTransport` reuses these.** ⇒ **Introduce `isRemote()` and migrate the remote-engine gates to it; reserve deletion for genuine browser-impossibility gates + relay/pairing code.** Blindly deleting the web branch would silently break cloud workspaces (e.g. the remote-spawn `workspaceId` clamp, `sessions-provider.tsx:719,1925`). *(Executed variant: the gates were removed with the surfaces in the 2026-06-30 cleanup because no remote UI was wired yet; the `isRemote()` seam gets re-introduced when Phase 2 wires the cloud path.)*

### DELETE (web-app-specific)

- `src/zeros/web/{web-app,auth-handoff}.tsx`
- `.env.web`, `public/_headers`, `.github/workflows/deploy-web.yml`
- `package.json`: `dev:web`, `build:web`
- `vite.config.ts`: collapse web-skip CSP → `if (command !== "build")`; `base` → **`"./"`** (leaving `/` blanks the packaged window); drop unused `mode`.
- Tests: `__tests__/csp-headers.test.ts` (**delete BEFORE `public/_headers`** — it `readFileSync`s it at module load), `bridge/__tests__/web-target.test.ts`, `shell/__tests__/column3-tab-manager.web.test.ts`.
- PostHog `t.zeros.build` web proxy default (`analytics/posthog.ts:78`).

### KEEP / RENAME (cloud reuses)

- `web-workspace-picker.tsx`, `web-folder-picker.tsx` → a cloud workspace also can't open a _local_ folder; these are the "pick a remote/sandbox folder" UX. Rename to `RemoteWorkspacePicker`. *(Outcome: deleted in the 2026-06-30 cleanup instead — rebuild when the cloud UI is wired, Phase 6.)*
- `web-target.ts` → recast as the `isRemote()` seam (`isRemote = isWebTarget || activeWorkspace.location==='cloud'`). *(Outcome: removed 2026-06-30; the seam returns with Phase 2.)*

### `isWebTarget()` call-site verdicts (the widest edit)

- **REMOTE → `isRemote()`** (migrate): `native/files.ts:54,108`, `native/git.ts:406,636`, `store/use-projects.ts` (11 sites), `use-active-workspace.ts:68`, `settings/migrate-legacy.ts:31`, `sessions-provider.tsx:142,168,719,1034,1925`, `app-shell.tsx:617,647,1036`, `no-folder-panel.tsx:35`, `open-github-project.tsx:193`, `workspace-file-tree.tsx:246`, `repositories-panel.tsx:1079`, `column2-topbar.tsx:399`.
- **DELETE-WEB → desktop branch:** `main.tsx:15,71`, `column3-tab-manager.ts:181,202` + `terminal-floating-panel.tsx:403`, `column1.tsx:1045`.
- **DEAD** (relay-pairing gone): `ws-client.ts:382,560`, `login-screen.tsx:77`, `auth-context.tsx:409`, `analytics/boot.tsx:80`.

### Blocker — desktop OAuth bounce — ✅ RESOLVED (Phase 0)

Desktop "Continue with Google/GitHub" hard-depends on **`app.zeros.build/auth/return`** (`auth-context.tsx`). Removing the web app's _source_ for that page breaks social sign-in **with no surfaced error** (Supabase silently falls back to Site URL) once `app.zeros.build` is redeployed/torn down. **Email-OTP is unaffected.**
**✅ RESOLVED (Phase 0) — kept a hosted static bounce (chosen over the loopback).** We first built a `127.0.0.1` loopback (RFC 8252), verified it end-to-end, then switched **per product preference** to a **standalone static `/auth/return` page** at `website/web-app/public/auth/return/index.html` — pure client-side HTML/JS (read `?code&scheme&nonce` → build `zeros://auth/callback#…` → redirect), **no worker, not the web app**. Deployed to Cloudflare Pages (`website/web-app/`, `.github/workflows/deploy-auth-bounce.yml`, served at `app.zeros.build`). `auth-context` keeps the original `redirectTo=app.zeros.build/auth/return?scheme&nonce` + `resolveDesktopScheme` + the `zeros://` deep-link handler (`electron/deep-link.ts`, kept). **Tradeoff:** the deep-link path is finicky in _dev_ on a machine with many Zeros checkouts (the scheme can route to a stale Electron); a **dev/prod hybrid** (loopback in dev, hosted bounce in prod) is on the shelf if dev social-login testing is ever needed — email-OTP covers dev today. **Did NOT delete** the Supabase URL/JWKS/issuer env in `sidecar.ts` (reused by cloud); `VITE_SUPABASE_*` confirmed in the desktop build env after `.env.web` removal.

---

## 7. Removal Plan B — the relay — ✅ EXECUTED (Phase 0, 2026-06-25) — retained as reference history

> **This section is history, not a to-do.** Executed in Phase 0. Retained because the KEEP verdicts define what `CloudTransport` builds on.

`RelayTransport` was instantiated at **one site** (`src/engine/index.ts:387-398`), gated by `if (process.env.ZEROS_RELAY_URL)`, set only in `electron/sidecar.ts:627` inside `isRemoteAccessEnabled()`. `transport/local.ts` imports **nothing** relay/crypto. **The local path is a clean island.**

### DELETE

- `packages/relay/` (CF Worker + DO + Node adapter) + `package.json` `"@zeros/relay"` → `pnpm install`.
- `src/engine/transport/relay.ts` + `__tests__/{relay-transport,relay-client,reset-race-probe}.test.ts`.
- `packages/core/src/client/{relay-client,device-identity,index}.ts` (`connectViaRelay`).
- `src/zeros/panels/remote-access-panel.tsx` + its registration in `settings-page.tsx:68,134`.
- `.github/workflows/{deploy-relay,relay-canary}.yml`, `scripts/relay-canary.mjs`.
- `packages/core/src/crypto/control-auth.ts` + its `crypto/index.ts:7` export.

### EDIT (keep the build green)

- `src/engine/index.ts`: remove `RelayTransport` import + the relay-enable block (387-420) + PAIRING\_\* handlers + the two `instanceof RelayTransport` calls. **KEEP** the `client.kind` gating mesh, `verifyAccountBinding`, `authorizeRemoteWrite`, `isRemoteAllowed` — **`CloudTransport` reuses all of it** (a cloud client is a remote peer with a per-user token).
- `transport/types.ts`: keep the `kind` union; **add `"cloud"`**; update the doc comment.
- `transport/router.ts`: **KEEP** `broadcastLocal`/`clientsOfKind` (cloud + collab reuse).
- `ws-client.ts`: remove the relay branch + `connectRelay()` + relay fields. **This is where `connectCloud()` is re-added** — a swap, not a pure delete.
- `electron/sidecar.ts`: remove the relay-env block **except** the Supabase JWT env (reused by cloud).
- `electron/ipc/commands/app.ts`: remove `RELAY_URL`/`REMOTE_ACCESS_ENABLED`/`DEFAULT_RELAY_URL`/getters.
- `packages/core/src/messages.ts` + `bridge/messages.ts` + `schemas.ts`: drop `PAIRING_*` interfaces + union members **in lockstep**.

### KEEP (reusable)

`crypto/{channel,primitives}.ts` + `reliable.ts` are transport-agnostic — `CloudTransport` reuses them for reliable resume / optional E2EE. `KeyManager`: delete pairing/device-registry; keep identity-keypair only if `CloudTransport` keeps E2EE (decide §14).

> **Dependency-graph proof:** unsetting `ZEROS_RELAY_URL` fully disables the relay; `local.ts` has zero relay imports → the local app is untouched once the shared-file edits land.

---

## 8. Data & sync architecture (the heart of v2, extended in v3)

A cloud workspace runs **two independent planes**. Keeping them separate is what makes it both _fast-as-local_ and _collaboration-native_. **Updated 2026-07-02:** the DB/chat plane now *ends in the cloud record* — the engine remains the live hub, and additionally writes through to the record.

### 8.1 DB / chat plane — engine-owned, in the sandbox (live hub) → the cloud record (durable home)

- The engine in the sandbox owns `zeros.db` at `ZEROS_DATA_DIR` (**already coded**, §5). It is the **single writer** and the **shared source of truth for the live session** — chats, sessions, agent transcripts, and git/workspace metadata.
- Both (all) Mac clients are **thin views** over the bridge — they pull/push deltas via the already-built `db.pull`/`DB_CHANGED`/`ReliableStream` machinery. Chat is small and streams fine over the 130 ms WSS hop (it's not latency-sensitive like file browsing).
- **Because the engine is the one shared writer, collaboration falls out for free:** N users = N authenticated `CloudTransport` clients on the one engine, which already fans every session update to **every** client (`router.ts:68-71`). The VM _is_ the collaboration hub — **no separate chat-sync server** on the live path (unlike Conductor's `api.conductor.build`).
- **Net-new for multi-user:** per-message author (`author_user_id` on `chat_messages` + `chats`, server-stamped from the authenticated connection — never trust a client-supplied author), presence, and the renderer live-delta fix for unopened chats (§5).
- **NEW (2026-07-02) — write-through to the cloud record:** the engine streams every chat/session/state event **up to the record** as it happens (async, near-real-time; §9 has the mechanics). The in-sandbox `zeros.db` becomes the **working copy**; the record is the **permanent one**. Devices/teammates *not* connected to a live engine still read everything — history, offline/asleep workspaces — straight from the record via realtime sync. The bridge's sequence-numbered resumable stream ("give me everything after №X") survives intact — it becomes the write-through + catch-up mechanism.

### 8.2 File plane — local mirror via Mutagen (the "fast as local" trick)

**Problem:** reading every file over the 130 ms bridge (the current `files.ts` `isRemote` path) makes the editor/file-tree/diffs feel laggy. **Solution (Conductor's, productized):** mirror the sandbox working tree to a **local folder**; the editor reads **local files at disk speed**. Only the agent/terminal/build/test stay server-side (where latency doesn't reach the user).

**Use Mutagen** (don't build sync from scratch):

- It's **MIT-buildable** (omit the `--sspl` flag) → embeddable in the shipped app. **Coder Desktop ships exactly this** ("local mirror of a remote workspace," two-way-safe) — proven in production. Docker-acquired (2023), still maintained.
- **Mode: `two-way-safe`** — both sides equal; conflicts are surfaced (never silent data loss) into our existing Source/diff UI.
- **What to sync:** the **working tree only**. **Exclude `.git`** (git-hook RCE + index corruption + lock conflicts — keep a per-side clone) and **`node_modules` + build/output/cache dirs** (`dist`, `.next`, `build`, `target`, `.venv`). Run `install`/builds **server-side** on the warm box. This keeps the mirror to source (KBs–MBs, not 4 GB).
- **Initial sync:** seed by `git clone` on **both** the sandbox and the Mac, then sync only residual deltas (cheap). (Codespaces does the analogous shallow-clone-first.)
- **Transport:** Mutagen injects its agent via `scp`+`ssh` — so it rides Daytona's **SSH access** (which exists, §2.3), _parallel to_ the bridge WSS. (The bridge carries chat/agents/PTY; Mutagen carries files. Two channels, two jobs.)
- **Gotchas to handle (§14):** the **offline-edit-resurrection trap** (on wake after the box/sync was down, `mutagen sync reset` rather than trust a stale baseline — critical given our sleep/wake cycle); the **Linux 10 s poll fallback** (force native/hybrid watching so the agent sees the user's save fast); translate the repo's `.gitignore` into Mutagen ignores; non-portable symlinks halt the session (surface in UI).
- **Phasing:** v1 ships **files-over-RPC** (already built) so a cloud workspace _works_; the **mirror is a fast-follow** that upgrades the feel. Fallback if Mutagen-in-Daytona proves awkward: a homegrown `{path→mtime,size,hash}` manifest + 3-way merge (Conductor's shape) — scoped, not the first build.

### 8.3 Durability — the cloud record (updated 2026-07-02; §9 expands)

- **Code** → the **git remote** (always; the deliverable for code workspaces). *Unchanged.*
- **Chat / sessions / design artifacts** → live on the **sandbox disk** in `zeros.db` (the working copy, survives stop/archive) **and are written through, event-by-event, to the cloud record** — their permanent home. Periodic exports to object storage (R2 / Supabase Storage) are **demoted to an optional nightly backup**. *(v2 said: "sandbox disk + a cheap periodic export to object storage. Not a live cloud DB." — **superseded 2026-07-02**.)*
- **Per-client replica** → because clients already delta-sync the DB, persisting that locally gives offline read + the "recover from a peer's local copy" property — now doubly covered: clients can also read the record directly. A complement, not the backstop.

---

## 9. Durability model (decision — updated 2026-07-02)

> **Decision update (2026-07-02, founder — Decision 1):** all durable workspace data — chats, agent transcripts/sessions, workspace metadata, memberships — is stored in **the cloud record** (our cloud Postgres, per-user account). This **replaces** the v2 model below ("export blobs to object storage; no live cloud DB") as the primary durability story. The v2 text is retained further down under a supersession banner — the founder decided to adopt a cloud record (Conductor's direction); do not read the old verdict as current.

### 9.1 The v3 rule

> **Live in the sandbox; permanently owned by the cloud record; code vaulted in git.**

The sandbox is the **workbench**, the cloud record is the **filing cabinet**, GitHub is the **vault**. Workbenches get cleared — even thrown away; the filing cabinet doesn't.

| Data                          | Live store (working copy)             | Durable home (2026-07-02)                                                                                                    |
| ----------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Code                          | sandbox working tree (+ local mirror) | **git remote** (GitHub) — already there                                                                                        |
| Chat / sessions / transcripts | engine `zeros.db` in the sandbox      | **the cloud record** (engine write-through, near-real-time) + optional nightly export **backup** to R2 / Supabase Storage      |
| Design artifacts              | engine in the sandbox                 | **the cloud record** and/or **commit to git like code**; same nightly backup                                                    |
| Workspace metadata / members  | engine + control plane                | **the cloud record** (Supabase Postgres, RLS)                                                                                   |

### 9.2 Why the flip (founder's reasoning, 2026-07-02 — all valid)

- Sandboxes cannot be the long-term home of data — they are disposable by design. Users must be able to get their data back **anytime**, even years later, even if every sandbox is gone.
- Cross-device sync with the same login (Conductor's model) requires a server-side record anyway.
- Shared team workspaces + collaborative agent chat want the same record.
- It closes the previously "honest gap": **local (non-cloud) workspaces can sync too** — a local engine writes through to the same cloud record. (Ship cloud-workspace sync first; local write-through is a fast-follow, with a privacy opt-out.)

### 9.3 Write-through mechanics (the new engineering)

- The engine streams every chat/session/state event to the record **as it happens** (near-real-time), **asynchronously** — a record outage never blocks live work; `zeros.db` is the working copy *and the local buffer*; queued events flush on reconnect.
- The bridge's **sequence-numbered resumable stream** ("give me everything after №X", already designed for Phase 2 reconnects) doubles as the write-through + catch-up mechanism — one mechanism, two consumers.
- The old **"chat journal"** idea (parts 05/07 of this report) is **absorbed** into the write-through: upgraded from "lose seconds, not hours" to "lose ~nothing, forever."
- **Sync layer (spike-gated, §14 #12):** **ElectricSQL** — the sync engine Conductor uses; runs on **any Postgres** (Supabase or Railway alike), so it doesn't lock the DB host — vs **Supabase Realtime** (the simpler starter). The spike compares write-through latency + catch-up correctness; it needs **no Daytona key** and can start now.
- **Restore path:** a new/woken sandbox rehydrates **code from git + chat/state from the record**. Sandboxes can now be **deleted** aggressively (cost win) with zero data loss.
- **Model naming (from part 05):** "**live engine + cloud record**" — a hybrid weighted to Model A: the record = source of durable truth + sync + discovery; the live engine = realtime hub while a workspace runs.

### 9.4 Privacy positioning (state openly)

Unlike Conductor's public "none of it is stored on our servers" claim, Zeros **does** store chat/history in the user's account in our cloud — that **is** the feature ("your work is always in your account"). Encrypted at rest, exportable, deletable on demand — and for companies that can't allow it, Decision 2 (§9.5).

### 9.5 Enterprise = they host the record (Decision 2, 2026-07-02)

For enterprise customers, the **same software** runs with the cloud record + workspace data on **customer infrastructure**. "Your data never lives in our cloud — it lives in yours."

- **Concretely, "their own server" =** their Postgres (the record) + their object storage (backups/artifacts) + their git remotes + optionally their sandbox runners (their VPC / plain VMs). Delivered as Docker Compose/Helm + license key.
- **Two rungs:** **BYOC** (our control plane orchestrates; their data plane holds all data) and **full self-host** (they run the control plane too). SSO/SAML/SCIM/audit stay a **purchase** (WorkOS-style), not a build.
- **Why Decision 1 makes this CLEANER, not harder:** all durable data now lives in exactly ONE well-defined place (one Postgres schema + one bucket + git). Self-hosting = pointing the app at THEIR record.
- **The four enterprise seams to design now (build later, after v1 GA):**
  1. **Configurable record endpoint** (the record's DB URL is config, never hard-coded) — *upgraded 2026-07-02 from the old "exportable data" seam*.
  2. `CloudSandboxProvider` interface stays swappable (their runners).
  3. No hard-coded vendor URLs anywhere.
  4. Engine runs on plain Linux.

### 9.6 Cost/effort honesty (2026-07-02)

An always-on DB is cheap at our scale: Supabase free tier → **$25/mo Pro** → **~$100–600/mo at 1k users** — negligible vs sandbox compute (§15.1). The sync/write-through layer is **real engineering**: schema, event streaming, rehydration, catch-up ≈ **+2–4 weeks** vs the old plan, only partly absorbed by pulling Phase 7 forward. New v1 estimate: **~3.5–6 months** from the Phase 1 spike.

### 9.7 Lifecycle policy (updated)

`autoStopInterval: 0` (engine owns sleep), `autoArchiveInterval` a few days, `autoDeleteInterval: -1` (never auto-delete). **Updated 2026-07-02:** once the record write-through lands (Phase 7), the janitor may **`delete()`** (not just stop/archive) long-abandoned boxes — the record already holds everything, so disk cost for idle history goes to ~$0.

### 9.8 The v2 model — SUPERSEDED 2026-07-02, retained for reference

> The following is the v2 (2026-06-24) durability decision, verbatim, kept for the record. Its *argument against archiving whole VMs* still stands (stronger, even); its verdict "a live cloud database is over-engineering / no live cloud DB" is the part the founder overturned on 2026-07-02.

The sandbox is **disposable**; nothing irreplaceable may live _only_ inside it. But a **live cloud database is over-engineering** for this. The rule:

> **Live in the sandbox; back up the same cheap way we back up code.**

| Data                          | Live store                            | Durable backstop (v2)                                                                                                                        |
| ----------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Code                          | sandbox working tree (+ local mirror) | **git remote** (GitHub) — already there                                                                                                      |
| Chat / sessions / transcripts | engine `zeros.db` in the sandbox      | cheap **export blob** → R2 / Supabase Storage at lifecycle moments (on `archive`, on PR-merge, periodic) + optional per-client local replica |
| Design artifacts              | engine in the sandbox                 | **commit to git like code**, or the same export blob                                                                                         |

**Why not archive whole VMs forever (still true):** archiving a multi-GB filesystem to preserve ~1 MB of chat is storing hundreds× more than needed, in one closed-source vendor with no redundancy. A tiny export lets us **`delete()` abandoned boxes** (saving money) while keeping the part that matters — and gives provider-independence. *(v3 note: the record inherits this whole argument — it is the "tiny export", upgraded to continuous and queryable.)*

**Staging (v2):** v1 / solo = sandbox-disk + git is fine (accept that a _destroyed_ box loses chat history; the code never is). Add the **export** when **collaboration or design mode** lands (more users, more value, and design artifacts that live _only_ in the workspace). *(v3 note: superseded — the record ships in v1, Phase 4 schema + Phase 7 write-through, so a destroyed box loses nothing even for solo users.)*

---

## 10. Collaboration & multi-user (design + phasing)

Multiple users in **one** workspace = **trusted teammates deliberately sharing** (like Google Docs / Figma), **not** untrusted multi-tenancy. It does **not** reopen the microVM question (§2.6). The single-authoritative-engine topology is the _ideal_ substrate — it's literally what Figma and VS Code Live Share use. **Updated 2026-07-02:** collaboration now rides **the record + the live wire** — durable history + membership are read from **the cloud record**; presence + the live transcript tail come from the **live engine**; there is no journal-based catch-up (the record's write-through/catch-up covers it). Three surfaces, increasing difficulty:

### 10.1 Collaborative chat — **no CRDT** (ship first)

Append-only → no real conflict. Needs only: per-user **JWT auth at the WS handshake**; **server-assigned order** (SQLite rowid/`ord` already gives this); **per-message author** stamped server-side from the authenticated connection (never client-supplied); **client-generated message-id** for idempotent retries across reconnects; **persist-then-broadcast** (the engine already fans to every client); **presence** ("who's here / typing") in an **in-memory map + 30 s timeout** (Yjs Awareness semantics, hand-rolled — no library needed). The engine multi-client substrate is **already built** (`router.ts`).

### 10.2 Collaborative code editing — **soft-lock first**, Yjs only if needed

For a coding tool, true character-level co-typing is rarely needed (and Cursor itself has **no** native human co-editing — a common myth). **Tier 1:** per-file **soft-lock + live presence/cursors** ("A is editing X") — cheap, no library, mirrors VS Code Live Share's host-authoritative model (= our topology). **Tier 2 (only if lossless simultaneous typing becomes a requirement):** adopt **Yjs + `y-codemirror.next`** (we're on CodeMirror); run the `Y.Doc` server-side in the engine.

### 10.3 Collaborative design canvas (design mode) — **Yjs + Hocuspocus**

Figma-like multiplayer is where CRDT earns its keep. **Yjs** (920k weekly downloads, ~20 KB bundle, first-class Awareness for cursors, richest server tooling) over Automerge — pick Automerge only if branch/merge **version history** is itself a product feature. Server via **Hocuspocus** (MIT, **runs on Bun** — fits the engine runtime). Shapes in `Y.Map`/`Y.Array`, cursors via Awareness, authoritative `Y.Doc` in the engine, persisted via callback. **Do not reimplement Figma's hand-rolled LWW-tree** — Yjs gives the tree CRDT + ordering + cycle-safety + undo + awareness off the shelf. Design artifacts then export/commit per §9 (v3: persisted to the record and/or git).

### 10.4 Auth, identity, membership, secrets

- **Membership** in Supabase `workspace_members(workspace_id, user_id, role)` — **not** Daytona org-RBAC (that only governs the API account; end users never touch Daytona). *(2026-07-02: unchanged — and membership now lives beside the record tables in the same Postgres.)*
- **Per-user identity** at the bridge — this **breaks v1 "Option A single-owner"** (`index.ts:411-419` binds to ONE owner account). Each `CloudTransport` connection authenticates as its **own** Supabase user (JWT in the WS handshake / subprotocol header); the engine attributes every action to that server-derived identity.
- **Shared secrets:** every member of a shared box can read injected creds → use **short-lived, workspace-scoped** tokens (GitHub App 1 h; rotate); decide whose token the box acts as.
- **One transport, one auth layer** across chat/code/canvas — build the per-user JWT handshake + room fan-out once in the engine.

---

## 11. Build Plan — phased, each with an exit criterion

Phases 0–2 are the existing removal/seam core (ship local-only first). 3+ build cloud behind a flag. v1 GA = **Phases 0–7 (single-user cloud workspace that feels local — with history that outlives every sandbox)**; collaboration (8) + design (9) come after, but the architecture supports them from day one. **Timeline (updated 2026-07-02):** v1 ≈ **~3.5–6 months from the day the Phase 1 spike runs** (+2–4 weeks vs the June estimate — the record's write-through/sync layer is real engineering: schema, event streaming, rehydration, catch-up — only partly absorbed by Phase 7 running in parallel with 5–6). Ship shape: flag-gated alpha → small invite beta → GA (Conductor ran ~2 months of invite-only beta before even shipping share links).

### Phase 0 — Removal & seam-prep — ✅ DONE (2026-06-25; local-only; reversible)

**Shipped:** removed the **relay** (whole `packages/relay/` worker + DO + Node adapter, `transport/relay.ts`, `crypto/keypair.ts` + `core/crypto/control-auth.ts`, the relay-client SDK `@zeros/core/client`, the `PAIRING_*`/`SECURITY_AUDIT` wire protocol, the pairing panel, relay CI, the `@zeros/relay` dep) and the **web app** (`web-app.tsx`, `auth-handoff.tsx`, `.env.web`, `public/_headers`, web CI/scripts/tests, vite web mode; `main.tsx` desktop-only). Collapsed `ws-client.ts` to local-only. Added `"cloud"` to the `kind` union (kept `"relay"` dormant) + the **`CloudTransport` stub** (`src/engine/transport/cloud.ts`); **LocalTransport untouched** (a separate cloud transport, per §0.2 item 5). OAuth → static hosted bounce (§6).
**Deliberate deviations from the original plan:** (a) OAuth landed as the **hosted bounce, not the loopback** (§6). (b) The broad web/remote picker and pairing leftovers were deleted in the 2026-06-30 cleanup instead of being renamed, because only Phase 1 CloudTransport is implemented today and no remote-workspace UI is wired.
**Exit — MET:** `tsc` at baseline (pre-existing errors only), `pnpm build:ui` + `build:engine` + `electron:compile` green, **`test:git` = 132 suites / 1429 tests / 0 failed**; desktop email-OTP works; social-OAuth works via the hosted bounce; app is local-only with no relay/web surface.

### Phase 1 — Daytona spike & snapshot (de-risk the unknowns) — ✅ BUILT & MERGED (2026-06-25) · ⏳ EXIT RUN PENDING (verified on disk 2026-07-03)

Build `zeros-engine-v0`: `Image.base('node:<pinned>-bookworm')` + bun + 3 agent CLIs + **CI-built linux-x64** `node-pty`/`better-sqlite3` (in a `linux/amd64` container vs the pinned Node ABI — avoids the electron-rebuild trap) + **Mutagen agent** + `.entrypoint`. Engine binds `0.0.0.0` with raised `keepAliveTimeout`/`headersTimeout` (#3846). Run the **§14 load-tests** — WSS soak, resume latency, **egress incl. Cursor `.sh` hosts**, `ssh -L` reality.
**Exit:** a sandbox boots the engine; a desktop test client dials `wss://{port}-{id}.proxy.daytona.work` + token, completes a bridge handshake + `file.tree` + PTY round-trip; survives a `stop()`/`start()` reconnect.

> **✅ CODE + HARNESS BUILT & MERGED (2026-06-25; re-verified on disk 2026-07-03).** The engineering side of this phase is fully executed and merged:
>
> - **Engine:** the `cloud.ts` placeholder is now a **working minimal `CloudTransport`** (`src/engine/transport/cloud.ts`) — binds `0.0.0.0:$ZEROS_CLOUD_PORT`, raised `keepAliveTimeout=120s`/`headersTimeout=125s` (#3846) + 25 s server-side keepalive pings, optional `?token=`/`x-zeros-cloud-token` gate, ungated `/health`, peers surfaced as `kind:"cloud"`. **Env-gated** in `ZerosEngine` (`index.ts`: built only when `ZEROS_CLOUD_PORT` is set → inert in the desktop build); **LocalTransport untouched**. Per-user JWT + account-binding is deliberately **Phase 2** — today a cloud peer is ungated like local while `accountAuth` is unset (verified: the relay-only write/read gates don't fire for `"cloud"`, and `file.tree`/PTY round-trip for a `"cloud"` client). Unit test `transport/__tests__/cloud-transport.test.ts` (**10 cases**). **`pnpm test:git` = 1,439 tests green** (1429 + 10); `build:engine` green.
> - **Harness:** `@daytona/sdk@0.190.1` pinned (devDep). The full spike harness lives in [`scripts/cloud-spike/`](../../scripts/cloud-spike/) (runbook in its README): `image.ts` (+ a portable `Dockerfile`) = the `zeros-engine-v0` build spec; `bake-snapshot.ts` registers it; `provision.ts` creates a box (`autoStopInterval:0`, `autoArchive` 3 d, `autoDelete:-1`), mints a cloud token, starts the engine as a managed session, waits for `/health`, persists coords to `.context/cloud-spike/state.json`. **`test-client.ts` automates the Exit** (handshake + `file.tree` + PTY + stop/start reconnect via the real bridge protocol). Load-tests: `soak-wss.ts` (#1), `lifecycle.ts` (#2), `egress.ts` (#4, incl. the Cursor `.sh` landmine), `ssh-forward.ts` (#6). §14 **#5/#7/#8/#9/#10/#11 remain manual/later** (see the README table); **#12 (ElectricSQL) is Phase-4-adjacent and needs no key**.
> - **To run:** push this branch (the image clones the repo at `ZEROS_REPO_REF`, so CloudTransport must be on the pushed ref), `export DAYTONA_API_KEY`, then bake → provision → test-client. Record the measured numbers into §14.
> - **Local-dev note:** `test:git` (Node) and Electron need different `better-sqlite3` ABIs. Running the suite rebuilt it for Node (ABI 141); `pnpm electron:rebuild` (run automatically by `electron:dev:prep`) flips it back for Electron — the documented ABI trap, not a regression.
>
> **⏳ Exit-run status (verified on disk 2026-07-03):** the hands-on run has **not** happened — **no `DAYTONA_API_KEY` has been provided**, `.context/cloud-spike/state.json` **does not exist** (`provision.ts` writes it on success), and **§14's measured numbers are unrecorded**. The engineering is executed; hands-on validation against a real Daytona sandbox is the remaining step and **the single blocker** for everything downstream. Effort once the key exists: days, not weeks — run the harness, write down the numbers.

### Phase 2 — `CloudTransport` + engine-in-sandbox (files-over-RPC first)

Renderer `connectCloud(cloudConn)` in `RuntimeClient` (mirror `connectRelay`, simpler): plain WSS to the preview URL, per-user token via `x-daytona-preview-token`/`?token=`; wrap in `ReliableStream`; **app-level keepalive <30 s**; refetch signed URL after wake. Engine: **separate `CloudTransport`** (`kind:"cloud"`) authenticating by per-user JWT + account/workspace binding (reuses the `client.kind` gating mesh). Per-workspace runtime transport selection in the renderer. Files use the existing **files-over-RPC** path (the mirror comes in Phase 3).
**Exit:** a hand-provisioned cloud workspace is fully usable from the Mac app (files via RPC, terminal, git, one agent turn) — functionally identical to local, just not yet local-_fast_ for files.

### Phase 3 — Local file-mirror (the "fast as local" upgrade)

Embed an MIT-built Mutagen binary; on cloud-workspace open, **seed by git-clone both ends**, start a **two-way-safe** session over Daytona SSH, **exclude `.git`/`node_modules`/build**, translate `.gitignore`. Point the editor/file-tree/diff at the local mirror (new layer beside `readWorkspaceFile`). Force native/hybrid watching; surface sync status + conflicts in the Source UI.
**Exit:** file open / tree / diff in a cloud workspace feel local (disk-speed); a user edit and an agent edit reconcile within ~1 s; conflicts surface, never silently lost.

### Phase 4 — Control plane + the cloud record schema (Supabase + thin worker) — expanded 2026-07-02

Supabase `cloud_workspaces(id, user_id→auth.users, workspace_id, repo_slug, branch, sandbox_id, provider='daytona', region, state, conn_url, last_active_at, …)` + `workspace_members` with **RLS** (read `user_id=auth.uid()` / member; writes service-role). Thin CF Worker (holds `DAYTONA_API_KEY`; reuses `verify-jwt.ts`): `POST /cloud/workspaces` (create+start), `…/:id/start|stop`, `GET/DELETE`. Sets `autoStopInterval:0`; writes state back; returns `{ previewUrl, connToken }`. Re-add `Workspace.location` + sandbox coords migration; per-workspace transport routing keyed on `location`.
**Expanded (2026-07-02):** the schema also grows **the cloud-record tables** — `chats` / `messages` / `sessions` (+ RLS, per-user ownership + workspace membership from day one) — beside workspaces/teams (**+a few days of effort**). These are the durable home Phase 7 writes into; designing them here lets Phase 7 start immediately after.
**Exit:** "Launch a cloud workspace" → worker provisions → Mac app attaches end-to-end, state in Supabase; the record tables exist with RLS enforced.

### Phase 5 — Idle/wake lifecycle (the cost lever)

Engine-owned idle controller: awake if (any agent running — aggregate Claude `turn` / Codex `turn.completed` / Cursor `run.wait`) **OR** (user activity <60 min — bump `lastActivity` on terminal keystroke / file edit / tree browse / diff / git op / prompt; **not** on a bare socket or keepalive). Both quiet 60 min → worker `stop()`. Wake on access → `start()` → cold-boot + client re-dial + **Mutagen `reset`+resync** (offline-edit trap). `autoArchive` after a few days; `autoDelete=-1`. *(2026-07-02: once Phase 7 lands, the janitor may additionally `delete()` long-abandoned boxes — §9.7.)*
**Exit:** a workspace sleeps after 60 min idle, never sleeps mid-agent-run, wakes on click within the measured budget, and the file-mirror reconciles cleanly after wake.

### Phase 6 — Cloud setup UI + agent/GitHub auth injection

New Settings → **Cloud** panel: plan status; **Agents** (subscription tokens + API keys); **GitHub** (Zeros App _recommended_ / PAT); **snapshot-config** step (stream build logs via `onLogs`); **Launch** button. Credential injection at provision into the sandbox engine's `process.env`, reusing the **exact** env-var names `deriveProviderEnv` already injects (adapters unchanged; only the _source_ moves from Keychain to worker-injected env):

- **Codex:** `OPENAI_API_KEY`, or device-code (`codex login --device-auth`) — surface the "admin must enable device-code authorization" prerequisite.
- **Claude:** **`ANTHROPIC_API_KEY` or gateway** (`ANTHROPIC_AUTH_TOKEN`+`ANTHROPIC_BASE_URL`). **Do NOT default to `CLAUDE_CODE_OAUTH_TOKEN`** (Anthropic bans + server-enforces subscription OAuth through the Agent SDK).
- **Cursor:** `CURSOR_API_KEY` (bills the user's Cursor plan; **requires Tier 3 egress** for `*.cursor.sh`).
- **GitHub:** Zeros App installation token (1 h, auto re-mint) `https://x-access-token:TOKEN@github.com/...`; PAT fallback; engine reads `ZEROS_GITHUB_TOKEN`.
  Sandbox bootstrap re-points host runtimes away from Electron: `ZEROS_PTY_HOST_RUNTIME=<bundled node>` (NO `ELECTRON_RUN_AS_NODE`), `ZEROS_PTY_HOST_SCRIPT`/`ZEROS_PTY_NODE_PTY`/`ZEROS_CURSOR_HOST_SCRIPT`/`ZEROS_CURSOR_SDK_ENTRY`, `ZEROS_DATA_DIR`, `ZEROS_WORKSPACES_DIR`, Supabase JWKS. **The image MUST contain a real Node** (PTY host + Cursor host need it; bun can't run them). Per-repo clone + setup script (mirror `.conductor/settings.toml [scripts] setup/run`; version the snapshot by a dep-manifest hash).
  **Exit:** a user configures creds once and launches a working cloud workspace with all 3 agents + git.

> **Daytona warning:** any secret injected via env/files **can be read by a context-injected agent inside the box.** Use short-lived, narrowly-scoped tokens; never bake long-lived keys into the snapshot.

### Phase 7 — Cloud record write-through & restore — re-scoped 2026-07-02 (was "Durability backstop"); pulled forward

**v3 scope:** the engine streams every chat/session/state event to **the cloud record** (async write-through, local buffering in `zeros.db`, sequence-numbered catch-up — §9.3); new/woken sandboxes **rehydrate** chat/state from the record (code from git); the periodic **exports demote to an optional nightly backup** (R2 / Supabase Storage); the janitor may **`delete()`** (not just stop) long-abandoned boxes. Sync layer chosen by the **ElectricSQL spike (§14 #12)** — ElectricSQL (Conductor-proven, any-Postgres) vs Supabase Realtime (simpler starter). Local-workspace write-through to the same record is the fast-follow after cloud (privacy opt-out).
**Sequencing (2026-07-02):** starts **right after Phase 4**, runs **in parallel with Phases 5–6** (no longer trailing Phase 6); lands by GA. **Effort:** 1–2 weeks → **3–5 weeks**.
**Exit:** a destroyed/abandoned box loses no chat/artifact history — because the record already holds it; a fresh sandbox rehydrates a workspace from record + git; write-through latency and catch-up correctness are measured (spike #12); storage cost stays flat.

> *(v2 scope, superseded 2026-07-02, retained:* "Engine exports chat/artifacts to R2/Supabase Storage on archive / PR-merge / periodically (§9); optional per-client local replica; janitor that `delete()`s long-abandoned boxes after export. **Exit:** a destroyed/abandoned box loses no chat/artifact history; storage cost stays flat." *— the export survives inside v3 as the nightly backup; the janitor-delete idea survives strengthened.)*

### Phase 8 — Collaboration (multi-user) — rides the record + the live wire (2026-07-02)

Per-user JWT auth on `CloudTransport`; `workspace_members` + roles; `author_user_id` on `chat_messages`/`chats` threaded spawn→persist→wire→UI; presence; the renderer live-delta fix for unopened chats; **collaborative chat** (§10.1); then **soft-lock code editing** (§10.2). **Updated 2026-07-02:** durable history + membership are read from **the record**; presence + the live transcript tail come from the **live engine**; any journal-based catch-up is dropped (the record's write-through/catch-up covers it).
**Exit:** two users in one cloud workspace see the same live chat with correct attribution + presence; soft-lock prevents silent edit loss.

### Phase 9 — Design-mode collaboration (Figma-like)

Yjs + Hocuspocus shared canvas (§10.3); artifacts persisted per §9.
**Exit:** two users co-edit a design canvas in real time with cursors; artifacts durable.

---

## 12. Risks & open questions

- **Provider lock-in / closed-source.** No self-host escape. Mitigate: all Daytona calls behind the worker + a `CloudSandboxProvider` interface (E2B/Vercel/Fly/Northflank swappable); durable state outside the box *(now: the record + git — stronger than v2's export)*. **Fly.io Sprites/Machines** is the strongest alternate (microVM, no cap, **Mumbai/Singapore regions** for Asia latency, native sleep/wake) if company-risk or region forces a move.
- **NEW (2026-07-02) — Cloud-record availability & privacy.** The record is a new **always-on dependency** and a new place user data lives. Availability mitigation: the write-through is **async with local buffering** (the engine's `zeros.db` is the working copy; a record outage never blocks live work; queued events flush on reconnect) + the nightly export backup as a second net. Privacy mitigation: state it openly — Zeros **does** store chat/history in the user's account (that *is* the feature); encrypted at rest, exportable, deletable on demand; a privacy **opt-out** for local-workspace write-through; and enterprises host the record on **their** infrastructure (Decision 2, §9.5).
- **Fork / runtime-snapshot maturity (vs Vercel).** Daytona's `_experimental_fork()` + `_experimental_createSnapshot()` are **pre-release**; Vercel's `fork()`/`snapshot()` are **GA**. **Not used in v1** — no phase depends on them: the user-facing _"revert to a checkpoint"_ is **app-level git** (Conductor's `checkpointer.sh` private-refs model, §3), parallelism is **git-worktree-based** (not sandbox-fork), durability is **git remote + the cloud record** (§9). **The one capability git can't replicate:** an _instant fork of a **dirty, uncommitted** mid-task disk state_ — untracked files + `node_modules` + build artifacts, **no commit/stash** — into N variations ("clone this messy in-progress box 3 ways, let 3 agents try different approaches"). Daytona's experimental `_experimental_fork()` _does_ offer it (unstably); Vercel's GA `fork()` offers it cleanly. **Memory-state resume** (E2B's ~1 s warm resume of live processes) is **not** a Vercel-vs-Daytona delta — **Vercel's snapshot is filesystem-only too**; only E2B preserves memory, so we lose nothing vs Vercel and the "cold-boot every wake" stance (§2.1) holds for both. ⇒ **Trigger to revisit:** if _"fork a dirty workspace into N parallel agent tries"_ becomes a marquee feature, either adopt Daytona's experimental fork or re-weigh the provider (`CloudSandboxProvider` swap stays open).
- **Region/latency for Asia.** No India region; EU ~130 ms. The file-mirror hides this for the editor; the agent stream/terminal still cross it. Acceptable; revisit Fly if Asian _users_ demand true-local.
- **Cursor egress (Tier 3).** `*.cursor.sh` not allowlisted on T1/T2 → budget Tier 3 ($500) if shipping Cursor agents. *(Part 07's recommendation: defer Cursor-in-cloud for v1; ship Claude + Codex, both allowlisted on all tiers.)*
- **Transport idle/reset (#3846).** Raise `keepAliveTimeout ≥ 120 s`; app pings <30 s; auto-reconnect on 400/ECONNRESET; refetch preview URL after wake. *(Engine side implemented in Phase 1: 120 s/125 s + 25 s pings.)*
- **Mutagen embedding** — confirm an MIT-only build retains two-way sync; confirm Daytona SSH supports Mutagen's `scp`+`ssh` agent injection; handle the offline-edit-resurrection trap on wake.
- **Multi-user trust model** — replaces single-owner account-binding; per-user authz, presence, concurrent-write reconciliation (the file-mirror's write-through must reconcile). Engine substrate is built; the trust model is not.
- **Codex `~/.codex` persistence** across `stop()`/wake so a device-login isn't lost.
- **`@daytona/sdk` Apache-2.0** — keep in the worker for API-key secrecy.

---

## 13. Sequencing (updated 2026-07-02/03)

```
Phase 0 ✅ DONE (remove web+relay, "cloud" kind stub, hosted-bounce OAuth; isRemote deferred) ──► local-only
   └─► Phase 1 ✅ BUILT & MERGED (env-gated CloudTransport + scripts/cloud-spike harness; 1,439 tests green)
        │        ⏳ EXIT RUN PENDING — §14 runs await a DAYTONA_API_KEY (the single blocker) ──► de-risk
        └─► Phase 2 (CloudTransport + engine-in-sandbox, files-over-RPC) ──► one cloud ws works
             ├─► Phase 3 (local file-mirror / Mutagen) ──► feels local
             └─► Phase 4 (Supabase registry + THE RECORD schema (chats/messages/sessions + RLS) + broker + routing)
                  ├─► Phase 5 (engine-owned idle/wake + mirror reset)        [cost lever]
                  ├─► Phase 6 (Cloud setup UI + agent/GitHub auth)           ──► v1 GA (single-user) behind a flag
                  ├─► Phase 7 (cloud record write-through & restore)         [pulled forward 2026-07-02: starts right
                  │        after Phase 4, parallel with 5–6, lands by GA;     ElectricSQL spike #12 de-risks it]
                  └──────► Phase 8 (collaboration: per-user auth + chat + soft-lock — rides the record + the live wire)
                               └─► Phase 9 (design-mode canvas: Yjs + Hocuspocus)
```

Everything cloud ships behind a feature flag; Phase 0 was independently shippable and made the app local-only immediately. **The critical path runs straight through Phase 1** — until the spike runs, wake latency, WSS stability, and Mutagen-over-SSH are all unmeasured, and Phases 2/3/5 are designed around those numbers. The one exception: **spike #12 (ElectricSQL) needs no Daytona key and can start now**, de-risking Phase 7 in parallel.

---

## 14. Load-test checklist (hands-on BEFORE building the code each item gates)

> **Status (2026-07-03):** the harness automates **#1** (`soak-wss.ts`), **#2** (`lifecycle.ts`), **#4** (`egress.ts`), **#6** (`ssh-forward.ts`) and the Phase-1 exit (`test-client.ts`); **#5/#7/#8/#9/#10/#11 remain manual/later** (see `scripts/cloud-spike/README.md`). **All measured numbers are unrecorded — blocked on a `DAYTONA_API_KEY`.** **#12 is the exception:** added 2026-07-02, it is Phase-4-adjacent and needs **no Daytona key at all** — it can start today.

1. **Multi-hour WSS soak through the preview proxy** with `autoStopInterval:0` — confirm the bridge isn't dropped (#3846 idle-reset; raise `keepAliveTimeout`). _Gates Phase 2._
2. **Resume latency** — `start()` from **stopped** vs **archived** for a multi-GB workspace. No published numbers. _Gates idle thresholds + wake-UX (Phase 5)._
3. **Cold engine boot on wake** — engine rehydrates from SQLite+git; ReliableStream RESET → app-state reload acceptable.
4. **Egress incl. Cursor** — confirm Anthropic/OpenAI/GitHub/Supabase/npm reachable, and **which `*.cursor.sh` host** your `@cursor/sdk` dials → whether Cursor needs Tier 3. _Gates Phase 6 Cursor support._
5. **Mutagen in Daytona** — agent injection over SSH; first-sync time for a real repo (excl. node_modules); native watching active on Linux (not the 10 s poll); offline-edit reset after a `stop()`/`start()`. _Gates Phase 3._
6. **`ssh -L` reality check** — does local port-forward work through `ssh.app.daytona.io`? (Source says yes; confirm.) _Gates the "Open in Cursor / forward port" feature, not the bridge._
7. **Real idle billing** over a week (stopped-disk vs archived rates).
8. **Multi-client WSS** — several concurrent connections to one preview URL behave (collaboration substrate). _Gates Phase 8._
9. **Stuck-state reconciliation** — provision/`stop`/`start` under induced failure; worker detects + recreates "stuck"/502/503 boxes.
10. **Daytona license terms** of the Apache-2.0 SDK / managed service in writing if you ship.
11. **Fork / runtime-snapshot reality (only if we ever rely on them).** Confirm whether `_experimental_fork()` / `_experimental_createSnapshot()` preserve **memory** or are **filesystem-only** — Daytona's docs **self-contradict** ("filesystem only" vs "filesystem + memory"), consistent with the near-daily SDK churn (§1 freshness note). Confirm a fork captures **uncommitted + untracked** working-tree state and whether `node_modules`/build artifacts ride along. _Gates any "fork a dirty workspace into N tries" feature — not in v1._
12. **ElectricSQL sync-engine spike** *(added 2026-07-02 — needs NO Daytona key; can start now).* Stand up ElectricSQL (the sync engine Conductor uses; it runs on **any** Postgres — Supabase or Railway alike) against the record schema; stream a chat table to two clients; kill one mid-stream and let it catch up. Compare write-through latency and catch-up correctness against the simpler **Supabase Realtime** starter. _Gates Phase 7's sync-layer choice._

---

## 15. Appendix

### 15.1 Cost model

- **Solo dev on $200 credit:** 1 box, 8 h/day active, idle-stopped ≈ **$33/mo** ⇒ ~6 months free; lean box ≈ ~12 months. No card until Tier 2/3.
- **100 workspaces, ~3 h/day active, sleep-when-idle:** ≈ **$1.5k/mo** compute + ~$77/mo idle disk. Always-on would be ~$12k/mo. **Cursor support ⇒ Tier 3 ($500 top-up)** for egress + ~100 concurrent.
- **NEW (2026-07-02) — the cloud record:** **~$0** while building (Supabase free tier, same project as the control plane) → **$25/mo** (Supabase Pro, through the beta) → **~$100–600/mo at 1,000 users** (bigger instance + storage as history grows). At most ~$0.60/user/mo — noise next to ~$15/user of compute — and it *strengthens* the sleep lever: the janitor can **delete** long-idle sandboxes outright (idle-disk cost → $0) because the record already holds everything. Backup storage (the demoted nightly export + artifacts): pennies → <$5/mo → <$50/mo.
- **Scale context (from part 07, dated 2026-07-02):** all-in ≈ $1.6k/mo at 100 users and ≈ $16k/mo at 1,000 users ⇒ **~$16/user COGS** for a ~3 h/day user; tier pools gate scale (T4 = 500 vCPU — at 1,000 users peak concurrency exceeds it → open the enterprise-limits conversation with Daytona early); price the workspace, don't margin-stack model tokens.

### 15.2 Doc & memory updates (do alongside)

- **SUPERSEDE banner (don't delete):** `remote-workspaces-relay-and-mobile.md`, `relay-p8-p10-execution-plan.md`, `relay-status-and-remaining.md`, `cloud-collab-and-mobile.md`.
- **UPDATE:** `universal-storage-and-zeros-db.md` (thesis survives — engine-owned `zeros.db`, thin clients, sync over `ReliableStream`; now extended with the **file-mirror plane** + **the cloud record** *(2026-07-02; was "durable export")*), `docs/CLI/03-foundational-plan.md`.
- **Memory:** `project_cloud_workspaces` carries the v2 decisions — **extend with the 2026-07-02 decisions** (the cloud record; enterprise hosts the record); **fix the stale `project_web_sync_gaps`** note (chat_messages sync IS built — the gap is the renderer unopened-chat live delta).
- **Consolidation note (2026-07-03):** this file (part 08) is now the canonical engineering plan; the original `docs/cloud-workspaces-daytona-execution-plan.md` (v2) is removed after verification. The founder-narrative counterparts live in parts 01–07 of `docs/cloud-workspace/` (the 2026-07-02 per-doc deltas were applied across them); raw research notes live in `docs/cloud-workspace/research/`.

---

## Sources

*(v2 §15.3 "Selected citations", complete, plus the v3 additions at the end. Every URL retained.)*

- **Daytona:** `daytona.io/docs/en/{sandboxes,preview,preview-and-authentication,ssh-access,snapshots,network-limits,regions,limits,security-exhibit,typescript-sdk/*}`; pricing `daytona.io/pricing`; closed-source notice `daytona.io/dotfiles/updates/daytona-is-going-closed-source`. Issues #3846 (proxy idle), #2270 (preview won't wake), #3354 (interval semantics).
- **SDK:** `registry.npmjs.org/@daytona/sdk` v0.190.1 (Apache-2.0).
- **Mutagen:** `mutagen.io/documentation/synchronization{,/ignores,/version-control-systems,/watching}`; `github.com/mutagen-io/mutagen/blob/master/LICENSE` (MIT-buildable); Coder Desktop `coder.com/blog/launch-week-2025-hybrid-workflows`.
- **Collaboration:** Figma `figma.com/blog/how-figmas-multiplayer-technology-works`; Yjs `docs.yjs.dev/api/about-awareness` + `/ecosystem/connection-provider/y-websocket`; `github.com/dmonad/crdt-benchmarks`; Hocuspocus `github.com/ueberdosis/hocuspocus`; VS Code Live Share `code.visualstudio.com/blogs/2017/11/15/live-share`; WebSocket auth `websocket.org/guides/authentication`.
- **Agent auth:** `developers.openai.com/codex/auth`, `code.claude.com/docs/en/legal-and-compliance`, `cursor.com/docs/cli/headless`, GitHub App installation-token docs.
- **Conductor analogue:** reverse-engineered from local disk (`~/Library/Application Support/com.conductor.app` + `~/conductor/remote-workspace-sync`); `vercel.com/blog/how-conductor-moved-parallel-coding-agents-from-the-laptop-to-the-cloud-with-vercel-sandbox`.
- **Codebase audit (file:line):** `src/engine/db/{paths,sqlite,index,migrations,sync,chats,messages}.ts`, `src/engine/workspace/service.ts:{580,658,823,1270}`, `src/engine/index.ts:{387,411,1858,1906,1931,1976}`, `src/engine/transport/{types,local,router}.ts`, `src/zeros/bridge/ws-client.ts:378-553`, `src/native/{files,git}.ts`, `src/zeros/agent/{agent-history-client,sessions-provider}.tsx`, `src/app-shell.tsx:{401,611,646}`, `packages/core/src/{reliable,agent-messages}.ts`.
- **v3 additions (2026-07-02/03):** the founder decision brief `docs/cloud-workspace/research/decision-update-2026-07-02.md` (the cloud record + enterprise hosts the record); the report pack parts 01–07 in `docs/cloud-workspace/` (esp. `07-execution-plan.md`, whose "What changes in the June engineering plan" section this v3 implements); the Phase 1 harness `scripts/cloud-spike/` (runbook in its README); ElectricSQL context via the Conductor research note. **Raw research notes live in `docs/cloud-workspace/research/`** (daytona, conductor, cursor-cloud, claude-code-cloud, vercel-sandbox, fly-io, railway, landscape, sync-collab, enterprise-selfhost, zeros-internal-plan — all fetched/verified 2026-07-02).
