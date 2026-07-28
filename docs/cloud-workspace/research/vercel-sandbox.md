# Vercel Sandbox — capabilities, pricing, limits (research notes, as of 2026-07-02)

Confidence labels: **[verified]** = confirmed in official docs/changelogs or 2+ sources; **[likely]** = strong single-source or circumstantial evidence; **[unverified]** = could not confirm.

## TL;DR for the Zeros cloud-workspaces decision

- Vercel Sandbox is a Firecracker-microVM "computer per agent" API, GA since Jan 30, 2026, with **filesystem persistence on by default** (auto-snapshot on stop, auto-resume on next API call) and `fork()` since May 26, 2026. **[verified]**
- It is exactly what Conductor.build built its Cloud Workspaces on (Vercel customer story, May 27, 2026). **[verified]**
- Billing is "Active CPU" (I/O wait is free) + provisioned memory + snapshot storage + egress. A stopped workspace costs only snapshot storage ($0.08/GB-month). A running-but-idle 4 GB sandbox costs ~$0.085/hour in memory alone (~$62/month if never stopped). **[verified, computed from official rates]**
- Two hard constraints that matter for Zeros: **single region (iad1, US East)** and **24-hour max session length** (sessions must cycle; processes die and must be restarted on resume — snapshots are filesystem-only, not memory). **[verified]**
- External clients (a Mac desktop app) CAN talk directly to services inside a sandbox via public per-port URLs (`https://<subdomain>.vercel.run`) — but those URLs are **public with no built-in auth**; the app inside must enforce its own token/basic-auth (this is the documented pattern, e.g. Vercel's OpenCode guide). **[verified]** Whether a WebSocket upgrade works through the vercel.run port routing is **not explicitly documented** — Vercel's own CLI shell does use an externally-reachable WSS+token endpoint, so long-lived WS to sandbox infra demonstrably works, but a spike test is needed for user-run WSS servers on exposed ports. **[likely / needs spike]**

## 1. What it is + timeline

Vercel Sandbox is "a compute primitive designed to safely run untrusted or user-generated code on Vercel… for AI agents, code generation, and developer experimentation" (docs, updated 2026-06-17). Each sandbox is an isolated ephemeral-by-default Linux VM created programmatically via JS SDK (`@vercel/sandbox`), Python SDK (`vercel` package), or the open-source `sandbox` CLI. **[verified]**

Timeline (all dates verified against Vercel changelog/blog):
- **June 25, 2025** — launched in beta at Vercel Ship 2025; initially max 45-minute runtime, "hundreds" of concurrent environments. **[verified]**
- **Aug 18, 2025** — concurrency raised 150 → 2,000 sandboxes (Pro/Enterprise); ports per sandbox raised to 4. **[verified]**
- (2025) — max duration extended 45 min → 5 hours; dynamic `extendTimeout()` added. **[verified, changelog entries exist; exact dates not captured]**
- **Jan 30, 2026** — **GA** ("the execution layer for agents"); SDK + CLI open-sourced (github.com/vercel/sandbox, repo created 2026-01-23); named customers: v0, Blackbox AI, Roo Code. Guillermo Rauch: "the easiest API to give your agent a computer… Snapshotting support for clone/fork/resume." **[verified]**
- **May 26, 2026** — **Persistence GA**: filesystem auto-snapshot/restore on by default, sandbox `name`s, `Sandbox.fork()`, `Sandbox.getOrCreate()`, lifecycle hooks (`onCreate`/`onResume`), tags, `delete()`. **[verified]**
- **May 27, 2026** — Conductor customer story published. **[verified]**
- **June 16, 2026** — max runtime raised 5 h → **24 hours** (Pro/Enterprise). **[verified]**
- Current port limit is **15 exposed ports** per sandbox (pricing docs, 2026-06-16). **[verified]**

Scale/credibility signals: powers v0's code execution; Vercel claims "sub-second starts for thousands of sandboxes per task" and 2.7M deployments/day on the broader platform (GA blog, Jan 30, 2026). **[verified quotes; numbers are vendor claims]**

## 2. Runtimes & system specs

- Guest OS: **Amazon Linux 2023**. Built-in runtimes: `node26`, `node24` (default), `node22`, `python3.13`. **[verified]**
- Runs as user `vercel-sandbox` **with sudo/root**; default cwd `/vercel/sandbox`; can install anything via `dnf`/npm/pip. **[verified]**
- **Custom Docker images** supported via Vercel Container Registry (VCR): `Sandbox.create({ image: 'my-repo:latest' })` — `image` and `runtime` are mutually exclusive. **[verified]**
- Can run **system-privileged processes**: Docker-in-sandbox, VPN clients, FUSE drivers (docs list these explicitly). **[verified]**
- Can bootstrap from a **git source** (including private repos via PAT / GitHub App token — official KB guide exists). **[verified]**
- Resources: 1 vCPU or any even count 2–32 (plan-capped); **memory fixed at 2 GB per vCPU** (not independently configurable); default 2 vCPU/4 GB; **32 GB ephemeral NVMe disk** (fixed, all plans). **[verified]**
- No GPU option (Modal is the GPU sandbox; Vercel has none as of early 2026 comparisons). **[verified via 3rd-party comparisons; absence-of-feature]**

## 3. Persistence, snapshots, fork — exact semantics

This is the load-bearing section for "engine + zeros.db live in the sandbox."

- **Persistence is the default.** "When a sandbox stops, the SDK automatically snapshots its filesystem, and the sandbox configuration is preserved across sessions." Opt out with `persistent: false` / `--non-persistent`. **[verified]**
- **Snapshots are filesystem-only.** Every doc statement says filesystem: "Vercel captures its filesystem and creates a snapshot automatically before the sandbox shuts down." **Memory and running processes are NOT captured** — the `onResume` hook exists specifically to "restart background services or rehydrate caches," and Vercel's own example restarts `npm run dev` on every resume. So the Zeros engine process would die on stop and must cleanly restart on resume. **[verified]**
- **Two-level model:** a *sandbox* (long-lived, identified by a project-unique immutable `name`) contains *sessions* (single VM boots). Each resume = new session from latest snapshot. **[verified]**
- **Auto-resume:** any SDK call on a stopped persistent sandbox (`runCommand`, `writeFiles`, …) transparently boots a new session and retries. `Sandbox.get({name})` / `Sandbox.getOrCreate({name})` are the idempotent handles. **[verified]**
- **Manual `snapshot()`** captures the filesystem **and then shuts the sandbox down automatically** ("becomes unreachable… any subsequent commands will fail"). Checkpoint ≠ free; it costs a session restart. **[verified]**
- **`Sandbox.fork({ sourceSandbox })`** (GA May 26, 2026): new sandbox seeded from the source's *current snapshot*; inherits all config **except `env` (not copied — encrypted server-side; must re-pass)** and `runtime` (comes from the snapshot). If the source has no snapshot, fork falls back to a fresh create. **[verified]**
- **Rollback:** `sandbox.update({ currentSnapshotId: 'snap_xyz' })` points the sandbox at an older snapshot — built-in time-travel across the retained snapshot set. **[verified]**
- **Snapshot retention:** default expiry **30 days after last use** (timer resets on each use). Configurable per call, per sandbox (`snapshotExpiration`, `0` = never), plus `keepLastSnapshots: { count: 1–10, expiration, deleteEvicted }`. Docs recommend `count: 1` to keep storage flat (every stop creates a new snapshot otherwise). **[verified]**
  - Data-loss footgun: a workspace untouched for >30 days silently loses its snapshot (sandbox is then deleted/re-created on next `getOrCreate`) unless expiration is set to 0. **[verified from getOrCreate behavior: "If the sandbox exists but its snapshot has expired, the stale sandbox is deleted, re-created with the same name."]**
- Snapshot statuses: `created` / `deleted` / `failed` ("take a new snapshot to retry" — failures happen). **[verified]**
- **Drives (private beta, free during beta):** mountable persistent directories, up to 4 per sandbox, 100 GiB default / 1 TiB max each, survive until manually deleted, NVMe-speed writes + cache-hit reads. **Currently single-reader/single-writer** ("multiple readers coming soon") — so no shared-drive multi-sandbox collaboration yet. Vercel says "use for caching and non-critical use cases during the private beta." **[verified]**

## 4. Networking — the critical question for a direct desktop↔sandbox connection

**Inbound (external app → sandbox):**
- Only ports explicitly declared in `ports` (max **15**) are reachable from the internet. `sandbox.domain(port)` returns `https://<subdomain>.vercel.run` (confirmed in SDK source: `` `https://${route.subdomain}.vercel.run` ``). Throws if the port wasn't registered. `sandbox.update({ ports })` replaces the full port list at runtime. **[verified]**
- **Exposed ports are PUBLIC.** Docs: "Exposed ports are accessible via a public URL, so be mindful of what services you run." There is **no built-in inbound authentication** on these URLs; Vercel's own guides put auth inside the app (the OpenCode guide runs the server with HTTP basic auth + a generated password). Zeros' planned "per-user token on the engine's WSS endpoint" is exactly this documented pattern. **[verified]**
- **Direct external connection is a supported, first-class pattern**: Vercel's OpenCode guide connects a local terminal ("`opencode attach`") and a browser directly to a server running in the sandbox over the public URL; the Sandbox CLI's `sandbox connect` gives an SSH-like interactive shell from your laptop. **[verified]**
- **WebSockets:** The CLI shell works by calling `sandbox.openInteractive()`, which "Returns the WebSocket URL and token the client uses to connect to the controller-hosted PTY" — i.e., Vercel's sandbox infrastructure already terminates long-lived WSS connections from external machines (verified in vercel/sandbox source, `session.ts` + `interactive-shell.ts`, which does `new WebSocket(url?token=…)`). **[verified]** However, that PTY endpoint is controller-hosted, not a user port; **no official doc explicitly states that a WebSocket upgrade works on user-exposed `*.vercel.run` port URLs.** Third-party guides for Vite-in-sandbox sometimes set `hmr: false` (though the one found used its own tunnel, not Vercel's). Treat "run the Zeros engine's WSS server on an exposed port" as **[likely, unconfirmed — needs a 30-minute spike test]**.
- Historical wrinkle: a 2025 community thread reported errors exposing >1 port; limits have since moved 1→4→15, so presumably fixed, but multi-port behavior is worth including in the spike. **[unverified/dated]**

**Outbound (egress) — the sandbox firewall (docs updated 2026-05-25):**
- Three modes, switchable live on a running sandbox without restart: `allow-all` (default), `deny-all` (blocks everything incl. DNS), and user-defined (deny by default + allowlist). **[verified]**
- User-defined policies: domain allowlists w/ wildcards (SNI-matched, TLS-only; plain HTTP must be allowed by IP range), IP-range allow/deny lists, **Postgres protocol supported** (TLS required, `sslmode=require`). **[verified]**
- **Credentials brokering** (permission-gated feature): inject API keys into egress traffic at the proxy so "secrets never enter the sandbox scope, preventing exfiltration" — e.g., give agents GitHub/AI-gateway access without the token ever being readable in the VM. **[verified]**
- **Request proxying** (permission-gated): forward matched egress to your own HTTP endpoint with a Vercel-signed OIDC token carrying `team_id`/`project_id`/`sandbox_id`/`sandbox_name` claims (helper: `defineSandboxProxy`). **[verified]**

## 5. Regions

- **iad1 (Washington DC / US East) only.** "Currently, Vercel Sandbox is only available in the `iad1` region" (pricing docs, 2026-06-16). No EU/APAC compute, no data residency options for sandbox workloads. No public roadmap date found for more regions. **[verified]**
- Implication: EU/Asia users of Zeros cloud workspaces would see ~80–250 ms RTT to their workspace; Daytona (multi-region: US/EU) wins here. **[likely; latency figures are general-knowledge estimates]**

## 6. Pricing (official rates, docs updated 2026-06-16)

| Metric | Hobby (included, free) | Pro & Enterprise rate |
| --- | --- | --- |
| Active CPU | 5 hours/month | **$0.128 / CPU-hour** |
| Provisioned memory | 420 GB-hours/month | **$0.0212 / GB-hour** |
| Sandbox creations | 5,000/month | **$0.60 / 1M creations** |
| Data transfer (in+out) | 20 GB/month | **$0.15 / GB** |
| Snapshot storage | 15 GB (lifetime) | **$0.08 / GB-month** |
| Concurrent sandboxes | 10 | 2,000 (Enterprise negotiable higher) |
| Max session runtime | 45 min | 24 hours |
| vCPU allocation rate | 40 / 10 min | 200/min (Pro), 400/min (Enterprise) |

All **[verified]** from https://vercel.com/docs/sandbox/pricing.

Key mechanics:
- **Active CPU** counts only time the CPU is actually busy — "time spent waiting for I/O (network requests, database queries, or AI model calls) does not count." For coding-agent workloads that mostly wait on LLM calls, this is the big cost lever (Vercel markets "up to 95% lower cost for bursty or I/O-bound patterns"). **[verified quote; 95% is a vendor marketing claim]**
- **Provisioned memory bills for wall-clock while the VM is up** (1-minute minimum increments), regardless of CPU activity. Memory is fixed at 2 GB/vCPU.
- Pro plans burn the standard **$20/month included credit** first; Spend Management can alert/pause. Hobby hard-pauses sandbox creation when limits are hit (no overage charges). **[verified]**
- Official worked examples: 5-min AI code validation (2 vCPU) ≈ **$0.03**; 30-min build/test (4 vCPU) ≈ **$0.34**; 2-hr task (8 vCPU) ≈ **$2.73** — all assuming 100% CPU, so real agent costs are lower. **[verified]**

**Idle / sleep economics (computed from official rates):**
- Running but idle (agent waiting for user, VM up): CPU ≈ $0; memory keeps billing. 2 vCPU/4 GB → ~$0.085/hr → **~$62/month if never stopped**; 4 vCPU/8 GB → ~$0.17/hr → **~$124/month**. So you MUST stop/timeout idle workspaces.
- Stopped: **only snapshot storage**. A 5 GB workspace snapshot = **$0.40/month**; even 32 GB (full disk) = $2.56/month. With `keepLastSnapshots: {count: 1}`, storage stays flat.
- Resume is triggered by any SDK call, so "wake on connect" is cheap and automatic. Creations are effectively free ($0.0000006 each).
- Data transfer matters for a Mutagen-style file mirror: every full 2 GB repo sync in/out ≈ $0.30; continuous incremental sync is small but nonzero; agent-downloaded node_modules etc. also count as transfer.

**Vs competitors (Jan–Jun 2026 third-party comparisons + Vercel's own KB):**
- E2B ≈ $0.0504/vCPU-hr and Daytona ≈ $0.0504/vCPU-hr but both bill **wall-clock**, vs Vercel $0.128/vCPU-hr **active-only** + $0.0212/GB-hr memory. Vercel's own worked example (1,000 sandboxes/day, 30 s wall / 10 s CPU): Vercel ~$63/mo vs E2B ~$191/mo. **[verified as published claims; Vercel-authored comparison, treat pricing spin cautiously]**
- E2B Pro has a $150/mo platform fee; Vercel needs only the $20 Pro plan. **[verified]**
- Cold-start reputation (3rd-party, Jan 2026): Daytona ~90 ms, E2B ~150 ms, Vercel just "fast" (no published number), Modal sub-second, Cloudflare 2–3 s. **[likely; informal benchmarks without methodology]**

## 7. Startup / warm-start latency

- Official docs: "Sandboxes start in milliseconds" (Firecracker fast-boot); GA blog: "sub-second starts for thousands of sandboxes per task." **[verified quotes; no official p50/p99 numbers published]**
- Resume-from-snapshot: "Resuming from a snapshot is even faster than starting a fresh sandbox" — again no number. **[verified quote]**
- Conductor CEO Charlie Holtz: "Vercel Sandboxes are super fast"; "To our users it feels just like the local version of Conductor. They don't know the difference." **[verified quotes]**
- No independent measured number for Vercel cold start was found; benchmarks list it as "Fast" without a figure. **[open question — measure in spike]**

## 8. Isolation & security model

- Each sandbox = its own **Firecracker microVM with a dedicated kernel** (not a container): "microVM boundary prevents escapes… designed for untrusted code." Filesystem, network namespace, and process isolation per sandbox; strict CPU/mem/disk limits; auto-timeouts. **[verified]**
- Auth to the Sandbox API: Vercel OIDC tokens (auto in Vercel envs; short-lived) or long-lived Vercel access tokens for external systems — i.e., Zeros would need a thin backend/worker holding the Vercel token for provisioning, same shape as the current Daytona plan. **[verified]**
- "Sandboxes run on Vercel's secure infrastructure, which maintains **SOC 2 Type II** certification" (sandbox docs). **[verified]**

## 9. Enterprise / compliance

- Vercel platform: SOC 2 Type II (Security, Confidentiality, Availability), **ISO 27001:2022**, PCI DSS, EU-U.S. Data Privacy Framework, TISAX; **HIPAA BAAs signed for eligible Pro and Enterprise customers**; trust center at security.vercel.com. **[verified]**
- Enterprise sandbox perks: custom pricing/limits, >2,000 concurrency, 400 vCPU/min allocation, 100k control-plane requests/min, up to 32 vCPU / 64 GB per sandbox. **[verified]**
- Sandbox-specific data residency: none (iad1 only); docs punt: "For specific data residency requirements, consult your plan details or compliance team." **[verified]**
- Some firewall features (credentials brokering, request proxying, matchers, Drives) are flagged "Permissions Required" in docs — likely gated to specific plans/enablement; exact gating not published. **[likely]**

## 10. Known limits & gotchas (consolidated)

1. **Single region iad1** — latency + residency. **[verified]**
2. **24 h max session** (Pro/Ent), 45 min Hobby; default timeout **5 min** — must set/extend (`extendTimeout()`); sandbox stops at timeout no matter what the agent is doing. Long-lived workspaces are stop/resume cycles, not continuous VMs. Vercel explicitly: "not designed to run continuously… not suitable for permanent hosting." **[verified]**
3. **Snapshots are filesystem-only; processes die on every stop** — engine must be crash-safe and restartable via `onResume`. SQLite (zeros.db) on the sandbox FS survives snapshots fine, but only if writes are flushed before stop; the auto-snapshot happens during shutdown, so WAL checkpointing behavior deserves a test. **[verified mechanics; SQLite nuance = my inference]**
4. **Default 30-day snapshot expiry (from last use)** — dormant workspaces get deleted+recreated unless `snapshotExpiration: 0`. **[verified]**
5. **Fixed 32 GB disk**, fixed 2 GB/vCPU memory ratio — no big-repo/monorepo headroom knobs beyond Drives (beta). **[verified]**
6. **15 exposed ports max**; exposed ports are public-internet, no built-in auth. **[verified]**
7. **WebSocket on exposed ports undocumented** (see §4). **[open]**
8. Concurrency 2,000 (fine), but **vCPU allocation rate limits** (200 vCPU/min Pro) could throttle a spiky "everyone opens 10 workspaces at 9am" pattern. **[verified]**
9. **Drives are single-reader/single-writer beta** — no shared filesystem between two live sandboxes yet. **[verified]**
10. **No GPU.** **[likely]**
11. `fork()` does not copy `env`. **[verified]**
12. Hobby plan pauses sandbox creation entirely once free limits hit. **[verified]**

## 11. How production apps architect on it — Conductor.build case study

Source: Vercel customer story (2026-05-27) + The New Stack coverage + Conductor docs. Conductor is the direct reference competitor for Zeros.

- **What they built:** "Cloud Workspaces, Conductor's remote execution layer built on Vercel Sandboxes, removes the local hardware constraint. Developers can now spawn multiple agents and close the lid without interrupting work." Announced ~early May 2026. **[verified]**
- **Product shape:** identical desktop GUI; "To our users it feels just like the local version… They don't know the difference" (CEO Charlie Holtz). Agents run per-workspace on isolated branches; **"File sync is available for all cloud workspaces"** (local ↔ remote synchronization — mirrors Zeros' Mutagen plan); side-panel diff view of remote agents' changes; sessions keep running after local disconnect. **[verified]**
- **Why Vercel (their stated criteria):** fast spin-up, snapshot support, provider longevity, support depth; "Being agnostic to the providers is the key, and we get that with Vercel." Model/harness-agnostic layer (Claude Code, Codex, etc.) on a stable cloud substrate. **[verified]**
- **Business context:** $22M Series A; used by teams at Notion, Linear, Ramp. **[verified via The New Stack / Vercel blog]**
- **What the case study does NOT disclose:** their sync protocol, where their DB lives, how the desktop app authenticates to sandboxes, whether they use fork/snapshots for workspace branching, costs. **[verified absence]**
- Note: the earlier intel that Conductor uses "Vercel Sandbox + Fly.io Sprites + Fly-hosted backend" is only half-corroborated here — the Vercel Sandbox part is now officially confirmed for Cloud Workspaces; **no public evidence of the Fly.io component was found in this research pass** (didn't rule it out either — could be their backend/DB tier). **[unverified]**
- Other production patterns from Vercel guides: run a headless agent server (OpenCode) in the sandbox behind basic auth on an exposed port, connect local TUI/browser directly; egress-lock the sandbox to just an AI gateway domain; use snapshots to skip dependency install; Claude Agent SDK guide exists too. Roo Code CEO on snapshots: "Snapshots turn agents from stateless workers into persistent collaborators." **[verified]**

## 12. Fit notes vs the current Zeros Daytona plan (analysis, not sourced)

- The Daytona plan's architecture (engine + zeros.db in sandbox, preview-URL WSS + per-user token, thin provisioning worker holding the platform API key, git remote + export blobs for durability) maps 1:1 onto Vercel Sandbox primitives: exposed-port URLs ≈ Daytona preview URLs; app-level token auth required on both; OIDC/access token ≈ Daytona API key in worker; persistent sandboxes + `keepLastSnapshots` handle the sleep/wake economics natively (Daytona equivalently has auto-stop + archived state).
- Advantages Vercel would bring: Conductor-proven for this exact product; persistence/fork/getOrCreate are turnkey (less state machine to build); active-CPU billing suits LLM-wait-heavy agents; strong egress firewall + credentials brokering (tokens never inside the VM); SOC2/ISO/HIPAA posture.
- Disadvantages vs Daytona: iad1-only (Daytona has US + EU), 24 h session cap (Daytona sandboxes can run longer / have different lifecycle), no published cold-start number (Daytona ~90 ms), memory fixed to 2 GB/vCPU, 32 GB disk cap, WebSocket-on-exposed-port unconfirmed (Daytona documents WSS over preview URLs), Drives (shared storage) still beta and single-writer.

## Sources

Official Vercel docs (all fetched 2026-07-02):
- https://vercel.com/docs/sandbox (overview; last_updated 2026-06-17)
- https://vercel.com/docs/sandbox/pricing (pricing & limits; last_updated 2026-06-16)
- https://vercel.com/docs/sandbox/concepts (Understanding Sandboxes — isolation, lifecycle, security; last_updated 2026-06-05)
- https://vercel.com/docs/sandbox/concepts/snapshots (last_updated 2026-06-10)
- https://vercel.com/docs/sandbox/concepts/persistent-sandboxes (last_updated 2026-05-29)
- https://vercel.com/docs/sandbox/concepts/firewall (last_updated 2026-05-25)
- https://vercel.com/docs/sandbox/concepts/drives (Drives beta; last_updated 2026-06-05)
- https://vercel.com/docs/sandbox/working-with-sandbox (last_updated 2026-06-17)
- https://vercel.com/docs/sandbox/sdk-reference (JS SDK; last_updated 2026-06-16)

Vercel changelogs / blog:
- https://vercel.com/blog/vercel-sandbox-is-now-generally-available (GA, 2026-01-30)
- https://vercel.com/changelog/vercel-sandboxes-ga (2026-01-30)
- https://vercel.com/changelog/sandbox-persistence-is-now-ga (2026-05-26)
- https://vercel.com/changelog/vercel-sandbox-can-now-run-for-up-to-24-hours (2026-06-16)
- https://vercel.com/changelog/vercel-sandbox-increases-concurrency-and-port-limits (2025-08-18)
- https://vercel.com/changelog/vercel-sandbox-maximum-duration-extended-to-5-hours
- https://vercel.com/blog/how-conductor-moved-parallel-coding-agents-from-the-laptop-to-the-cloud-with-vercel-sandbox (2026-05-27)
- https://vercel.com/blog/vercel-ship-2025-recap (beta launch, 2025-06)
- https://vercel.com/sandbox (marketing page)

Vercel KB guides:
- https://vercel.com/kb/guide/vercel-sandbox-vs-e2b (2026-06-05)
- https://vercel.com/kb/guide/running-opencode-securely-with-the-vercel-sandbox
- https://vercel.com/kb/guide/sandbox-private-github-repositories

Source code (github.com/vercel/sandbox, read via gh api 2026-07-02):
- packages/vercel-sandbox/src/session.ts (domain() → `https://<subdomain>.vercel.run`; openInteractive() → WSS URL + token)
- packages/sandbox/src/interactive-shell/interactive-shell.ts (CLI WebSocket client)
- skills/sandbox/SKILL.md (ports up to 15, create options)

Vercel compliance:
- https://vercel.com/docs/security/compliance
- https://vercel.com/blog/vercel-supports-hipaa-compliance
- https://security.vercel.com/

Third-party:
- https://thenewstack.io/conductor-cloud-ai-coding-agents/ (Conductor Cloud, early May 2026; $22M Series A) — full text not retrievable; details via search excerpts
- https://www.superagent.sh/blog/ai-code-sandbox-benchmark-2026 (cold starts: Daytona ~90 ms, E2B ~150 ms, Vercel "fast"; updated Jan 2026)
- https://gist.github.com/homanp/b0bb68dad99a9434057e37e730a66039 (sandbox comparison gist, created 2026-01-16)
- https://www.startuphub.ai/ai-news/artificial-intelligence/2026/daytona-vs-e2b-vs-modal-vs-vercel-sandbox-2026
- https://particula.tech/blog/modal-vs-e2b-vs-daytona-vs-vercel-sandbox-ai-code-execution
- https://www.computesdk.com/blog/how-to-run-your-first-vercel-sandbox/ (Vite `hmr: false` example — third-party tunnel, weak WS signal)
- https://x.com/rauchg/status/2017423825152184772 (GA announcement tweet)
- https://community.vercel.com/t/creating-a-sandbox-with-more-than-1-port-exposed-throws-errors/15728 (dated multi-port bug report)
- https://deepwiki.com/vercel/sandbox (CLI connect = WebRTC/WebSocket PTY tunnel)
