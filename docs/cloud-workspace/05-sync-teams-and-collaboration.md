# Sync, Teams & Collaboration
*Part 05 of the Zeros Cloud Workspaces Report · July 2026*

> **Decision update — 2026-07-02.** This page originally recommended Model B — engine-owned chat, with export blobs for safekeeping — and was honest about its one real gap. The founder has since decided to adopt **the cloud record** — our cloud database that permanently stores your chats, sessions, and workspace history in your account — while keeping the live engine as the realtime hub. The chosen architecture is a hybrid weighted to Model A, named **"live engine + cloud record."** The Model A vs Model B comparison below is kept because it still explains why each piece landed where it did; the original verdicts carry dated updates rather than silent rewrites.

## The short version

- **Users expect three things**: same workspaces and chats on every Mac they log into, the ability to invite a teammate who sees the same agent chat live, and history that never dies — even if the cloud computer behind it does.
- There are **two ways to build this**, both kept below as pedagogy. Model A (Conductor's way): a central cloud database stores every message, and all devices sync against it. Model B (the June plan): the workspace itself is the meeting point — everyone connects to the same live engine in the sandbox, and a tiny cloud registry only lists who may enter. Model B is a real, named industry pattern ("session backends" — Figma runs one server process per document that all editors connect to).
- **Decided 2026-07-02 — the verdict flipped to "live engine + cloud record,"** a hybrid weighted to Model A. The **cloud record** (our Postgres) is the source of durable truth, cross-device sync, and discovery. The **live engine** in the sandbox stays the realtime hub while a workspace runs — every open window still talks to it over the direct WebSocket ("the live wire"), with no broker on the live path. The engine **writes every chat/session event through to the record** as it happens; devices and teammates not connected to a live engine read everything from the record.
- **Durability upgraded from "lose seconds" to "lose ~nothing, forever."** The June recommendation to add a Figma-style chat journal next to export blobs is absorbed: the write-through stream to the cloud record *is* the journal, and the record — not export blobs — is chat's permanent home. Sandboxes become fully disposable: delete them aggressively; history stays in your account.
- **Agent chat still does not need fancy conflict-resolution tech (CRDTs)**. Figma, Linear, and Slack all reject it for this shape of problem. One engine per workspace means one referee that puts messages in order — and the record stores what the referee ordered; it never referees. Unchanged by the decision.
- **One protocol trick still delivers almost everything**: number every chat event, and let any consumer say "give me everything after number X." Devices use it to reconnect after lid-close, catch up on a second device, and join mid-conversation — and now the engine uses the same primitive to write through to the record and to catch it up after any hiccup. Verified as the 2025–26 industry standard.
- **The old honest gap is now solved by design**: in pure Model B, *local* (non-cloud) workspaces didn't sync across devices. With the record, a local engine writes through to the same cloud record — local work appears on your other Macs too (a fast-follow after v1, with a privacy opt-out). Conductor still doesn't sync local workspaces at all.
- **Identity and membership stay in the cloud, on Supabase — unchanged**: who you are, which workspaces you may enter, and the short-lived keys that let you in. Stronger now, in fact: the record makes that Postgres load-bearing rather than merely convenient. Presence stays in the live engine, never stored.
- **Timeline**: v1 (Phases 0–7) ships a *single-user* cloud workspace that feels local, with the record write-through as its durability spine (Phase 7, re-scoped); local write-through follows fast after v1; Phase 8 adds teammates riding the record + the live wire; Phase 9 adds the co-edited design canvas. The record adds ~2–4 weeks of engineering: v1 now ≈ **3.5–6 months** from the Phase 1 spike.

---

## What users actually expect: three promises

Before any architecture talk, here is the experience being promised, step by step.

**Promise 1 — every device, same everything.** You start an agent on your MacBook at a café. You get home, open Zeros on your Mac Studio, and the same workspace is there — same chat, and the agent's reply is *still streaming in live*, mid-sentence. You prompt from the Studio; later the MacBook shows that message too. Nothing was exported, nothing was emailed to yourself.

**Promise 2 — invite a teammate.** You click share, Sarah gets an invite, and she opens the same workspace on her Mac. You both see the same agent chat, live. She types a follow-up prompt; it appears in your window with her name on it. A small indicator says "Sarah is here." It should feel like a shared Google Doc, except the "document" is a conversation with a working agent.

**Promise 3 — history survives everything.** Six months later the cloud computer behind that workspace has long been deleted to save money. You search for that conversation and it's still there, readable — because it lives in your account (the cloud record), not on the dead machine.

Everything below is about how those three promises get built.

---

## Two ways to build it

Think of a hotel. Every workspace is a room where a conversation is happening.

**Model A — head office keeps a copy of everything.** Every word spoken in every room is also written down and filed at the hotel chain's headquarters. Any guest, on any device, reads from headquarters. **Model B — the conversation lives in the room.** People who want to participate walk into the room and talk. The front desk doesn't record conversations — it only keeps the guest registry and hands out key cards. For safekeeping, the room's notebook is photocopied into a cheap storage unit every so often.

*(Spoiler, since 2026-07-02: Zeros keeps the live room **and** gives head office a filing cabinet — with your name on the drawer. The comparison is still worth reading; it's why the hybrid is shaped the way it is.)*

### Model A: central cloud database of record (Conductor's way)

This is what our teardown of Conductor.build found (verified first-hand against a live install, 2026-07-02 — see the Conductor teardown document in this report pack for full detail):

- Conductor runs a backend on **Fly.io** (a cloud hosting company) with an "encrypted Postgres database" — Postgres being the industry-standard database server — holding account data, organizations, and the cloud-workspace registry. **[verified]**
- That backend speaks **ElectricSQL**, a "sync engine" — software that automatically copies changes from a central database down to each user's device — so workspace data flows into a local database file on every Mac. **[verified from response headers; exactly what syncs is unverified]**
- The results are visible on disk: the local `conductor.db` file on the inspected machine holds **474,736 chat messages, of which 81,188 belong to cloud workspaces**, and the schema already carries collaboration plumbing — organization IDs, per-workspace permission levels, and a per-message `sender_id` (who said it). Shareable workspace/chat links shipped July 1, 2026. **[verified]**
- Awkwardly, Conductor's public docs *still* say "your chat history is saved locally… none of it is stored on our servers" — while the backend demonstrably runs a sync engine and server-side registry. A real docs-versus-product contradiction, worth remembering when writing Zeros' own privacy story. **[verified quote vs. verified infrastructure]**

**What Model A does well:** durability is free (a proper cloud database doesn't lose data), everything is readable even when a sandbox is asleep or deleted, and — in principle — it could sync *local* workspaces too, since the database of record doesn't care where the agent ran. It's the boring, well-trodden path.

**What it costs:** the vendor now holds every customer conversation on its servers, forever, which makes the privacy page harder to write and the **enterprise story harder** (the enterprise-readiness research in this pack found the key procurement question is "can the vendor see the payload?" — under Model A the answer is yes). There's an always-on cloud database bill that grows with usage. And every message takes a detour through the vendor's servers on its way between you and your agent. *(**Updated 2026-07-02:** Zeros now accepts these costs knowingly — the always-on database is cheap at our scale, and the privacy question gets answered openly instead of avoided. See "The decision" below.)*

### Model B: the workspace is the meeting point (the June plan)

From the internal plan (v2, 2026-06-24 — written before the 2026-07-02 decision):

- The **engine** — Zeros' brain, the program that runs agents, terminals, and git — lives inside the sandbox (a rented cloud computer created and destroyed in seconds). It owns `zeros.db`, the workspace's database file, right there on the sandbox's disk. One writer, sitting next to the agent.
- Every device and every teammate connects **directly to that same engine** over a secure WebSocket (a phone-line-style connection that stays open so both sides can talk instantly). Your MacBook, your Studio, and Sarah's Mac are just three windows onto one live process.
- A small **cloud registry** (Supabase — a hosted service bundling login and a Postgres database) stores only: who you are, which workspaces exist, who's a member, and where each sandbox lives. It's the front desk with the guest list. It never sees chat.
- Durability comes from **export blobs** — periodic photocopies of chat and artifacts pushed to cheap object storage (a digital storage unit, pennies per gigabyte) — plus the git remote for code.

This is a **validated, named industry pattern** called *session backends*. Figma — the collaborative design tool — spins up "a separate process for each multiplayer document which everyone editing that document connects to" **[verified, Figma engineering blog]**. Jamsocket productized the same idea (their Plane runtime "guarantees that only one process will be running for each key… allowing that process to act as an authoritative source of document state") **[verified]**. The design tool Rayon ships on it. And VS Code Live Share is the cautionary host-local variant: everything stays on the host's laptop, so the session dies when the host closes the lid. **Zeros' cloud engine is exactly "a Live Share host that never sleeps."** The live-engine half of the chosen architecture keeps all of this.

### Side by side

| | **Model A: central DB of record** | **Model B: workspace is the meeting point** | **Zeros' pick: live engine + cloud record** *(2026-07-02)* |
|---|---|---|---|
| Who holds the chat | Vendor's cloud database | The workspace's own engine + your exports | The engine holds the live working copy; **the cloud record keeps it permanently, in your account** |
| Cross-device sync (cloud workspaces) | Yes, via sync engine | Yes — both devices join the same engine | Yes — live windows join the engine; everything else syncs from the record |
| Cross-device sync (local workspaces) | Possible in principle (Conductor doesn't do it today) | **No — the old honest gap** | **Yes — local engines write through too** (fast-follow after v1, privacy opt-out) |
| Teammate live collaboration | Server must re-implement rooms/ordering | **Native** — everyone's already in the same room | **Native** — kept from Model B: everyone on the live wire |
| Durability | Free (real database) | Must be added (exports + journal) | **Free again** — the write-through record is a real database |
| Reading history when sandbox is asleep/deleted | Always readable | Needs wake-on-connect or read-from-last-export | **Always readable** — straight from the record |
| Privacy/enterprise story | Vendor sees all payloads | Vendor's cloud sees only the guest list | Stored **openly, in your account** — encrypted, exportable, deletable; enterprises host the record themselves (part 06) |
| Always-on cloud cost | Grows with every message | Tiny fixed registry; pay per live workspace | One always-on Postgres — $0 → $25/mo → ~$100–600/mo at 1k users; tiny vs sandbox compute |
| Precedents | Slack, Linear, Conductor | Figma multiplayer, Jamsocket/Plane, Rayon | Figma's real shape (live process + central Postgres) — and Conductor's database direction |

The research consensus was already that **hybrid is the norm**: nobody serious runs "engine-owned only." Figma keeps the live document in the per-document process but keeps users, teams, and permissions in central Postgres. The June plan matched half of that norm (live state in the engine, registry in Supabase, snapshots in object storage); the 2026-07-02 decision completes it — **live state in the engine, durable truth in the cloud record, code in git.**

---

## The decision: live engine + cloud record *(decided 2026-07-02)*

**Updated 2026-07-02:** this page previously concluded "Keep Model B — no architectural rethink needed." The founder decided otherwise: Zeros adopts the cloud record — Conductor's direction on the database — while keeping the live engine and the direct connection that made Model B attractive in the first place.

The analogy that runs through this whole report pack: **the sandbox is the workbench, the cloud record is the filing cabinet, GitHub is the vault** (for code). Workbenches get cleared; the filing cabinet doesn't.

How the pieces fit:

- **The live engine stays the realtime hub** (Model B's good part). While a workspace runs, every open window connects directly to the engine over the live wire — no broker, no detour through Zeros' servers on the live path. Same instant streaming, same one-referee ordering, same natively-shared room for teammates. Nothing changes about the live experience.
- **The engine writes through to the record** (the new part). Every chat/session/state event streams to the cloud record near-real-time, keyed by the same sequence numbers as the live stream. The in-sandbox `zeros.db` becomes the working copy; the cloud record is the permanent one.
- **Off the live wire, you read the record** (Model A's good part). Devices and teammates not connected to a live engine get everything — full history, asleep workspaces, long-deleted workspaces — from the record via realtime sync. ElectricSQL (the sync engine Conductor uses; it runs on any Postgres, so it doesn't lock the database host) is the named spike candidate for that layer; Supabase Realtime is the simpler starter.
- **Restore is rehydration.** A new or woken sandbox pulls code from git and chat/state from the record, and picks up where the old one stopped. Sandboxes can now be **deleted** aggressively — not merely put to sleep — with zero data loss, which makes the sleep-when-idle cost lever from part 04 stronger, not weaker.
- **Exports demote to backup.** A cheap periodic export to object storage can remain as a belt-and-braces safety net, but the record — a real database — is the durability story.

**The privacy story, stated openly.** Conductor's public docs still claim "none of it is stored on our servers" while their backend demonstrably syncs chat through a cloud Postgres. Zeros will not play that game: **yes, Zeros stores your chats and history — in your account, in our cloud. That is the feature** ("your work is always in your account"). Encrypted at rest, exportable, deletable on demand. And for companies that can't allow any vendor cloud, the enterprise plan (part 06) runs the same record on **their** servers.

**The cost, stated openly.** The always-on database is cheap at Zeros' scale: Supabase's free tier to start, $25/mo Pro, roughly $100–600/mo at a thousand users — negligible next to sandbox compute. The real cost is engineering: the write-through and sync layer are ~2–4 extra weeks versus the June plan, moving the v1 estimate to **~3.5–6 months** from the Phase 1 spike.

---

## How the three promises actually get delivered

### Promise 1: two Macs, one login

What you experience: open Zeros on a second Mac, sign in, everything's there.

Behind the scenes: signing in (Supabase Auth) gives that Mac an identity token. The app asks the cloud "which workspaces can this person enter?" — the registry answers with the list, and **the cloud record supplies every conversation in it**, so history is readable before any sandbox is touched. Click a *running* workspace and the registry mints a short-lived key card; the Mac dials the sandbox directly over the live wire and joins the live stream. Click an *asleep* one and you're reading from the record until it wakes.

The magic ingredient is the **resumable stream**: the engine numbers every chat event with a simple increasing counter (1, 2, 3…), and every device remembers the last number it saw. On connect, a device says *"give me everything after 41,207"* — the engine replays the gap, then streams live. This one primitive delivers reconnect after lid-close, second-device catch-up, *and* a teammate joining mid-turn. It is the verified 2025–26 industry standard for AI chat: ElectricSQL shipped it as an open protocol ("Durable Streams," Dec 9, 2025, explicitly pitched for LLM token streaming), and Ably's engineering writeups describe the identical design — decouple the agent's output from any one screen's connection, buffer server-side, replay on reconnect. Zeros gets the "decouple" part for free by construction: the engine keeps running in the sandbox whether or not any Mac is connected. **And since 2026-07-02 the same primitive does double duty upward**: the engine pushes "everything after №X" to the cloud record exactly the way a reconnecting Mac pulls it down — one numbering scheme end to end, so device catch-up, teammate join, and the record's write-through are one mechanism, not three.

### Promise 2: Sarah joins

What you experience: you invite Sarah; she opens the workspace; you both chat with the agent; you see "Sarah is here."

Behind the scenes, four small pieces:

- **Membership** lives in the registry (a `workspace_members` table: who, which workspace, what role). It *cannot* live in the engine — a workspace you can't discover or get authorized into is useless, and the engine can't vouch for strangers by itself. Every precedent (including Figma) keeps membership in central Postgres.
- **The key card**: the registry mints a short-lived token asserting *{Sarah, this workspace, Member}*; the engine checks it at the door and scopes what she can do. Short-lived matters because a shared sandbox is a shared room — you never bake long-lived secrets into it.
- **Authorship is server-stamped**: the *engine* writes "from: Sarah" on each message based on her authenticated connection — clients don't get to claim who they are. That's what makes attribution trustworthy.
- **Presence** ("Sarah is here", "Sarah is typing") is just an in-memory list in the engine, broadcast over the connections that already exist, forgotten after ~30 seconds of silence. Figma does presence exactly this way. It's deliberately *not* stored anywhere — presence is a fact about right now.

One addition since the 2026-07-02 decision: when Sarah accepts the invite, **the cloud record already gives her the workspace's full history to read** (membership-gated); the live wire adds the present tense — the streaming turn, presence, typing.

Worth knowing: the cross-industry survey in this pack found that **nobody has shipped real-time multiplayer agent chat yet** — Amp shares threads with the team, Anthropic's Claude sessions have view-only share links, Conductor's multiplayer chat is still founder speculation on a podcast (June 2026). Zeros' live engine makes it nearly free (everyone is already connected to the same room), and the cloud record hands a joining teammate the backstory. This is open ground.

### Promise 3: history outlives the sandbox

The engine's database lives on a disposable computer — so the question is where the permanent copy lives.

**Updated 2026-07-02:** the June plan answered with export blobs at lifecycle moments, and this research originally recommended adding a Figma-style journal beside them. That recommendation is **absorbed**: the write-through stream to the cloud record *is* the journal, and the record — not blobs — is chat's permanent home. Upgraded from "lose seconds, not hours" to **"lose ~nothing, forever."**

The chosen design: **code goes to the git remote** (the vault — already durable); **every chat/session event streams into the cloud record** within moments of happening, keyed by the same sequence numbers as the live stream. The in-sandbox `zeros.db` is just the working copy.

Figma's published durability playbook validates the shape, with numbers **[verified, Figma engineering blog]**: they checkpoint each document to storage every 30–60 seconds *plus* keep a running **journal** — a cheap append-only list of every small change, keyed by the same sequence numbers — between checkpoints. Result: 95% of edits durable within 600 ms, crash data-loss window under 1 second, at 2.2 billion changes/day. The write-through is that journal taken to its conclusion: instead of flushing to blob files beside periodic exports, events flow straight into a real database. Chat is low-volume, so streaming it costs pennies. Recovery = rehydrate code from git + chat/state from the record; a brand-new sandbox picks up exactly where the dead one stopped. (A cheap nightly export to object storage can stay as a belt-and-braces backup; it is no longer the durability story.)

---

## Why chat does NOT need a CRDT

A **CRDT** (conflict-free replicated data type) is a special data structure that lets many people edit the same thing simultaneously *without a referee*, merging everyone's changes automatically. It's clever, heavy, and famous — and the biggest names in collaboration deliberately avoid it where a referee exists:

- **Figma** explicitly rejected both CRDTs and OT (operational transforms, the older Google-Docs-era technique): the server is "the central authority," and last-writer-wins per property is "faster and leaner." **[verified]**
- **Linear** syncs an entire product with a single increasing counter (`lastSyncId`) and zero CRDTs. **[verified via CTO-endorsed reverse engineering]**
- **Slack** orders every channel's messages through one stateful server process per channel. **[likely — Slack engineering blog]**
- Convex's engineers put the principle bluntly: "anything less than serializability is way too hard of a programming model." **[verified]**

The rule of thumb: CRDTs earn their complexity only when **no single ordering authority exists**. Zeros' one-engine-per-workspace *is* that authority. Chat is an append-only, server-ordered log — sequence numbers, one writer, done. The cloud record changes nothing here: it sits *downstream* of the referee, storing what the engine already ordered — it never merges concurrent edits. The only future Zeros surface where CRDT-class tech plausibly enters is the **design canvas** (Phase 9, planned as Yjs — the most production-adopted CRDT library — with the authoritative copy still held in the engine), and even there Figma's simpler property-level last-writer-wins through the single engine should be tried first.

---

## What v1 ships vs. what comes later

Per the internal plan (v2, 2026-06-24) — which predates the 2026-07-02 decision. Phase 7 below is re-scoped accordingly; the plan's v3 revision shipped 2026-07-03 as part 08:

| Stage | What the user gets | The work |
|---|---|---|
| **v1 GA (Phases 0–7)** | *Single-user* cloud workspace that feels local; laptop-lid-close survival; **every chat permanently in your account — the cloud record** | CloudTransport (the live wire's plumbing), engine-in-sandbox, file mirror, registry, sleep/wake, **cloud record schema + write-through & restore** (Phase 7, re-scoped from "durability exports," 2026-07-02). Phase 0 done (2026-06-25); Phase 1 built & merged (2026-06-25), its exit run awaiting a Daytona API key |
| **Fast-follow after v1** | **Local workspaces in your account too** — chats from this Mac readable on your other Macs, with a per-workspace privacy opt-out ("keep this on this Mac only") | The local engine reuses the same write-through client the cloud engine ships with |
| **Phase 8 — Collaboration** | Two Macs and teammates in one workspace: shared live chat, correct name on every message, presence — riding **the record** (history, membership) + **the live wire** (realtime) | Per-user identity on the connection (Supabase JWT — a signed proof-of-login the engine can verify), membership + roles, server-stamped `author_user_id`, presence map, **the renderer live-delta fix**, then soft-lock editing |
| **Phase 9 — Design canvas** | Two people co-editing a visual canvas with live cursors | Yjs + Hocuspocus (an open-source Yjs server), authoritative document in the engine |

Timeline honesty: the write-through and sync layer add **~2–4 weeks** versus the June plan; v1 now ≈ **3.5–6 months** from the Phase 1 spike.

Two items in Phase 8 deserve plain-English footnotes:

- **The renderer live-delta fix**: the engine and transport already sync chat correctly (an earlier "chat sync isn't built" worry turned out stale — the codebase audit confirmed it works). The remaining gap is in the Mac app's display layer: live updates for a chat you don't currently have open are silently ignored. Fine solo — you were the one typing — but with a teammate, chats must update in the background. Known, scoped, on the Phase 8 list.
- **Soft-lock code editing**: rather than letting two people type into the same file simultaneously (which *would* need Yjs-class machinery), v1 collaboration shows "Sarah is editing this file" and gently holds others off. Cheap, predictable, and matches how teammates actually behave. Lossless co-typing only gets built if users demand it.

Also honest: multi-client WSS (several Macs on one sandbox connection URL) is on the pre-Phase-8 load-test checklist — believed fine, **needs-testing**.

---

## The old honest gap: local workspaces — solved by design

In pure Model B, sync happens because everyone connects to the same cloud engine. A **local** workspace's engine runs on one Mac — so its chats lived on that Mac, full stop. That was this page's honest gap, and the reasoning is worth keeping on the record.

**Conductor, notably, still has this gap today**: their docs tell users moving machines to use Apple's Migration Assistant or manually copy the application-support folder **[verified]** — a central cloud database *enables* local-workspace sync in principle, but even the reference competitor hasn't shipped it.

The June analysis weighed three options:

1. **Accept it and message it.** "Cloud workspaces follow you everywhere; local workspaces live on this Mac" — clean, honest, a natural upsell. Cost: zero. *(The June recommendation for v1.)*
2. **Export-based lightweight sync.** Local engines periodically push chat exports to the user's cloud storage; other devices show that history read-only. Cost: small. *(The June fast-follow.)*
3. **A cloud DB of record.** Adopt a real sync engine (Rocicorp Zero 1.0, June 8 2026; ElectricSQL; PowerSync) for chat history across all workspace types. Cost: a whole new subsystem — and it reopens the "vendor holds the data" question. *(The June verdict: only if users demonstrably demand it.)*

**Updated 2026-07-02: the founder chose option 3's mechanism — the cloud record — for reasons bigger than this gap.** Durability, cross-device sync, and teams all want the same record, and once it exists, closing the local-workspace gap is a side effect: the local engine runs the same write-through as the cloud engine (a fast-follow after v1). Two honest notes survive:

- **Sequencing**: cloud workspaces get the write-through first (it's v1's durability spine); local write-through is the fast-follow. So the v1 pitch remains "cloud = synced," upgrading fast to **"everything in your account — cloud first, local fast-follow."**
- **Privacy**: the question option 3 reopened is answered head-on rather than avoided — a per-workspace opt-out for local workspaces ("keep this on this Mac only"), everything encrypted at rest, exportable, deletable on demand, and enterprises can host the record on their own servers (part 06).

---

## Identity, membership, and roles

- **Auth: stay on Supabase.** Free to 50,000 monthly active users; the $25/mo Pro tier includes 100,000 (then $0.00325 per user) — effectively free at Zeros' scale, and it double-serves as the registry database and a broadcast channel. **[verified pricing, 2026-07]** Since 2026-07-02 this recommendation is stronger, not weaker: the same Postgres is the natural first host for **the cloud record** itself — load-bearing, not merely convenient.
- **Roles: copy Linear's minimalism.** Admin and Member (add Guest for external collaborators later). Workspaces are **private by default to their members** — access by containment, not a permissions matrix. Slack, Notion, and Linear all converged on tiny role lists. Enforcement: the registry mints a token asserting *{user, workspace, role}*; the engine validates and scopes capabilities (Guest = read-only chat tail).
- **Registry change notifications**: Supabase Realtime can nudge clients ("workspace renamed," "member added"), but its own docs say "the server does not guarantee that every message will be delivered" — so the pattern is *database is the record, broadcast is a hint, client refetches*. Never lean on it for chat. Chat's cross-device sync is the one place that needs more than hints — that's the record's sync layer: **ElectricSQL** (Conductor-proven; runs on any Postgres, so it doesn't lock the host) is the named spike candidate, **Supabase Realtime** the simpler starter.
- **Shared secrets, short-lived**: anything injected into a shared sandbox (agent API keys, GitHub access) is readable by everyone in the room, including the agent — so use short-lived scoped tokens (e.g., Zeros GitHub App installation tokens that expire in 1 hour), never long-lived personal credentials.
- **Enterprise, later**: when the first "we need Okta" deal appears, bolt WorkOS on top for SSO/SCIM at $125 per enterprise connection per month — designed to layer onto an existing identity stack, cost aligned with closed deals. Don't rebuild identity for a hypothetical.

---

## What this means for Zeros

1. **Adopt "live engine + cloud record" (decided 2026-07-02).** *This item previously read "Keep Model B — no architectural rethink needed"; the founder decided otherwise.* The cloud record is the source of durable truth, cross-device sync, and discovery; the live engine keeps everything that made Model B attractive — the direct connection with no broker on the live path, native teammate collaboration, one referee for message order. Conductor's database direction; Zeros' live path.
2. **Build `subscribe(after_seq)` into the WSS protocol now** (Phase 2, not Phase 8). Per-workspace sequence numbers on every chat event; consumers remember their last number. The one primitive now serves four masters: reconnect, cross-device catch-up, teammate live-tail, and **the record's write-through + catch-up**.
3. **The chat-journal recommendation is absorbed (2026-07-02).** *Previously: "add the Figma journal next to the export blobs."* The write-through stream to the cloud record IS the journal — upgraded from "lose at most a few seconds" to "lose ~nothing, forever." A cheap periodic export stays as a backup safety net, not the durability story.
4. **Chat gets no CRDT — ever.** Server-ordered log, server-stamped authorship, client-generated message IDs for safe retries; the record stores what the engine ordered and never referees. Soft-lock for code editing. Yjs only for the Phase 9 canvas, and try engine-mediated last-writer-wins first.
5. **Keep identity and membership on Supabase, and keep the registry thin** (users, orgs, workspaces, members, sandbox pointers, token minting). Linear-minimal roles. Broadcast as hint, database as record. Presence lives in the engine, never persisted. New since the decision: the same Supabase Postgres is the record's natural first host, with ElectricSQL the sync-layer spike candidate.
6. **Retire the local-workspace gap.** *Previously: "own the gap in the product story."* v1 still pitches "cloud workspaces sync everywhere"; the local write-through fast-follow (with privacy opt-out) upgrades the line to "everything in your account — cloud first, local fast-follow."
7. **Move fast on multiplayer chat.** Nobody — not Conductor, not Anthropic, not Amp — has shipped live multi-person agent chat as of July 2026. The chosen architecture makes it even cheaper than before: the record hands a joining teammate the backstory; the live wire hands them the present. Gated mainly by the Phase 8 identity work and one renderer fix.

---

## Sources

- https://www.figma.com/blog/how-figmas-multiplayer-technology-works/ — process-per-document, LWW, CRDT/OT rejection
- https://www.figma.com/blog/making-multiplayer-more-reliable/ — checkpoints + journal, 600 ms / 95% durability numbers
- https://github.com/wzhudev/reverse-linear-sync-engine — Linear sync mechanics (CTO-endorsed)
- https://github.com/jamsocket/plane — session backends, one-process-per-key guarantee
- https://electric.ax/blog/2025/12/09/announcing-durable-streams — resumable-stream protocol for AI chat
- https://ably.com/blog/token-streaming-for-ai-ux — decouple generation from delivery, buffer + replay
- https://stack.convex.dev/object-sync-engine — serializability argument, sync-engine design space
- https://slack.engineering/real-time-messaging/ — Slack channel-server architecture
- https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/connectivity — Live Share host-owned model
- https://workos.com/blog/multi-tenant-permissions-slack-notion-linear — roles/membership patterns
- https://supabase.com/pricing and https://supabase.com/docs/guides/realtime/limits — Supabase Auth/Realtime pricing and delivery caveats
- https://workos.com/pricing — SSO/SCIM per-connection pricing
- https://clerk.com/pricing — Clerk alternative pricing
- https://www.infoq.com/news/2026/06/zero-version-1/ — Rocicorp Zero 1.0 (June 8, 2026)
- https://vercel.com/blog/how-conductor-moved-parallel-coding-agents-from-the-laptop-to-the-cloud-with-vercel-sandbox — Conductor Cloud on Vercel Sandbox (May 27, 2026)
- https://www.conductor.build/changelog and https://www.conductor.build/docs/reference/privacy — share links (0.71.0, Jul 1, 2026); "none of it is stored on our servers" claim
- First-hand teardown of a live Conductor install (2026-07-02): conductor.db schema/queries, api.conductor.build ElectricSQL headers, WorkOS DNS — see the Conductor teardown document in this report pack
- Internal: the Zeros engineering plan (v2, 2026-06-24) — two-plane architecture, phases, collaboration decisions — consolidated into [08-engineering-reference.md](08-engineering-reference.md) (2026-07-03); original removed. The June v2 predated the 2026-07-02 decision (cloud record, Phase 7 re-scope); the v3 applies it.
- Internal: founder decision update (2026-07-02) — adopts "live engine + cloud record" and the enterprise self-hosting commitment; supersedes this page's original Model B verdict.
