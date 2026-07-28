# Cloud Coding-Agent Landscape — Patterns to Learn From

Research date: 2026-07-02. Scope: survey of cloud coding-agent products beyond local Cursor/Claude Code usage, focusing on (a) cloud execution mechanics, (b) how results come back, (c) device/web/mobile access + sync, (d) team/collab features, (e) pricing — then a synthesis of industry best practices for any cloud-workspace product (i.e., Zeros Cloud Workspaces).

Confidence labels: **[verified]** = read on official docs/pricing/blog; **[likely]** = credible secondary source(s), not confirmed on an official page; **[unverified]** = single or weak source.

---

## 1. OpenAI Codex cloud (chatgpt.com/codex)

**What it is.** OpenAI's coding agent with three surfaces: CLI, IDE extension, and "Codex cloud" — background tasks that run in OpenAI-managed cloud containers, launched from chatgpt.com/codex, the IDE, GitHub, or the ChatGPT mobile app. [verified — developers.openai.com/codex/cloud]

**Cloud execution mechanics** [verified — developers.openai.com/codex/cloud/environments]:
- Each task runs in an **isolated OpenAI-managed container** based on a default image called `universal` (pre-installed common languages/tools; repo at openai/codex-universal). Versions of Python/Node/etc. can be pinned per environment.
- **Two-phase runtime model**: a *setup phase* with internet access installs dependencies (auto-detected for npm/yarn/pnpm/pip/poetry etc., or a custom Bash setup script); then the *agent phase* runs **offline by default** — internet can be enabled per-environment (limited allowlist or unrestricted), with all outbound traffic routed through an HTTP/HTTPS proxy.
- **Container state is cached for up to 12 hours** to speed up new tasks and follow-ups; the cache is invalidated when setup scripts, maintenance scripts, env vars, or secrets change. On resume, the task-specific branch is checked out and an optional maintenance script runs.
- **Secrets** get an extra encryption layer, are available only to setup scripts, and are **removed before the agent phase starts**.
- Tasks are async; users can **queue many tasks in parallel**, each in its own sandbox.

**Results delivery.** Task produces a diff + terminal logs traceable step by step; user can open a **pull request directly from the task**, or apply the diff locally via the IDE extension. PR-first but with an "apply locally" escape hatch. [verified]

**Device/web/mobile.** Web (chatgpt.com/codex), IDE extension, GitHub (@codex on PRs), and **ChatGPT mobile apps (iOS/iPad/Android) since ~May 14, 2026** — start tasks, steer running tasks, review, plus **push notifications for turn completion** (added ~May 21, 2026). Codex mobile can also control a paired Mac host ("work with Codex from anywhere"). [likely — 9to5Mac May 2026 + openai.com post; mobile launch itself is well corroborated]

**Team/collab.** Environments are configured per repo and shared at workspace level on Business/Enterprise; admin setup docs exist for enterprise controls. No shared-conversation collaboration on a task. [verified for admin setup existence; collab absence = observed gap]

**Pricing** [verified — developers.openai.com/codex/pricing + uibakery.io cross-check]:
- Included in ChatGPT plans: Plus $20/mo, Pro $100/mo ("5x") and $200/mo ("20x"), Business $25/user/mo ($20 annual), Enterprise custom.
- **April 2, 2026: Codex moved from per-message/per-task metering to API-style token metering** (input / cached input / output) drawn against plan limits, with extra usage bought as **credits**. Credit rates per 1M tokens: GPT-5.5 = 125 in / 12.5 cached / 750 out; GPT-5.4 = 62.5 / 6.25 / 375; GPT-5.4-mini = 18.75 / 1.875 / 113. "GPT-5.5 usage averages 5–45 credits per message."
- Local messages, cloud tasks, and code review **share the same 5-hour rolling window**. (Older public numbers — Plus ≈ 10–60 cloud tasks per 5h window — predate the April 2026 token change.) [likely for the old numbers]
- Notably: **no separate charge for the cloud container/compute** — the sandbox is bundled into plan usage. [verified by omission on the rate card + pricing page]

---

## 2. Claude Code on the web (Anthropic) — richest public documentation of the "engine-in-sandbox" pattern

**Cloud execution mechanics** [verified — code.claude.com/docs/en/claude-code-on-the-web, fetched in full]:
- Each session runs in a **fresh, isolated Anthropic-managed VM** with the repo cloned. Resource ceilings: **4 vCPUs, 16 GB RAM, 30 GB disk**. Ubuntu 24.04, setup scripts run as root. PostgreSQL 16, Redis 7, Docker, and most language toolchains pre-installed.
- **Environment caching = filesystem snapshot**: the setup script runs once; Anthropic then "snapshots the filesystem and reuses that snapshot as the starting point for later sessions." Cache expires after **roughly seven days** or on config change. Setup scripts should stay under ~5 minutes so the cache can build. Cache stores files, not running processes.
- **Network access levels** per environment: None / Trusted (large default allowlist of package registries, GitHub, cloud SDKs) / Full / Custom allowlist. All outbound traffic goes through a security proxy with DNS-level audit trail.
- **GitHub proxy — credentials never in the sandbox**: "sensitive credentials such as git credentials or signing keys are never inside the sandbox." The git client inside uses a custom scoped credential; a proxy verifies it, translates to the real token, and **restricts pushes to the current working branch**. This is the flagship security pattern in the industry.
- Config comes from the repo (CLAUDE.md, .claude/settings.json, .mcp.json, skills/agents/commands) — anything local-only doesn't carry over. No dedicated secrets store yet (env vars visible to environment editors).
- Sessions **persist when the browser closes**; sessions expire after inactivity ("environment expired") and reopen fresh with conversation history restored.

**Results delivery.** Diff view with inline comments in the browser; **create a PR from the web UI**; commits carry a `Claude-Session: <url>` git trailer and PR bodies include the session URL (traceability from artifact back to the agent run). **Auto-fix PRs**: Claude subscribes to GitHub webhooks on a PR and automatically pushes fixes for CI failures and review comments (per-PR toggle; requires GitHub App). [verified]

**Device/web/mobile + portability.** Monitor and steer sessions from the **Claude mobile app**. **`claude --remote "task"`** starts a cloud session from the terminal; **`--teleport`** pulls a cloud session (conversation + branch) into the local terminal; Desktop app has "Continue in" to push local→web. Repos without GitHub can be **bundled and uploaded** (<100 MB). This bidirectional local↔cloud session portability is the most complete in the market. [verified]

**Team/collab.** Session sharing with visibility levels: Private/Team (Team & Enterprise accounts — visible to the claude.ai org, with repository-access verification on by default) or Private/Public (Pro/Max). Shared views are read-only snapshots, **not live-updating**. Slack sessions auto-share with Team visibility. [verified]

**Pricing.** Research preview included in Pro ($20), Max ($100/$200), Team, and Enterprise premium seats. Key line: **"There is no separate compute charge for the cloud VM"** — cloud sessions just draw the account's shared rate limits; parallel tasks consume proportionally more. [verified]

---

## 3. GitHub Copilot coding agent (+ Agent HQ)

**Cloud execution mechanics** [verified — docs.github.com about-coding-agent]:
- Runs in an **ephemeral development environment powered by GitHub Actions** — one per task. Hard limits: **59-minute max execution**, single repository, **one branch and one PR per task**.
- GitHub MCP server and Playwright MCP server enabled by default; firewalled internet by default (configurable).

**Task entry points.** Assign a GitHub Issue to Copilot; Copilot Chat on github.com; `@copilot` PR comments; Azure Boards/JIRA/Linear/Slack/Teams; scheduled/event triggers. [verified]

**Results delivery.** Works on a branch, opens a **draft PR**, every step is a commit with viewable session logs; humans iterate via PR review comments. Pure PR-first — no live IDE into the agent's machine. [verified]

**Device/web/mobile.** "Mission control" (part of **Agent HQ, announced Oct 28, 2025 at Universe**) is a unified command center **across GitHub.com, VS Code, mobile, and CLI** to direct/monitor/manage every agent task. Agent HQ also opens GitHub to **third-party agents (Anthropic, OpenAI, Google/Jules, Cognition, xAI) running inside a Copilot subscription**. [verified — github.blog]

**Pricing** [verified — github.blog usage-based billing post]:
- **June 1, 2026: all Copilot plans moved to usage-based billing.** Premium requests replaced by **GitHub AI Credits (1 credit = $0.01)** consumed by token usage at published API rates. Pro $10/mo with $10 credits; Pro+ $39/mo with $39 credits; Business $19/user/mo with $19 credits; Enterprise $39/user/mo with $39 credits (promo: $30/$70 credits June–Aug 2026). Completions/next-edit-suggestions stay unlimited.
- The coding agent additionally consumes **GitHub Actions minutes** — i.e., GitHub explicitly bills agent compute separately from model tokens (the only major player that does).

---

## 4. Google Jules

**Cloud execution mechanics** [verified — jules.google/docs]:
- **Fresh Google Cloud VM per task**; clones the repo, installs dependencies, modifies files. Optional environment **setup scripts**; reads **AGENTS.md** for repo conventions. Google states it doesn't train on private code; data isolated in the execution VM.
- Workflow includes an explicit **plan approval step**: Jules writes a plan and "you can review and approve it before any code changes are made."

**Results delivery.** Multi-file change pushed as a branch → **opens a pull request**. Async: launch tasks, come back later. [verified/likely]

**Device/web/mobile.** Web app (jules.google.com), browser notifications, **Jules Tools CLI and a REST API** (both listed in official docs nav). No dedicated mobile app. [verified]

**Team/collab.** None meaningful — paid tiers are **individual-only**: "Paid Jules plans are accessed via a Google AI Plans subscription, which is currently available only for individual Google Accounts (ending in @gmail.com)." [verified — jules.google/docs/usage-limits]

**Pricing / quotas** [verified — jules.google/docs/usage-limits]:
- Free: **15 tasks/day, 3 concurrent** (Gemini 2.5 Pro-class access).
- Google AI Pro ($19.99/mo): **100 tasks/day, 15 concurrent**, "higher access to the latest model (starting with Gemini 3 Pro)".
- Google AI Ultra: **300 tasks/day, 60 concurrent**, priority model access. (Ultra entry price reportedly cut from $249.99 to $99.99/mo at Google I/O 2026. [likely — secondary sources])
- Timeline: Labs experiment Dec 2024 → public beta May 2025 (I/O) → **GA Aug 6, 2025** with the free 15/day tier. [verified via Google blog/TechCrunch]
- Note the pricing axis: Jules meters **tasks and concurrency**, not tokens — the simplest mental model in the market.

---

## 5. Devin (Cognition)

**Cloud execution mechanics**:
- Devin runs in a **cloud VM that is effectively a full "cloud laptop"**: shell, VS Code-style editor, and a headless Chrome browser inside a sandboxed workspace. [verified via docs + multiple analyses]
- **Machine Snapshots** are the core environment primitive: "save states for Devin's entire environment that capture installed software, cloned repositories, authentication tokens, and any files on disk… use it as the starting point for all future sessions, so you do not have to reinstall dependencies each time." Environment setup is framed as "setting up Devin's laptop on the first day of work" (guided 8-step repo setup). [verified — docs.devin.ai/onboard-devin/repo-setup]
- **Idle economics**: Devin auto-sleeps when a session is idle — "Devin typically sleeps automatically after roughly 0.1 ACUs of inactivity," and usage accrues from actions performed + VM time + bandwidth ("typically a small fraction of total usage"). Cognition's guidance: **keep sessions under 10 ACUs** because performance degrades in long sessions. [verified — docs.devin.ai/admin/billing/usage via search extraction]
- Parallelism is a first-class pattern ("agents fan out to work in parallel, then open PRs for review"; MultiDevin/"Devin can manage Devins" for fleets). [verified — devin.ai/cloud]

**Results delivery.** **PR-first**, often with a **screen recording of the fix** attached as proof-of-work; browser/terminal/GUI verification "on Linux, Windows, or Android." Built-in automated PR review features. [verified — devin.ai/cloud]

**Device/web/mobile + surfaces.** Web app, **Slack bot, Linear, Jira** task intake; event-driven automations (CI failures, Snyk, PagerDuty). Three form factors: **Devin Cloud, Devin Desktop (formerly Windsurf), Devin CLI** — the CLI supports "start local, hand off to the cloud." [verified — devin.ai + cognition.com blog]

**Team/collab.** Teams plan: unlimited members, sharing/collaboration on sessions, centralized billing + admin dashboard with analytics; Enterprise adds SSO, dedicated deployment. [verified — devin.ai/pricing]

**Pricing** [verified — devin.ai/pricing fetch, 2026]:
- Self-serve: **Free $0** (light quota); **Pro $20/mo**; **Max $200/mo** (significantly higher quotas); **Teams $80/mo base + $40/mo per full developer seat**; Enterprise custom.
- **Enterprise is billed in ACUs** "at the rate set in their order form." 1 ACU ≈ **15 minutes of active Devin work**; historically $2–2.25/ACU. [verified concept; price per ACU likely]
- History worth quoting to a founder: Devin launched at **$500/mo minimum (2024)**, then **Devin 2.0 (April 2025) cut entry to $20/mo** pay-as-you-go — a 25x price-floor collapse in one year as competition arrived. [verified — VentureBeat Apr 2025]

---

## 6. Cursor cloud agents

**Cloud execution mechanics** [verified — cursor.com/docs/cloud-agent]:
- **One isolated VM per agent** with a full dev environment; clones from GitHub, GitLab, Azure DevOps, or Bitbucket Cloud; works on its own branch.
- Environment config: agent-led setup, **saved snapshots of base environments**, or a **Dockerfile via `.cursor/environment.json`**; dashboard shows which environment each agent used, **with version history** (May 13, 2026 changelog adds multi-repo support, 70% faster Docker layer caching, rollback, scoped secrets, Teams integration [likely — secondary]).
- Runtime options: **Cursor-managed** (secrets, domain restrictions, Tailscale) or **self-hosted** ("My Machines" / "Self-Hosted Pool") for orgs that must own the execution environment.

**Results delivery.** "**Merge-ready PRs with artifacts to demo their changes**" — screenshots, **videos**, logs; plus **remote desktop control** to poke at the agent's VM directly without checking out the branch. [verified]

**Device/web/mobile.** Launch/monitor from cursor.com/agents (web), **Cursor iOS app**, desktop, **Slack (@cursor), GitHub/Bitbucket PR comments, Linear, API**. [verified]

**Pricing.** Requires a paid plan (Pro $20+); **cloud agents bill at API pricing for the chosen model and always run in Max Mode**; users set spend limits on first use. Compute itself isn't separately priced. Adoption datapoint: **>35% of PRs merged by Cursor's own engineering team were created by cloud agents as of April 2026** (up from ~30% at the Feb 2026 launch). [likely — buildfastwithai/secondary; the docs verify billing mechanics]

---

## 7. Factory (Droids)

**Cloud execution mechanics** [verified — docs.factory.ai/cli/features/droid-computers]:
- Sessions can run locally (CLI/desktop app) or on **Droid Computers — persistent compute environments** that "retain state — installed packages, files, running services, and configuration all persist between sessions." Two types: **Managed** (Factory provisions **4 CPU / 8 GB RAM / 6 GB swap**) and **BYOM** (register your own VPS/workstation/on-prem box).
- **Sleep-when-idle with full-state resume**: managed computers "auto-pause when idle and auto-resume when a new session targets them"; per Factory's announcement, resume restores **filesystem AND memory snapshots** "so local services can continue running as if they never paused," and "you'll only be charged while they're awake." [likely for the billing quote — factory.ai/news/droid-computers via search; docs page itself doesn't publish rates]
- Access without exposing SSH ports: `droid computer ssh` tunnels over **WebSocket through the daemon** with Factory-managed Ed25519 keys. (Directly relevant to Zeros' preview-URL WSS plan — same shape.)

**Results delivery.** Branch/PR via git like a local session; web-triggered "remote workspaces" let Droids do tasks from the browser. [verified/likely]

**Device/web/mobile.** Factory App (web), Droid CLI, Droid SDK, Slack integration (can pick which Droid Computer a Slack session targets). No mobile app found. [verified]

**Team/collab.** Teams plan: up to 150 members, custom usage limits, SSO/SAML/SCIM, ZDR option; Enterprise: dedicated compute with partitioned inference pool, audit logs, on-prem. [verified — docs.factory.ai/pricing]

**Pricing** [verified — docs.factory.ai/pricing]: **Pro $20/mo** (cloud & local background agents, rolling 5-hour/weekly/monthly rate limits); **Plus $100/mo** (~5x usage, **Droid Computers access**); **Max $200/mo** (~10x). Extra usage = prepaid USD credits, $10 minimum, never expire; free BYOK allowance on all plans. Company: raised **$150M Series C led by Khosla (April 2026), ~$1.5B valuation, $220M total**. [likely — theaiagentindex/press]

---

## 8. Amp (Sourcegraph)

**Execution model.** Primarily local (CLI + editor extensions) but **rebuilt in mid-2026 as "a distributed system with durable execution for the agent loop"**; **Orbs** (announced **June 30, 2026**) are "remote machines that can run Amp threads so your laptop can do something else or take a break." Multi-model routing (GPT-5.5, Claude Opus 4.8, fast models) per task. [verified — ampcode.com/manual + /news/agents-everywhere + chronicle]

**Results delivery.** Git/PR via normal workflow; the product's real output primitive is the **thread** (persistent conversation with all messages, context, tool calls).

**Device/web/mobile + sync.** **Remote Control** (June 4, 2026): manage *all* active threads from ampcode.com on desktop or **mobile web**, or a sidebar in the CLI — start work locally, continue from anywhere. Explicit design goal: "be happy and productive running many Amp agents simultaneously on long-running tasks." [verified]

**Team/collab — best-in-class thread sharing.** Thread visibility: **Private / Workspace-shared (default in a workspace) / Group-shared (enterprise) / Unlisted link**. Team activity feed at ampcode.com/feed with search filters (`label:`, `file:`, `author:`). Threads = "living memory"; teammates reuse successful solutions. [verified — ampcode.com/manual]

**Pricing.** **No subscription — pay-as-you-go credits at zero markup on LLM provider pricing for individuals**; $5 minimum purchase; workspace credits pool across members; **enterprise usage costs +50%** and adds SSO, zero data retention, analytics APIs; unused credits expire after 1 year of inactivity. [verified — ampcode.com/manual]

---

## 9. Charlie Labs

**Pivoted to "Daemons"** — always-on background AI processes rather than interactive agents: defined in **Markdown files with frontmatter + policies**, triggered by events or schedules, with deny-rules limiting actions and organizational memory that improves over time. Reference daemons: Issue Labeler, Bug Triage, Codebase Maintainer (dependency/security PRs), Librarian (docs). [verified — charlielabs.ai]

**Integrations/output.** GitHub, Linear, Slack, Sentry; outputs are **PRs, issue updates, comment reports, or explicit no-op decisions**. [verified]

**Pricing** [verified — charlielabs.ai/pricing]: **Free $0** (baseline daily+weekly usage limits), **Starter $50/mo (2.5x limits)**, **Team $200/mo (10x limits + priority Slack support)** — all plans have **unlimited team members and unlimited daemons**; billing is per-team with a shared usage meter and prepaid overage. Notable pattern: **price the work, not the seats**.

---

## 10. Conductor.build (the reference competitor)

- Mac app running parallel Claude Code/Codex agents in isolated git worktrees; **Conductor Cloud announced early May 2026** — same UI, agents spin up on hosted environments. [likely — The New Stack, June 2026]
- **Cloud Workspaces are built on Vercel Sandbox** — confirmed by Vercel's own case study: "Cloud Workspaces, Conductor's remote execution layer built on Vercel Sandboxes." Selection criteria per Conductor: fast spin-up, **snapshot support**, provider longevity, support quality. CEO Charlie Holtz: "Our users can't tell the difference between local and cloud because Vercel Sandboxes are super fast." [verified — vercel.com/blog]
- **The founder-context claim that Conductor uses Fly.io Sprites could NOT be confirmed** — public sources only confirm Vercel Sandbox. Fly Sprites (below) matches the *pattern* Conductor would want, but no public link found. [unverified]
- Pricing: **the app is free today; no published pricing**; paid collaboration features planned but not shipped (as of June 2026). Company: ~6 people, **$22M Series A**. [likely — The New Stack]

---

## 11. Infrastructure economics reference points (for the sleep-when-idle argument)

- **Fly.io Sprites** (launched ~Jan 13, 2026): "ball-point disposable computers" — Linux VMs created in **1–2 seconds**, root access, **100 GB durable object-storage-backed disk (billed only on blocks actually written)**, **auto-sleep when inactive and "cost practically nothing while asleep"**, checkpoint/restore that's "like a git restore" (metadata-only, fast), with Claude/Gemini/Codex pre-installed and configured for checkpoint/restore. Explicitly aimed at AI agents. [verified — fly.io/blog/design-and-implementation + devclass]
- **Daytona** (the current Zeros plan): usage-based, **per-second billing**: ~$0.0504/vCPU-hour, $0.0162/GiB-RAM-hour, $0.000108/GiB-storage-hour; $200 free compute credit. A 4-vCPU/8GB sandbox ≈ $0.33/hour while awake. [verified rates — daytona.io/pricing via search extraction; arithmetic mine]
- **Vercel Sandbox**: what Conductor chose; selling points were spin-up speed + snapshots + vendor durability.
- Implication: at these rates, the economics only work if workspaces sleep aggressively — which is exactly what Factory (pause/resume with memory snapshots), Devin (~0.1-ACU idle cap), and Sprites (near-zero idle cost) all implement.

---

## 12. Synthesis: 10 industry best practices for a cloud-workspace product

1. **PR-first output, with artifacts as proof-of-work.** Every product converges on branch → (draft) PR as the durable result (Codex, Copilot, Jules, Devin, Cursor, Claude web). The best add evidence: Cursor attaches screenshots/videos/logs; Devin attaches screen recordings; Claude embeds a session-URL trailer in every commit/PR so reviewers can open the exact agent run. Code that only lives in a cloud workspace is not a deliverable.
2. **Snapshot the environment after setup; never pay cold-start twice.** Codex caches container state 12h; Claude snapshots the filesystem post-setup-script for ~7 days; Devin's Machine Snapshots persist "Devin's laptop"; Cursor versions environment snapshots with rollback; Sprites make checkpoint/restore metadata-cheap. Invalidate on config change, not on a timer alone.
3. **Sleep-when-idle economics, resume-with-state.** Bill (and incur) compute only while the agent is awake: Factory pauses idle Droid Computers and resumes with filesystem+memory snapshots; Devin auto-sleeps after ~0.1 ACU idle; Sprites cost "practically nothing while asleep." This is the difference between $0.33/hr × 24/7 (≈$240/mo per workspace) and a few dollars.
4. **Never put real credentials in the sandbox.** Anthropic and OpenAI both use a scoped-credential git proxy (Anthropic's also restricts pushes to the working branch); Codex strips secrets before the agent phase; Cursor scopes secrets per environment; Factory tunnels SSH over WebSocket without exposing ports. Assume the agent's box is compromised by design.
5. **Two-phase network policy.** Full internet during setup, deny-by-default (or curated allowlist of package registries) during the agent phase, everything through an auditing proxy (Codex, Claude web). Makes "autonomous" safe to sell to teams.
6. **Mobile check-in is table stakes in 2026 — as monitor/steer/approve, not a full IDE.** Codex in the ChatGPT mobile app with turn-completion push notifications (May 2026); Claude sessions monitorable from the Claude mobile app; Cursor iOS app; GitHub mission control on mobile; Amp Remote Control on mobile web. The mobile job-to-be-done: notice a finished/blocked task, unblock it in one message.
7. **Local↔cloud session portability.** Claude's `--remote`/`--teleport` (conversation + branch move both ways), Devin CLI's "start local, hand off to cloud," Cursor's open-PR-in-IDE and remote desktop. The workspace should be a location, not a silo — this is Zeros' natural strength given file mirroring via Mutagen.
8. **Share the conversation, not just the diff.** Amp's workspace-shared threads + team feed and Claude's Team-visibility sessions treat the agent transcript as a team artifact ("living memory"). Almost nobody has real-time co-presence yet (Claude's shared views don't live-update) — genuinely open ground for Zeros' engine-owned, collaboration-native chat DB.
9. **Price model tokens as pass-through; don't margin-stack compute.** H1 2026 was an industry-wide repricing: Copilot to AI Credits at API rates (June 1, 2026), Codex to token metering (April 2, 2026), Cursor cloud agents at API pricing, Amp at zero-markup credits. Cloud compute is either absorbed into the subscription (Anthropic: "no separate compute charge"), a metered but small line (Devin: VM time "a small fraction"), or explicit (GitHub Actions minutes). Also common: subscription floor + prepaid overage credits (Factory, Charlie, GitHub, OpenAI), and **concurrency as the tier axis** (Jules 3/15/60 concurrent tasks; Factory parallelism/priority queue; Codex Pro 5x/20x).
10. **Meet work where it lives + let agents run unattended.** Task intake from issue assignment, Slack, Linear, Jira, PR comments (Copilot, Devin, Cursor, Charlie); event-driven autonomy is the 2026 frontier — Claude's Auto-fix PRs (webhook-driven CI/review fixes) and Routines, Charlie's 24/7 daemons, Copilot's scheduled triggers. A cloud workspace that only responds to a human typing in an app under-uses the fact that it's always on.

**Bonus pattern — repo-as-config:** environment definition lives in the repo and is versioned/shared (AGENTS.md for Jules/Codex, CLAUDE.md + .claude/ for Anthropic, `.cursor/environment.json` Dockerfile for Cursor). Team members inherit working environments for free.

**Positioning note for Zeros:** the market splits into (a) *ephemeral task-sandbox* products — one throwaway VM per task, PR out, no persistent workspace (Codex, Copilot, Jules, Claude web) — and (b) *persistent-machine* products — a long-lived environment you return to (Devin snapshots, Factory Droid Computers, Cursor self-hosted pools, Conductor Cloud, and Zeros' Daytona plan). Camp (b) is rarer and matches Zeros' whole-engine-in-sandbox design; its two make-or-break requirements per this survey are aggressive sleep/resume economics (#3) and durable results outside the workspace (#1 — Zeros' git-remote + export-blob durability plan addresses this).

---

## Sources

- https://developers.openai.com/codex/cloud
- https://developers.openai.com/codex/cloud/environments
- https://developers.openai.com/codex/pricing
- https://uibakery.io/blog/openai-codex-pricing
- https://openai.com/index/introducing-codex/
- https://openai.com/index/work-with-codex-from-anywhere/
- https://9to5mac.com/2026/05/14/openai-brings-codex-control-to-chatgpt-for-iphone-and-android/
- https://9to5mac.com/2026/05/21/openai-improves-codex-ios-experience-with-turn-completion-alerts-new-commands-more/
- https://code.claude.com/docs/en/claude-code-on-the-web
- https://www.anthropic.com/news/claude-code-on-the-web
- https://www.anthropic.com/engineering/claude-code-sandboxing
- https://docs.github.com/copilot/concepts/agents/coding-agent/about-coding-agent
- https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/
- https://github.blog/news-insights/company-news/welcome-home-agents/ (Agent HQ)
- https://jules.google/docs
- https://jules.google/docs/usage-limits/
- https://blog.google/innovation-and-ai/models-and-research/google-labs/jules-now-available/
- https://techcrunch.com/2025/08/06/googles-ai-coding-agent-jules-is-now-out-of-beta/
- https://www.morphllm.com/comparisons/jules-google-coding-agent
- https://devin.ai/pricing/
- https://devin.ai/cloud/
- https://docs.devin.ai/admin/billing
- https://docs.devin.ai/admin/billing/usage
- https://docs.devin.ai/onboard-devin/repo-setup (machine snapshots)
- https://cognition.com/blog/devin-for-terminal
- https://venturebeat.com/programming-development/devin-2-0-is-here-cognition-slashes-price-of-ai-software-engineer-to-20-per-month-from-500
- https://cursor.com/docs/cloud-agent
- https://www.buildfastwithai.com/blogs/cursor-cloud-agents-development-environments-2026
- https://factory.ai/pricing
- https://docs.factory.ai/pricing
- https://docs.factory.ai/cli/features/droid-computers
- https://factory.ai/news/droid-computers
- https://ampcode.com/manual
- https://ampcode.com/news/agents-everywhere
- https://ampcode.com/chronicle
- https://charlielabs.ai/
- https://charlielabs.ai/pricing/
- https://www.producthunt.com/products/daemons-by-charlie-labs
- https://vercel.com/blog/how-conductor-moved-parallel-coding-agents-from-the-laptop-to-the-cloud-with-vercel-sandbox
- https://thenewstack.io/conductor-cloud-ai-coding-agents/
- https://fly.io/blog/design-and-implementation/ (Sprites)
- https://devclass.com/2026/01/13/fly-io-introduces-sprites-lightweight-persistent-vms-to-isolate-agentic-ai/
- https://www.daytona.io/pricing
- https://northflank.com/blog/ai-sandbox-pricing
