# How Cursor & Claude Code Do Cloud

*part 03 of the Zeros Cloud Workspaces Report · July 2026*

## The short version

- **Cursor and Anthropic both ship cloud coding agents, and both chose the same basic shape: disposable, task-sized cloud computers.** You send a task, a fresh machine spins up, the agent works, the result comes back as a pull request, the machine is thrown away. That is a *different product* from what Zeros is building — a persistent workspace you live in.
- **Both solved cross-device sync the same way: the conversation lives on their servers, and every device (Mac, browser, phone) is just a window onto it.** Code reaches your laptop through git, not file sync. Neither has anything like Zeros' planned Mutagen file mirror. (Verified in both vendors' docs.) **Zeros now adopts the same principle (decided 2026-07-02)** via **the cloud record** — our cloud database that permanently stores your chats, sessions, and workspace history in your account — while the live engine in the sandbox stays the realtime hub.
- **Cursor's cleverest move is architectural: the agent's "brain" doesn't run on the cloud machine at all** — it runs in Cursor's own infrastructure, so machines can be hibernated, swapped, and upgraded mid-task without killing the session. That's how they went from ~90% to 99%+ reliability at 50M+ actions/day (their June 2, 2026 engineering blog).
- **Anthropic's cleverest move is security: real GitHub credentials never enter the sandbox.** The agent gets a fake scoped credential; a proxy outside the sandbox swaps it for the real token and only allows pushes to the agent's own branch. This is the pattern the whole industry is copying, and Zeros should too.
- **Neither charges separately for cloud compute.** Cursor bills raw model-token prices; Anthropic bundles the VM into the subscription ("no separate compute charge"). This is a subsidy Zeros *cannot* copy — we pay Daytona for every sandbox-hour — so sleep-when-idle economics are existential for us in a way they aren't for them.
- **The features worth stealing outright:** PR-first output with proof-of-work artifacts, "teleport" (pull a cloud session down to your Mac in one command), mobile check-ins with push notifications, environment snapshots after setup so you never pay cold-start twice, and repo-committed environment config.
- **The gap worth exploiting:** both vendors' team features are shallow — view-only sharing, no live collaboration on an agent conversation. Zeros' engine-owned chat database makes real-time shared workspaces natural. Nobody big has shipped that yet (as of mid-2026).

---

## Why these two matter

Cursor and Claude Code are the two biggest agent vendors Zeros users already run *inside* Zeros, and both spent 2025–2026 building cloud versions of their agents — instructive partly as patterns to copy, partly as a warning about what Zeros should *not* become. Everything below is dated mid-2026 and tagged **verified** (official docs, or two independent sources), **likely** (one credible source), or **needs-testing** where noted.

---

## Cursor Cloud Agents

### What you experience, step by step

Cursor's cloud agents started as "Background Agents" (preview May 2025, GA June 2025) and were renamed **Cloud Agents** in Cursor 2.0 on October 29, 2025. **[verified]**

1. **You kick off a task from almost anywhere.** In the Cursor editor you pick "Cloud" from the agent dropdown. Or you open cursor.com/agents in a browser. Or you use the Cursor iOS app (public beta since June 29, 2026). Or you type `@Cursor fix the login bug` in Slack, comment `@cursor` on a GitHub pull request, assign an issue to @cursor in Linear, hit their API, or schedule it as a recurring Automation. **[verified]**
2. **You close your laptop. The agent keeps working.** Each agent gets its own rented computer in Cursor's cloud — a **VM** (virtual machine — a full computer simulated in a data center, created and destroyed in seconds). It clones your repository from GitHub/GitLab/Bitbucket, works on its own branch, and since February 2026 even has its own desktop and web browser (**Computer Use**) so it can click around the app it's building. **[verified]**
3. **You watch from your phone.** The chat streams live; you can send follow-ups mid-run. The iOS app sends a **push notification when the agent finishes a turn**, and Live Activities on the lock screen track up to eight agents at once. **[verified]**
4. **You review a finished package.** The agent delivers a **merge-ready pull request** — a PR, GitHub's standard "here are my proposed changes, please review" bundle — with **artifacts**: screenshots, screen recordings, and logs proving the change works. You can merge, request changes, or hand a failing check back to the agent, all from web or phone. Cloud agents also **auto-fix CI failures** (CI — the automated test suite that runs on every PR) on PRs they created. **[verified]**
5. **You take over locally when you want your hands on the code.** "Open in Cursor" pulls the agent's work into your editor. Since Cursor 3.x the handoff is **bidirectional**: a local session can be moved to the cloud to keep working while you're offline, and a cloud session can be pulled back down. There's also an inverse mode, `/remote-control`: the agent's brain moves to the cloud so your phone can drive it, while its tools keep running on your desk-bound Mac. **[verified]**

Cursor publishes a striking adoption stat: **more than 40% of Cursor's own merged PRs come from cloud agents** as of June 2026, up from 30% in February. **[verified — their engineering blog]**

### Under the hood, in plain words

- **A fresh VM per agent, on Cursor's AWS.** Isolated Ubuntu machines; exact size unpublished. In July 2025 security researchers escaped the sandbox to the underlying host — one of several incidents worth remembering (repeated prompt-injection CVEs followed in 2025–2026). The agent has **internet access by default and auto-runs every terminal command** — Cursor's own docs acknowledge the data-exfiltration risk. **[verified]**
- **The agent loop does NOT run on that VM.** This is the headline design. The "loop" — the think-act-observe cycle that is the agent — runs in **Temporal** (a workflow system: think of it as air-traffic control that guarantees a job lands even if the plane carrying it has to be swapped mid-flight) inside Cursor's own cloud. The VM is just the workbench. Because brain and workbench are separate, Cursor can hibernate VMs between messages, keep pre-warmed ones ready, checkpoint/restore/fork machine images, and upgrade software without killing sessions. Result: from "one 9" of reliability in early beta to "past two 9s," at 50M+ actions per day. **[verified — June 2, 2026 engineering blog]**
- **Environment setup is repo-committed config.** A file in your repo, `.cursor/environment.json`, defines how to build the agent's workbench: a saved **snapshot** (a frozen copy of a fully set-up machine's disk), a Dockerfile, or agent-led setup where the agent installs everything itself while you watch. After the install step, Cursor **auto-checkpoints** and starts future agents from that snapshot — you pay the setup cost once, not every run. Snapshots are encrypted and kept up to 90 days of inactivity. Cursor's stated lesson: *"the single biggest factor in cloud agent output quality is ensuring it has a full development environment"* — rebuilding a dev environment in the cloud was their hardest problem. **[verified]**
- **Secrets** are stored via cursor.com and injected as environment variables; runtime secrets show up as `[REDACTED]` in transcripts; commits are signed with a hardware-backed key so they show "Verified" on GitHub. **[verified]**

### What syncs across devices

The trick is that there's almost nothing *to* sync: **the session — conversation, state, diffs, artifacts — lives server-side**, streamed to every device from an append-only store (a log you can only add to, never rewrite — so every device can replay it identically). Devices are pure renderers. Your actual code reaches your laptop only through **git** — check out the agent's branch — never through file sync. There is **no continuous file mirror to the laptop**, verified by absence across all their docs. **[verified]**

### Team features

Shallow, honestly. Teammates with repo access can *view* each other's agents at cursor.com/agents; replying to someone else's agent is an opt-in setting; team-scoped service accounts are Enterprise-only. The one real shared team asset is **saved environments** (with version history and an audit log). Team seats: $40/user/mo Standard, $120 Premium, plus a $0.25-per-million-token surcharge on non-Auto requests. **[verified]**

### Pricing

Individual plans: **Pro $20/mo ($20 of model usage included), Pro+ $60 ($70 included), Ultra $200 ($400 included)**. Cloud agents always run in Max Mode, **billed at the model's raw API token price** — included usage first, then metered on-demand billing with a mandatory spend limit. **No separate charge for VM time is disclosed** — compute appears bundled. **[verified pricing; the VM-time question is officially unanswered]** The loudest criticism is cost unpredictability: Hacker News reports of $2k/week, subscriptions drained in a day. **[likely]**

---

## Claude Code on the web

### What you experience, step by step

Launched October 20, 2025 and *still labeled a research preview as of July 2026*. It runs full Claude Code sessions on Anthropic-managed cloud VMs at claude.ai/code. **[verified]**

1. **You sign in at claude.ai/code and connect GitHub** (install the Claude GitHub App, grant repo access).
2. **You create an "environment"** — a named recipe: network access level, environment variables, and a setup script that installs your project's dependencies.
3. **You pick a repo and a branch, type a task, press Enter.** Each task gets **its own session, its own fresh VM, and its own branch**. The VM is roughly 4 vCPUs, 16 GB RAM, 30 GB disk, Ubuntu 24.04, with Docker, Postgres, and Redis pre-installed. You can watch and steer in real time, or walk away. **[verified]**
4. **You close the laptop; the session lives on claude.ai's servers.** You can check it from the Claude iPhone/Android app, get push notifications when Claude finishes or needs a decision, and reply from the beach.
5. **You review a diff, not a machine.** Sessions show a `+42 −18` change indicator; clicking opens a diff view. You can leave **inline comments on specific lines**, which get bundled into your next message ("at src/auth.ts:47, don't catch the error here"). Then **Create PR** (full, draft, or GitHub compose page). A per-PR **Auto-fix** toggle subscribes Claude to that PR's webhooks so it automatically fixes CI failures and responds to review comments. **[verified]**
6. **You "teleport" the session down to your Mac.** `claude --teleport` fetches the cloud session's branch AND downloads the full conversation history into your local terminal — you continue exactly where the cloud left off. Requirements: same claude.ai account, same repo, clean working tree. **[verified]**

The reverse direction is telling: **going local → cloud is weak even for Anthropic.** The CLI can only create *new* cloud sessions (`--remote` clones your repo from GitHub, or uploads a <100 MB bundle if there's no GitHub). The Desktop app's "Continue in" menu *fakes* a live handoff: it pushes your branch, writes a summary of the conversation, and starts a fresh cloud session. Lifting a live session into the cloud is hard enough that Anthropic cheats with a summary. **[verified]**

### Under the hood, in plain words

- **Ephemeral task sandboxes, not persistent workspaces.** Idle environments expire and are reclaimed; reopening provisions a fresh VM with the conversation restored but the old machine's working state gone. What survives is the **branch on GitHub plus the server-side transcript**. The VM is explicitly disposable. **[verified]**
- **The credential proxy — the flagship security pattern.** Inside the sandbox, git authenticates with a custom **scoped credential** — think of a valet key that can only start the car, not open the trunk. A proxy outside the sandbox verifies it, swaps it for your *real* GitHub token, and **restricts `git push` to the current working branch**. Real tokens and signing keys never touch the machine the agent controls. **[verified]**
- **All network traffic goes through a security proxy** with per-environment levels: None / Trusted (default — an allowlist of ~150 package registries and developer services) / Full / Custom. The proxy keeps a DNS-level audit trail of every hostname requested. The docs honestly admit that even at "None," data can still exit via the Anthropic API channel itself. **[verified]**
- **Environment caching:** after your setup script succeeds once, Anthropic **snapshots the filesystem** and starts later sessions from it; the cache expires after ~7 days or on config change. Config committed to the repo (CLAUDE.md, `.claude/`, `.mcp.json`) carries into cloud sessions; your personal `~/.claude` setup does not. There is **no secrets store yet** — env vars are plaintext-visible to anyone who can edit the environment. No custom base images. **[verified]**

### What syncs across devices

Same answer as Cursor, same mechanism: **the session lives server-side on claude.ai; every surface — web, iOS, Android, Desktop, terminal-via-teleport — is a client.** Commits from web sessions even carry a `Claude-Session: <url>` trailer so any PR traces back to the exact agent run. Local CLI sessions do *not* sync unless you use **Remote Control** — the mirror mode where the session keeps running on *your* Mac and web/phone are just synced windows onto it (outbound-only connections, no open ports). **[verified]**

**Decision update (2026-07-02) — Zeros adopts this principle.** Both vendors keep the conversation on their servers; every device is a window. Zeros now does the same via the cloud record — chat and session history live permanently server-side in your account — while the live engine in the sandbox remains the realtime hub for a running workspace.

### Team features

Also shallow: **view-only session sharing** (Private/Team on Team-Enterprise plans; Private/Public on Pro/Max), no real-time co-driving, no shared ownership of sessions. Enterprise gets server-side org toggles, audit logs, SCIM. Notable footgun for teams: a connected GitHub account gives cloud sessions reach into *every* repo that account can see — access control has to happen on GitHub's side. **[verified]**

### Pricing — and the rule that binds Zeros

The headline: **"there is no separate compute charge for the cloud VM."** Cloud sessions just draw from your plan's shared rate limits — Pro $20/mo, Max $100/$200, Team Premium ~$125/seat monthly. Anthropic eats the sandbox bill as a subscription perk. **[verified]**

Two facts here matter enormously for Zeros:

1. **We can't replicate the subsidy.** Zeros pays Daytona per sandbox-hour. Anthropic and Cursor amortize compute into subscriptions at a scale we don't have.
2. **We can't piggyback their subscriptions.** Anthropic explicitly bans third-party products — including anything built on the Claude Agent SDK, which is what Zeros uses — from offering claude.ai login or subscription rate limits. API-key auth only. And teleport/Remote Control/cloud sessions are claude.ai-subscription perks unavailable over API keys. Their cross-device fabric is a walled garden; Zeros must build its own (which is exactly what the Daytona plan does). **[verified — Agent SDK docs]**

---

## The one big difference: task runners vs. a workspace you live in

Here is the sentence to keep: **Cursor and Claude Code built couriers; Zeros is building an office.**

Their cloud machines are **task-shaped**: a fresh computer is created for one job, the deliverable (a PR) is mailed out, and the computer is demolished. Nothing about *you* lives there — no running services, no accumulated state, no "the way I left things yesterday." It's a hotel room with aggressive housekeeping: identical every check-in, nothing personal survives checkout.

Zeros (and Conductor — see the Conductor teardown doc in this pack) is building **persistent workspaces**: a rented studio with your name on the door. The full Zeros engine, your chat history, your running dev server, your half-finished experiments — all stay in the sandbox across days and weeks. You return to it; teammates can walk into it. The landscape survey in this pack found the market splits cleanly into these two camps, and **the persistent camp is rarer and differentiating** — Devin, Factory, Conductor, Zeros — versus the ephemeral camp of Codex, Copilot, Jules, and Claude web.

The persistent model's two make-or-break requirements (per the landscape survey): **aggressive sleep-when-idle economics** (an always-on 4-vCPU Daytona sandbox is ~$240/month; slept properly it's dollars) and **durable results that live outside the workspace** (git remote for code + the cloud record for chats and history — decided 2026-07-02, upgrading the earlier export-blob plan; a periodic export stays as a backup). The ephemeral vendors get both for free because they throw the machine away.

---

## The broader landscape at a glance

Fuller detail lives in the landscape survey; the fifty-cent version:

| Product | Cloud model | Output | Environment memory | Mobile | Pricing axis |
|---|---|---|---|---|---|
| **OpenAI Codex cloud** | Fresh container per task; internet ON during setup, OFF by default while the agent works; secrets stripped before the agent phase | Diff → PR, or apply locally | Container state cached up to 12h | ChatGPT app (May 2026) + turn-completion pushes | Token metering vs plan limits (since Apr 2, 2026); compute bundled |
| **GitHub Copilot agent** | Ephemeral GitHub Actions runner; 59-min cap, one PR per task | Draft PR, every step a commit | None (fully ephemeral) | "Mission control" across web/VS Code/mobile/CLI | AI Credits at API rates (June 1, 2026) **plus Actions minutes — the only vendor that bills agent compute explicitly** |
| **Google Jules** | Fresh Google Cloud VM per task; plan-approval step before any code changes | Branch → PR | Setup scripts, AGENTS.md | Web only | Simplest model: **tasks/day + concurrency** (15/3 free, 100/15 at $19.99, 300/60 Ultra) |
| **Devin (Cognition)** | Persistent "cloud laptop" — the closest to Zeros | PR **with a screen recording** as proof | **Machine Snapshots** persist the whole machine incl. auth tokens; auto-sleeps after ~0.1 ACU idle | Web, Slack, Linear, Jira | $500/mo (2024) → $20/mo (Apr 2025) — a **25x price-floor collapse** in one year; enterprise metered in ACUs (~15 min of work) |

Cross-cutting patterns (all verified in the survey): PR-first output is universal; environment snapshotting after setup is standard; H1 2026 saw an industry-wide repricing to token pass-through; and mobile check-in became table stakes — as *monitor/steer/approve*, never a full IDE.

---

## What Zeros should copy — and what to avoid

### Copy

1. **PR-first as an output *option*, with proof-of-work artifacts.** Even in a persistent workspace, the durable deliverable is a branch/PR — and the leaders attach evidence (Cursor's videos/screenshots/logs, Devin's recordings, Claude's session-URL trailer in every commit). Zeros should offer "wrap this up as a PR" with artifacts, without making it the *only* exit.
2. **Teleport / cloud-local handoff.** Claude's `--teleport` (branch + full conversation down to the laptop) is the single most-loved portability feature in the market. Zeros is structurally *better* positioned here: with the Mutagen file mirror, the files are already on the Mac, and with the engine-owned chat DB (now backed by the cloud record), the conversation is already synced — Zeros' "teleport" is nearly free. Also note what's hard: even Anthropic fakes local→cloud handoff with a summary. Zeros' persistent-workspace model sidesteps this — there's no session to lift, you just reconnect. *(Needs-testing once Phase 1 has an API key: measure reconnect/resume feel.)*
3. **Mobile check-ins, scoped tightly.** Push notification when a turn finishes or the agent is blocked, plus one-message unblocking. Not an IDE on a phone.
4. **Environment snapshots after setup.** Everyone learned the same lesson: never pay cold-start twice, invalidate on config change. Map this onto Daytona snapshots + a repo-committed environment file (the "repo-as-config" pattern: `.cursor/environment.json`, CLAUDE.md — Zeros should have its own).
5. **Credentials never in the sandbox.** Anthropic's scoped-credential git proxy, push restricted to the working branch. Assume the agent's box is compromised by design — Cursor's container-escape and prompt-injection CVE history is the cautionary tale.
6. **Usage-based compute, priced honestly.** The 2026 norm is model tokens at pass-through and compute either absorbed or a small metered line. Zeros can't absorb compute like Anthropic — so meter it transparently, and make sleep-when-idle the default so the number stays small (see 'Platform Comparison' for the Daytona math).

### Avoid

1. **Task-shaped-only agents.** Don't chase Cursor/Claude into the courier business — they've won it, they subsidize the compute, and Zeros users already get those products' cloud features *through* those products. Zeros' wedge is the thing they structurally can't do: a persistent, multi-agent, multi-day workspace with live shared chat.
2. **Their sync architecture, wholesale.** *Updated 2026-07-02: this item previously argued that "everything lives on our servers, devices render it" contradicts Zeros' engine-owned zeros.db design — the founder has since decided Zeros adopts that very principle via the cloud record.* Both vendors keep the conversation on their servers; every device is a window — Zeros now does the same: the cloud record permanently stores chats and history in your account, the in-sandbox zeros.db becomes the working copy, and the live engine stays the realtime hub (the sync & collaboration doc's verdict is now "live engine + cloud record"). What Zeros still does *not* copy is their live-path topology: the app keeps its direct WSS connection to the engine — no vendor server brokering the live conversation. The *primitive* advice stands: an append-only, resumable conversation stream with "give me everything after offset X" — it now doubles as the write-through + catch-up mechanism that feeds the cloud record.
3. **Cost opacity.** Cursor's loudest criticism is surprise bills. Show the meter.
4. **Indefinite-by-default retention and public-URL artifacts.** Cursor keeps conversation history indefinitely by default and serves artifacts from unguessable-but-unauthenticated URLs. Both are documented; both are trust liabilities Zeros shouldn't inherit.

---

## What this means for Zeros

- **Stay the course on persistent workspaces.** Both giants validated the demand for cloud agents and *neither* built what Zeros is building. The Daytona plan (full engine in the sandbox, direct WSS, Mutagen mirror, engine-owned chat DB) targets the rarer, differentiated camp. No architectural rethink required — the one addition (decided 2026-07-02) is the cloud record: the engine stays the live hub and now also writes history through to your account, adopting the one principle both giants got right about sync.
- **Adopt four features into the roadmap now:** (1) a Zeros credential proxy so real tokens never enter sandboxes; (2) environment snapshot-after-setup on Daytona with a repo-committed config file; (3) a "finish as PR" action with artifacts; (4) subscribe-after-offset resumable chat streams in the WSS protocol — it buys reconnect, cross-device catch-up, and teammate live-tail in one primitive.
- **Plan mobile as a check-in surface for v2** — push notifications plus one-message steering. Table stakes by mid-2026, but genuinely small in scope.
- **Budget reality:** Zeros pays for compute that Cursor and Anthropic give away inside subscriptions. Sleep-when-idle isn't an optimization, it's the business model (the internal plan's autoStopInterval-0 + engine-owned-sleep design is exactly right). Daytona's $200 free credit and Startup Grid credits soften the beta period.
- **The open ground is collaboration.** Cursor: opt-in follow-ups on someone else's agent. Anthropic: view-only share links. Nobody has live, multiplayer agent chat. Zeros' engine-owned DB makes it native. That — plus persistence — is the pitch.

---

## Sources

**Cursor**
- https://cursor.com/docs/cloud-agent — Cloud Agents overview (fetched 2026-07-02)
- https://cursor.com/docs/cloud-agent/setup — environment.json, snapshots, secrets
- https://cursor.com/docs/cloud-agent/security-network — AWS VMs, privacy mode, network modes, commit signing
- https://cursor.com/docs/cloud-agent/capabilities — Computer Use, artifacts, CI auto-fix
- https://cursor.com/docs/cloud-agent/web-and-mobile — cross-device inbox, /remote-control
- https://cursor.com/docs/models-and-pricing — plans, token prices, Max Mode billing
- https://cursor.com/blog/cloud-agent-lessons — "What we've learned building cloud agents" (2026-06-02)
- https://cursor.com/blog/agent-computer-use — Computer Use (2026-02-24)
- https://cursor.com/changelog/2-0 — rename to Cloud Agents (2025-10-29)
- https://cursor.com/changelog/ios-mobile-app — iOS public beta (2026-06-29)
- https://forum.cursor.com/t/what-is-the-pricing-structure-for-using-cloud-agents/156843 — staff billing answers
- https://www.reco.ai/blog/hijacking-cursors-agent-how-we-took-over-an-ec2-instance — EC2/Docker architecture research (2025-07-16)
- https://thehackernews.com/2026/07/critical-cursor-flaws-could-let-prompt.html — CVE-2026-50548/50549
- https://www.infoq.com/news/2026/04/cursor-3-agent-first-interface/ — Cursor 3 coverage + community reaction

**Claude Code**
- https://code.claude.com/docs/en/claude-code-on-the-web — cloud sessions reference (fetched 2026-07-02)
- https://code.claude.com/docs/en/web-quickstart — onboarding flow
- https://code.claude.com/docs/en/remote-control — Remote Control, Trusted Devices
- https://code.claude.com/docs/en/desktop — Local/Remote/SSH sessions, "Continue in"
- https://code.claude.com/docs/en/agent-sdk/overview — third-party auth restriction (the rule that binds Zeros)
- https://claude.com/blog/claude-code-on-the-web — launch announcement (2025-10-20)
- https://www.anthropic.com/engineering/claude-code-sandboxing — sandboxing + credential proxy
- https://www.anthropic.com/engineering/how-we-contain-claude — containment architecture (2026-05-25)
- https://techcrunch.com/2025/10/20/anthropic-brings-claude-code-to-the-web/ — launch coverage
- https://simonwillison.net/2025/Oct/20/claude-code-for-web/ — independent security assessment
- https://claude.com/pricing — plan prices (fetched 2026-07-02)

**Landscape**
- https://developers.openai.com/codex/cloud — Codex cloud mechanics
- https://developers.openai.com/codex/pricing — Codex token metering (2026-04-02 change)
- https://docs.github.com/copilot/concepts/agents/coding-agent/about-coding-agent — Copilot coding agent
- https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/ — AI Credits (2026-06-01)
- https://jules.google/docs/usage-limits/ — Jules task/concurrency tiers
- https://devin.ai/pricing/ and https://docs.devin.ai/onboard-devin/repo-setup — Devin plans + Machine Snapshots
- https://venturebeat.com/programming-development/devin-2-0-is-here-cognition-slashes-price-of-ai-software-engineer-to-20-per-month-from-500 — Devin price collapse
- https://vercel.com/blog/how-conductor-moved-parallel-coding-agents-from-the-laptop-to-the-cloud-with-vercel-sandbox — Conductor on Vercel Sandbox
- https://fly.io/blog/design-and-implementation/ — Fly Sprites (sleep-when-idle reference)
- https://www.daytona.io/pricing — Daytona rates

**Internal**
- [08-engineering-reference.md](08-engineering-reference.md) — Zeros Daytona execution plan (v3, consolidated 2026-07-03 from the June v2, 2026-06-24; original removed)
