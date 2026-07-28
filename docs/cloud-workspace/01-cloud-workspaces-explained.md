# Cloud Workspaces, Explained

*Part 01 of the Zeros Cloud Workspaces Report · July 2026*

## The short version

- **A cloud workspace is a normal Zeros workspace whose computer lives in a data center instead of under your keyboard.** Same app, same chat, same files, same agents — the work just happens on a rented machine that never sleeps when you do.
- **The whole Zeros "brain" moves into that rented machine.** Roughly 80% of our existing code runs there unchanged (verified in our engineering audit), which is why this is an extension of the product, not a rewrite.
- **Your Mac talks to it over one secure, always-open connection** — like a phone line the app keeps off the hook — and keeps a live local copy of the files so editing feels instant even when the machine is 130 milliseconds away.
- **Close the laptop; the agents keep going.** Open Zeros on any Mac later and the workspace, the chat, and the code are all exactly where you left them.
- **A sleeping workspace costs almost nothing** — about $0.001/hour stopped vs ~$0.17/hour running on Daytona (as of mid-2026). Sleep-when-idle is the difference between ~$1.5k/month and ~$12k/month at 100 workspaces — an ~8x cost lever.
- **Nothing irreplaceable lives only in the rented machine.** Code goes to GitHub (the vault); chats, sessions, and workspace history stream to **the cloud record** — our cloud database that permanently stores them in your account (decided 2026-07-02). A periodic export to cheap storage remains as a backup safety net. The machine itself is disposable by design — it can even be deleted outright with zero data loss.
- **This is the same architecture our reference competitor shipped.** Conductor.build's Cloud Workspaces (announced May 2026, still invite-only) run the same shape — hosted sandbox, direct connection from the Mac app, local file mirror — and their CEO's pitch is literally "users can't tell the difference between local and cloud." (Verified via Vercel's own case study.)
- **Where we differ, we differ on purpose:** the connection is direct (no broker of ours on the data path), and the *live* chat stays with the engine in the cloud — which makes teammates-in-one-workspace a natural next step instead of a bolt-on. On the database itself we now go Conductor's way: the cloud record is chat's permanent home.

---

## Local vs cloud: what stays the same, what changes

Today, when you create a workspace in Zeros, everything — the code checkout, the agents, the terminal, the chat history — runs and lives on your Mac. A **cloud workspace** keeps the exact same experience but moves the computer.

| | Local workspace (today) | Cloud workspace |
|---|---|---|
| Where the code runs | Your Mac | A rented computer in a US or EU data center |
| Where the agents run | Your Mac (eats your battery and RAM) | The rented computer |
| Where the chat lives | On your Mac | Working copy with the engine; permanent copy in the cloud record (your account) |
| What happens when you close the laptop | Everything stops | Agents keep working |
| Opening from a second Mac | Not possible | Same workspace, same state |
| Sharing with a teammate | Not possible | Designed-in (a later phase) |
| How editing files feels | Instant (they're local) | Still instant — a synced local copy |
| The app you use | Zeros | Zeros — same window, same UI |

The design goal, stated plainly: **you should not be able to tell where a workspace lives except by the badge on it.** That's not just our ambition — it's the exact claim Conductor's CEO makes about their cloud product, and it's achievable because of two tricks explained below (the file mirror and the persistent connection).

---

## A day in the life

Here's the whole product in one story. The *what you see* comes first; the *what actually happened* follows in plain words.

**9:04 AM — You open Zeros on your Mac** and hit "New Workspace," but this time you pick **Cloud**. You choose the repo. A few seconds later the workspace is open and ready — file tree on the left, chat in the middle, terminal at the bottom. It looks identical to every local workspace you've ever made.

> *Behind the scenes:* Zeros asked our small backend ("the reception desk" — more on it later) to create a **sandbox** — a rented computer in a data center that can be created and thrown away in seconds. The sandbox didn't start from a blank disk: it started from a **pre-baked image** with everything Zeros needs already installed, which is why it took seconds and not the ten minutes a fresh laptop setup would. The Zeros engine booted inside it, cloned your repo from GitHub, and your Mac dialed a **secure WebSocket** — a phone line between two computers that stays open so either side can speak instantly — straight to the sandbox.

**9:10 AM — You kick off three agents.** Claude Code takes a gnarly refactor, Codex picks up a bug from yesterday, a third agent starts writing tests. You watch tokens stream into three chats at once. Your Mac's fan never spins up, because your Mac isn't doing the work — it's just displaying it.

**11:30 AM — You open a file the refactor agent just touched.** It opens instantly, like any local file. You skim the diff, leave the agent a follow-up message.

> *Behind the scenes:* the file genuinely *was* local. Zeros keeps a **mirror** — a continuously synced copy of the workspace's files in a folder on your Mac, kept in step both ways by a sync tool called **Mutagen**. When the agent edits a file in the cloud, the change lands in your local copy within about a second; when you edit locally, it flows back up. Your editor never waits on the network.

**12:30 PM — You close the laptop and go to lunch.** No "are you sure?" dialog. Nothing to save.

> *Behind the scenes:* the phone line from your Mac hung up, and nothing else changed. The engine and the agents live in the sandbox, not in the app — the app is just a window onto them. The refactor agent keeps chewing through files with nobody watching.

**3:00 PM — At the studio, you open Zeros on a different Mac.** The cloud workspace is right there in your sidebar. You click it: the full morning's chat history, the agents' progress, the new diffs — everything present, mid-sentence. You steer the refactor in a new direction and head into a meeting.

> *Behind the scenes:* your account's workspace list lives in the reception-desk database, so any Mac you sign into sees the same list. Clicking the workspace opened a fresh phone line to the same sandbox, and because **the chat database lives with the engine in the sandbox** (not on your first Mac), there was nothing to transfer — the second Mac just subscribed to the same source of truth. This is the deliberate difference from Conductor, whose chat still lands in a database on each individual Mac (verified by inspecting a live install).

**7:00 PM — You review, merge a PR, and stop for the day.** An hour after the last agent finishes and you go quiet, the workspace **goes to sleep** on its own.

> *Behind the scenes:* the engine noticed both conditions were true — no agent running, no user active for 60 minutes — and told the sandbox to stop. Its disk is kept; its billing drops from ~$0.17/hour to ~$0.001/hour (Daytona rates, mid-2026). Crucially, the *engine* decides when to sleep, never the hosting provider's own idle timer — because that timer can't see a running agent and would kill it mid-task. (This is a documented Daytona behavior and the #1 correctness trap we've designed around.)

**8:56 AM the next day — you open the workspace again.** It takes a breath — a cold start we still need to measure, our budget is a few seconds — and everything is back: chat, files, branches.

> *Behind the scenes:* the sandbox restarted from its kept disk, the engine booted and rehydrated from its database and git, your Mac re-dialed, and the file mirror re-checked itself so no overnight edits get lost or resurrected. Wake-up latency is one of the top items on our hands-on test checklist — **needs-testing**, not yet measured. (And had the sandbox been deleted outright instead of stopped, Zeros would simply create a fresh one and rehydrate code from git and chat from the cloud record.)

**Three months later — the project shipped, the workspace archived, the sandbox deleted.** You want to reread how the refactor agent solved that migration. You search your history in Zeros and the whole conversation is right there — every workspace, every session, still in your account.

> *Behind the scenes:* all along, the engine was **writing every chat and session event through to the cloud record** as it happened (decided 2026-07-02). The sandbox's own database was only the working copy; the record is the permanent one. The workbench is long cleared; the filing cabinet keeps the files.

---

## The concepts, one at a time

Every term below is anchored to something you'd actually notice as a user.

### The sandbox — the rented computer

A **sandbox** is a computer in a data center that can be created in seconds, used like any Linux machine, stopped, restarted, or thrown away. Think of it as a **hotel room for your project**: furnished, ready on arrival, cleaned up when you check out, and you only pay while you're actually in it. Our current provider is **Daytona**, a company that rents exactly these (a typical Zeros box: 2 CPUs, 4 GB memory ≈ $0.167/hour running — verified pricing, mid-2026). The provider is deliberately swappable behind an interface; Fly.io is the researched fallback (see the platform comparison document in this pack).

### Image / snapshot — the pre-baked setup

An **image** is a saved template of a fully set-up computer — like a **cake mix instead of raw ingredients**. We bake one image containing everything a Zeros workspace needs (the engine runtime, the three agent CLIs, git, the sync agent), and every new sandbox starts from it. A **snapshot** is the same idea applied to a machine that's already been used: a saved copy of its disk. This is why creating a workspace takes seconds, not minutes. Related term you'll hear: a **warm pool** — providers keep a few pre-started machines matching your image idling at the curb, like a valet who already brought the car around; on an exact match Daytona quotes creation as fast as ~90 milliseconds (**likely** — provider claim plus third-party benchmarks; our own numbers pending the spike).

### The Zeros engine — the brain that moves

The **engine** is the part of Zeros that does the actual work: runs agents, manages git, executes terminal commands, owns the chat. Today it runs invisibly inside the app on your Mac. For a cloud workspace, **the same engine runs inside the sandbox instead** — audited at roughly 80% code reuse (verified, file-by-file). The Mac app becomes a thin window onto a brain that lives elsewhere. This is why closing the laptop changes nothing: you closed the window, not the brain.

### The WebSocket bridge (CloudTransport) — the phone line

A **WebSocket** is a network connection that opens once and then stays open, so both sides can send messages instantly at any time — a phone line off the hook, versus mailing letters (ordinary web requests). Our implementation is called **CloudTransport**: the Mac app dials the sandbox's **preview URL** (a public web address every Daytona sandbox gets) over **WSS** (the encrypted version of WebSocket), presenting a **per-user token** — a signed digital pass proving who you are — before anything flows. Elsewhere in this pack this direct connection is also called **the live wire** — worth keeping distinct from the cloud record: the live wire carries a running workspace's traffic; the record permanently keeps its history.

One deliberate choice worth understanding: **the connection is direct**. Your Mac talks straight to your sandbox; our servers are not in the middle relaying your code and chat. Conductor routes through their broker server; we don't, which means less latency, less infrastructure for us to keep up at 3 AM, and less of your data passing through us. Daytona explicitly documents WebSocket support through its preview URLs (verified in their docs) — though a long-running soak test is the first thing our Phase 1 spike will confirm (**needs-testing**).

### The two-plane architecture — files and chat travel differently

This is the heart of the design. A workspace's data splits into two "planes" that move by different rules, because they have opposite needs.

**Plane 1: Files — a local mirror, for speed.** Code files are big, touched constantly, and you feel every millisecond of lag when scrolling or diffing them. So we don't read them over the network at all: **Mutagen** (an open-source file synchronizer) keeps a complete copy of the working files on your Mac, updated both directions within about a second. Think **shared Dropbox folder, but for one project and near-instant**. Why it matters: our sandboxes run in US/EU data centers only (as of mid-2026), and a user in India is ~130 milliseconds away — round-trip — from the EU. Reading every file over that hop would make the editor feel like typing through molasses. The mirror hides the distance entirely; only the agent, terminal, builds, and tests run remotely, where the latency never reaches your fingers. (Conductor proved this trick in production with a homegrown version; we adopt it with an off-the-shelf tool. Mutagen-inside-Daytona is on our test checklist — **needs-testing**.)

**Plane 2: Chat and workspace state — the engine is the live hub; the cloud record is the permanent home.** The chat history, agent sessions, and workspace metadata live in **zeros.db** — a small database file — *inside the sandbox, owned by the engine*. And as of the 2026-07-02 decision, the engine **writes every chat and session event through to the cloud record** in near-real-time — so the sandbox's copy is the working copy, and the record is the permanent one. Chat is tiny and doesn't mind 130 ms, so there's no speed reason to copy it locally. Keeping the one *live* copy with the engine buys us something big later: when two people open the same workspace, they're just **two phone lines into the same brain**, both seeing the same chat, live — like a shared Google Doc, where the document has exactly one live home and everyone's screen is a view of it. No merge conflicts to resolve. Conductor made the opposite choice on the live path (chat lands in a local database on each Mac) and is now retrofitting collaboration through their servers; ours falls out of the architecture. Industry research backs this pattern — Figma runs one server process per document for the same reason (see the sync-and-collaboration document in this pack). And when you're *not* connected to a live engine — the workspace is asleep, or deleted — you read the same history straight from the cloud record.

### The control plane — the reception desk

The **control plane** is a small, boring backend whose only jobs are: know who you are (login), know which workspaces exist and who may enter them (the registry), and hold the master key that creates sandboxes (the provider API key, which must never live in the app on your Mac). Think of it as the **hotel reception desk**: it checks you in and hands you the room key, but it does not stand in your room while you work. It is never on the data path — if the reception desk goes down, existing workspaces keep working; you just can't create new ones for a while. Current plan: **Supabase** (a hosted login-plus-database service) for auth and the registry, plus a thin worker holding the Daytona key. The founder question of Supabase vs Railway vs Fly for this piece is exactly the subject of the platform comparison document — short preview: the research favors keeping Supabase for auth/registry and treating Railway as, at most, a home for the thin worker. One addition since the 2026-07-02 decision: the same Supabase Postgres also hosts **the cloud record** — that part *is* a durable home for your data (chat and history), but it still sits off the live path between your Mac and your sandbox.

### Idle / sleep / wake — why a parked workspace costs ~nothing

A running 2-CPU sandbox costs ~$0.167/hour — about **$120/month if left on 24/7**. A **stopped** one keeps its disk but releases the computer: ~$0.001/hour, well under $1/month (verified Daytona pricing, mid-2026). So the engine plays a disciplined parking valet: awake while an agent is running *or* you've been active in the last 60 minutes; asleep otherwise; never, ever asleep mid-agent-run. At fleet scale the math is the entire business model: **100 workspaces at ~3 active hours/day ≈ $1.5k/month with sleep-when-idle, vs ~$12k/month always-on — roughly 8x**. Every serious competitor implements some version of this (Fly's Sprites "cost practically nothing while asleep"; Factory's Droid machines auto-pause; Devin auto-sleeps), because at these prices nothing else works.

One honest caveat: waking is a **cold boot** — Daytona's stop is a full power-off, not a memory freeze — so the engine restarts and rehydrates from disk on every wake. Our engine already knows how to do that (it's how the app launches today), but wake latency is unpublished by Daytona and unmeasured by us (**needs-testing**; it gates our Phase 5).

### Durability — the sandbox is disposable on purpose

> **Decision update — 2026-07-02.** An earlier version of this section made periodic export blobs to object storage the permanent home of chat — and explicitly rejected a permanently-running cloud database as over-engineering. The founder has decided otherwise: we adopt **the cloud record** (Conductor's direction) — our cloud database that permanently stores your chats, sessions, and workspace history in your account. Why: sandboxes are disposable by design and can't be the long-term home of your data; cross-device sync and shared team workspaces need a server-side record anyway; and an always-on database is cheap at our scale (free tier → ~$25/month early on, ~$100–600/month at a thousand users — negligible next to sandbox compute). The honest cost is engineering: the write-through sync layer adds roughly 2–4 weeks to the plan. Exports remain as a backup safety net only. The text below reflects the new decision.

Rule: **nothing irreplaceable lives only in the sandbox.** Picture three homes. The sandbox is the **workbench** — disposable on purpose; it can be stopped, wiped, or now even deleted outright. **GitHub is the vault**: code is continuously pushed to your **git remote**, as before. And **the cloud record is the filing cabinet**: as you work, the engine streams every chat message, agent session, and state change into it, near-real-time, so your history stays permanently in your account — retrievable anytime, even years later, even if every sandbox is gone. Workbenches get cleared; the filing cabinet doesn't. If a sandbox is deleted, corrupted, or the provider has a bad day, a fresh one rehydrates code from git and chat from the record — you lose ~nothing. (This also makes the sleep economics *stronger*: sandboxes can be deleted aggressively, not just stopped.) A periodic **export blob** — a cheap compressed copy dropped into object storage (think **a storage unit for files: pennies per gigabyte, boring, reliable**) — remains as a backup safety net, and it keeps us provider-independent: the export is readable anywhere, so switching vendors is a migration, not a hostage negotiation.

One thing said openly: unlike Conductor's public "none of it is stored on our servers" claim, Zeros *does* store your chat and history in your account in our cloud — that is the feature ("your work is always in your account"). It's encrypted at rest, exportable, and deletable on demand; and for companies that can't allow it, the enterprise plan runs the record on *their* servers instead (see the enterprise self-hosting document in this pack).

### Warm pools — near-instant creation, when we want it

Covered above under images, but worth its own line because it shapes first impressions: because every workspace starts from the same baked image, providers can keep pre-warmed machines ready, making "New cloud workspace" feel closer to opening a tab than provisioning a server. Sub-second creation is a provider claim we'll validate in the spike (**likely, needs-testing**).

---

## Why this matters — the four payoffs

1. **Agents keep working with the laptop closed.** The single most requested behavior in this category, and the one thing local execution can never do. Every major AI-coding vendor shipped a version of it in the last year (Anthropic, OpenAI, Cursor, Google) — but almost all of them ship *throwaway task boxes* that produce a PR and vanish. Zeros (like Conductor, Devin, and Factory) is in the rarer **persistent workspace** camp: a place you return to, not a task you fire off.
2. **Run 10 agents without melting your Mac.** Agents are hungry — parallel local agents mean fans, heat, and a swap-thrashed laptop. In the cloud each workspace has its own dedicated machine, and your Mac only renders text.
3. **Same work from any device.** Because the workspace's brain and memory live in the cloud, any signed-in Mac is an equal window onto it. (Longer-term this is also the path to a phone check-in experience — the 2026 table stakes across the industry are "monitor and nudge from mobile," not a full IDE.)
4. **Teammates in one workspace.** The engine-owned chat database makes shared workspaces a natural extension: N people are N authenticated connections to one engine that already broadcasts every update to every connected client. Notably, *nobody* in the market has real-time collaborative agent chat yet — Conductor's is quiet plumbing plus share links, Claude's session sharing is read-only snapshots. This is genuinely open ground (see the landscape survey in this pack).

---

## What this means for Zeros

Concrete takeaways, in decision language:

- **The architecture is sound and market-validated.** Conductor shipped the same shape (hosted sandbox + direct Mac-to-sandbox WebSocket + local file mirror) on Vercel Sandbox and users reportedly can't tell cloud from local. We are not inventing an unproven pattern; we're executing a proven one with two deliberate improvements (direct connection with no broker on the data path; engine-owned chat for native collaboration).
- **Sleep-when-idle is the business.** ~8x cost difference at fleet scale. The engine-owned idle controller (never sleep mid-agent-run, `autoStopInterval: 0` on the provider side) is a correctness requirement, not an optimization — treat Phase 5 as launch-blocking.
- **Durability discipline is what makes the disposable-sandbox model safe.** Git remote plus the cloud record write-through and restore path must ship (Phase 7 — re-scoped on 2026-07-02 from "durability export" to "cloud record write-through & restore", with a nightly export backup as the safety net) before we invite users to trust cloud workspaces with months of chat history.
- **The immediate blocker is trivial and administrative:** Phase 0 is done (verified, 1,429 tests green), Phase 1's spike harness is built and waiting on a Daytona API key. Getting that key and running the 11-item load-test checklist (WebSocket soak, wake latency, Mutagen-in-sandbox, egress) converts every "needs-testing" in this document into a number.
- **Money on the table:** Daytona's $200 no-card credit covers roughly six months of a solo-dev workspace (~$33/month), and their Startup Grid program offers $10k–$50k in credits — worth applying before beta to subsidize early COGS.
- **Keep the provider swappable.** Daytona went closed-source in June 2026 and Conductor already switched sandbox vendors once mid-beta (from a provider codenamed "sprite" to Vercel) — proof that the pluggable-provider seam we've designed is not paranoia, it's table stakes.

---

## Glossary

| Term | Plain-language meaning |
|---|---|
| **Cloud workspace** | A Zeros workspace whose computer is rented in a data center instead of being your Mac. Same app, same experience. |
| **Sandbox** | The rented computer itself — created in seconds, disposable, isolated to one workspace. The hotel room. |
| **Daytona** | The company we currently rent sandboxes from (US/EU data centers, ~$0.17/hr for a typical box as of mid-2026). |
| **Image** | A saved template of a fully-installed computer, so new sandboxes start pre-set-up in seconds. The cake mix. |
| **Snapshot** | A saved copy of a specific machine's disk at a moment in time — how a stopped workspace remembers everything. |
| **Warm pool** | Pre-started machines kept idling so "create workspace" feels instant. The valet with the car already out front. |
| **Zeros engine** | The brain of Zeros — runs agents, git, terminals, and owns the chat. Moves into the sandbox for cloud workspaces. |
| **WebSocket / WSS** | A network connection that opens once and stays open so both sides can talk instantly; WSS is the encrypted kind. The phone line. |
| **CloudTransport** | Our name for the Mac app's WebSocket connection to a cloud workspace — also called "the live wire" in this pack. It carries the running workspace; the cloud record keeps the permanent history. |
| **Preview URL** | The public web address every Daytona sandbox gets, which our WebSocket dials. |
| **Token** | A signed digital pass sent when connecting, proving which user you are. The room key. |
| **Mutagen** | An open-source file synchronizer that keeps a local copy of the workspace's files in step with the sandbox, both directions. |
| **File mirror** | That synced local copy — why opening and editing files feels instant despite the distance. |
| **zeros.db** | The small database holding chat, sessions, and workspace state; lives with the engine inside the sandbox as the working copy — every event streams on to the cloud record. |
| **The cloud record** | Our cloud database that permanently stores your chats, sessions, and workspace history in your account, synced to every device you sign into. The filing cabinet. (Decided 2026-07-02.) |
| **Two-plane architecture** | Files travel one way (mirrored locally for speed); chat/state travel another (engine-owned live hub, written through to the cloud record for permanence). |
| **Control plane** | The small backend that handles login, the workspace registry, and sandbox creation. The reception desk — never in your data path. |
| **Supabase** | The hosted login+database service currently pencilled in as our control plane. |
| **Worker** | A tiny server-side program holding the Daytona master key, so it never ships inside the Mac app. |
| **Idle / sleep / wake** | Workspaces stop after 60 quiet minutes (never mid-agent-run) and cost ~$0.001/hr asleep; they cold-boot back on demand. |
| **Cold boot** | Waking is a full restart from disk, not resuming a frozen machine — the engine rehydrates from its database and git. |
| **Durability** | The guarantee that nothing irreplaceable lives only in the sandbox: code → GitHub, chat & history → the cloud record (plus a backup export). |
| **Export blob** | A cheap compressed backup copy of chat/artifacts dropped into object storage — a safety net behind the cloud record, no longer the primary home. The storage unit. |
| **Git remote** | Your repo's home on GitHub — the durable, canonical copy of the code. The vault. |
| **Latency / RTT** | Round-trip travel time for a message; India→EU is ~130 ms, which the file mirror makes irrelevant for editing. |
| **Egress** | Outbound internet access from the sandbox — restricted by allowlist on cheap Daytona tiers (why Cursor agents need Tier 3). |

---

## Sources

**Internal**
- Zeros engineering plan (canonical): [08-engineering-reference.md](08-engineering-reference.md) — the v3 consolidation (2026-07-03) of the June plan (v2, 2026-06-24; Phase 0 shipped 2026-06-25); the original file was removed. The June v2 predated the 2026-07-02 cloud-record decision; the v3 applies it (see the execution-plan document in this pack)

**Conductor.build (reference competitor)**
- https://vercel.com/blog/how-conductor-moved-parallel-coding-agents-from-the-laptop-to-the-cloud-with-vercel-sandbox (May 27, 2026 — confirms Vercel Sandbox, "can't tell the difference" quote)
- https://thenewstack.io/conductor-cloud-ai-coding-agents/ (May 14, 2026 — announcement, no published pricing)
- https://www.conductor.build/cloud (early-access waitlist, fetched 2026-07-02)
- https://www.conductor.build/changelog (cloud beta features, May–July 2026)
- https://www.conductor.build/docs/reference/privacy (local-chat storage claims)

**Providers & pricing**
- https://www.daytona.io/pricing (vCPU/RAM/disk rates, $200 credit — verified mid-2026)
- https://vercel.com/docs/sandbox/pricing and https://vercel.com/docs/sandbox/concepts/persistent-sandboxes (Conductor's provider, sleep/snapshot model)
- https://fly.io/blog/design-and-implementation/ and https://simonwillison.net/2026/Jan/9/sprites-dev/ (Fly Sprites — fallback provider, sleep economics)
- https://northflank.com/blog/ai-sandbox-pricing (cross-provider pricing comparison)

**Industry patterns (persistent vs ephemeral, sleep-when-idle, mobile, portability)**
- https://code.claude.com/docs/en/claude-code-on-the-web (Anthropic's cloud sessions — ephemeral-sandbox contrast)
- https://developers.openai.com/codex/cloud (Codex cloud tasks)
- https://cursor.com/docs/cloud-agent (Cursor cloud agents)
- https://docs.factory.ai/cli/features/droid-computers (persistent, sleep-when-idle Droid Computers)
- https://devin.ai/pricing/ and https://docs.devin.ai/onboard-devin/repo-setup (machine snapshots, idle sleep)
- https://ampcode.com/manual (thread sharing — team-collab state of the art)
