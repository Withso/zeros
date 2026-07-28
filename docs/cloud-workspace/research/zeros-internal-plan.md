# Zeros Cloud Workspaces on Daytona — Internal Plan Summary (v2, 2026-06-24)

Source: `docs/cloud-workspaces-daytona-execution-plan.md` (canonical engineering plan; replaces `docs/roadmap/cloud-workspaces.md`). Synthesized from the design conversation, a reverse-engineering of Conductor.build from local disk, fresh Daytona/Mutagen/CRDT research, and five file-precise codebase audits. Phase 0 shipped 2026-06-25; Phase 1 is scaffolded, awaiting a `DAYTONA_API_KEY` to run the hands-on spike.

## Core thesis

A **cloud workspace = the same Zeros engine running inside a Daytona sandbox**. It behaves identically to a local workspace, just remotely. Approximately 80% of the existing codebase is reused (engine, bridge, transport seam, WorkspaceService, PtyService, 3 agent adapters, ReliableStream, desktop auth, Mac build). Cloud adds a third transport plus per-workspace transport selection — not a rewrite.

## Two-plane architecture (the heart of v2)

Two independent planes make a cloud workspace both fast-as-local and collaboration-native:

1. **DB/chat plane — engine-owned, in the sandbox.** The engine owns `zeros.db` at `ZEROS_DATA_DIR` inside the sandbox (single writer; **already cloud-ready in code** — `db/paths.ts` honors `ZEROS_DATA_DIR`/`ZEROS_WORKSPACES_DIR`). Mac clients are thin synced views over a new `CloudTransport` (Daytona preview-URL WSS + per-user token) using the already-built `db.pull`/`DB_CHANGED`/`ReliableStream` machinery. **Why this plane exists:** chat is small and latency-tolerant, and because the engine is the one shared writer, collaboration falls out for free — N users are N authenticated clients on one engine that already fans every session update to every client (`router.ts:68-71`). The VM *is* the collaboration hub; no separate chat-sync server needed. (The `chat_messages` sync being "not built" was a stale memory — the audit confirmed engine+transport sync is done; the only gap is renderer-side: live deltas for unopened chats no-op.)
2. **File plane — local mirror via Mutagen.** The sandbox working tree is mirrored to a local folder (Mutagen, `two-way-safe` mode), so the editor, file tree, and diffs read **local files at disk speed**. **Why this plane exists:** with no Asia region, an India-based user is ~130 ms RTT from EU; reading every file over that hop makes the editor laggy. The mirror hides the latency — only the agent, terminal, builds, and tests run server-side, where latency doesn't reach the user. This is exactly Conductor's "fast as local" trick, productized. Details: working-tree only (exclude `.git` — git-hook RCE/index-corruption risk — plus `node_modules` and build dirs); seed by git-clone on both ends; Mutagen agent injected over Daytona SSH (parallel to the bridge WSS — two channels, two jobs); on wake, `mutagen sync reset` to avoid the offline-edit-resurrection trap; force native watching (Linux defaults to a 10 s poll). v1 ships files-over-RPC (already built) first; the mirror is a fast-follow.

**Durability:** the sandbox is disposable; nothing irreplaceable lives only inside it. Code → git remote. Chat/sessions/design artifacts → sandbox disk (survives stop/archive) plus a cheap periodic **export blob** to R2/Supabase Storage (on archive, PR-merge, periodic). Explicitly **no always-live cloud DB** — over-engineering. Archiving multi-GB VMs to preserve ~1 MB of chat is waste; the export lets a janitor `delete()` abandoned boxes and gives provider independence. v1/solo can accept sandbox-disk+git alone; the export lands when collaboration/design mode does.

## Locked decisions

- **Provider: Daytona** ($200 no-card credit, ~2.5× cheaper vCPU than alternatives, no hard runtime cap, near-free idle, documented WS-over-proxy), kept swappable behind a `CloudSandboxProvider` interface. Fly.io Sprites/Machines and Northflank are the fallbacks if company-risk or region forces a move.
- **Remove web app + relay entirely** (done in Phase 0); keep the ~80% reusable foundation.
- **Connection: direct.** Mac renderer dials the sandbox over `CloudTransport` — preview-URL **WSS + per-user bearer token**. **No broker on the data path** (unlike Conductor). A thin worker holds the Daytona API key for provisioning only.
- **Engine transport: a separate `CloudTransport`** (`kind:"cloud"`), authenticated per-user (Supabase JWT in the WS handshake) + account/workspace binding. **Do NOT relax LocalTransport** — relaxing its loopback/Origin gate reopens the DNS-rebinding hole it exists to close (this corrected v1's "token-only LocalTransport" idea).
- **DB:** engine-owned `zeros.db` in the sandbox; single writer; thin synced clients.
- **Files:** Mutagen local mirror as above.
- **Idle: engine-owned.** Awake if (an agent is running) OR (user active); sleep via Daytona `stop()` only when both quiet 60 min. **Daytona native auto-stop DISABLED (`autoStopInterval: 0`)** — mandatory, because Daytona's inactivity timer is NOT reset by background processes (a running agent would be killed mid-turn; this is the #1 correctness trap, docs-confirmed).
- **Durability:** git remote + export blobs (above). Lifecycle: `autoStopInterval:0`, `autoArchiveInterval` a few days, `autoDeleteInterval:-1`.
- **Collaboration (first-class future goal):** chat = **no CRDT** (server-ordered, server-stamped per-message author, client-generated message-ids for idempotent retries, presence via in-memory map + 30 s timeout). Code editing = per-file **soft-lock + presence** first; Yjs + `y-codemirror.next` only if lossless co-typing becomes a requirement. Design canvas = **Yjs + Hocuspocus** (MIT, runs on Bun), authoritative `Y.Doc` in the engine. Shared workspaces are trusted teammates, not multi-tenancy — no microVM requirement.
- **Control plane:** Supabase (auth + `cloud_workspaces` registry + `workspace_members`, RLS) + a thin CF Worker holding `DAYTONA_API_KEY` (server-side for API-key secrecy, not licensing — the SDK is Apache-2.0, not AGPL).
- **Agent auth:** Codex device-code or `OPENAI_API_KEY`; Claude **API key or gateway** (subscription OAuth via `CLAUDE_CODE_OAUTH_TOKEN` is banned and server-enforced for the Agent SDK); Cursor `CURSOR_API_KEY` (**needs Tier 3 egress**); GitHub via Zeros GitHub App (1 h installation tokens) or PAT.
- **SDK:** `@daytona/sdk` v0.190.1, pinned (ships near-daily; had a breaking v0.21 + a package rename).

## Conductor.build reverse-engineering (the model learned from)

Inspected a live install (`~/Library/Application Support/com.conductor.app` + `~/conductor/remote-workspace-sync`):

- **Rust/sqlx; local `conductor.db` 1.3 GB WAL, ~336k messages.** Cloud-workspace chat is stored **locally** (2,970 messages across 2 Vercel workspaces live in the local DB, not the cloud) — a local-DB-of-record model.
- **Files: homegrown bidirectional mirror** to `~/conductor/remote-workspace-sync/<repo>/<uuid>/` (4.3 GB incl. `node_modules` + `.git`) via a manifest sync (`baseline.json` of `{path:{mtime_ms,size}}` + a `watchexec` watcher). Git checkpoints via `checkpointer.sh` private refs + `archive_commit`.
- **Provider: Vercel Sandbox, brokered through `api.conductor.build`** — the Mac never dials Vercel directly (almost certainly because Vercel lacks a clean direct WS endpoint).
- Multi-user schema exists but sparse (`sender_id`, `creator_user_id`, `permission_level`) — collaboration is being built, routed through their server.

**Zeros adopts** the local file-mirror (with Mutagen, not homegrown) and **diverges** twice: go direct (Daytona's documented preview-URL WSS removes the broker from the data path) and keep the DB engine-owned in the sandbox (Conductor's local-DB model is single-user-shaped; engine-owned gives native collaboration).

## Daytona facts (verified 2026-06-24)

- **Pricing (per-hour is canonical; per-second not published):** vCPU **$0.0504/h**, RAM $0.0162/GiB-h, disk $0.000108/GiB-h (first 5 GiB free). $200 free credit, no card; Startup Grid up to $50k (Zeros qualifies). A 2 vCPU/4 GiB/10 GiB box ≈ $0.167/h running, ~$0.001/h stopped. Tiers gate a shared resource **pool**, not a sandbox count: T1 10 vCPU · T2 (card+$25) 100 · T3 ($500) 250 · T4 ($2000) 500.
- **Regions: `us` and `eu` only** (a Mumbai region was announced but is not in current docs — do not assume it). India → EU ≈ **~130 ms RTT** (US-East ~200–250 ms) — the single biggest reason the file mirror exists.
- **Egress:** T1/T2 are allowlist-only and NOT overridable; T3/T4 full internet. Anthropic, OpenAI, GitHub, Supabase, npm are allowlisted on all tiers. **Landmine: Cursor** — only `*.cursor.com` is allowlisted, but `@cursor/sdk` dials `api2/api3/agent.api5.cursor.sh`, so **Cursor agents effectively require Tier 3+ ($500)**.
- **Lifecycle:** `stop()` is a full process halt (not a memory freeze) — every wake is a **cold engine boot** rehydrating from on-disk SQLite + git (which Zeros already does). `0`-value semantics differ per TTL field (issue #3354) — set explicit values. A preview hit does NOT wake a stopped sandbox (#2270); the control plane must `start()` first.
- **Networking:** `getPreviewLink(port)` → `https://{port}-{sandboxId}.proxy.daytona.work[s]` (never hardcode the apex); **WebSocket over the preview proxy is explicitly documented** — the load-bearing enabler. Auth via `x-daytona-preview-token` header (rotates on restart) or a signed URL (max 24 h; cleaner reconnect). Known idle-reset risk #3846 — mitigate with `keepAliveTimeout ≥ 120 s` + app-level pings <30 s. `ssh -L` is undocumented but source-confirmed working; SSH is only for "Open in Cursor/VS Code" and Mutagen agent injection, never the bridge.
- **Isolation:** Sysbox (`sysbox-runc`) user-namespace containers on a **shared host kernel** — stronger than plain Docker, weaker than a microVM; the "dedicated kernel" marketing is false. Fine for Zeros (one user/team per sandbox, never mixed trust boundaries). SOC 2 Type I; us/eu residency only.
- **Company risk:** Daytona took the core platform **closed-source on 2026-06-11** (public AGPL repo frozen; SDKs Apache-2.0 and maintained). Trust docs + published npm `.d.ts` over GitHub; pin the SDK.
- **Fork/snapshot:** Daytona has `_experimental_fork()` (CoW clone of a live box) and `_experimental_createSnapshot()` — pre-release, vs **Vercel's GA `fork()`/`snapshot()`**. A maturity gap, not a capability gap, and **used by no phase 0–9**: user-facing "revert to a checkpoint" is app-level git (Conductor's private-refs model), parallelism is git-worktree-based, durability is git + export. The one thing git can't replicate — instantly forking a *dirty, uncommitted* box into N variations — is the only trigger to revisit. Docs self-contradict on whether fork/pause preserve memory; design for filesystem-only/cold-boot (Vercel's snapshot is filesystem-only too; only E2B preserves memory).
- **Snapshots (templates):** bake a `zeros-engine-vX` image (bun + Node + 3 agent CLIs + linux-x64 prebuilt `node-pty`/`better-sqlite3` + Mutagen agent); warm-pool creates can hit sub-90 ms on exact config match. Stopped-start and archived-restore latencies are unpublished — load-test them.

## Phase plan (each with exit criterion)

v1 GA = Phases 0–7 (single-user cloud workspace that feels local); everything cloud ships behind a feature flag.

- **Phase 0 — Removal & seam-prep — DONE (2026-06-25).** Removed relay + web app entirely; `"cloud"` kind + `CloudTransport` stub; LocalTransport untouched; desktop social-OAuth moved to a static `app.zeros.build/auth/return` bounce (Cloudflare Pages, no worker). A 2026-06-30 cleanup also deleted deferred `isWebTarget()`/picker/pairing surfaces. **Exit MET:** builds green, 1429 tests pass, email-OTP + social OAuth work, app local-only.
- **Phase 1 — Daytona spike & snapshot — SCAFFOLDED (2026-06-25), awaiting `DAYTONA_API_KEY`.** Working minimal `CloudTransport` shipped (env-gated on `ZEROS_CLOUD_PORT`; `keepAliveTimeout=120s`, 25 s pings, optional token gate; 1439 tests green) + full spike harness in `scripts/cloud-spike/` (image spec, snapshot bake, provision, automated exit test, soak/lifecycle/egress/ssh load-tests). Per-user JWT deliberately deferred to Phase 2. **Exit (not yet checked):** sandbox boots the engine; a desktop test client completes a bridge handshake + `file.tree` + PTY round-trip over preview WSS and survives a `stop()`/`start()` reconnect.
- **Phase 2 — `CloudTransport` + engine-in-sandbox (files-over-RPC first).** Renderer `connectCloud()` (mirror of the old `connectRelay`, simpler); per-user JWT + account/workspace binding on the engine; per-workspace transport selection. **Exit:** a hand-provisioned cloud workspace fully usable from the Mac app (files via RPC, terminal, git, one agent turn).
- **Phase 3 — Local file-mirror (Mutagen).** **Exit:** file open/tree/diff feel disk-speed; user and agent edits reconcile within ~1 s; conflicts surface, never silently lost.
- **Phase 4 — Control plane (Supabase + thin worker).** `cloud_workspaces` + `workspace_members` with RLS; worker endpoints create/start/stop; `Workspace.location` migration. **Exit:** "Launch a cloud workspace" → worker provisions → Mac attaches end-to-end, state in Supabase.
- **Phase 5 — Idle/wake lifecycle (the cost lever).** Engine-owned idle controller; wake → cold-boot + client re-dial + Mutagen reset. **Exit:** sleeps after 60 min idle, never mid-agent-run, wakes within the measured budget, mirror reconciles cleanly.
- **Phase 6 — Cloud setup UI + agent/GitHub auth injection.** Settings→Cloud panel; creds injected at provision into engine env (same var names `deriveProviderEnv` uses; adapters unchanged). Image must contain real Node (PTY/Cursor hosts can't run on bun). Warning: any injected secret is readable by an agent in the box — short-lived scoped tokens only. **Exit:** configure creds once, launch a working cloud workspace with all 3 agents + git.
- **Phase 7 — Durability backstop.** Export to R2/Supabase Storage + janitor deletes abandoned boxes. **Exit:** a destroyed box loses no chat/artifact history; storage cost flat.
- **Phase 8 — Collaboration.** Per-user JWT, membership/roles, `author_user_id`, presence, renderer live-delta fix, collaborative chat, then soft-lock editing. **Exit:** two users see the same live chat with correct attribution + presence; soft-lock prevents silent edit loss.
- **Phase 9 — Design-mode collaboration.** Yjs + Hocuspocus canvas. **Exit:** two users co-edit a canvas in real time with cursors; artifacts durable.

## Cost model

- **Solo dev on the $200 credit:** 1 box, 8 h/day active, idle-stopped ≈ **$33/mo** → ~6 months free (lean box ~12 months); no card until Tier 2/3.
- **100 workspaces at ~3 h/day active, sleep-when-idle: ≈ $1.5k/mo** compute + ~$77/mo idle disk — vs **~$12k/mo always-on**. Sleep-when-idle is the whole ballgame. Cursor support adds a Tier 3 ($500) requirement.

## Top risks

1. **Provider lock-in / closed-source** — no self-host escape; mitigated by the worker + `CloudSandboxProvider` interface and durable state outside the box; Fly.io is the strongest alternate (microVMs, Mumbai/Singapore, native sleep/wake).
2. **Fork/snapshot immaturity vs Vercel** — irrelevant to v1; revisit only if "fork a dirty workspace into N parallel agent tries" becomes a marquee feature.
3. **Asia latency** — no India region; mirror hides it for the editor; agent stream/terminal still cross ~130 ms.
4. **Cursor egress** — Tier 3 required.
5. **Preview-proxy idle resets (#3846)** — keepalive + auto-reconnect + URL refetch after wake.
6. **Mutagen embedding** — confirm MIT-only build keeps two-way sync; confirm agent injection works over Daytona SSH; handle the offline-edit trap.
7. **Multi-user trust model** — engine substrate built, trust model not; breaks v1 single-owner binding; shared-box secret exposure → short-lived scoped tokens.
8. **Codex `~/.codex` persistence** across stop/wake so device-login isn't lost.

## Load-test checklist (11 items, hands-on before the code each gates)

1. Multi-hour WSS soak through the preview proxy with `autoStopInterval:0` (gates Phase 2). 2. Resume latency from stopped vs archived — unpublished (gates Phase 5). 3. Cold engine boot on wake. 4. Egress incl. which `*.cursor.sh` host the SDK dials (gates Phase 6 Cursor). 5. Mutagen-in-Daytona: SSH injection, first-sync time, native watching, offline-edit reset (gates Phase 3). 6. `ssh -L` reality check (gates "Open in Cursor", not the bridge). 7. Real idle billing over a week. 8. Multi-client WSS to one preview URL (gates Phase 8). 9. Stuck-state reconciliation under induced failure. 10. Daytona license terms in writing before shipping. 11. Fork/runtime-snapshot reality — memory vs filesystem-only, dirty-tree capture (only if ever relied on; not v1).
