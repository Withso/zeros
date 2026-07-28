# Claude Code on the web / cloud sessions — how they work (as of 2026-07-02)

Research notes for the Zeros cloud-workspaces project. Confidence tags: **[verified]** = confirmed in official Anthropic docs/announcements or 2+ independent sources; **[likely]** = single credible source or strong inference; **[unverified]** = single third-party source, not cross-checked.

---

## 1. What it is (one paragraph)

Claude Code on the web (claude.ai/code) runs full Claude Code sessions on **Anthropic-managed cloud VMs** instead of the user's laptop. You connect a GitHub repo, type a task, and Claude clones the repo into an isolated VM, works autonomously, pushes a branch, and lets you review the diff / create a PR from the browser or the Claude mobile app. Sessions **persist when you close the browser/laptop** and can be pulled down into a local terminal ("teleport") or pushed up from the Desktop app. **[verified — code.claude.com docs + claude.com announcement]**

Anthropic's framing: it's the same Claude Code harness everywhere — "Claude Code behaves the same everywhere. What changes is where code executes and whether your local config is available." **[verified — web quickstart doc]**

---

## 2. Timeline / status

- **Oct 20, 2025** — Launched as a **research preview** for Pro ($20/mo) and Max ($100/$200) users; also on the Claude iOS app as an "early preview." TechCrunch reported Claude Code had grown 10x in users since May 2025 and was >$500M annualized revenue at the time. **[verified — TechCrunch 2025-10-20 + anthropic.com announcement]**
- **Nov 12, 2025** — Expanded to **Team and Enterprise** users with premium seats. **[verified — announcement update note]**
- **~Nov 2025** — Sandboxing tech blog + open-source `anthropic-experimental/sandbox-runtime` released; sandboxing "safely reduces permission prompts by 84%". **[verified — anthropic.com/engineering/claude-code-sandboxing]**
- **March 2026** — **Auto-fix PRs** on web (wk13); **Android app** ships (third-party reporting). **[verified for auto-fix; likely for Android date]**
- **April 2026** — **Ultraplan** early preview (draft plans in a cloud session, review in browser, wk15); **Routines** (scheduled/API/GitHub-triggered cloud agents, wk16); **Ultrareview** public research preview (multi-agent cloud code review, wk17); claude.ai/code UI redesign with sessions sidebar + drag-and-drop layout (wk17). **[verified — code.claude.com/docs/en/whats-new]**
- **May–June 2026** — Trusted Devices (beta, Team/Enterprise device-bound Remote Control auth); Artifacts on web sessions (beta, Team/Enterprise); "How we contain Claude" engineering post (May 25, 2026); Managed Agents announced around Code with Claude SF (May 2026). **[verified]**
- **As of mid-2026 the whole surface is still labeled "research preview."** **[verified — docs note, fetched 2026-07-02]**

---

## 3. User flows

### 3.1 Start a session from the web (claude.ai/code)
1. Sign in at claude.ai/code → prompted to **install the Claude GitHub App** and grant repo access. **[verified]**
2. **Create an environment** (form fields: Name, Network access level, Environment variables in `.env` format, Setup script). Defaults are fine for a first project. **[verified]**
3. Pick a **repository + branch** from a selector under the input box (can add multiple repos to one session), pick a **permission mode** (default **Accept edits**; also **Plan mode** and **Auto mode**; NO "Ask" and NO "Bypass permissions" in cloud — "Bypass permissions is not available because the cloud environment is already sandboxed"). **[verified — quickstart + desktop docs]**
4. Type the task, press Enter. Each task gets **its own session and its own branch**; parallel tasks don't wait on each other. **[verified]**

Session run lifecycle (per docs): (1) clone repo to Anthropic-managed VM + run setup script, (2) configure network per environment access level, (3) Claude works — you can watch and steer in real time or walk away, (4) Claude pushes its branch to GitHub; the session stays open for review/PR/iteration. **[verified]**

**Pre-fill via URL params**: `https://claude.ai/code?prompt=...&repositories=owner/repo&environment=...` (also `prompt_url` for long prompts) — designed so third-party tools (issue trackers, etc.) can deep-link into a new session. **[verified]**

### 3.2 GitHub connection — two methods
| Method | Mechanics | Notes |
|---|---|---|
| **Claude GitHub App** | OAuth install during web onboarding | Required for Auto-fix (PR webhooks) |
| **`/web-setup` (CLI)** | Syncs your local `gh` CLI token to your Claude account | For devs who already use `gh`; creates a default cloud environment |

Important nuance: **a cloud session can access ANY repository the connected GitHub account can see**, not just repos the App is installed on — "App installation … is not a session-level access control." Admins must restrict access on GitHub itself. **[verified — docs note]**

### 3.3 Start from the terminal (CLI)
- `claude --remote "Fix the auth bug"` → creates a new cloud session; **clones your current repo's GitHub remote at your current branch** (push local commits first — the VM clones from GitHub, not your machine). One repo per `--remote`. **[verified]**
- As of v2.1.195 the CLI shows a **live provisioning checklist** (cloning, setup script) and queues messages typed during provisioning. **[verified]**
- **No-GitHub fallback**: from a repo without GitHub, `claude --remote` **bundles the local repo and uploads it directly** (full history + uncommitted tracked changes; must be <100 MB, with graceful fallbacks to single-branch then squashed snapshot; untracked files excluded; can't push results back without GitHub auth). Force with `CCR_FORCE_BUNDLE=1`. **[verified]**
- Monitor sessions with `/tasks` in the CLI; steer from claude.ai or mobile. **[verified]**
- Recommended pattern in docs: "**Plan locally, execute remotely**" — plan in `--permission-mode plan` locally, commit the plan file, then `claude --remote "Execute the migration plan in docs/migration-plan.md"`. **[verified]**

### 3.4 Watch, review diffs, create PRs
- Each session shows a **diff indicator** (`+42 -18`); clicking opens a **diff view** (file list left, changes right).
- **Inline comments**: select any diff line, type feedback; comments queue and are bundled with your next message so Claude gets "at src/auth.ts:47, don't catch the error here" with location context. **[verified]**
- **Create PR** button offers: full PR, draft PR, or jump to GitHub's compose page with generated title/description. Session stays live after PR creation. **[verified]**
- **Auto-fix PRs**: Claude subscribes to GitHub webhooks on a PR (via the GitHub App) and reacts to CI failures and review comments — pushes clear fixes, asks about ambiguous ones, ignores duplicates. Per-PR toggle. Enable from web CI status bar, `/autofix-pr` in terminal, mobile ("watch this PR..."), or by pasting a PR URL. Cannot detect merge conflicts (GitHub emits no webhook for base-branch advance). Claude's GitHub replies post **under your GitHub account** but labeled as from Claude Code — docs warn this can trigger comment-driven automation (Atlantis, Terraform Cloud). **[verified]**

### 3.5 Teleport (cloud → local terminal)
- `claude --teleport` (interactive picker), `claude --teleport <session-id>`, `/teleport` or `/tp` inside a session, press `t` in `/tasks`, or **"Open in CLI"** on the web (copies a command). **[verified]**
- Mechanics: verifies you're in a checkout of the same repo (not a fork), requires a clean working tree (prompts to stash), **fetches and checks out the cloud session's branch**, and **loads the full conversation history into your terminal**. Requires the branch to have been pushed and that you're signed in to the **same claude.ai account**. **[verified]**
- Distinct from `--resume` (local history only). Teleport requires claude.ai subscription auth — not available via API key/Bedrock/Vertex/Foundry. **[verified]**
- Teleport was reportedly introduced in Claude Code **v2.1.0**; Boris Cherny (Claude Code creator) publicly promotes the loop: "Move sessions back and forth between mobile/web/desktop and terminal. Run `claude --teleport` … Or run `/remote-control` to control a locally running session from your phone/web." **[likely for version number (ClaudeLog, not cross-checked); verified for the quote — Threads post]**
- **Handoff is one-way from the CLI**: you can't push an existing terminal session to the cloud (`--remote` creates a NEW cloud session). There's an open GitHub feature request (#56687) for the inverse. The **Desktop app** DOES have it: **"Continue in" menu → Claude Code on the Web** pushes your branch, generates a conversation summary, and creates a new cloud session with full context (requires clean working tree). **[verified — docs + desktop docs]**

### 3.6 Mobile
- Claude iOS app has a **Code tab**: start sessions, monitor, steer, get push notifications; Android app arrived ~March 2026. All coding executes in Anthropic's cloud sandboxes (or mirrors a local Remote Control session). **[verified for iOS/flows; likely for Android date]**
- **Dispatch** (Desktop + mobile pairing, Pro/Max only, not Team/Enterprise): message a task from your phone; it can spawn a Desktop Code session on your machine. **[verified — desktop docs]**
- Mobile **push notifications** (v2.1.110+): Claude decides when to push (task finished / needs decision); configurable "Push when Claude decides" and "Push when actions required" toggles. **[verified]**

### 3.7 Session management & sharing
- Sessions live in a sidebar at claude.ai/code; **archive** (hidden but running sessions keep running) and **delete** (permanent, removes session event data). **[verified]**
- **Sharing**: Team/Enterprise: visibility **Private | Team** (team = whole claude.ai org; repository-access verification ON by default; Slack-created sessions auto-shared to Team). Pro/Max: **Private | Public** (public = any logged-in claude.ai user; repo-access verification OFF by default; docs warn sessions may contain code/credentials from private repos). Recipients see latest state on open, **not real-time**. **[verified]**
- Collaboration is **read-share only** — no evidence of multi-user co-driving a session (recipients view; the owner steers). **[likely — absence in docs]**

---

## 4. The sandbox / cloud environment (mechanics)

### 4.1 Isolation
- "Each session runs in an isolated, Anthropic-managed VM." Code is analyzed/modified inside the VM before PRs are created. Cloud environments are **automatically terminated after session completion**; all operations in cloud environments are **logged for compliance and audit**. **[verified — security doc]**
- For contrast, Anthropic's May 2026 "How we contain Claude" post details three containment patterns: claude.ai code execution = **gVisor container + seccomp** on isolated infra; local Claude Code = OS sandboxing (**Seatbelt on macOS, bubblewrap on Linux**); Claude Cowork = **full VM via Apple Virtualization framework / Hyper-V HCS**. Third-party writeups describe web sessions as "gVisor-style runtime," but Anthropic's own cloud-session docs only say "isolated VM." **[verified for the three patterns; unverified that web sessions specifically use gVisor]**
- Design principle quote: "Design for containment at the environment layer first, then steer behavior at the model layer." **[verified — how-we-contain-claude]**

### 4.2 VM spec & tooling
- Resource ceilings (approximate, may change): **4 vCPUs, 16 GB RAM, 30 GB disk**. Bigger workloads → use Remote Control on your own hardware. **[verified]**
- Base: **Ubuntu 24.04**, setup scripts run **as root**. Pre-installed: Python 3.x (pip/poetry/uv/pytest/ruff...), Node 20/21/22 (npm/yarn/pnpm/bun), Ruby 3.1–3.3, PHP 8.4, OpenJDK 21, Go, Rust, GCC/Clang, **Docker + docker compose (dockerd available)**, PostgreSQL 16, Redis 7.0, git/jq/ripgrep/tmux/vim. `check-tools` command (cloud-only) lists exact versions. Bun has known proxy issues. `gh` CLI NOT pre-installed. **[verified]**
- **Custom base images are NOT supported** — you layer on top with setup scripts or run your image as a side container via docker compose. **[verified]**

### 4.3 Environments, setup scripts, caching
- An **environment** = named config of {network access level, env vars (.env format, plaintext-visible to anyone who can edit the environment), setup script}. Managed in the web UI; `/remote-env` in CLI picks the default for `--remote`. **[verified]**
- **No dedicated secrets store yet** — docs explicitly: "A dedicated secrets store is not yet available… If you need secrets in a cloud session, add them as environment variables with that visibility in mind." **[verified]**
- **Setup script**: Bash, runs before Claude Code launches, must finish in ~**5 minutes** or cache-building fails; non-zero exit blocks the session.
- **Environment caching**: after first successful setup, Anthropic **snapshots the filesystem** and reuses it — new sessions start with deps/Docker images already on disk; cache rebuilds on script/network-config change or after ~**7 days**; cache stores files, not running processes. **[verified]**
- **SessionStart hooks** (repo `.claude/settings.json`) run on every start/resume, both local and cloud; `CLAUDE_CODE_REMOTE=true` env var distinguishes cloud. **[verified]**

### 4.4 What config carries over (the sync model for settings)
Everything **committed to the repo** is available (CLAUDE.md, `.claude/settings.json` hooks, `.mcp.json`, `.claude/rules|skills|agents|commands`, declared plugins). Org policy arrives via **server-managed settings** fetched from Anthropic's servers. **User-level** `~/.claude/*` (memory, skills, MCP servers added via `claude mcp add`, user plugins) does NOT carry over — commit it to the repo instead. Skills enabled on claude.ai load automatically. Interactive auth (AWS SSO) unsupported. **[verified]**

### 4.5 Network access
- Per-environment levels: **None** (no outbound; note: Claude can still talk to the Anthropic API, "which may allow data to exit the VM"), **Trusted** (default; allowlist only), **Full** (any domain), **Custom** (own allowlist ± defaults, wildcard `*.domain` support). **[verified]**
- **Trusted default allowlist** is large (~150+ domains): Anthropic services, GitHub/GitLab/Bitbucket, Docker/GCR/GHCR/ECR registries, GCP/Azure/AWS/Oracle endpoints, npm/PyPI/RubyGems/crates/Go/Maven/NuGet/pub.dev/hex/CPAN/CocoaPods/Hackage, Ubuntu/NixOS, k8s/HashiCorp/Anaconda/Apache/Node, Sentry/Datadog/Statsig/Honeycomb, sourceforge/packagecloud/Google Fonts, schemastore, `*.modelcontextprotocol.io`. Simon Willison flags the breadth as an exfiltration concern. **[verified — docs list + simonwillison.net]**
- **Security proxy**: ALL outbound HTTP/HTTPS traffic passes through a proxy providing malicious-request protection, rate limiting/abuse prevention, content filtering, and a **DNS-level audit trail of requested hostnames**. Blocked hosts return `403` with `x-deny-reason: host_not_allowed`. **[verified]**
- **MCP connector traffic is routed through Anthropic's servers**, so connectors work regardless of the environment allowlist. **[verified]**

### 4.6 GitHub credential proxy (the key security design)
- "All GitHub operations go through a dedicated proxy service… Inside the sandbox, the git client authenticates using a custom-built **scoped credential**, which the proxy **verifies and translates to your actual GitHub authentication token**" — i.e., real tokens/signing keys **never enter the VM**. The proxy also **restricts `git push` to the current working branch**. The sandboxing blog adds: the proxy "verifies git command contents before attaching real authentication tokens." **[verified — docs + engineering blog]**
- Built-in GitHub tools (read issues, list PRs, fetch diffs, post comments) authenticate through this proxy with zero setup. **[verified]**

### 4.7 Local sandboxing (context for the open-source angle)
- Local Claude Code sandboxing: **bubblewrap (Linux) / Seatbelt (macOS)**; filesystem restricted to CWD; network via a **Unix domain socket to a proxy outside the sandbox** with per-domain user confirmation. Open-sourced as `anthropic-experimental/sandbox-runtime` (research preview). Internal result: **84% fewer permission prompts**; earlier telemetry showed users approved ~93% of permission prompts (fatigue). **[verified — engineering blogs]**

---

## 5. What syncs across devices

- **The session (conversation + state) lives server-side** on claude.ai — any signed-in surface (web, iOS/Android, Desktop, CLI-via-teleport) sees the same session list and transcript; sessions survive browser/laptop close. **[verified]**
- Each cloud session has a **transcript URL** (`https://claude.ai/code/session_...`); the session knows its own ID via `CLAUDE_CODE_REMOTE_SESSION_ID`. Since v2.1.179, commits from web sessions carry a `Claude-Session: <url>` git trailer and PR bodies include the session URL (opt-out via `attribution.sessionUrl=false`). **[verified]**
- **Teleport** pulls the full conversation history + branch into the terminal. **Routines** created on web/Desktop/CLI "write to the same cloud account, so a routine you create in one shows up in the others immediately." **[verified]**
- **Local CLI sessions do NOT sync** unless you use Remote Control (mirror) or Desktop "Continue in" (summary + new cloud session). Local transcripts are cached in plaintext at `~/.claude/projects/` for 30 days by default (`cleanupPeriodDays`). **[verified]**
- **Expiry**: idle cloud sessions have their environment reclaimed; reopening from claude.ai/code provisions a **fresh VM with conversation history restored** (working state on the old VM is gone — the branch on GitHub is the durable artifact). **[verified]**

---

## 6. Remote Control (the mirror-mode sibling)

- Remote Control = claude.ai/code or mobile app as a **window into a session running on YOUR machine** — "Claude keeps running locally the entire time, so nothing moves to the cloud." Conversation stays in sync across all connected devices simultaneously (terminal + browser + phone interchangeably). Auto-reconnects after sleep/network drop; ~10-min network outage kills the session. **[verified]**
- Start: `claude remote-control` (server mode: `--spawn same-dir|worktree|session`, `--capacity` default **32** concurrent sessions, QR code for phone), `claude --remote-control`/`--rc` (interactive), `/remote-control` in-session, or VS Code extension. Config option "Enable Remote Control for all sessions." **[verified]**
- Connection security: **outbound HTTPS only, no inbound ports**; registers with the Anthropic API and polls; "multiple short-lived credentials, each scoped to a single purpose and expiring independently." Requires claude.ai subscription auth (no API key/Bedrock/Vertex/Foundry, no custom `ANTHROPIC_BASE_URL`). Requires v2.1.51+. **[verified]**
- **Trusted Devices** (beta; Team/Enterprise, off by default): org-wide requirement that members enroll each device (WebAuthn-style) + re-auth every **18 hours** via FaceID/TouchID/Windows Hello/passkey before viewing/steering Remote Control sessions. Anthropic stores only the device public key + metadata, never biometrics. **[verified]**
- Docs positioning: use web sessions for "kick off a task without any local setup… or run multiple tasks in parallel"; Remote Control for continuing local work with local MCP/tools. **[verified]**

## 6.1 Desktop app cloud sessions

- Desktop's Code tab has an **environment picker per session: Local | Remote (Anthropic cloud) | SSH** (your own servers — Desktop auto-installs Claude Code over SSH). Cloud sessions in Desktop support **multiple repositories** (each with its own branch selector). "Usage counts toward your subscription plan limits with **no separate compute charges**." Plugins and the `+` connectors button are not available in cloud sessions (routines configure connectors at creation time). **[verified — desktop docs]**

---

## 7. Routines (cloud automation built on the same sessions)

- A **routine** = saved prompt + repos + connectors + environment, run autonomously as a **full Claude Code cloud session** on Anthropic infra ("keep working when your laptop is closed"). Triggers: **Schedule** (min interval 1 hour; cron via CLI; one-off runs), **API** (per-routine bearer-token POST to `api.anthropic.com/v1/claude_code/routines/<id>/fire` under beta header `experimental-cc-routine-2026-04-01`; returns a session URL), **GitHub events** (PR/release, with field filters; hourly caps during preview). **[verified]**
- Runs have **no permission prompts** at all; branch pushes limited to `claude/`-prefix unless "Allow unrestricted branch pushes" is set per repo. Routines belong to the individual account (not shared with teammates); actions appear as the user's GitHub/Slack/Linear identity. Daily per-account run cap + normal subscription usage; overage possible with usage credits. **[verified]**
- Available on Pro/Max/Team/Enterprise where Claude Code on the web is enabled; Owners can disable org-wide. **[verified]**

---

## 8. Enterprise / team controls

- **Admin console**: claude.ai/admin-settings/claude-code has server-side org toggles for: **Remote Control** (off by default on Team/Enterprise), **Routines**, **Quick web setup** (`/web-setup`), **Require trusted devices**. Enterprise orgs may need an Owner/account team to enable Claude Code on the web at all ("Not available for the selected organization"). **[verified]**
- **Server-managed settings**: org policy is fetched from Anthropic's servers into cloud sessions (MDM/local managed-settings files do NOT apply to cloud VMs — the VM isn't your device). `availableModels` enforcement extends to cloud sessions. **[verified]**
- **Zero Data Retention orgs cannot use cloud sessions at all** (`/web-setup` and other cloud session features blocked). **[verified]**
- **Org IP allowlisting breaks cloud sessions** — cloud sessions call the Anthropic API from Anthropic infra, so every session fails auth unless support exempts Anthropic-hosted services. Same for Code Review and Routines. **[verified]**
- **Audit**: all cloud-environment operations logged for compliance; DNS-level hostname audit trail via the security proxy. Enterprise plan includes SCIM, audit logs, RBAC, HIPAA-ready option. **[verified]**
- **Data retention**: Consumer (Free/Pro/Max): 5-year retention if training opt-in, 30-day if opted out. Commercial (Team/Enterprise/API): 30-day standard; ZDR available per-org for Enterprise (but then no cloud sessions). No training on commercial data unless opted in (Developer Partner Program). Users can delete individual web sessions permanently. **[verified — data-usage doc]**
- Repo access control caveat (worth repeating for teams): connecting GitHub gives cloud sessions reach into **everything the GitHub account can see**; restriction must happen on the GitHub side. **[verified]**

---

## 9. Pricing / entitlements (as of 2026-07)

- **No separate compute charge for cloud VMs** — "Claude Code on the web shares rate limits with all other Claude and Claude Code usage within your account. Running multiple tasks in parallel consumes more rate limits proportionately. There is no separate compute charge for the cloud VM." This is the headline pricing fact. **[verified — docs Limitations]**
- Plan prices (claude.com/pricing, fetched 2026-07-02):
  - Free $0 (no Claude Code)
  - **Pro** $17/mo annual, $20/mo monthly — includes Claude Code + Claude Cowork
  - **Max 5x** from $100/mo; **Max 20x** = $200/mo (pricing page extraction showed "from $100" for both tiers; TechCrunch and third-party guides consistently say $100/$200) **[verified for $100/$200 across sources]**
  - **Team Standard** $20/seat annual ($25 monthly), 5–150 seats — third-party guides say standard seats do NOT include Claude Code **[likely]**
  - **Team Premium** $100/seat annual ($125 monthly) — includes Claude Code ("5x more usage than standard seats")
  - **Enterprise** — pricing page now shows "$20/seat + usage costs at API rates," custom terms via sales **[likely — single fetch, new model, not cross-checked]**
- Web availability gate: "research preview for Pro, Max, and Team users, and for Enterprise users with **premium seats or Chat + Claude Code seats**." **[verified]**
- Routines add a **daily run cap** on top of plan usage; orgs can enable **usage credits** (metered overage) to keep running past subscription limits. **[verified]**
- Rate-limit reality check from HN launch thread (578 points / 390 comments): biggest complaints were rate limits (Opus hours cut for Max users) rather than the web product itself. **[verified — HN thread]**

---

## 10. Relation to the Claude Agent SDK

- The **Agent SDK is Claude Code's engine as a library** — "the same tools, agent loop, and context management that power Claude Code, programmable in Python and TypeScript." Cloud sessions are (per Simon Willison's assessment at launch) essentially "Claude Code CLI wrapped in a container" with permission prompts pre-configured. **[verified for SDK framing; likely for the wrapped-container characterization]**
- Three tiers now exist: **Agent SDK** (library, runs in YOUR process/infra, session state as JSONL on your filesystem) vs **Managed Agents** (2026: hosted REST API — "Anthropic runs the agent and the sandbox," Anthropic-hosted event log, managed sandbox per session; positioned as "prototype with the Agent SDK locally, then move to Managed Agents for production"; Cloudflare announced as a partner/host) vs **Claude Code surfaces** (CLI/web/desktop/mobile as end-user products on the same harness). **[verified — agent-sdk overview + managed-agents docs + Cloudflare blog]**
- **Critical restriction for third-party builders (relevant to Zeros)**: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Please use the API key authentication methods described in this document instead." Also branding: third-party products must NOT use "Claude Code" branding ("Claude Agent" is the allowed label). **[verified — agent-sdk overview]**
- Teleport/Remote Control/cloud sessions require **claude.ai subscription auth** and are unavailable over API key/Bedrock/Vertex — i.e., the cross-device session fabric is a first-party subscription perk, not an SDK feature you can rebuild against their backend. **[verified]**

---

## 11. Known limitations (docs' own list + observed)

- GitHub-only for clone/PR (GitHub Enterprise Server supported for Team/Enterprise; GitLab/Bitbucket only via local bundle upload, can't push back). **[verified]**
- Session ↔ local movement only within the **same claude.ai account**. **[verified]**
- Shared rate limits, no extra compute (see §9); parallel tasks burn limits proportionally. **[verified]**
- **4 vCPU / 16 GB / 30 GB** ceilings; heavy builds may be killed. **[verified]**
- No secrets store; env vars visible to environment editors. **[verified]**
- No custom base images; Bun package fetching broken via proxy; `gh` not preinstalled; interactive-picker slash commands (`/model`, `/config`) unavailable in cloud sessions (`/compact`, `/context` work; `/clear` doesn't). **[verified]**
- Idle environments expire (fresh VM on reopen, history restored, uncommitted VM state lost). **[verified]**
- CI failures during research preview: capacity is provisioned on demand; "Session creation failed" → retry. **[verified]**
- Cloud sessions with network "None" can still exfiltrate via the Anthropic API channel (docs admit this). **[verified]**
- Sharing is view-only, no real-time collaborative steering; sessions are per-account (routines too). **[likely]**
- Security track record: a Claude Code sandbox-bypass was silently patched (SecurityWeek, 2026); Anthropic's own containment post discloses a Feb 2026 phishing test where a malicious prompt exfiltrated AWS credentials 24/25 times with only egress controls as defense. **[verified — how-we-contain-claude; likely for SecurityWeek specifics]**

---

## 12. Competitive/context notes relevant to Zeros

- Anthropic's cloud model = **ephemeral task sandboxes + GitHub as durability + server-side transcript store**, NOT persistent cloud workspaces. The VM is disposable; the branch and the claude.ai transcript are what survive. Zeros' Daytona plan (persistent engine + files mirrored via Mutagen + engine-owned DB) is a different shape: persistent, file-synced, collaboration-native.
- Anthropic solved cross-device sync by **owning the session store server-side** (claude.ai) and making every surface a client; handoff down to the terminal is a git checkout + history download (teleport). The one-way CLI handoff (no local→cloud push except Desktop's summarize-and-recreate) shows how hard "lift a live local session to cloud" is even for Anthropic — they cheat with a summary + fresh session.
- The credential story (scoped credential inside sandbox, proxy swaps for real token, push restricted to working branch) is the pattern to copy for any cloud agent runner.
- "No separate compute charge" is subsidized bundling only Anthropic can do; third parties (Zeros, Conductor) must charge for or absorb sandbox compute, and **cannot piggyback claude.ai subscriptions** (explicit SDK ToS restriction, §10).
- Environment caching (filesystem snapshot after setup script, ~7-day TTL) is their cold-start answer — comparable to Daytona snapshots.

---

## Sources

- https://code.claude.com/docs/en/claude-code-on-the-web — main cloud-sessions reference (fetched 2026-07-02)
- https://code.claude.com/docs/en/web-quickstart — onboarding/user-flow quickstart (fetched 2026-07-02)
- https://code.claude.com/docs/en/remote-control — Remote Control + Trusted Devices + surface comparison (fetched 2026-07-02)
- https://code.claude.com/docs/en/routines — cloud routines/triggers/limits (fetched 2026-07-02)
- https://code.claude.com/docs/en/security — cloud execution security section (fetched 2026-07-02)
- https://code.claude.com/docs/en/data-usage — retention, training, cloud data flow (fetched 2026-07-02)
- https://code.claude.com/docs/en/desktop — Desktop local/remote/SSH sessions, Continue in, Dispatch (fetched 2026-07-02)
- https://code.claude.com/docs/en/agent-sdk/overview — Agent SDK vs Managed Agents vs CLI; third-party auth restriction (fetched 2026-07-02)
- https://code.claude.com/docs/en/whats-new — dated feature digest (weeks 13–26, 2026) (fetched 2026-07-02)
- https://claude.com/blog/claude-code-on-the-web (redirect from anthropic.com/news/claude-code-on-the-web) — launch announcement, Oct 20 2025 + Nov 12 2025 update
- https://www.anthropic.com/engineering/claude-code-sandboxing — sandboxing engineering blog + sandbox-runtime open source
- https://www.anthropic.com/engineering/how-we-contain-claude — containment architecture across products (May 25, 2026)
- https://techcrunch.com/2025/10/20/anthropic-brings-claude-code-to-the-web/ — launch coverage, plan availability, revenue context
- https://claude.com/pricing — plan prices (fetched 2026-07-02)
- https://simonwillison.net/2025/Oct/20/claude-code-for-web/ — independent security/architecture assessment
- https://news.ycombinator.com/item?id=45647166 — HN launch thread (578 points, 390 comments)
- https://www.threads.com/@boris_cherny/post/DWfjo22FKJ4/ — Boris Cherny on teleport/remote-control loop
- https://github.com/anthropics/claude-code/issues/56687 — feature request: inverse of /teleport (local→cloud push)
- https://claudelog.com/faqs/what-is-teleport-in-claude-code/ — teleport v2.1.0 claim (fetch blocked 403; search-snippet only, unverified)
- https://www.infoq.com/news/2025/11/anthropic-claude-code-sandbox/ — InfoQ on sandboxing (Nov 2025)
- https://www.securityweek.com/anthropic-silently-patches-claude-code-sandbox-bypass/ — sandbox bypass report
- https://sealos.io/blog/claude-code-on-phone/ — mobile availability summary (third-party)
- https://platform.claude.com/docs/en/managed-agents/overview — Managed Agents (via search)
- https://blog.cloudflare.com/claude-managed-agents/ — Cloudflare Managed Agents partnership (via search)
- https://www.finout.io/blog/claude-code-pricing-2026 / https://www.ssdnodes.com/blog/claude-code-pricing-in-2026-every-plan-explained-pro-max-api-teams/ — third-party pricing cross-checks
