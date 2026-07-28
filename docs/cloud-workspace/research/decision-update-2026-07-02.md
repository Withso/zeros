# Decision Update — 2026-07-02 (founder decision, supersedes parts of the June plan + the July 2 report pack)

Two decisions by the founder, dated **2026-07-02**. Every doc in `docs/cloud-workspace/` must be updated to reflect them as THE direction (decided, not under debate), while keeping tradeoffs honestly visible.

## Decision 1 — The cloud record (cloud database of record). We go Conductor's way.

**What:** All durable workspace data — chats, agent transcripts/sessions, workspace metadata, memberships — is stored in **our cloud database** ("the cloud record": Postgres, per-user account). Every device with the same login syncs from it, live. This REPLACES "export blobs to object storage" as the primary durability story (a cheap periodic backup export can remain as a safety net, but the DB is the record).

**Why (founder's reasoning, all valid):**
- Sandboxes cannot be the long-term home of data — they are disposable by design. Users must be able to get their data back **anytime**, even years later, even if every sandbox is gone.
- Cross-device sync with the same login (Conductor's model) requires a server-side record anyway.
- Shared team workspaces + collaborative agent chat want the same record.
- It closes the previously "honest gap": **local (non-cloud) workspaces can sync too** — a local engine writes through to the same cloud record. (Ship cloud-workspace sync first; local write-through is a fast-follow, with a privacy opt-out.)

**The architecture shape (Conductor's direction, with our twist):**
- The engine (in the sandbox, or local) stays the **live hub** for a running workspace — the app still talks to it over the direct WebSocket ("the live wire"). Nothing changes about the live experience.
- NEW: the engine **writes through** every chat/session/state event to the cloud record (streamed, near-real-time). The in-sandbox `zeros.db` becomes the working copy; the cloud record is the permanent one.
- Restore path: a new/woken sandbox rehydrates code from git + chat/state from the cloud record. Sandboxes can now be deleted aggressively (cost win) with zero data loss.
- Devices/teammates NOT connected to a live engine can still read everything (history, offline/asleep workspaces) straight from the cloud record via realtime sync.
- We still **skip Conductor's broker on the live data path** (direct WSS stays — our advantage). We adopt their **cloud Postgres + sync-engine** layer. ElectricSQL (what Conductor uses; works on any Postgres incl. Supabase/Railway) is the named spike candidate for the sync layer; Supabase Realtime is the simpler starter.

**Analogy to use everywhere:** the sandbox is the **workbench**, the cloud record is the **filing cabinet**, GitHub is the **vault** (code). Workbenches get cleared; the filing cabinet doesn't.

**Privacy positioning (state openly):** unlike Conductor's public "none of it is stored on our servers" claim, Zeros DOES store chat/history in the user's account in our cloud — that IS the feature ("your work is always in your account"). Encrypted at rest, exportable, deletable on demand — and for companies that can't allow it, Decision 2.

**Cost/effort honesty:** always-on DB is cheap at our scale (Supabase free tier → $25/mo Pro → ~$100–600/mo at 1k users; negligible vs sandbox compute). The sync/write-through layer is real engineering: ~+2–4 weeks vs the old plan. New v1 estimate: **~3.5–6 months** from the Phase 1 spike.

## Decision 2 — Enterprise = they host the record (and data plane) on THEIR servers.

**What:** For enterprise customers, the SAME software runs with the cloud record + workspace data on **customer infrastructure** instead of our cloud. "Your data never lives in our cloud — it lives in yours."

**Concretely, "their own server" =** their Postgres (the record) + their object storage (backups/artifacts) + their git remotes + optionally their sandbox runners (their VPC / plain VMs). Delivered as Docker Compose/Helm + license key. Two rungs: **BYOC** (our control plane orchestrates; their data plane holds all data) and **full self-host** (they run control plane too). SSO/SAML/SCIM/audit stay a purchase (WorkOS-style), not a build.

**Why Decision 1 makes this CLEANER, not harder:** all durable data now lives in exactly ONE well-defined place (one Postgres schema + one bucket + git). Self-hosting = pointing the app at THEIR record. The four enterprise seams to design now (build later, after v1 GA):
1. **Configurable record endpoint** (DB URL is config, never hard-coded) — upgraded from the old "exportable data" seam.
2. `CloudSandboxProvider` interface stays swappable (their runners).
3. No hard-coded vendor URLs anywhere.
4. Engine runs on plain Linux.

## What does NOT change (do not touch these claims)
- **Daytona** as the sandbox provider; the Phase 1 spike + DAYTONA_API_KEY blocker; Startup Grid application.
- **Direct WebSocket** app↔engine; no broker on the live data path.
- **Mutagen local file mirror** (files plane) — unchanged.
- **Sleep-when-idle** economics (~8× lever) — in fact stronger: with the record, sandboxes can be deleted (not just stopped) even more aggressively.
- **Git remains the vault for code.**
- **Supabase recommendation** (part 04) — now STRONGER: we need auth + Postgres + realtime + storage, and now the Postgres is load-bearing (it IS the record). Railway stays the fallback Postgres / worker host. Add: ElectricSQL runs on any Postgres (Supabase or Railway), so the sync-engine choice doesn't lock the DB host.
- Design system, nav (8 exact filenames), self-containment of every .html, Sources sections, non-technical founder tone with inline glosses.

## Consistent terminology (use everywhere)
- "**the cloud record**" (first use: "the cloud record — our cloud database that permanently stores your chats, sessions, and workspace history in your account").
- "**the live wire**" for the direct WebSocket (existing docs may call it the bridge/CloudTransport — keep those names where already glossed, but the record vs live-wire distinction must be clear).
- Decision callouts dated **2026-07-02**.

## Honesty rules for the edit
- Where a doc previously argued the OTHER way (e.g., "a live cloud database is over-engineering", "diverge on the database", "Model B chosen", "chat journal recommendation", "local workspaces don't sync — accept it"), do NOT silently rewrite history: update the verdict AND add a brief dated note, e.g. "**Updated 2026-07-02:** the founder decided to adopt a cloud record (Conductor's direction) — see below." The engineering-plan doc (docs/cloud-workspaces-daytona-execution-plan.md) is NOT being edited in this pass; where docs cite it, note the June plan predates this decision.
- The old "chat journal" recommendation (part 05/07) is **absorbed**: the write-through stream to the cloud record IS the journal, upgraded from "lose seconds not hours" to "lose ~nothing, forever".
- Model A vs Model B framing in part 05: keep the comparison, but the verdict becomes a **hybrid, weighted to Model A**: cloud record = source of durable truth + sync + discovery (Model A), live engine = realtime hub while a workspace runs (the good part of Model B). Name it "**live engine + cloud record**".

## Per-doc deltas (each agent applies its own, md AND html in lockstep)
- **01-cloud-workspaces-explained:** "Where things live" / durability concepts: chat's permanent home = the cloud record (filing cabinet), not export blobs; sandbox = workbench (disposable, now even deletable); add "cloud record" to the glossary; day-in-the-life gains a beat: "months later, sandbox long gone — your chat history is still in your account". Two-plane story stays but the DB/chat plane now ends in the cloud record.
- **02-how-conductor-does-it:** the verdict flips from "diverge on the database" to "**we now go their way on the database** (decided 2026-07-02): cloud Postgres record + sync engine (they use ElectricSQL) — while still skipping their broker on the live path and keeping our direct connection". Their local-DB-first finding stays as reported fact; note Zeros leapfrogs it by making the cloud record primary from day one.
- **03-cursor-and-claude-code-cloud:** light touch: "both vendors keep the conversation on their servers; every device is a window — **Zeros now adopts the same principle** (decided 2026-07-02) via the cloud record" in the sync section + synthesis table row if present.
- **04-platform-comparison:** Decision B section gains weight: the backend now includes THE RECORD (always-on Postgres + sync). Supabase verdict unchanged but stronger (its Postgres becomes the record); add ElectricSQL-on-Postgres as the sync-engine spike candidate (Conductor-proven; DB-host-agnostic); Railway framing: still viable as record host (plain Postgres) for scale-out or preference, still lacks auth/realtime; reliability caveats stand. Cost tables: add the record line (~$0→$25→$100–600/mo).
- **05-sync-teams-and-collaboration:** the big one. Verdict flips to "live engine + cloud record" (Model A-weighted hybrid, decided 2026-07-02). The "honest gap" (local workspaces don't sync) is now SOLVED-by-design via local write-through (fast-follow, privacy opt-out). Chat journal → absorbed into the record write-through. Sequence numbering / "give me everything after №X" survives intact — it becomes the write-through + catch-up mechanism. Membership/identity in Supabase unchanged. Presence still via live engine.
- **06-enterprise-self-hosting:** now anchored on Decision 2 as a COMMITTED product direction (still phased after v1 GA): the ladder stays; the star rung is "their Postgres + their storage + optionally their runners"; seam #1 upgraded to the configurable record endpoint; add the one-liner "because all durable data = one Postgres schema, self-hosting = pointing Zeros at their database". Keep "buy SSO/SCIM, don't build" and "don't build before v1 GA".
- **07-execution-plan:** phases updated: Phase 4 (control plane) expands to include the **cloud record schema** (chats/messages/sessions tables + RLS); Phase 7 re-scoped from "durability export" to "**cloud record write-through & restore**" (engine streams events up; new sandbox rehydrates from the record; optional nightly export backup) and can start right after Phase 4; Phase 8 collaboration rides the record + live wire. Timeline: v1 ≈ 3.5–6 months (+2–4 weeks vs before). Cost model: add the record line. Decision register: move "cloud record" and "enterprise self-host commitment" into DECIDED (2026-07-02); founder-decides-this-month list shrinks accordingly (API key, Startup Grid, Cursor Tier-3 remain; "confirm Supabase" becomes "confirm Supabase as auth + THE RECORD host"). Add ElectricSQL spike to the load-test/spike checklist. Note the June engineering plan (v2) predates this and needs a v3 revision — list exactly what changes in it.
- **README + index.html (hub):** exec summary paragraphs for parts 05/06/07 updated to the new verdicts; decisions tables: "Engine-owned DB in the sandbox" row becomes "Engine stays the live hub; **the cloud record** permanently stores history (decided 2026-07-02)"; "Durability = git + exports" → "Durability = git + **the cloud record**"; recommended-table rows updated (chat journal → absorbed; "cloud = synced" → "everything in your account — cloud first, local fast-follow"); add a dated "Decision update" callout near the top; index.html architecture diagram: the "Object storage — chat durability" node becomes "🗂️ The cloud record — chats & history, forever" (description: our cloud database; for enterprises, can run on THEIR servers); part 05/06/07 page-card blurbs updated.
