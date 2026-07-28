# Cursor Cloud Agents (formerly "Background Agents") — how they work

Research date: 2026-07-02. Confidence tags: **[verified]** = confirmed on 2+ sources or official docs read directly; **[likely]** = single credible source; **[unverified]** = single secondary source, could not cross-check.

---

## 1. Timeline and naming

- **May 15, 2025 — Cursor 0.50**: "Background Agent" ships in early preview; agents "run in their own remote environments" and users can "view the status, send a follow-up, or take over" at any point. **[verified]** (Cursor changelog 0-50 + community writeups)
- **June 2025 — Cursor 1.0**: Background Agent goes GA for paid users. **[verified]** (Cursor changelog 1-0)
- **June 30, 2025**: Cursor Agents launch on **web and mobile** at cursor.com/agents (PWA installable on iOS/Android); TechCrunch covers the launch same day. **[verified]** (cursor.com/blog/agent-web + TechCrunch)
- **Oct 29, 2025 — Cursor 2.0**: "Background Agents have been renamed to **Cloud Agents**"; claims "99.9% reliability, instant startup"; new multi-agent editor runs "up to eight agents in parallel on a single prompt" using "git worktrees or remote machines to prevent file conflicts." Composer model launches. **[verified]** (cursor.com/changelog/2-0)
- **Oct 30, 2025**: "Cloud Agents" blog post; plan mode can send plans to be implemented in the cloud. **[verified]** (cursor.com/blog/cloud-agents)
- **Feb 24, 2026**: **Computer Use** for cloud agents — each agent gets a full desktop + browser in its VM; produces video/screenshot/log artifacts; users can take remote control of the agent's desktop. Cursor: "More than 30% of the PRs we merge at Cursor are now created by agents operating autonomously in cloud sandboxes." **[verified]** (cursor.com/blog/agent-computer-use + changelog 02-24-26)
- **Apr 2, 2026 — Cursor 3.0**: agent-first "Agents Window" interface; run agents "locally, in worktrees, in the cloud, and on remote SSH" from one surface; `/worktree`, `/best-of-n`. **[verified]** (cursor.com/changelog/3-0; note InfoQ article dated Apr 16, 2026 covers it)
- **June 2, 2026**: Engineering blog "What we've learned building cloud agents" (Josh Ma) — the key under-the-hood source (see §4). **[verified]**
- **June 17, 2026 — Cursor 3.7**: cloud environment setup by agent "in less than 10 minutes"; **cloud subagents** via `/in-cloud` (own VM + branch); `/babysit` to have a cloud agent prepare the PR; "Move agent sessions more reliably between your local computer and the cloud." **[verified]** (cursor.com/changelog/cloud-in-agents-window)
- **June 29, 2026**: **Cursor for iOS** public beta (iOS 26+, all paid plans): launch/manage cloud agents, Remote Control of desktop sessions, Live Activities, push notifications, review artifacts/diffs, merge PRs from phone. 75% off Composer 2.5 runs through July 5, 2026. **[verified]** (cursor.com/changelog/ios-mobile-app + cursor.com/blog/ios-mobile-app + press)
- A "Cursor 3.5" release on May 20, 2026 with headline Cloud Agents features is claimed by one blog (codersera). **[unverified]** — version number/date not cross-checked against official changelog.

## 2. What a cloud agent is (the model)

Same agent harness as the in-IDE agent, but the agent + code run server-side: "Each cloud agent runs in its own isolated VM with a full desktop environment" (docs). It clones your repo from GitHub/GitLab/Azure DevOps/Bitbucket Cloud, works on **its own branch**, pushes to your repo, and typically opens a "merge-ready PR with artifacts (videos, screenshots, and logs) to demo their changes." Runs continue when your laptop is closed. Cloud agents **always run in Max Mode** (no toggle). **[verified]** (cursor.com/docs/cloud-agent, /capabilities)

Positioning (cursor.com/cloud landing page): "Cloud agents control their own computers to build ambitious software" — pitched as "the next level of autonomy," "larger tasks over longer timescales." **[verified]**

## 3. User flows

### 3.1 Kick-off surfaces **[verified]** (docs/cloud-agent)
1. **Cursor desktop**: pick "Cloud" in the agent dropdown (or send a plan-mode plan to the cloud; or `/in-cloud` to spawn a cloud subagent from a local session).
2. **Web**: cursor.com/agents in any browser (PWA installable).
3. **iOS app** (public beta since June 29, 2026); Android app "planned" — Android uses mobile web/PWA.
4. **Slack**: `@Cursor <prompt>` (see §7).
5. **GitHub/Bitbucket**: comment `@cursor` on PRs/issues. **Linear**: assign/mention @cursor. **Microsoft Teams** and **Jira** also listed on cursor.com/cloud.
6. **API** (`POST /v1/agents`) and **Automations** (cron schedules + event triggers).

### 3.2 Watch progress
- Live chat stream of the agent working; send follow-ups mid-run; view subagent child transcripts. Mobile: "a push notification when an agent finishes a turn," Live Activities track "up to eight agents at once" on lock screen/Dynamic Island. **[verified]** (docs web-and-mobile)
- Dashboard shows which environment each agent used, with environment version history. **[verified]**

### 3.3 Review + ship
- "Read full diffs, commits, deployments, and review threads. Then merge with squash, mark ready, update the branch, toggle auto-merge, publish, close, or hand a failing check back with Fix with Agent" — all from web/mobile. **[verified]** (docs web-and-mobile)
- **Artifacts**: screenshots, screen recordings, logs proving the change works; can be embedded in PR descriptions ("Artifacts in PR descriptions use long, unguessable URLs that are viewable without authentication" — a notable security tradeoff). **[verified]** (docs capabilities)
- **Remote desktop control**: user can take over the agent's VM desktop to click around the running app "without checking out the branch locally," then hand control back. **[verified]**
- **CI auto-fix**: "Cloud Agents automatically try to fix CI failures in PRs they create" (GitHub Actions only; stops after 10 attempts or if a human pushes/follows up; `@cursor autofix off` to disable). **[verified]** (docs capabilities)

### 3.4 Take over locally / handoff
- From web/Slack there's an "**Open in Cursor**" action; back at the desktop you "pick up the agent's work in Cursor to review the changes, add follow-up instructions, or directly make edits inline." **[verified]** (blog agent-web, Slack docs)
- Cursor 3.x made handoff bidirectional: "An agent session running locally can be moved to the cloud to continue working while the developer is offline. Conversely, a cloud session can be pulled back to local for hands-on editing and testing." **[verified]** (InfoQ on Cursor 3 + changelog 3.7)
- **`/remote-control`** (iOS): inverse of cloud agents — "The agent loop moves to the cloud while its tools keep running on your machine, so it reads your files, runs your tests, and uses your local setup the same way," letting the phone drive a session whose tools execute on the desktop. **[verified]** (docs web-and-mobile)

## 4. Under the hood

### 4.1 Infrastructure **[verified unless noted]**
- Cloud agents run "inside our AWS infrastructure in isolated VMs"; code sits on the VM disk while the agent is accessible. (docs security-network)
- Reco security research (July 16, 2025) revealed the earlier concrete stack: **Docker containers on single-tenant AWS EC2 instances** (one instance per user), ~1TB storage provisioned, custom Docker image artifactory, GitHub Server-to-Server token scoped to user repos inside the VM. They escaped the container to the EC2 host; "Cursor confirmed that relevant safeguards were in place" and that AWS roles/VPC were "well-defined and heavily restricted." **[verified for mid-2025; architecture has evolved since]**
- June 2, 2026 engineering blog (the best architecture source):
  - "dedicated virtual machines, with their own environments, dependencies, and network access."
  - **The agent loop does NOT run on the VM** — it runs in **Temporal** workflows: "Because the agent loop runs in Temporal rather than on VMs, we can manage pod lifecycles independently and run agents across different kinds of pods — including optimizations like readonly VMs or prewarmed VMs."
  - Built "methods to efficiently hibernate and resume agent VMs between messages" and "pipelines to quickly and durably checkpoint, restore, and fork VM images."
  - Reliability journey: early beta was "one 9 of reliability" on a work-stealing architecture; after moving to Temporal ("retry mechanisms, scheduling work across machines, durability across node failures") they are "past two 9s"; Temporal handles "more than 50 million actions per day across more than 7 million unique workflows."
  - Workflows changed from "eternal" agent workflows to "multiple shorter ones that exit after completing a single task, which makes version upgrades easier."
  - Architecture principle: "agent loop, machine state, and conversation state as decoupled components."
  - Conversation state: "efficient append-only storage mechanism that streams conversation updates," with clients able to "detect [a retry], rewind its stream, and show the new data instead of the old."
  - Adoption stat: "More than 40% of our PRs come from cloud agents, and growing" (up from 30% in Feb 2026).
  - Even for self-hosted runtimes ("My Machines", "Self-Hosted Pool"), "the agent loop still runs in Cursor's cloud." (docs)
- Default VM: "isolated Ubuntu machines" with a default VM profile of unspecified size; Enterprise can request bigger limits. Exact vCPU/RAM not published. **[verified that specs are unpublished]**

### 4.2 Repo + environment setup **[verified]** (docs cloud-agent/setup)
- Agent clones the repo(s) fresh each run (Cursor "manages the workspace and checks out the correct commit" — Dockerfiles must not COPY the project).
- **Three ways to define an environment**: (1) agent-led setup (agent installs deps interactively, you watch via shared terminal; "less than 10 minutes" claim in 3.7), (2) a saved **snapshot**, (3) a **Dockerfile**, all wired through `.cursor/environment.json`.
- `environment.json` fields: `snapshot` (saved VM snapshot id), `build.dockerfile`/`build.context` (paths relative to `.cursor`), `install` (idempotent update command, e.g. `npm install` — "It can run more than once, and it may run on partially cached state"), `start` (process after install), `terminals` (named tmux sessions for dev servers etc.).
- **Auto-checkpointing**: after `install` runs, "if it took more than a few seconds to run, Cursor will take an internal checkpoint snapshot and will attempt to start future cloud agents from this checkpoint." Snapshots fall back gracefully — "Agents no longer hard fail when Cursor can recover from an environment configuration issue."
- Environment resolution order: repo `.cursor/environment.json` → personal saved environment → team saved environment.
- **Multi-repo environments**: select multiple repos when creating the environment; "Cursor clones each selected repo into the agent machine and reuses the environment for future agent runs"; agent opens PRs in each repo it changes.
- Environment snapshots (encrypted VM disk copies) are retained for a "maximum of 90 days of inactivity," extended on each agent start/resume.

### 4.3 Secrets **[verified]** (docs setup + security-network)
- "The easiest way to manage secrets is through cursor.com. These are exposed to the cloud agent as environment variables." Environment-scoped secrets apply to every repo in a multi-repo environment but "are not available to other environments."
- **Runtime Secrets** are redacted as `[REDACTED]` in tool results/transcripts (but visible to a user in the terminal); **Build Secrets** exist only during Docker builds via secret mounts. All encrypted at rest and in transit.
- AWS access: agents can assume a customer IAM role via `CURSOR_AWS_ASSUME_IAM_ROLE_ARN`; "Cursor assumes the role with STS credentials that expire after 1 hour," refreshed on wake when near expiry. TOTP 2FA logins supported via a stored TOTP secret + `oathtool`.
- Commits: "Cloud agents sign every commit with a HSM-backed Ed25519 key" → "Verified" badge on GitHub/GitLab. Git credentials egress via a proxy on a narrow set of 3 published IPs.

### 4.4 Network + privacy **[verified]** (docs security-network)
- Internet: "The agent has internet access by default" and the agent "auto-runs all terminal commands" without per-command approval — docs explicitly acknowledge the prompt-injection/"data exfiltration risk."
- Network modes: "Allow all network access," "Default + allowlist," "Allowlist only" (with carve-outs for Cursor services + SCM). Team admins can lock the setting; per-environment overrides exist.
- **Privacy Mode**: cloud agents DO work with (current) Privacy Mode — code isn't trained on and prompts/environments aren't collected for product improvement; but code must be stored on Cursor's VMs while the agent runs ("Cloud Agents require temporary code storage while running"). **Privacy Mode (Legacy)** — the strict no-cloud-storage variant — is NOT supported for cloud agents. Quirk: "If you disable privacy mode when starting a cloud agent, then enable it during the agent's run, the agent continues with privacy mode disabled until it completes." Conversation history is kept indefinitely by default (deletable via API).

### 4.5 Capabilities and limits on the VM **[verified]** (docs capabilities / cloud-agent)
- MCP servers supported; HTTP MCP recommended because "server configurations are never present in the cloud agent's VM" (stdio MCP runs inside the VM and can see env vars). Built-in "Cursor Cloud" MCP gives the agent self-diagnostics (transcripts, setup logs, related runs).
- Hooks: repo `.cursor/hooks.json` command hooks run; IDE-specific and client-side hooks (`Tab` hooks, `workspaceOpen`, `sessionStart`, `beforeSubmitPrompt`) don't; user-level `~/.cursor/hooks.json` unavailable ("cloud VMs don't have access to your local home directory").
- Computer Use requires Debian/Ubuntu-based images; enabled by default for automations (Feb 24, 2026); enterprise admins can disable it.

## 5. Cross-device sync (what lives in Cursor's cloud)

- The session itself — conversation stream, agent state, diffs, artifacts, environment metadata — is server-side, so **any device just renders it**: "Agents you start anywhere appear in the mobile inbox automatically"; iOS-started runs tagged `source: iosApp`. **[verified]** (docs web-and-mobile)
- The June 2026 blog explains the mechanism: append-only conversation storage streamed to clients, with rewind-on-retry semantics; "agent loop, machine state, and conversation state as decoupled components." **[verified]**
- Code changes reach other devices via **git** (branch pushed to your remote), not via file sync; "taking over locally" = checking out the agent's branch / "Open in Cursor." **[verified]**
- Handoffs: local→cloud (send session/plan to cloud), cloud→local (pull session down), desktop→phone (`/remote-control`, agent loop moves to cloud, tools stay on the desktop). **[verified]**

## 6. Team features

- **Prerequisite**: an account admin must connect source control (GitHub/GitLab/Bitbucket/Azure DevOps) before anyone can launch cloud agents; users need a paid plan + repo read-write access. **[verified]** (docs)
- **Visibility**: Cursor staff (forum, Mar 10, 2026): "Team members can already view each other's cloud agents at cursor.com/agents if they have repository access," but by default cannot interact/follow-up. **[verified]**
- **Team follow-ups** setting (dashboard): Disabled (creator-only) / "Service accounts only" / "All" (any team member can message any agent) — so shared interaction is now opt-in. **[verified]** (docs cloud-agent/settings)
- **Environments are team assets**: saved environments are "available to your team," scoped to one repo or a group; version history, "Update with Agent," restore; admins can restrict rollback to admin-only; "an audit log captures every action team members take on environments." **[verified]**
- **Service Accounts**: team-scoped API keys for shared automations — "available on the Enterprise plan only" (staff, Mar 2026). Team-Owned automations run under the team's shared service account and bill to the team pool. **[verified]**
- **Seats** (June 2026 Teams revamp): Standard $40/user/mo, Premium $120/user/mo, plus free Unpaid Admin seats; team plans add a "Cursor Token Rate of $0.25 per million tokens" on non-Auto agent requests atop model API pricing; new spend alerts to Slack/email. Cursor estimates the June 2026 changes "will lower costs for 90% of teams" (effective for renewals from July 1, 2026). **[verified]** (docs models-and-pricing + finout/eesel writeups)
- From launch, "Team members with repository access can review agent diffs, pull requests, and even create pull requests directly from the web interface." **[verified]** (blog agent-web)
- Enterprise-only knobs: computer-use disable, service accounts, custom VM sizing, secret-management admin controls, code-attribution settings. **[verified]** (docs + changelog 3-0)

## 7. Slack / Linear / Automations / API

- **Slack** **[verified]** (docs integrations/slack): `@Cursor <prompt>` in a channel; model choice ("@Cursor with opus, fix the login bug"), repo targeting ("in cursor-app"), inline options `branch=` and `autopr=`; channel-level defaults via `@Cursor settings`; "When Cloud Agent completes, you get a notification in Slack and an option to view the created PR in GitHub," plus "Open in Cursor" during execution. Requires usage-based pricing enabled. 21 Slack permissions requested. Privacy Mode (Legacy) unsupported.
- **Automations** **[verified]** (docs cloud-agent/automations): cloud agents "on a schedule or in response to events from GitHub, GitLab, Slack, webhooks, Linear, and more" (+ Sentry, PagerDuty); created from Agents Window, cursor.com/automations, `/automate`, or marketplace templates; Private / Team Visible / Team Owned scopes; "always run in Max Mode because they run as cloud agents."
- **API** **[verified]** (docs cloud-agent/api/endpoints): `POST /v1/agents` (params: `prompt.text`, `repos` w/ `startingRef` or `prUrl`, `model.id`, `autoCreatePR`, `envVars`, `mcpServers`, `customSubagents`, `workOnCurrentBranch`); follow-ups, status, streaming endpoint, cancel, archive/delete, artifact download. Basic/Bearer auth with user API keys or service accounts. Webhooks "coming soon" in v1 (legacy v0 API has them).

## 8. Pricing

- Individual plans (2026): **Pro $20/mo ($20 API usage included), Pro+ $60/mo ($70 included), Ultra $200/mo ($400 included)**; separate cheaper pool for Auto/Composer usage. **[verified]** (docs models-and-pricing)
- **Cloud agents are charged at API pricing for the selected model** and **always run Max Mode**; "Max Mode is billed at the model's API rate" (legacy request-based plans had a 20% Max Mode surcharge). **[verified]** (docs)
- Billing order (Cursor staff correction, Apr 30, 2026): "Cloud agents actually do consume included API usage first before moving on to on-demand usage." On-demand (usage-based) billing must be enabled and a spend limit set before first use; "The spend-based rate limiter requires at least ~$2 of headroom under your hard limit before a Cloud Agent run will start." Note the same staffer first answered incorrectly (Apr 7) that they were separate — even Cursor employees found this confusing. **[verified]** (forum.cursor.com/t/156843)
- Real user datapoint: first cloud-agent run with Claude Opus cost $0.21; Composer 2 runs drew from included usage. **[likely]** (single forum user)
- Third-party estimate: one agent run on a ~50k-line codebase can eat "roughly 22.5% of a $20 credit pool." **[unverified]** (secondary blogs; no methodology shown)
- Token prices (API pool, mid-2026): Composer 2.5 $0.50/M in, $2.50/M out; Claude Sonnet 5 $3/$15 (promo through Aug 2026); GPT-5.4 $2.50/$15; Gemini 3.5 Flash $1.50/$9. **[verified]** (docs models-and-pricing)
- Open question raised by users, never answered by staff: whether VM/compute time is charged beyond tokens (currently it appears VM time is free / bundled into token pricing). **[unverified]**

## 9. Known limitations and criticisms

- **Environment setup is the make-or-break**: Cursor itself: "The single biggest factor in cloud agent output quality is ensuring it has a full development environment… In the cloud, you have to reconstruct all of that from scratch, and it's surprisingly hard to tell when you haven't done it perfectly." (June 2026 blog) **[verified]**
- Forum complaints (2026): environment setup burns compute/time "even if you don't use it"; "Cursor Web/Cloud is horribly slow" thread; confusion about simultaneous-agent vs environment limits. **[verified threads exist; representativeness unknown]**
- **Cost unpredictability** is the loudest criticism: HN commenter on Cursor 3: spending "$2k a week with premium models" before switching to Claude Code Max at "1/10th the price"; documented cases of "subscriptions depleting in a single day"; cloud agents billed at API pricing was "not clearly communicated at signup." **[likely]** (HN/InfoQ + finout/eesel roundups)
- **Product-direction pushback** on agent-first UI (Cursor 3): "This view makes you lose any connection to your code… I specifically stay with Cursor because it's so good at being an IDE" (Reddit); "Agent-first needs ambient, background autonomy. Code-first needs precise, synchronous control… you're always making tradeoffs that frustrate one half of your users" (HN). **[verified quotes via InfoQ]**
- **Security surface**: agent auto-runs all commands with internet access → acknowledged exfiltration risk; July 2025 Reco research achieved container→EC2-host takeover from the agent terminal; 2025–2026 saw repeated prompt-injection CVEs (e.g. CVE-2026-50548/50549, zero-click command execution via hidden instructions in MCP/web content, reported July 2026). **[verified]**
- **No local file mirroring**: the only path from cloud VM to your machine is git (branch/PR) or manual takeover — there is no Mutagen-style continuous file sync to the laptop. **[verified by absence in all docs]**
- Other gaps: Android app still "planned" (PWA only); webhooks missing from API v1; CI auto-fix is GitHub Actions only; user-level hooks/config don't reach the VM; Privacy Mode Legacy incompatible; default VM size unpublished and only Enterprise can raise it; conversation history retained indefinitely by default. **[verified]**

## 10. Notes relevant to Zeros (facts, not recommendations)

- Cursor's architecture **separates the agent loop (Temporal, Cursor cloud) from the execution VM** — the opposite of Zeros' Daytona plan (full engine in the sandbox). Their stated payoff: independent pod lifecycles, prewarmed/readonly VMs, upgrades without killing sessions, two-9s reliability at 50M actions/day.
- Their durability story = append-only conversation store in their cloud + git for code + 90-day encrypted VM snapshots; artifacts (video/screenshot/log) are first-class review objects served from unguessable public URLs.
- Cross-device "sync" is trivially solved by keeping state server-side and streaming; devices are pure renderers; local takeover is git checkout, not file sync.
- Team collaboration is still shallow as of mid-2026: view-others'-agents by repo access, opt-in follow-ups, Enterprise-only service accounts — no true shared workspace/live co-editing of an agent session.
- Environment definition converged on repo-committed config (`.cursor/environment.json`) + auto-captured snapshots + agent-led setup with human-watchable shared terminal; snapshot fallback logic ("never hard fail") was worth calling out in their changelog.
- Monetization: no charge for VM time (as far as disclosed) — tokens only, always Max Mode, drawn from plan-included API usage then on-demand with mandatory spend limit.

## Sources

- https://cursor.com/docs/cloud-agent — Cloud Agents overview (fetched 2026-07-02)
- https://cursor.com/docs/cloud-agent/setup — Cloud Environment Setup / environment.json / secrets
- https://cursor.com/docs/cloud-agent/security-network — Security & Network (AWS VMs, retention, privacy mode, network modes, commit signing)
- https://cursor.com/docs/cloud-agent/capabilities — computer use, artifacts, MCP, CI auto-fix
- https://cursor.com/docs/cloud-agent/settings — dashboard settings, team follow-ups, network modes, audit log
- https://cursor.com/docs/cloud-agent/automations — Automations (triggers, scopes, Max Mode billing)
- https://cursor.com/docs/cloud-agent/api/endpoints — Cloud Agents API v1
- https://cursor.com/docs/cloud-agent/web-and-mobile — web/mobile flows, /remote-control, cross-device inbox
- https://cursor.com/docs/integrations/slack — Slack integration
- https://cursor.com/docs/integrations/github — GitHub app permissions
- https://cursor.com/docs/models-and-pricing — plans, token prices, Max Mode billing
- https://cursor.com/blog/agent-web — web/mobile launch (2025-06-30)
- https://cursor.com/blog/cloud-agents — Cloud Agents post (2025-10-30)
- https://cursor.com/blog/agent-computer-use — computer use (2026-02-24)
- https://cursor.com/blog/cloud-agent-lessons — "What we've learned building cloud agents" (2026-06-02, Josh Ma)
- https://cursor.com/blog/ios-mobile-app — iOS app launch
- https://cursor.com/changelog/0-50 — Background Agent preview (2025-05-15)
- https://cursor.com/changelog/1-0 — Background Agent GA
- https://cursor.com/changelog/2-0 — rename to Cloud Agents (2025-10-29)
- https://cursor.com/changelog/3-0 — Agents Window (2026-04-02)
- https://cursor.com/changelog/cloud-in-agents-window — v3.7 cloud setup + /in-cloud subagents (2026-06-17)
- https://cursor.com/changelog/02-24-26 — Cloud Agents with Computer Use
- https://cursor.com/changelog/ios-mobile-app — iOS public beta (2026-06-29)
- https://cursor.com/cloud — Cloud Agents landing page
- https://forum.cursor.com/t/team-level-cloud-agents/153717 — staff answer on team visibility + service accounts (2026-03)
- https://forum.cursor.com/t/what-is-the-pricing-structure-for-using-cloud-agents/156843 — staff answers on billing (2026-04)
- https://forum.cursor.com/t/cloud-agent-environment-setup-is-time-consuming-even-if-you-dont-use-it/155216 — setup-cost complaint
- https://forum.cursor.com/t/cursor-web-cloud-is-horribly-slow/155735 — performance complaint
- https://www.infoq.com/news/2026/04/cursor-3-agent-first-interface/ — Cursor 3 coverage + community reaction quotes
- https://techcrunch.com/2025/06/30/cursor-launches-a-web-app-to-manage-ai-coding-agents/ — web app launch coverage
- https://www.reco.ai/blog/hijacking-cursors-agent-how-we-took-over-an-ec2-instance — EC2/Docker architecture research (2025-07-16)
- https://thehackernews.com/2026/07/critical-cursor-flaws-could-let-prompt.html — CVE-2026-50548/50549 prompt-injection flaws
- https://www.finout.io/blog/what-happened-to-cursor-pricing-2026-guide-5-cost-cutting-tips — pricing criticism roundup
- https://www.eesel.ai/blog/cursor-pricing — plan comparison
- https://www.oflight.co.jp/en/columns/cursor-ios-mobile-coding-agent-2026-06 — iOS launch details
- https://www.digitalapplied.com/blog/cursor-3-agents-window-complete-guide — Cursor 3 guide (secondary)
- https://codersera.com/blog/cursor-ide-complete-guide-2026/ — "Cursor 3.5" claim (unverified)
