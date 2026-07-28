# The Execution Plan
*part 07 of the Zeros Cloud Workspaces Report · July 2026 · decision update applied 2026-07-02*

## The short version

- **Decision update (2026-07-02).** The founder made two calls that reshape the back half of this plan. **One:** Zeros adopts **the cloud record** — our cloud database that permanently stores your chats, sessions, and workspace history in your account (Conductor's direction; part 05 has the full reasoning, part 02 the Conductor evidence). The engine streams every event to it as it happens, every device with your login syncs from it, and a fresh sandbox can rebuild a workspace from it — so sandboxes become fully disposable. **Two:** the enterprise offer is committed as **"they host the record on their own servers"** (part 06) — same software, their Postgres. Everything dated 2026-07-02 below flows from these two decisions.
- **The plan is sound and already moving.** Phase 0 (rip out the old web app and relay) shipped 2026-06-25 with all 1,429 tests green. Phase 1 is ✅ **built & merged (2026-06-25)** — the env-gated engine CloudTransport plus the full spike harness in `scripts/cloud-spike/` plus 10 unit tests (suite 1,439 green). ⏳ **Its exit run is still pending**: it needs one thing — a **Daytona API key** — so the measured numbers are still unrecorded. The engineering is executed; the hands-on validation against a real Daytona sandbox is the remaining step, and that key is the single item blocking everything else.
- **The architecture survived this entire report pack.** Eight research documents later, nothing says "rethink it." The engine-in-sandbox design is a named industry pattern ("session backends" — Figma runs one server process per document the same way), and Conductor.build independently shipped the same shape (direct Mac-to-sandbox connection, local file mirror) in production. The 2026-07-02 decisions change where durable data *lives*, not how the live system works: the direct WebSocket (**the live wire**), the Mutagen mirror, and sleep-when-idle all stand.
- **v1 = Phases 0–7:** a single-user cloud workspace that feels local — with history that outlives every sandbox. Realistic timeline for a tiny team: **~3.5 to 6 months** from the day the Phase 1 spike runs. That is **+2–4 weeks over the June estimate**, because the record's write-through/sync layer is real engineering (schema, event streaming, rehydration, catch-up) — only partly absorbed by pulling Phase 7 forward to run in parallel with Phases 5–6. Collaboration (Phase 8) and the design canvas (Phase 9) come after, but the architecture supports them from day one.
- **Money:** you personally ride Daytona's $200 free credit for ~6 months (~$33/mo of usage). 100 active users cost roughly **$1.6k/mo all-in with sleep-when-idle** — versus ~$12k/mo if workspaces never sleep. Sleep-when-idle is the entire business model, and the record makes the lever *stronger*: long-idle sandboxes can now be deleted outright, not just stopped. The record itself is the cheapest line on the sheet: **$0 → $25/mo → ~$100–600/mo at 1,000 users** — negligible next to compute. Apply to Daytona's Startup Grid ($10k credits, path to $50k) this month.
- **What this report now carries into the plan:** (1) the two 2026-07-02 decisions above; (2) keep Supabase as the backend, don't switch to Railway (part 04) — a stronger call now, because Supabase's Postgres becomes the record's home; (3) part 06's enterprise seams, with seam #1 upgraded to a **configurable record endpoint** (the record's database URL is config, never hard-coded). This report's earlier third addition — the "chat journal" from part 05 — is **absorbed (2026-07-02)**: the write-through stream to the record *is* the journal, upgraded from "lose seconds, not hours" to "lose ~nothing, forever."
- **Four founder decisions this month:** get the Daytona key and run the spike; confirm Supabase as auth + the record's host; apply to Startup Grid; decide whether Cursor-in-cloud is worth a $500 Daytona Tier-3 top-up for v1 (recommendation: defer it).
- Everything below is the consolidated, stand-alone plan — the June engineering plan (v2, 2026-06-24) merged with what all eight research docs found, updated for the 2026-07-02 decisions. **The June plan's v3 revision shipped 2026-07-03 as part 08 — [Engineering Reference](08-engineering-reference.md) — and the original file was removed; the exact change list is in this document.**

---

## What we're building (the 60-second user story)

You open Zeros on your Mac and create a workspace — except this time you pick **Cloud**. Behind the scenes, Zeros rents a **sandbox** (a small computer in a data center that can be created and thrown away in seconds, from a company called **Daytona**), installs the same Zeros engine that normally runs on your Mac, and connects your app to it over a **secure WebSocket** (an always-open, encrypted two-way phone line between your Mac and the sandbox — this report calls it **the live wire**).

You chat with your agent exactly as before. Files feel instant because a tool called **Mutagen** keeps a live copy of the project on your Mac (a "mirror" — like Dropbox for just this folder). Then you close your laptop and go to dinner. The agent keeps working, because it never lived on your laptop. Open Zeros on another Mac — same login, same workspace, same chat, mid-sentence. Later, a teammate joins the same workspace and you both watch the same agent, live.

Nothing irreplaceable lives in the sandbox: code is pushed to GitHub, and — as of the 2026-07-02 decision — every chat and session event is streamed, the moment it happens, to **the cloud record** (it replaces the old plan's periodic exports to object storage, which survive only as an optional nightly backup). Think of it as three homes: the sandbox is the **workbench**, the cloud record is the **filing cabinet**, GitHub is the **vault**. Workbenches get cleared — even thrown away; the filing cabinet doesn't. Months later, with the sandbox long gone, your chat history is still in your account.

---

## The roadmap, phase by phase

Ten phases, each with what **you the user** get, what gets built, the exit test, and rough effort (my estimates, assuming 1–2 engineers; ranges are honest). **Sequencing change (2026-07-02):** Phase 7 — re-scoped from "durability backstop" to **"cloud record write-through & restore"** — now starts right after Phase 4 and runs in parallel with Phases 5 and 6, instead of trailing them.

**Phase 0 — Clear the ground. ✅ DONE (2026-06-25).**
*User gets:* nothing visible — the app went local-only and simpler. *Built:* deleted the old web app and relay server; added the empty "cloud" connection slot; moved Google/GitHub login to a tiny static bounce page. *Exit:* met — builds green, 1,429 tests pass, login works. *Effort:* done.

**Phase 1 — The spike. ✅ BUILT & MERGED (2026-06-25); ⏳ exit run pending a `DAYTONA_API_KEY`.**
*User gets:* nothing yet — this is the "does the whole idea actually work" experiment. *Built (already, merged 2026-06-25):* the env-gated engine CloudTransport — a working minimal cloud connection — plus a full test harness in `scripts/cloud-spike/` that bakes the sandbox image, provisions a box, and runs the load tests automatically, with 10 unit tests (suite 1,439 green). *Exit (still pending — no API key yet, so no measured numbers):* a sandbox boots the engine; a test client connects over the secure WebSocket, lists files, runs a terminal command, and survives the sandbox being stopped and restarted. *Effort:* **days, not weeks** — the engineering is executed; what remains is the hands-on validation against a real Daytona sandbox and writing down the measured numbers.

**Phase 2 — First real cloud workspace (files over the wire).**
*User gets:* a hand-provisioned cloud workspace that fully works from the Mac app — files, terminal, git, one agent turn — just not yet disk-fast for file browsing. *Built:* the Mac app learns to dial a sandbox directly with a per-user login token, and each workspace picks local vs cloud. *Exit:* one cloud workspace is functionally identical to a local one. *Effort:* 2–3 weeks.

**Phase 3 — The local file mirror (the "feels local" upgrade).**
*User gets:* file browsing, editing, and diffs at local-disk speed even though the workspace is ~130 ms away. *Built:* embed Mutagen to mirror the sandbox's working files to a local folder (source code only — never `.git` or `node_modules`). *Exit:* file open/tree/diff feel instant; your edit and the agent's edit reconcile within ~1 second; conflicts are surfaced, never silently lost. *Effort:* 2–4 weeks (the riskiest build phase — see risk #4).

**Phase 4 — The control plane (Supabase + a thin worker) + the cloud record schema.**
*User gets:* a real "Launch cloud workspace" button instead of hand-provisioning. *Built:* a small central database (**Supabase** — a hosted service bundling login + a Postgres database) records who owns which workspace, and a tiny server-side **worker** (the only thing holding the Daytona API key) creates/starts/stops sandboxes. **Expanded 2026-07-02:** the same Postgres also gets the **cloud record schema** — `chats`, `messages`, and `sessions` tables beside workspaces/teams, protected by **RLS** (row-level security: database rules that let each user read only their own rows). Tables and permissions only at this point; the write-through that fills them is Phase 7, which this phase unlocks. *Exit:* click Launch → sandbox provisions → Mac attaches, all state recorded — and the record tables exist with RLS enforced. *Effort:* 1.5–2.5 weeks (the schema adds a few days).

**Phase 5 — Sleep and wake (the cost lever).**
*User gets:* workspaces that nap when idle and wake when clicked — this is what makes the pricing work. *Built:* the engine itself decides when to sleep (only when no agent is running AND you've been away 60 minutes), because Daytona's own idle timer would kill an agent mid-task. *Exit:* sleeps after 60 idle minutes, never mid-agent-run, wakes within the budget we measure in Phase 1, and the file mirror reconciles cleanly. *Effort:* 1–2 weeks. **Note (2026-07-02):** once Phase 7's record is live, this lever gets stronger — long-idle sandboxes can be *deleted*, not just stopped, because nothing durable lives in them.

**Phase 6 — Setup UI + agent/GitHub credentials. → v1 GA (behind a flag) with Phases 4–5, and Phase 7 landing in parallel.**
*User gets:* a Settings → Cloud panel: connect your agent accounts and GitHub once, then launch working cloud workspaces with all three agents. *Built:* credentials injected at provision time as short-lived tokens (anything inside a sandbox is readable by the agent in it, so nothing long-lived goes in). *Exit:* configure once, launch a workspace where Claude, Codex, and (budget permitting) Cursor plus git all work. *Effort:* 2–3 weeks.

**Phase 7 — Cloud record write-through & restore. ⏩ PULLED FORWARD (2026-07-02): starts right after Phase 4, in parallel with Phases 5–6.**
*User gets:* your chats, sessions, and workspace history permanently in your account — readable from any device even while (or after) every sandbox is gone. *Built:* the engine **streams every chat/session/state event up to the cloud record** as it happens (write-through — the in-sandbox `zeros.db` becomes the working copy; the record is the permanent one); a new or woken sandbox **rehydrates** — code from git, chat and state from the record; an optional **nightly export** to object storage remains as a belt-and-braces backup; and the janitor can now **delete** long-abandoned sandboxes outright. *Exit:* destroy a sandbox, provision a fresh one → full history and state come back; a second device reads the whole chat with zero sandboxes alive; write-through lag is seconds at most. *Effort:* 3–5 weeks (was 1–2 — this is where the new timeline's +2–4 weeks mostly lives).
**Updated 2026-07-02:** this phase was previously "durability backstop" — periodic exports to object storage plus a small chat journal (part 05's recommendation). The founder's cloud-record decision absorbs both: the write-through stream *is* the journal, upgraded from "lose seconds, not hours" to "lose ~nothing, forever," and exports demote to an optional backup.

**Phase 8 — Collaboration.**
*User gets:* invite a teammate into your workspace; you both see the same live chat with correct name attribution and presence ("who's here"). *Built:* per-user identity on every connection, membership and roles in Supabase, and soft-lock file editing ("Priya is editing this file") — riding the two rails that now exist: **history and membership ride the cloud record** (a teammate reads everything even while the workspace sleeps), **presence and live-tail ride the live wire**. *Exit:* two users, one workspace, live chat, no silent edit loss. *Effort:* 3–5 weeks.

**Phase 9 — Design-mode collaboration.**
*User gets:* a Figma-like shared canvas inside a workspace. *Built:* a real-time collaborative document layer (Yjs) hosted by the same engine. *Exit:* two users co-edit a canvas with live cursors; artifacts durable. *Effort:* 3–6 weeks; deliberately last.

---

## The decision register

### Newly decided — 2026-07-02 (founder decisions)

| Decision | What it means |
|---|---|
| **The cloud record (Conductor's direction) — DECIDED 2026-07-02** | All durable workspace data — chats, agent transcripts/sessions, workspace metadata, memberships — lives in our cloud Postgres, in your account. The engine writes every event through to it; every device with your login syncs from it, live; a new sandbox rehydrates from it. This replaces "export blobs to object storage" as the primary durability story (exports stay as an optional nightly backup). The model from part 05 is "**live engine + cloud record**": the record is the durable truth; the live engine stays the realtime hub while a workspace runs. We still **skip Conductor's broker on the live path** — the direct connection stays ours. |
| **Enterprise = they host the record on their servers — DECIDED 2026-07-02** | The same software, with the record (their Postgres) + object storage + git remotes + optionally sandbox runners on **customer infrastructure**. "Your data never lives in our cloud — it lives in yours." A committed product direction — still built strictly after v1 GA (part 06). |

**Privacy positioning, stated openly:** unlike Conductor's public "none of it is stored on our servers" claim, Zeros *does* store chat and history in the user's account in our cloud — that is the feature ("your work is always in your account"). Encrypted at rest, exportable, deletable on demand — and for companies that can't allow it, the enterprise decision above exists.

### Already locked (from the June plan — re-validated by this report; updated where noted)

| Decision | One-line why |
|---|---|
| **Provider: Daytona** | ~2.5× cheaper vCPU than Vercel-style billing for always-warm boxes, near-free idle, no hard runtime cap (Vercel caps sessions at 24 h), US **and** EU regions (Vercel is US-East only), and WebSocket-over-proxy is documented. Kept swappable behind a provider interface. |
| **Direct connection (no broker)** | The Mac dials the sandbox itself over the secure WebSocket — the live wire. Conductor routes everything through their own server; we skip that entire middleman — fewer moving parts, and the vendor is never in your *live* data path (an enterprise selling point, per part 06). Unchanged by the 2026-07-02 decisions. |
| **Mutagen local file mirror** | The proven "fast as local" trick (Conductor built a homegrown version; Coder ships Mutagen itself). |
| **Engine-owned chat DB (`zeros.db` in the sandbox)** | One shared writer = collaboration falls out for free. Part 05 confirmed this is Figma's own architecture. **Updated 2026-07-02:** still true for the live path — but `zeros.db` is now the *working copy*; the cloud record is the permanent home. |
| **Supabase pencilled as control plane; thin worker holds the Daytona key** | Login + registry + row-level permissions for $0–25/mo, and the only secret stays server-side. **Updated 2026-07-02:** the stakes rose — the same Postgres now hosts the cloud record, making it load-bearing (this month's decision #2 confirms it). |
| **Engine-owned sleep; Daytona auto-stop disabled** | Daytona's idle timer isn't reset by a running agent — it would kill work mid-turn. Verified, and the #1 correctness trap. |
| ~~**Durability = git remote + export blobs; no always-live cloud DB**~~ | **Superseded 2026-07-02.** The June plan (and an earlier draft of this report) argued a live cloud database was more than v1 needed. The founder decided otherwise: durability = git (code) + **the cloud record** (chats/sessions/state); exports demote to an optional nightly backup. See "Newly decided" above — the sandbox stays just as disposable; *more* so, in fact. |

### What this report adds (recommendations from parts 04–06 — updated 2026-07-02)

1. **Backend: stay on Supabase; do not move to Railway** (part 04). Supabase Pro at $25/mo bundles everything the control plane needs (login, database, permissions, a realtime "hint" channel, storage). Railway would make you rebuild login and permissions yourself, its Postgres is officially "unmanaged," and it suffered an ~8-hour full-platform outage on 2026-05-19 when Google Cloud auto-suspended its account. Verdict: **verified facts, clear call** — and **a stronger one since 2026-07-02**: the Postgres is now load-bearing because it *is* the record. Railway remains the fallback record host (plain Postgres); ElectricSQL runs on any Postgres, so the sync-engine choice doesn't lock the DB host.
2. **Sync model: append-only, resumable chat stream** (part 05). Give every workspace chat a running sequence number and let clients say "give me everything after #N" — that one primitive delivers reconnect, second-device catch-up, and teammate live-tail. No CRDTs (fancy merge math) needed for chat; Figma, Linear, and Slack all use server-ordered logs. **Updated 2026-07-02:** the second half of this recommendation — the standalone "chat journal" — is **absorbed into the cloud record**: the write-through stream *is* the journal. The sequence-number primitive survives intact as the record's write-through + catch-up mechanism.
3. **Enterprise seams now, enterprise features later** (part 06). Four cheap disciplines: make *teams* a first-class database concept from day one (retrofitting later is "a months-long migration"); a **configurable record endpoint** — the record's database URL is config, never hard-coded (**upgraded 2026-07-02** from the old "exportable data" seam; it's exactly what makes the enterprise decision cheap later); one engine image for all deployments; a telemetry off-switch. Buy SSO/SCIM from WorkOS (~$125/connection/mo) only when the first enterprise deal appears. PostHog's cautionary tale: they built self-hosting early, only 3.5% used it, and it nearly drowned their infra team.

### Decisions the founder must make this month

| # | Decision | Recommendation |
|---|---|---|
| 1 | **Get a Daytona API key and run the Phase 1 harness.** | Do it this week. Phase 1 is already built & merged (2026-06-25) — this exit run is the only remaining step. It is the critical path; every phase behind it is guesswork until the measured numbers exist. Sign-up is self-serve with $200 credit, no card. |
| 2 | **Confirm Supabase — as auth + the record's host.** | Supabase (per part 04 — a stronger call now: we need auth + Postgres + realtime + storage in one place, and the Postgres is load-bearing because it *is* the record). ElectricSQL runs on any Postgres, so the sync-engine choice doesn't lock the host; Railway stays the fallback record host. Close the question and unblock Phase 4. |
| 3 | **Apply to Daytona Startup Grid.** | Yes — $10k credits on acceptance, path to $50k; the application is a form plus a deck link, "less than 5 minutes." This could cover the entire beta's compute bill. |
| 4 | **Cursor Tier-3 budget.** | Daytona's cheaper tiers only allow outbound traffic (**egress** — what the sandbox is allowed to talk to on the internet) to an approved list. Cursor's agent dials `*.cursor.sh` hosts that aren't on it, so shipping Cursor agents in cloud needs Tier 3 — a **$500 wallet top-up** (it becomes compute credit, not a fee, and also removes a preview warning page). Recommendation: **defer Cursor-in-cloud for v1**, ship Claude + Codex (both allowlisted on all tiers), and do the top-up when usage justifies it anyway. |

---

## What changes in the June engineering plan (the v3 revision — shipped as part 08)

✅ **Done (2026-07-03):** the v3 revision shipped as part 08 — [Engineering Reference](08-engineering-reference.md), and the original `docs/cloud-workspaces-daytona-execution-plan.md` was deleted. What changed from v2 to v3:

1. **Phase 4 scope:** the control-plane schema grows the cloud record tables — `chats`/`messages`/`sessions` + RLS — beside workspaces/teams (+a few days of effort).
2. **Phase 7 rewrite:** "durability export" becomes **"cloud record write-through & restore"** — the engine streams events up; new/woken sandboxes rehydrate from the record; exports demote to an optional nightly backup; the janitor may *delete* (not just stop) abandoned sandboxes. Effort 1–2 weeks → 3–5 weeks.
3. **Phase 7 sequencing:** starts right after Phase 4, in parallel with 5–6 — no longer trailing Phase 6.
4. **Phase 8:** collaboration reads history/membership from the record and presence/live-tail from the live wire; drop any journal-based catch-up.
5. **Timeline:** v1 ~3–5 months → **~3.5–6 months**.
6. **Decision table:** the "durability = git + exports; no always-live cloud DB" row is superseded (2026-07-02); add the two new decisions (the cloud record; enterprise hosts the record).
7. **Enterprise seam #1:** "exportable data" → **configurable record endpoint** (the record's DB URL is config, never hard-coded).
8. **Load-test list:** add the ElectricSQL sync-engine spike (#12 below).

---

## Timeline (tiny team, honest ranges)

**The critical path runs straight through Phase 1.** Until the spike runs, wake latency, WebSocket stability, and Mutagen-over-SSH are all unmeasured — and Phases 2, 3, and 5 are designed around those numbers. **Why the end date moved (2026-07-02):** the record's write-through/sync layer is real engineering — schema, event streaming, rehydration, catch-up — worth **+2–4 weeks** on a 1–2-engineer team, even though Phase 7 now overlaps Phases 5–6 on the calendar rather than trailing them.

| Milestone | When (from spike day) | Confidence |
|---|---|---|
| Phase 1 spike complete, numbers recorded | Week 1 | High — built & merged 2026-06-25; only the run remains |
| Phase 2: first working cloud workspace | Weeks 3–5 | High — mirrors existing transport code |
| Phase 3: feels-local file mirror | Weeks 6–9 | Medium — most technically uncertain phase |
| Phases 4–6 (with Phase 7 in parallel): self-serve launch, sleep/wake, setup UI → **v1 GA behind a flag** | **Months 3.5–6** | Medium |
| Phase 7: cloud record write-through & restore *(pulled forward)* | Starts right after Phase 4 — 3–5 weeks, in parallel with 5–6; lands by GA | Medium — new sync layer; the ElectricSQL spike (load test #12) de-risks it |
| Phase 8: collaboration beta | Months 5–8 | Medium |
| Phase 9: design canvas | After 8; schedule when demand is real | Low priority |

Calibration from the market: Conductor ran its cloud as an invite-only beta for ~2 months of weekly iteration before even shipping share links, and still hasn't published pricing (as of 2026-07-02). Plan the same shape: **flag-gated alpha → small invite beta → GA**, and don't couple pricing to the first invite.

---

## Cost model at three scales

Daytona rates (verified on the pricing page, 2026-07-02): vCPU $0.0504/hr, RAM $0.0162/GiB-hr, disk $0.000108/GiB-hr. A standard 2 vCPU / 4 GiB / 10 GiB workspace ≈ **$0.167/hr running, ~$0.001/hr stopped**. That ~170:1 running-to-stopped ratio is why sleep-when-idle is the whole ballgame.

| | **Solo / beta (you + ~10 testers)** | **100 active users** | **1,000 active users** |
|---|---|---|---|
| Compute (~3 h/day active, sleeps otherwise) | ~$33/mo (you); ~$150–400/mo for the beta | **~$1,500/mo** | ~$15k/mo *(extrapolated — needs real usage data)* |
| Idle disk (stopped boxes) | ~$1–8/mo | ~$77/mo | ~$770/mo (less once the record lets the janitor delete instead of stop) |
| Control plane (Supabase + worker) | $0–25/mo | ~$25–50/mo | ~$100–300/mo (connection overages) |
| **The cloud record** (chats/sessions Postgres + sync) *(added 2026-07-02)* | $0 (free tier — same Supabase project as the control plane) | ~$25/mo (Supabase Pro) | ~$100–600/mo (bigger instance + storage as history grows) |
| Backup storage (optional nightly export + artifacts) | pennies | <$5/mo | <$50/mo |
| **Roughly** | **≈ $0–massively covered by the $200 credit + Startup Grid** | **≈ $1.6k/mo ⇒ ~$16/user COGS** | **≈ $16k/mo ⇒ ~$16/user COGS** |

Four footnotes that matter:

- **The nightmare scenario is forgetting to sleep:** 100 always-on workspaces ≈ $12k/mo instead of $1.5k. Phase 5 is not optional polish; it is the margin.
- **The record is the cheapest line on the sheet (added 2026-07-02):** $0 while you build, $25/mo through the beta, ~$100–600/mo at 1,000 users — at most ~$0.60/user/mo, noise next to ~$15/user of compute. And it *strengthens* the sleep lever: the janitor can delete long-idle sandboxes outright (disk cost → $0) because the record already holds everything.
- **Tier pools gate scale.** Daytona tiers cap total *running* resources: T2 ($25 card) = 100 vCPU, T3 ($500) = 250, T4 ($2,000/30 days) = 500. At 1,000 users, peak concurrency (~250–300 running workspaces × 2 vCPU) exceeds T4 — that's an enterprise-limits conversation with Daytona, worth opening early (verified tier numbers; the concurrency estimate is mine).
- **Pricing implication:** at ~$16/user/mo COGS for a 3 h/day user, a $30–50/mo cloud tier with usage-based overage is the natural shape. The whole industry repriced to pass-through economics in H1 2026 (Copilot, Codex, Cursor all bill tokens at API rates now) — don't margin-stack model tokens; charge for the workspace.

---

## Top 11 risks, each with a plain-language mitigation

| # | Risk | What could go wrong | Mitigation |
|---|---|---|---|
| 1 | **Provider lock-in** | Daytona raises prices or degrades; we're stuck. | All Daytona calls sit behind one swappable interface; nothing irreplaceable lives in a sandbox (git + the cloud record). Fly.io is the fallback (Sprites is the closest match, with Mumbai/Singapore machines). Conductor proved mid-beta provider swaps are survivable — they switched providers without users noticing. |
| 2 | **Daytona company risk** | A Series-A vendor that went closed-source on 2026-06-11 — no self-host escape hatch if it stumbles. | Same portability posture as #1, plus: pin the SDK, get terms in writing before GA (load test #10). Counter-signals: $24M raise, Datadog/Figma as investors, 99.98% uptime. Watch, don't panic. |
| 3 | **WebSocket idle resets** | Daytona's proxy has a known bug (#3846) that can drop quiet connections, killing the live link. | Already coded into Phase 1: long keep-alive timeouts, a ping every 25 seconds, auto-reconnect, and re-fetch the connection URL after every wake. The soak test proves it before Phase 2 builds on it. |
| 4 | **Mutagen traps** | The mirror could resurrect deleted files after a sleep ("offline-edit trap"), sync slowly on Linux (10-second polling default), or fail to install over Daytona's SSH. | Reset the sync baseline on every wake; force native file-watching; never sync `.git` (a booby-trapped git folder is a security risk); load test #5 proves it all before Phase 3. Fallback: a simple manifest sync like Conductor's. |
| 5 | **Cursor egress (Tier 3)** | Cursor agents silently fail in cloud workspaces on cheap tiers. | Ship v1 with Claude + Codex; label Cursor "coming soon" in cloud; do the $500 top-up when revenue or usage justifies it. Load test #4 confirms exactly which host the SDK dials. |
| 6 | **Secrets in shared boxes** | Anything injected into a sandbox is readable by the agent inside it — and later by teammates in a shared workspace. | Short-lived, narrowly-scoped tokens only (GitHub App tokens expire in 1 hour and auto-renew); never bake keys into the image. Long-term, copy the industry pattern: credentials live at a proxy, never in the box (Anthropic and Vercel both do this). |
| 7 | **Region latency for Asia** | No India region (Mumbai was announced May 2025, absent from current docs); India → EU is ~130 ms. | The file mirror exists precisely for this — files read locally; only the agent stream and terminal cross the hop, where latency doesn't hurt. If Asian users demand true-local, Fly.io has Mumbai and Singapore. |
| 8 | **Cold-wake UX** | Every wake is a full cold boot (Daytona's stop clears memory); if it takes 20+ seconds, "always ready" feels broken. | Measure it first (load test #2 — the numbers are unpublished). Then design honestly: a "waking up…" state, wake-on-click from the control plane (a preview hit does *not* wake a stopped box — confirmed bug #2270), and pre-wake heuristics later. Needs-testing. |
| 9 | **Multi-user trust model** | The engine substrate supports many clients, but v1's auth binds a workspace to one owner; shipping collab without per-user identity would let teammates impersonate each other. | Phase 8 does this properly: every connection authenticates as its own user, the server stamps authorship (never trusts the client), roles are Linear-minimal (Admin/Member), and the control plane mints the tokens. Don't shortcut it. |
| 10 | **Enterprise support burden** | Saying yes to an early "run it on our servers" deal turns a 2-person team into an unpaid ops department (PostHog's exact mistake). | Seams now, features later (see below) — the 2026-07-02 enterprise decision commits the *direction* but keeps the build strictly after v1 GA. The first ten enterprise asks are answered with SSO/audit purchases (~$1–3k/mo total) and the "the record — and with it all your data — runs on your servers" architecture pitch, sold as a roadmap commitment, not an early build. |
| 11 | **Cloud record availability & privacy** *(new 2026-07-02)* | The record is a new always-on dependency: if it's down, devices not attached to a live engine can't fetch history. And Zeros now *does* store chat in our cloud — a bigger privacy surface than the old "nothing durable on our servers" posture. | Write-through is asynchronous and never blocks the live wire — a running workspace keeps working through an outage, buffers events in the local working copy (`zeros.db`), and replays them when the record returns. Data is encrypted at rest, exportable, and deletable on demand; the optional nightly export is the belt-and-braces backup; and companies that can't accept our cloud host the record themselves (the enterprise decision). |

---

## The 12 load tests, in plain words (what we're testing and why it gates code)

These run in Phase 1 (harness already written for #1–4 and #6) — each proves a physical assumption *before* we build the feature that depends on it. #12 is the exception: added 2026-07-02, it's a Phase-4-adjacent spike and the one test that needs no Daytona key at all:

1. **Multi-hour connection soak** — leave the Mac↔sandbox line open for hours. Does Daytona's proxy drop it? *Gates Phase 2 (the connection everything rides on).*
2. **Resume latency** — how many seconds from "stopped" (and from "archived") to usable? Daytona publishes no numbers. *Gates Phase 5's sleep thresholds and the wake UX.*
3. **Cold engine boot** — after a wake, does the engine correctly reload everything from its on-disk database and git? *Gates the whole sleep/wake model.*
4. **Egress check** — can the sandbox actually reach Anthropic, OpenAI, GitHub, npm — and which Cursor host does the SDK dial? *Gates Phase 6 agent support and the Tier-3 decision.*
5. **Mutagen in Daytona** — does the mirror install over SSH, how long is first sync, is file-watching instant, does the wake-reset work? *Gates Phase 3.*
6. **SSH port-forward reality check** — needed for "Open in Cursor/VS Code," not for the main connection. *Gates that convenience feature only.*
7. **Real idle billing over a week** — do stopped/archived boxes actually cost what the pricing page says? *Gates the cost model.*
8. **Multi-client test** — do several Macs connected to one sandbox behave? *Gates Phase 8 collaboration.*
9. **Stuck-state recovery** — kill things mid-provision; does the worker detect and recreate broken boxes? *Gates reliability at GA.*
10. **License terms in writing** — before shipping a product on Daytona, get the commercial terms on paper. *Gates GA.*
11. **Fork/snapshot reality** — Daytona's experimental "clone a running box" features: filesystem-only or memory too? *Gates nothing in v1 — only a future "fork this messy workspace into 3 parallel attempts" feature.*
12. **ElectricSQL sync-engine spike** *(added 2026-07-02)* — stand up ElectricSQL (the sync engine Conductor uses; it runs on any Postgres, Supabase or Railway alike) against the record schema; stream a chat table to two clients; kill one mid-stream and let it catch up. Compare write-through latency and catch-up correctness against the simpler Supabase Realtime starter. *Gates Phase 7's sync-layer choice.*

---

## Success metrics per milestone

| Milestone | You know it worked when… |
|---|---|
| **Phase 1 spike** | Soak ≥ 4 h with zero unrecovered drops; stop→start reconnect < 10 s; wake latency measured and written into the plan; egress verdicts recorded. |
| **Phase 2 alpha** | One cloud workspace completes a full agent turn end-to-end; you personally use it for a real task for a week. |
| **Phase 3 "feels local"** | File open/tree/diff indistinguishable from local in blind use; user-edit ↔ agent-edit reconcile ≤ 1 s; zero silently lost edits. |
| **v1 GA (4–6)** | Clean install → first cloud workspace in < 5 minutes; laptop closed mid-task → task finishes; sleep engages at 60 min idle and **never** mid-agent-run; compute ≤ ~$1/day per 3 h/day workspace. |
| **Phase 7 record** | Deliberately destroy a sandbox → a fresh one rehydrates code from git and chat/state from the cloud record with zero loss; a second device reads full history with no sandbox alive; measured write-through lag ≤ a few seconds. |
| **Phase 8 collab** | Two users, one workspace: both see the same chat live with correct attribution; presence updates in seconds; soft-lock prevents overwrite in testing. |
| **Business** | Startup Grid accepted; beta compute fully credit-covered; a priced cloud tier whose margin at $16/user COGS you've validated. |

(Targets are mine; the latency ones become real numbers after the spike.)

---

## How the enterprise track slots in without blocking v1

The headline from part 06 got *stronger* on 2026-07-02 — but it changed shape, so let's be precise. The old pitch was "the vendor can't see your data, because nothing durable leaves the sandbox." Decision one deliberately changes that for the everyday product: chats and history now live in our cloud, in your account — that *is* the feature. Decision two restores the enterprise answer, cleaner than before: **the record itself runs on their servers.** Because all durable data now lives in exactly one well-defined place (one Postgres schema + one object-storage bucket + git), self-hosting stops being a re-architecture and becomes configuration: **point Zeros at their database.**

So the enterprise track is a *discipline*, not a workstream:

- **Now (costs ~zero):** team-first database schema in Phase 4 — now including the record tables; a **configurable record endpoint** (the record's DB URL is config, never hard-coded — seam #1, upgraded 2026-07-02); one engine image for every deployment (it already runs on plain Linux); no hard-coded vendor URLs anywhere; a telemetry switch and a one-line data-flow statement.
- **At first enterprise interest:** buy SSO/SCIM/audit (WorkOS, ~$125/connection/mo), start SOC 2, write the DPA. Weeks of work, mostly paperwork.
- **Only with a paid contract:** **BYOC — now concretely defined (2026-07-02):** their Postgres (the record) + their object storage (backups/artifacts) + their git remotes + optionally their sandbox runners (their VPC / plain VMs), delivered as Docker Compose/Helm + a license key — our control plane orchestrates; their data plane holds all the data. Ask Daytona sales what their BYOC ("custom regions") concretely offers before assuming it — it's documented but sales-gated and early.
- **Never (for now):** air-gapped installs — and nothing on this ladder gets *built* before v1 GA. Full self-host (they run the control plane too) is on the committed ladder since 2026-07-02, but it's the last rung, not the first.

Nothing on this list touches the v1 critical path.

---

## What this means for Zeros

1. **Run the spike this week.** Get the Daytona API key, run `scripts/cloud-spike/`, and write the measured numbers into the plan. Everything else in this document is provisional until then; the harness is already built & merged, which makes it a days-long task.
2. **Lock the backend as Supabase — as auth + the record's host** — and start Phase 4's schema with teams *and the record tables* (`chats`/`messages`/`sessions` + RLS) as first-class concepts. Railway is off the table as the primary backend (verified reliability record, missing auth/permissions) but stays the fallback record host — ElectricSQL runs on any Postgres, so the sync choice doesn't lock the host. Fly stays the sandbox-provider fallback, not the control plane.
3. **Apply to Daytona Startup Grid now** — plausibly $10–50k of the beta's COGS, for a five-minute application.
4. **Ship v1 with Claude + Codex; defer Cursor-in-cloud** until the $500 Tier-3 top-up is justified by usage (you'll likely hit Tier 3 for pool capacity anyway around ~50–100 active users).
5. **Build the record on part 05's two rails:** the sequence-numbered, resumable stream (Phase 2) becomes the record's write-through + catch-up mechanism (Phase 7); the old chat-journal idea is absorbed into it (2026-07-02). Run the ElectricSQL spike (load test #12) before committing the sync layer — it needs no Daytona key and can start now.
6. **Keep the swap-out muscle warm.** Pin the SDK, keep the provider interface honest, get Daytona's terms in writing, and re-check Fly Sprites at the Phase 5 mark. Conductor's pluggable-provider column is the proof this insurance pays.
7. **Sequence like Conductor did:** flag-gated alpha → ~2-month invite beta with weekly iteration → GA. Collaboration (Phase 8) is your differentiation moment — real-time shared agent chat is open ground nobody, including Conductor and Cursor, has shipped as of mid-2026 — and it now rides rails v1 already built: the record + the live wire.
8. ✅ **Done (2026-07-03) — the June engineering plan got its v3 revision.** It shipped as part 08 — [Engineering Reference](08-engineering-reference.md) — and the original file was removed. The change list applied is in this document (Phase 4 schema, Phase 7 rewrite + resequencing, timeline, decision table, seam #1, load test #12).

---

## If you only read this page

**The plan:** a cloud workspace is the same Zeros engine running in a rented Daytona sandbox. Your Mac talks to it directly over a secure, always-open connection (the live wire); a Mutagen mirror makes files feel local; the engine streams every chat and session event to **the cloud record**, so your history lives permanently in your account (decided 2026-07-02); git holds the code. The sandbox is the **workbench**, the record is the **filing cabinet**, GitHub is the **vault** — the workbench can be cleared, or thrown away, any time. Phase 0 (cleanup) is done. Phase 1 (the proof-of-life spike) is **built & merged (2026-06-25)** — only its exit run against a real sandbox is still pending, **waiting on a Daytona API key**.

**The path:** spike (days) → first working cloud workspace (~a month) → feels-local mirror (~2 months) → self-serve launch + sleep/wake + setup UI, with the record's write-through built in parallel = **v1 in ~3.5–6 months** (+2–4 weeks vs the June estimate — the sync layer is real engineering) → collaboration (~months 5–8) → design canvas later. Twelve hands-on load tests gate the code; the harness for the first batch is already written.

**The money:** ~$0.17/hour while a workspace runs, ~$0.001/hour asleep — so the sleep controller *is* the business model, and the record sharpens it (the janitor can delete idle sandboxes outright). You ride $200 of free credit for ~6 months; 100 users ≈ $1.6k/mo (~$16/user); the record adds $0 → $25/mo → ~$100–600/mo at 1,000 users — the cheapest line on the sheet; Startup Grid credits ($10k–$50k) can cover the beta.

**This month:** (1) get the API key and run the spike; (2) confirm Supabase as auth + the record's host; (3) apply to Startup Grid; (4) defer Cursor-in-cloud rather than pre-paying $500.

**The three watch-items:** Daytona is a young, now closed-source vendor — mitigated by the swappable provider seam and keeping all durable state outside the box. Cold-wake time is unmeasured — the spike answers it in week one. And the record is a new always-on dependency — mitigated by async write-through (an outage never blocks live work), local buffering, and the nightly backup export.

**The endgame:** the enterprise story is now a committed direction, not an accident — decided 2026-07-02: **they host the record on their servers**, so their data lives in their database. And live, multi-user agent chat remains open ground no competitor has shipped. v1 needs neither to launch — but both are downhill from here, because both ride the same two rails v1 builds: the record and the live wire.

---

## Sources

**Internal:** `research/decision-update-2026-07-02.md` (founder decision brief — the cloud record + enterprise-hosts-the-record) · the June engineering plan (v2, 2026-06-24; Phase 0 note 2026-06-25; cleanup 2026-06-30) — **consolidated into [08-engineering-reference](08-engineering-reference.md) (2026-07-03); original removed** · `scripts/cloud-spike/` (Phase 1 harness — built & merged 2026-06-25) · research notes in `research/` (all fetched/verified 2026-07-02).

**Daytona:** https://www.daytona.io/pricing · https://www.daytona.io/docs/en/limits/ · https://www.daytona.io/docs/en/network-limits/ · https://www.daytona.io/docs/en/regions/ · https://www.daytona.io/docs/en/sandboxes/ · https://www.daytona.io/docs/en/custom-preview-proxy/ · https://www.daytona.io/docs/en/bring-your-own-compute · https://www.daytona.io/startups (Startup Grid) · https://www.daytona.io/dotfiles/updates/daytona-is-going-closed-source (2026-06-11) · https://www.daytona.io/dotfiles/daytona-raises-24m-series-a-to-give-every-agent-a-computer (2026-02-05) · https://status.app.daytona.io/

**Competitors & providers:** https://vercel.com/blog/how-conductor-moved-parallel-coding-agents-from-the-laptop-to-the-cloud-with-vercel-sandbox (2026-05-27) · https://thenewstack.io/conductor-cloud-ai-coding-agents/ (2026-05-14) · https://www.conductor.build/changelog · https://vercel.com/docs/sandbox/pricing · https://vercel.com/docs/sandbox/concepts/persistent-sandboxes · https://sprites.dev/ · https://fly.io/blog/design-and-implementation/ · https://fly.io/docs/about/pricing/ · https://simonwillison.net/2026/Jan/9/sprites-dev/

**Backend (part 04):** https://supabase.com/pricing · https://docs.railway.com/pricing/plans · https://blog.railway.com/p/incident-report-may-19-2026-gcp-account-outage · https://fly.io/docs/mpg/ · https://docs.railway.com/storage-buckets

**Sync & collaboration (part 05):** https://www.figma.com/blog/how-figmas-multiplayer-technology-works/ · https://www.figma.com/blog/making-multiplayer-more-reliable/ · https://electric.ax/blog/2025/12/09/announcing-durable-streams · https://ably.com/blog/token-streaming-for-ai-ux · https://github.com/wzhudev/reverse-linear-sync-engine · https://github.com/jamsocket/plane

**Enterprise (part 06):** https://workos.com/blog/enterprise-readiness-checklist-2026 · https://workos.com/pricing · https://northflank.com/blog/what-is-byoc-in-cloud-computing · https://posthog.com/blog/sunsetting-helm-support-posthog · https://retool.com/blog/building-a-modern-on-prem-software-business · https://e2b.dev/docs/byoc · https://depot.dev/docs/self-hosted/architecture

**Landscape:** https://code.claude.com/docs/en/claude-code-on-the-web · https://cursor.com/docs/cloud-agent · https://cursor.com/blog/cloud-agent-lessons (2026-06-02) · https://developers.openai.com/codex/cloud · https://docs.factory.ai/cli/features/droid-computers · https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/ · https://mutagen.io/documentation/synchronization
