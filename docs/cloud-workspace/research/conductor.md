# Conductor.build Cloud Workspaces — Full Teardown (research notes)

Research date: 2026-07-02. Methods: web research (official site/docs/changelog/blog, Vercel blog/docs, The New Stack, HN, podcast summaries) PLUS first-hand verification against a live Conductor install (v0.71.x, macOS) on this machine: binary string analysis of `/Applications/Conductor.app`, read-only SQL against the local `conductor.db`, DNS lookups, and live HTTP probes of Conductor's production endpoints. Confidence tags: **[verified]** (2+ sources or direct first-hand observation), **[likely]** (strong single-source or inferential), **[unverified]** (plausible, no confirmation).

---

## 1. TL;DR

- Conductor Cloud ("Cloud Workspaces") is Conductor's remote-execution layer: the same Mac-app UX, but agents run in a hosted sandbox that keeps working when the laptop closes. Announced early May 2026, still **invite-only early access** as of July 2026 (waitlist at conductor.build/cloud). **[verified]**
- Execution provider today is **Vercel Sandbox** (Firecracker microVMs, Amazon Linux 2023, `sb-*.vercel.run` URLs, direct WSS from the Mac app). An earlier/parallel provider codenamed **`sprite`** exists in their data model — almost certainly Fly.io's Sprites (sprites.dev). **[verified for Vercel; likely for Sprites=Fly]**
- The control plane/broker is `api.conductor.build`: a Fly.io-hosted service (internal codename **"roundhouse"**) behind Cloudflare, with **ElectricSQL** Postgres-sync headers, **WorkOS** auth (auth.conductor.build), and an encrypted **Fly Postgres** database for account/server-side data. There is also a web app at `app.conductor.build`. **[verified]**
- Chat/workspace data is still **stored locally in a SQLite `conductor.db`** on the Mac — including for cloud workspaces (81k+ cloud-workspace messages in the local DB on this install). The cloud registry (orgs, permissions, workspace identity) lives server-side; the schema and the Electric sync engine strongly suggest cloud-workspace data is server-synced, but Conductor's public docs still say "chat history is stored locally, none on our servers." **[verified facts; sync-of-chat is likely-but-unverified]**
- Team sharing is real but quiet: cloud workspaces carry `organization_id`, `permission_level`, per-message `sender_id`, and "shared workspace access" fixes shipped in changelogs; "workspace and chat links" shipped July 1, 2026. No public marketing of team collaboration yet. **[verified mechanics; positioning unannounced]**
- Pricing: the app is free; Conductor Cloud has **no published pricing** ("Conductor hasn't detailed pricing for Conductor Cloud" — The New Stack, May 14, 2026). Monetization plan = collaboration/teams + enterprise. $22M Series A (Spark + Matrix) announced March 30, 2026. **[verified]**

---

## 2. Timeline (dated)

| Date | Event | Source |
|---|---|---|
| Jul 17, 2025 | Show HN launch: "Conductor, a Mac app that lets you run a bunch of Claude Codes at once" (228 pts, 115 comments). Local-only. | HN 44594584 |
| Jan 9, 2026 | Fly.io launches **Sprites.dev** (stateful agent sandboxes, checkpoint/restore). Relevant because Conductor's DB later tags early cloud workspaces `sandbox_provider='sprite'`. | simonwillison.net |
| Mar 30, 2026 | **$22M Series A** from Spark (Nabeel Hyatt) + Matrix (Ilya Sukhar, board), YC, founders of Notion and Linear. "10x user growth since January." Roadmap: "available everywhere from your phone to your VPC." | conductor.build/blog/series-a |
| Apr 2, 2026 | **cmd joins Conductor** (Guillaume Sabran, ex-Airbnb iOS platform lead; cmd = AI for Xcode). "Conductor is quickly growing from a desktop app to a platform." | conductor.build/blog/cmd-joins-conductor |
| early May 2026 | **Conductor Cloud announced**, invitation-only early access. | The New Stack (May 14, 2026) |
| May 13, 2026 | Anthropic announces Claude-subscription policy changes for Agent-SDK tools (affects Conductor's free-rider economics); **delayed indefinitely June 15, 2026**. | conductor.build/blog/claude-subscription-update |
| May 18, 2026 | Changelog 0.54.0: "Prepare Conductor Cloud for release ☁️". | changelog |
| May 20–27, 2026 | 0.55–0.59: "Cloud beta just keeps getting better" — sleeping cloud workspaces, file-sync fixes (dropped SSH-config requirement), shared-workspace permission fixes. | changelog |
| May 27, 2026 | **Vercel customer-story blog**: "How Conductor moved parallel coding agents from the laptop to the cloud with Vercel Sandbox." | vercel.com/blog |
| Jun 4–17, 2026 | 0.62–0.67: cloud setup polish — snapshot configuration page, one-click agent API-key import, Amazon Linux/dnf awareness for Vercel sandboxes, file sync for ALL cloud workspaces, failed workspaces become read-only. | changelog |
| Jul 1, 2026 | 0.71.0: **Workspace and Chat Links** (⌘⇧C copy link); Cmd+O opens local mirror of a synced cloud workspace, Cmd+Opt+O opens it remotely; remote menu copies the SSH command. | changelog |
| Jul 2, 2026 | conductor.build/cloud is still an early-access email waitlist ("Run a team of coding agents in the cloud — Get early access"). | fetched directly |

---

## 3. Architecture teardown

### 3.1 Execution layer: Vercel Sandbox **[verified]**

- Vercel's blog (May 27, 2026, by Eric Dodds): "Cloud Workspaces, Conductor's remote execution layer built on Vercel Sandboxes... When a developer opens a new workspace, agents spin up on a remote server instead of their local machine. The interface doesn't change."
- CEO Charlie Holtz (ex-Vercel employee): "Our users can't tell the difference between local and cloud because Vercel Sandboxes are super fast." And on provider selection: "There are so many sandbox providers now, and we needed to know that ours were going to be fast and reliable, and that we get great support. Vercel checked all boxes."
- **First-hand (app binary CSP/allowlist)**: the Mac app is allowed to connect to `https://sb-*.vercel.run/*` and `wss://sb-*.vercel.run/*` — i.e., the Mac app talks **directly to the Vercel sandbox over HTTPS + WebSocket** at its `sb-<id>.vercel.run` URL (this is the same "direct WSS to sandbox" shape as the Zeros/Daytona plan). Also allowlisted: `*.ngrok.dev` / `*.ngrok-free.dev` (wss too) — ngrok is apparently used for some tunneling/preview path.
- **Environment**: changelog (Jun 12, 2026): "Agents in Vercel cloud workspaces now know they're on Amazon Linux and should install packages with dnf" — Vercel Sandbox runs Amazon Linux 2023.
- **Lifecycle / sleep-resume**: Vercel Sandboxes are "persistent by default": on stop the filesystem is auto-snapshotted; resume boots a new session from the snapshot; SDK calls auto-resume a stopped sandbox (`Sandbox.getOrCreate` with `onCreate`/`onResume` hooks — onCreate for repo clone + deps, onResume to restart dev servers). Snapshots expire 30 days after last use by default (configurable; `keepLastSnapshots`). Conductor's changelog references "sleeping cloud workspaces" (0.55.0) and a "snapshot configuration page" in cloud settings (0.65.0) — i.e., Conductor exposes this snapshot/sleep model to users. **[verified]**
- **Vercel Sandbox platform numbers (docs, updated 2026-06-16)**: Active CPU $0.128/hr; provisioned memory $0.0212/GB-hr; creations $0.60/1M; data transfer $0.15/GB; snapshot storage $0.08/GB-month. Max runtime **24 hours** per session (Pro/Enterprise; 45 min Hobby); default timeout 5 min (extendable); 32 GB ephemeral NVMe disk; up to 8 vCPU/16 GB (Pro) or 32 vCPU/64 GB (Enterprise); 2,000 concurrent sandboxes (Pro); **single region `iad1`**. Rough cost example from Vercel: 2-hour task on 8 vCPU/16 GB ≈ $2.73 at full utilization (I/O wait not billed).
- Implication: a "24h max runtime" + auto-snapshot/resume model means Conductor's always-on cloud workspaces are actually stop/resume cycles over snapshots, not one long-lived VM. **[verified platform limit; the cycling behavior is likely]**

### 3.2 Fly.io: backend host + earlier 'sprite' sandbox provider

- **Backend on Fly [verified, first-hand]**: `curl -I https://api.conductor.build/` returns `via: 1.1 fly.io` and `fly-request-id: ...` behind Cloudflare (`server: cloudflare`). Body: `{"app":"@roundhouse/internal","status":"ok"}` — internal codename **roundhouse**. The same service answers directly (no Cloudflare) at `https://conductor-cloud-alpha.fly.dev/` with `server: Fly/...` — same `@roundhouse/internal` body. The app binary also allowlists `https://conductor-roundhouse.fly.dev/*` and `https://conductor-cloud-alpha.fly.dev/*` plus `stage-api.conductor.build` / `stage-app.conductor.build`.
- **Cloud DB on Fly [verified]**: Conductor's own privacy docs: "In an **encrypted Postgres database served by Fly**, we store: Your account data (such as your email address, and if you integrate with GitHub, installation data)." Enterprise page: account data "stored server-side, in an encrypted Postgres database... SOC 2 compliant."
- **Fly Sprites [likely]**: the Mac app's SQLite migration #95 (extracted from the binary) reads:
  ```sql
  ALTER TABLE workspaces ADD COLUMN sandbox_provider TEXT;
  UPDATE workspaces SET sandbox_provider = 'sprite' WHERE hosting_server_url IS NOT NULL;
  ```
  i.e., when multi-provider support landed, **all pre-existing cloud workspaces were classified as provider `sprite`** — matching Fly's Sprites product (launched Jan 9, 2026; the naming and their Fly-hosted backend make Fly Sprites the overwhelmingly likely referent, though the string 'sprite' is the only direct evidence; no `sprites.dev` URLs appear in the binary). On this machine's install, all 18 cloud workspaces are `sandbox_provider='vercel'` — so **Vercel is the current default** and 'sprite' appears to be the legacy/alpha provider (the alpha service literally lived at `conductor-cloud-alpha.fly.dev`).
- **Fly Sprites platform facts** (for comparison): stateful sandboxes, ~1–12 s creation, checkpoint of full disk state in ~300 ms (copy-on-write), auto-sleep after ~30 s idle, persistent NVMe+object-storage filesystem, SSH access, ~$0.46 for a 4-hour heavy coding session (Simon Willison, Jan 9, 2026).
- Net: the earlier rumor "Conductor = Vercel Sandbox + Fly Sprites + Fly backend" is **confirmed in structure**: Fly hosts the backend + cloud Postgres; Vercel Sandbox is the current execution layer; 'sprite' was a real second provider (probably the alpha).

### 3.3 The broker: api.conductor.build ("hosting server") **[verified]**

- Every cloud workspace row in the local DB has `hosting_server_url = https://api.conductor.build` (verified via SQL on this install). So the Mac app treats api.conductor.build as the **hosting/broker server** for cloud workspaces; the sandbox URL (`sb-*.vercel.run`) is used for direct data-plane connections (port forwards etc.).
- Response headers expose **ElectricSQL sync protocol** headers: `access-control-expose-headers: electric-handle, electric-offset, electric-cursor, electric-up-to-date, electric-schema`. ElectricSQL is a Postgres sync engine ("partial replication, fan-out, data delivery" — pitch: local-first apps + multi-agent systems on Postgres sync). This means Conductor's backend serves Electric "shapes" — i.e., **subsets of a cloud Postgres are streamed/synced to clients**. **[verified headers; what exactly syncs through it is unverified]**
- **Auth**: `auth.conductor.build` CNAMEs to `cname.workos-dns.com` → **WorkOS** (AuthKit) handles login. The `app.conductor.build` web app's CSP allows `connect-src https://api.workos.com`. **[verified]**
- **Web app**: `app.conductor.build` serves a Vite/React SPA (same Fly backend, Cloudflare-fronted). Purpose not publicly documented — most plausibly the login/account/org surface and the target of the new workspace/chat share links. **[verified it exists; purpose likely]**
- Marketing site (`www.conductor.build`) is on Vercel (vercel-dns CNAME). Status page: statuspage.incident.io (allowlisted in app). Analytics: PostHog (per privacy docs). **[verified]**
- A worker/queue detail from binary strings: agent dialog handling mentions "the worker's park deadline" — suggests server-side workers parking/settling agent interactions when no client is connected. **[unverified interpretation]**

### 3.4 Data layer: local conductor.db + cloud registry (the reconciliation)

First-hand, read-only inspection of `~/Library/Application Support/com.conductor.app/conductor.db` on 2026-07-02 (a live, daily-driver install):

- DB is **1.7 GB SQLite (WAL)** with tables: workspaces, repos, sessions, session_messages, terminal_sessions, diff_comments, port_forwards, env_vars, attachments, settings, etc. **474,736 rows in `session_messages`** (up from ~336k when this machine was inspected in June — same local-store model, still growing).
- **Cloud workspaces' chat is in the LOCAL DB**: 81,188 messages belong to sessions of cloud workspaces (`sandbox_provider IS NOT NULL`). So even for cloud execution, the Mac app keeps a full local copy of chat.
- Cloud/collab columns on `workspaces` (all verified in schema): `hosting_server_url`, `sandbox_provider`, `remote_file_sync_enabled`, `workspace_path`, `permission_level`, `creator_user_id`, `creator_client_id`, `organization_id`. On this install: 18 cloud workspaces, all `vercel`, all `permission_level='write'`, all with `organization_id` set (cloud workspaces are org-scoped), 17/18 with file sync enabled.
- `session_messages.sender_id` exists and is populated on 2,136 messages — a **multi-sender chat model** (needed for collaborative/shared chats).
- Reconciliation with public claims:
  - Conductor docs (current, July 2026): "Your chat history is saved locally in ~/Library/Application Support/com.conductor.app. **None of it is stored on our servers**" and "Conductor is a Mac app, not a hosted IDE." **[verified quote]** — but the docs have **no cloud-workspaces section at all** (sitemap checked); they describe the local product and appear to predate/ignore Cloud.
  - Meanwhile the backend demonstrably runs a Postgres **sync engine** (Electric), the schema is multi-user/multi-client (`creator_client_id`, `sender_id`, `organization_id`, `permission_level`), and share links (July 1) imply server-resolvable workspace/chat identity.
  - **Best synthesis [likely]**: for cloud workspaces, the server-side Postgres holds at least the workspace registry, org membership, and permissions, and Electric syncs relevant state down to each client's local SQLite (which is why cloud-workspace chat shows up in conductor.db). Whether full chat content is stored server-side for cloud workspaces is **not publicly confirmed** and directly contradicts the (stale?) privacy-docs wording. This is a real docs-vs-product tension worth watching.
- **Cross-device sync answer**: For LOCAL workspaces — no sync; docs recommend Apple Migration Assistant or manual copying of `~/Library/Application Support/com.conductor.app` + `~/conductor` to move machines. For CLOUD workspaces — the code+agent live server-side and the registry is org-scoped server data, so a second Mac on the same login should see and attach to the same cloud workspaces; that is the whole design direction (links, orgs, Electric). But **no public statement explicitly demonstrates two-Mac same-login sync**, and chat-history portability across devices is unverified. **[likely, unverified in public claims]**

### 3.5 File sync (cloud → local mirror) **[verified mechanics, partial]**

- Cloud workspace files mirror to the Mac at `~/conductor/remote-workspace-sync/<RepoName>/` (verified on disk; this install has two mirrored repos).
- **Not Mutagen**: zero "mutagen" strings in either app binary. Internal command args extracted from the binary: `mirrorPath`, `metadataPath`, `localRepoPath`, `syncRef`, `gzipUrl`, `zstdUrl`, `sha256`, plus port-forward args (`sandboxUrl`, `localPort`, `remotePort`) — i.e., a **custom sync engine**: git-ref-based (`syncRef`) plus compressed archive downloads (gzip/zstd, sha256-checked). An earlier iteration required the user's SSH config; 0.55.0 (May 20, 2026) removed that ("Fixed file sync startup so remote workspaces no longer require SSH config").
- File sync started as opt-in/partial; 0.65.0 (Jun 12, 2026): "Made file sync available for all cloud workspaces." Synced files run the repo setup script on first local mirror (0.61.0). Sync recovers after restarts/missed FS events (0.65.0). The Git panel shows "remote file sync status labels."
- Local ⇄ remote handoff (0.71.0): **Cmd+O opens the local mirror** of a synced cloud workspace; **Cmd+Opt+O opens it remotely**; the "remote" menu **copies an SSH command** — so users can SSH into the sandbox (e.g., VS Code Remote / terminal). **[verified changelog]**
- Terminals are mirrored via an internal PTY-mirror protocol (PtyCreateMirror/PtyWriteMirror... in binary strings) — remote terminal streams rendered in the app. **[verified strings; interpretation likely]**

### 3.6 What runs in the sandbox

- The agents (Claude Code via Claude Agent SDK, Codex, Cursor Composer, OpenCode) run inside the sandbox for cloud workspaces; Conductor is "model agnostic... they can keep the same cloud layer underneath" (Vercel blog). The app ships a 72 MB `conductor-runtime` sidecar binary (JS bundle) containing the agent-harness runtime; strings show Claude-Agent-SDK-style telemetry (`tengu_*`) and Codex config with **Vercel AI Gateway** as an optional model provider (`ai-gateway.vercel.sh/v1`, `AI_GATEWAY_API_KEY`). **[verified strings; exact cloud packaging unverified]**
- Cloud setup imports your locally-configured agent API key with one click (0.65.0) — i.e., **your model credentials get pushed into the sandbox**; model traffic goes sandbox→provider. **[verified changelog + privacy docs "network traffic goes straight to your model provider"]**
- GitHub access in cloud prefers a **GitHub App** installation path, "preserving reusable personal access tokens" (changelog ~June 2026); privacy docs note GitHub installation data is stored server-side. HN history: after security pushback on broad GitHub OAuth scopes, they shipped fine-grained GitHub App permissions. **[verified]**

---

## 4. Team / collaboration status (as of 2026-07-02)

- Shipped (quietly, in cloud early access):
  - Org-scoped cloud workspaces (`organization_id` on every cloud workspace). **[verified locally]**
  - Permission levels per workspace (`permission_level`; "Fixed an issue where **shared workspace access** could use stale permissions" — 0.56.0, May 21, 2026). **[verified]**
  - Multi-sender chat plumbing (`sender_id` per message). **[verified locally]**
  - **Workspace & chat links** (0.71.0, Jul 1, 2026): right-click or ⌘⇧C to copy a link to a workspace or chat. Where links open (web viewer vs deep link into the Mac app) is not documented. **[verified feature; open-behavior unverified]**
- Not shipped/announced publicly: multiplayer chat UX, team dashboards, shared fleets. Holtz on the YC podcast (published Jun 4, 2026) was still speculative: "Should you be able to have multiplayer chats where multiple people [work with the same agents]?" FAQ says monetization will come from "collaboration features that help teams make the most of AI agents." **[verified quotes]**
- Enterprise: an enterprise page exists (deployment/security discussions, enterprise_data_privacy toggle to disable external-AI features via `.conductor/settings.toml`), with logos/users claimed at Google, Meta, Amazon, Spotify, Ramp, Datadog, Block, Notion, Linear, Life360, etc. **[verified claims by company]**

## 5. Pricing / plans

- Mac app: **free**; no subscription; BYO model credentials (Claude Pro/Max, Codex/ChatGPT, Cursor API key, API keys). **[verified]**
- Conductor Cloud: **early access, invite/waitlist; no published pricing**. The New Stack (May 14, 2026): "Conductor hasn't detailed pricing for Conductor Cloud, though the hosted service will likely sit alongside its existing local-first product." TNS framing: hosted workspaces let companies "charge not just for coordination software but also for the infrastructure on which those agents execute." **[verified]**
- Cost floor for them (from Vercel list prices): a 2 vCPU/4 GB sandbox running an active hour ≈ $0.13–0.34; snapshot storage $0.08/GB-mo. Sprites comparison: ~$0.46 per 4-hour session. **[verified platform prices; Conductor's negotiated rates unknown]**
- Business-model risk noted: May 13, 2026 Anthropic tried to restrict Claude subscription use through the Agent SDK in third-party tools (would push Conductor users to API pricing); delayed indefinitely June 15, 2026. **[verified]**
- Third-party analyst guess (Marvin Vista deep dive, Feb 21, 2026): future pricing "likely per-seat... $20/mo individual, $40/user/mo team" — speculation only. **[unverified analyst projection]**

## 6. User-facing UX flows (what's known)

- **Create**: ⌘N opens the "Dispatcher" (new-workspace prompt composer, 0.63.0). Choosing cloud runs a **cloud setup flow**: GitHub App access → repo + setup script (setup logs focus on "your repo and setup script instead of internal steps") → snapshot configuration page → optional one-click import of your local agent API key → Launch button. Workspaces get statuses (backlog/in-progress/in-review/done since 0.35.0). **[verified changelog]**
- **Work**: identical UI to local — chat with agents, side-panel diff view, terminals, checks; browser preview of dev servers (port forwarding to `localhost`, cookie-auth-safe since 0.63.0); "Vercel preview" button in the git panel. **[verified]**
- **Close the laptop**: agents keep working server-side; workspaces "sleep" when idle (snapshot) and resume on demand; failed cloud workspaces become **read-only** rather than disappearing (0.65.0); sleeping workspaces can be archived (0.55.0 fix). **[verified changelog]**
- **Local handoff**: enable file sync → local mirror in `~/conductor/remote-workspace-sync` → Cmd+O opens local mirror in your editor; Cmd+Opt+O opens remote; copy SSH command for direct remote access. **[verified]**
- **Share**: copy workspace/chat links (⌘⇧C). **[verified]**
- **Mobile/web**: nothing shipped publicly. `app.conductor.build` web app exists (login-gated SPA); stated direction is "available everywhere **from your phone to your VPC**" (Series A letter, Mar 30, 2026); Holtz personally drives agents remotely via Telegram + voice (Spokenly/Parakeet) per the YC podcast — i.e., mobile control is founder-desired but not productized. **[verified statements; no mobile product]**

## 7. Company context

- Melty Labs (YC S24), founders Charlie Holtz (CEO, ex-Vercel, ex-Replicate) & Jackson de Campos. ~6 people at the time of the Vercel blog (May 2026) + cmd's Guillaume Sabran (Apr 2026). Prior product: Chorus (app.chorus.sh — still allowlisted in the app). Seed: $2.8M (Goodwater, Caffeinated, YC, angels). Series A: $22M (Mar 30, 2026). Users: "10x since January [2026]"; "YC startups writing 100% of their code in Conductor"; Notion: "It makes you feel like an octopus, where each one of your arms is working on something separately." **[verified]**
- Strategic framing (Holtz, TNS May 14, 2026): ">3–5 agents is an interface challenge"; "the models are going to get 10 or 100 times smarter... run for longer without you needing to intervene"; persistent cloud execution is core to that ("agents are going to be able to run for much longer").

## 8. Direct implications for Zeros (facts, not advice)

- Conductor's shape ≈ Zeros' Daytona plan: hosted sandbox running the full engine + **direct WSS from the Mac app to the sandbox URL** + thin broker holding provider credentials + local file mirror. Conductor validates that architecture in production. **[verified]**
- Differences: (1) Conductor's durable registry/sync = **Fly Postgres + ElectricSQL sync into local SQLite**, not engine-owned DB in the sandbox — chat lands in a local DB on every client; (2) file mirror is a **custom git-ref + zstd/gzip archive sync**, not Mutagen; (3) provider strategy is **pluggable** (`sandbox_provider` column: sprite → vercel), which insulated them from switching sandbox vendors mid-beta; (4) sleep/wake is delegated to the sandbox vendor's snapshot-resume primitive (Vercel persistent sandboxes / Sprites checkpoint), with a user-visible "snapshot configuration" page.
- Their sequencing: cloud beta invite-only for ~2 months while iterating weekly; collaboration primitives (orgs/permissions/sender_id/links) shipped inside the beta **before** any team-features marketing; pricing still unannounced.

---

## Sources

- https://vercel.com/blog/how-conductor-moved-parallel-coding-agents-from-the-laptop-to-the-cloud-with-vercel-sandbox (May 27, 2026)
- https://thenewstack.io/conductor-cloud-ai-coding-agents/ (Paul Sawers, May 14, 2026)
- https://www.conductor.build/cloud (early-access waitlist page, fetched 2026-07-02)
- https://www.conductor.build/blog/series-a (Mar 30, 2026)
- https://www.conductor.build/blog/cmd-joins-conductor (Apr 2, 2026)
- https://www.conductor.build/blog/claude-subscription-update (Jun 15, 2026)
- https://www.conductor.build/changelog — entries 0.54.0 (May 18), 0.55.0 (May 20), 0.56.0 (May 21), 0.57.0 (May 22), 0.58.0 (May 25), 0.61.0 (May 29), 0.62.0 (Jun 4), 0.63.0 (Jun 8), 0.65.0 (Jun 12), 0.67.0 (Jun 17), 0.71.0 (Jul 1, 2026)
- https://www.conductor.build/docs/reference/privacy (fetched 2026-07-02)
- https://www.conductor.build/docs/reference/security-and-permissions (fetched 2026-07-02)
- https://www.conductor.build/docs/faq
- https://www.conductor.build/enterprise
- https://vercel.com/docs/sandbox/pricing (updated 2026-06-16)
- https://vercel.com/docs/sandbox/concepts/persistent-sandboxes (updated 2026-05-29)
- https://simonwillison.net/2026/Jan/9/sprites-dev/ (Fly Sprites launch analysis)
- https://sprites.dev/ and https://fly.io/blog/design-and-implementation/ (Sprites design)
- https://news.ycombinator.com/item?id=44594584 (Show HN, Jul 17, 2025)
- HN Algolia API search results (Conductor Cloud story Jun 25, 2026; Series A Mar 31, 2026)
- https://www.marvinvista.com/p/a-deep-dive-on-conductor-yc-s24 (Feb 21, 2026)
- https://finance.biggo.com/podcast/fe599900ba5c87ae (YC podcast summary, Jun 4, 2026: "Conductor CEO Charlie Holtz Walks Us Through His AI Coding Setup"; video: https://www.youtube.com/watch?v=fQmlML9Lay4)
- https://electric-sql.com/ (ElectricSQL — identified via response headers on api.conductor.build)
- First-hand verification (2026-07-02, this machine): DNS lookups (api/app/auth/www.conductor.build), HTTP probes of https://api.conductor.build/ and https://conductor-cloud-alpha.fly.dev/ and https://app.conductor.build/, `strings` analysis of /Applications/Conductor.app binaries (v0.71.x), read-only SQLite queries against ~/Library/Application Support/com.conductor.app/conductor.db, and inspection of ~/conductor/remote-workspace-sync/
