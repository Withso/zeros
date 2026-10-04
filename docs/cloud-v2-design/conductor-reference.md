# How Conductor's cloud works — reference for Zeros (v1, orchestrator-verified)

Status: written by the orchestrator from first-hand inspection of this Conductor cloud VM
(workspace 868c47cc…, runtime 2c97beec…, 2026-10-04), Conductor's public docs and OpenAPI, and the
Conductor Mac app's local files on nisha-10482. Deep internals are in the R1/R2b reports; every
claim here was checked by the orchestrator unless marked (R1)/(R2b)/(INFERENCE).

## 1. The four layers

| Layer | Conductor | Where it runs | Zeros today |
|---|---|---|---|
| Control plane ("Roundhouse") | `api.conductor.build` — workspaces, sessions, messages, events, builds, auth broker, Codex ChatGPT proxy, public `/v0` API, hosted `/mcp` | Conductor's servers | Control plane on Railway (`api*.zeros.build`) |
| Sandbox provider | Vercel Sandbox (Firecracker microVM, Amazon Linux 2023, 8 vCPU/16 GB/32 GB, us-east-1) | Vercel | Boat (`boat.dev/api/v1`) |
| Org environment ("Cloud Computer") | One per org: active build = repos (≤50) + env vars/secrets + installed software, saved as a snapshot; history + rollback | Snapshot lineage at the provider | `cloud_computers` per org (draft/active profile), org images derived from a qualified base image |
| In-VM runtime | `/conductor/` (real directory) whose `bin`, `worker`, `manifest.json` selectors point into `/conductor-infra/<runnerSha>/`: Rust host runtime + Node worker + agent CLIs + wrappers | Inside every workspace VM | Runtime baked into the image (`/opt/zeros`, `/opt/zeros-runtime`, `/etc/zeros`, `/run/zeros`) |
| Client | Conductor Mac app 0.90.1 (direct-access websocket "uplinks", SSH aliases, file sync) | User's Mac | Zeros desktop app (runtime bridge/relay, cloud replica) |

## 2. Inside the VM: `/conductor`

```
/                                   Vercel image (Amazon Linux 2023), user vercel-sandbox (uid 1000, passwordless sudo)
├── run/vercel/share/sandbox-init   PID 1 (Vercel), /run/vercel/share/init.sock
├── vercel/runtimes/node24          Node 24 / npm / pnpm (Vercel-provided)
├── conductor-infra/                version-addressed runtime payloads (one dir per runner git SHA;
│                                   boot-generated wrappers inside bin/)
│   ├── affea025…/                  previous runtime (v22, 2026-10-02) — kept
│   └── 2c97beec…/                  current runtime (v22, 2026-10-03)
│       ├── manifest.json           {sandboxRunnerGitSha, sandboxRunnerVersion, sandboxRunnerAssetFingerprint,
│       │                            hostRuntimeBinaryName, agentBinaryUrlHashes{claude,codex,codexCodeModeHost,
│       │                            githubCli,ghStack,ripgrep}, createdAt}
│       ├── binaries/               claude (Claude Code 2.1.286), codex, codex-code-mode-host,
│       │                           conductor-workspace-host-runtime (Rust), gh-stack, rg, conductor-cli.js
│       │                           + <name>.sha256 beside each downloaded binary
│       ├── internal/gh             real GitHub CLI (shadowed by the wrapper)
│       ├── bin/                    PATH entry: symlinks to binaries + generated wrappers
│       │                           (git, gh, git-askpass — regenerated at boot, mode 700, no secrets)
│       │                           checkpointer.sh, git-busy-check.sh, conductor (CLI launcher)
│       └── worker/                 index.js (worker), wda-frontend.js, codex-local-execution-mcp.js,
│                                   numbered chunks, conductor-skill/, computer-admin-skill/
├── conductor/                      STABLE ENTRY POINT + PER-MACHINE STATE
│   ├── bin -> /conductor-infra/<sha>/bin
│   ├── worker -> /conductor-infra/<sha>/worker
│   ├── manifest.json -> /conductor-infra/<sha>/manifest.json
│   ├── disk-epoch                  integer, +1 by the boot shell on every launch on this disk lineage
│   │                               (published in the host's readiness line; wake-from-sleep use = INFERENCE)
│   ├── sessions/<sessionId>.json   durable per-session inbox/outbox (see §4)
│   ├── logs/server.log             host runtime + children (rotated at 10 MiB → newest ~6.7 MiB)
│   ├── logs/workspace.log          worker log
│   └── state/                      runtime state (empty here)
└── home/vercel-sandbox/
    ├── <repo>/                     the workspace checkout (CONDUCTOR_WORKSPACE_PATH / ROOT_PATH)
    ├── .context/ (in repo, gitignored) agent collaboration files
    ├── .gitconfig                  written at boot (git-lfs filters + broker-backed github.com helper)
    ├── .claude/, .claude.json, .codex/  agent CLI state (updated during sessions)
    └── .global/, .npmrc, .bash_profile   image defaults (predate this boot)
```

Size: one runtime version ≈ 730 MB (binaries 676 MB: Claude Code 241 MB, Codex 287 MB, host
runtime 74 MB, code-mode host 74 MB; worker JS 17 MB). Two versions retained (1.5 GB). Hard-link
reuse between versions is partial (29 small files, ~6 MB); large unchanged binaries are separate
inodes, and boot-generated wrappers make the tree not strictly immutable (R1 §10).

## 3. Boot and process model (verified)

```
sandbox-init (PID 1, Vercel)
└─ bash -l -c '<boot script>'                 (launched via the provider's command API — INFERENCE)
   ├─ disk-epoch += 1 (atomic tmp+mv); export CONDUCTOR_INTERNAL_DISK_EPOCH
   ├─ log rotation loop (30 s) + `chmod 1777 /tmp` (not a restart loop)
   ├─ tail -f server.log (stdout for the provider's log stream)
   └─ conductor-workspace-host-runtime: reaper process → app process (Rust; tokio/axum/hyper/rustls;
      OTEL logs+traces; unauthenticated local /health; WDA child restarted on exit)
      ├─ cgroup v2 /sys/fs/cgroup/conductor/{host-runtime,workload}: CPU caps (7000/6000 millicores)
      ├─ memory watchdog (crash <300 MiB available; thrash PSI avg10 ≥10 ×2), OOM steering
      ├─ runtime ingress listener 0.0.0.0:49173 (CONDUCTOR_INTERNAL_HOST_PORT; sshd on :22 and an
      │  unresolved [::]:23456 also observed) — authenticated (INCOMING_AUTH,
      │  WORKSPACE_AUTH, WDA_VERIFY_KEY); "WDA direct-access routes"; media server with expiring tokens
      ├─ pty-ipc Unix socket (terminals)
      ├─ node /conductor/worker/index.js       (cwd = repo)  → Roundhouse client, agent runner, MCP, broker
      │  └─ /conductor/bin/claude --output-format stream-json --input-format stream-json … (per session)
      │     codex (via app-server / code-mode host, OPENAI_BASE_URL = Conductor's ChatGPT proxy), cursor
      └─ node /conductor/worker/wda-frontend.js (127.0.0.1:42145) → Mac uplinks: file-sync, port-forwards
   readiness line: __CONDUCTOR_WORKER_HTTP_LISTENING__ {addr, diskEpoch, sandboxRunnerGitSha,
                    sandboxRunnerVersion, sandboxRunnerAssetFingerprint, workspaceId}
```

### 3.1 Host runtime HTTP surface (R1, orchestrator-verified samples)

The Rust host (a reaper process + the app process; tokio/axum/hyper/rustls) owns the Conductor
runtime ingress listener (sshd on :22 and an unresolved :23456 listener were also observed; public
routability of each listener was not tested). Route families recovered from the binary: runtime (`/health`, `/worker-kept-alive`,
`/auth`, `/shutdown`, `/jsonrpc`); control callbacks (`/github-credentials/changed`,
`/agent-credentials/changed`, `/session-notifications/drain|ack`); sessions
(`/sessions/{id}/messages|stop|rollback|config|respond-to-plan|answer-question|slash-commands|
context-usage|codex-goal`); client RPC (`/sessions/{id}/frontend-rpc/{req}/claim|resolve`); files
(`/files/list|read|read-text|write|write-stream|stat|search|grep|media|media-token|artifacts`);
file sync (`/files/sync/bootstrap|snapshot|read|write|delete-batch`, `/spotlight/sync`);
`/shell/execute`; `/mcp-servers`; direct transports (`/direct/mws`, `/direct/tcp-proxy`,
`/direct/tcp-tunnel`, `/direct/ssh`, `/direct/desktop`). The host talks to the Node worker over
**stdio NDJSON** (typed methods such as `session.sendUserMessage`, `workspace.ping`), not HTTP.
Direct access ("WDA") uses Ed25519 JWTs: issuer `roundhouse`, audience `workspace-direct`,
workspace id + scopes (`files:read`, `terminal:connect`, …), ±30 s skew, `jti` replay cache.
Native modules: file_sync tracker (inotify), listening_ports, tcp_proxy/tunnel, virtual_desktop,
pty, resource_limits, oom_steering, memory_watchdog, process_log, otel_trace.

### 3.2 Worker ↔ Roundhouse (R1, verified samples)

Outbound HTTP only (no long-lived worker WebSocket): `POST /sessions/{id}/notification` (gzip,
batches ≤50 events, returns `x-conductor-session-event-watermark`); message inbox
`/workspaces/{ws}/session-message-inbox/{recover|sessions/read|sessions/{id}/read|{msg}/ack|
{msg}/assets/{asset}/read}` (claim → persist → guarded ack with expected generation/revision →
deliver → complete); `/workspaces/{ws}/{github-token|sessions/{id}/github-token|user-github-token}`
(+ `/report-failure`); `/workspaces/{ws}/{codex-chatgpt-token|claude-oauth-token|agent-auth-modes}`;
`/workspaces/{ws}/worker-keepalive`; `/workspaces/{ws}/sleep-request`;
`/workspaces/{ws}/{checkouts|pull-requests/associate}`; `/models/catalog`; computer-admin
`/workspaces/{ws}/computers/{list,get-configuration,create-configuration,build-status,
update-repository-setup-script}`. Requests carry `workspaceId` + `workspaceAuth`.
Idle policy lives in the worker (`idleMonitor.ts`): 30 s ticks; defaults 5 min idle and 4 h 55 m
lifetime, overridden by `CONDUCTOR_INTERNAL_IDLE_TIMEOUT_MS` (1 h here) and `…MAX_LIFETIME_MS`
(≈23.8 h here); it asks Roundhouse to sleep the VM (`reason: idle|max_lifetime`).
Agents: Claude via the Agent SDK driving the native CLI (`stream-json`, `maxTurns 1000`,
Conductor MCP + plugin dirs, `PreToolUse` checkpoint gate); Codex via
`codex app-server --listen stdio://` + `codex-code-mode-host`, Conductor MCP helper over a Unix
socket, ChatGPT proxy provider `conductor_chatgpt` (no websockets); Cursor via `@cursor/sdk`
in-process with a SQLite store.

## 4. Durable session state

`/conductor/sessions/<sessionId>.json` holds: agent type and config (model, harness, thinking
level, fast mode, chrome/local-execution MCP flags, workspace settings revision),
`hasStartedAgentTurn`, `lastRoundhouseSessionEventWatermark`, `nextNotificationIndex`,
`pendingNotifications[]` (outbox of events not yet acknowledged by Roundhouse, with payload
truncation metadata), `skippedNotifications`, `inboxMessages` (user messages received but not
delivered to the agent), `deliveredInboxMessageIds`, `sessionUserGeneration`, `sessionUserId`.
⇒ a retrying, identity-bearing inbox/outbox per session that survives worker restarts and
sleep/wake (the disk persists; processes do not). Writes are tmp+rename without fsync; dedupe is
bounded (last 100 delivered ids, ≤1,000 skipped notifications); on restart live turn state is
reset to idle (interrupted turns are not automatically continued) and a `sandboxRestart` event
is emitted per session. Not exactly-once for tool side effects (R1 §3.3–3.5).

## 5. Credentials and Git

- Agent credentials are injected as environment variables for the agent processes:
  `CLAUDE_CODE_OAUTH_TOKEN` (user's Claude subscription), `CURSOR_API_KEY`; Codex talks to
  `OPENAI_BASE_URL=https://api.conductor.build/internal/codex-chatgpt-proxy/<workspaceId>/v1`
  with a proxy token. (Observed proxy path; a separate ChatGPT token-refresh path also exists, so
  "the raw login never reaches the VM" is UNCONFIRMED — R2b §5.)
- Org Cloud Computer env vars/secrets arrive as `CONDUCTOR_INTERNAL_CLOUD_ENV_JSON` and are
  exported into workspace processes (precedence: repo/personal cloud vars > org vars).
- GitHub: no token on disk. `git`/`gh` wrappers call a per-session Unix-socket broker
  (`/tmp/conductor-agent-git-auth-<ws>-<pid>.sock`; `context=session:<id>`; capability header)
  for a short-lived token per network operation; on 401 they report the token hash
  (`/report-failure`) and retry with a fresh one; `gh pr create` / `gh stack submit` are detected
  and reported (`/pr-created`) so the workspace links its PR.
- A workspace-issued Conductor API token (`CONDUCTOR_API_TOKEN`, `condw_…`; it listed multiple
  caller-visible workspaces/projects; cross-user/private access and write scope untested) lets agents call the
  public API from inside the VM (the `conductor` CLI is preinstalled).

## 6. Checkpoints

`checkpointer.sh save|restore|diff` stores full working-tree snapshots (tracked + untracked,
honoring .gitignore) as commits under private refs `refs/conductor-checkpoints/<id>`, without
moving HEAD or touching files; restore is minimal-write (only differing files), refuses outside
the workspace root, and skips during merges/rebases (exit 101/102). Used per agent turn
("Checkpoints: view turn-by-turn changes and revert").

## 7. Cloud Computer (org snapshot lineage)

- Configuration: repositories (≤50 GitHub), environment variables & secrets, **Install software**
  script (once per build, bash -euo pipefail, sudo dnf), per-repository **Setup script** (runs at
  every workspace creation; saving it needs no build).
- **Build computer**: clone/refresh repos, add env, run install script, save snapshot. Success →
  automatically **Active** (new workspaces start from it; existing workspaces keep theirs).
  Build logs (stdout/stderr + system "event" lines), Restart build, History, Activate an older
  successful build (instant rollback).
- Evidence (INFERENCE, medium) that builds reuse one filesystem lineage per org at least for repos:
  this VM's repo reflog has a single `clone` on
  2026-07-27 followed by ~27 `reset: moving to origin/main` at build times (two coincide to the
  second with the two runtime installs), and `/conductor-infra` keeps the previous runtime.
  (The computer-admin skill nevertheless tells agents to write install scripts as if each build
  starts fresh.)
- **Configure with an agent**: an Admin workspace whose agent has admin tools
  (ListComputers, GetComputerConfiguration, CreateComputerConfiguration, GetComputerBuildStatus,
  UpdateRepositorySetupScript) and the computer-admin skill; it cannot change env/secrets, repos,
  members or credentials, or activate old builds. Tool contract (worker index.js:73001-73005,
  250579-250583): CreateComputerConfiguration publishes a new configuration with a replaced
  install script and starts a snapshot build (script runs after repos are cloned; repos and env
  carried forward); requires `previousBuildId` (optimistic concurrency → conflict on change); a
  running build is cancelled and replaced; failed builds never become active;
  GetComputerBuildStatus returns status (`ready`/`failed`…) + last 200 log entries + failureReason;
  UpdateRepositorySetupScript saves a per-repo script that runs in a fresh checkout at every
  workspace creation, no build needed (current docs: the repo's own .conductor/settings.toml is
  ignored in cloud; the bundled conductor skill still describes an older TOML/JSON fallback).
- Onboarding: create org → computer color → GitHub App + repos → build starts → add an agent
  credential (personal, or org-shared API keys, which take precedence over a member's personal API key
  for the same agent; precedence over subscriptions unconfirmed) → Finish → Admin workspace.

## 8. Workspace lifecycle

Create (app ⌘N / API / MCP / routines) → VM from the active build → repo fetch + branch → repo
setup script → agent session. Sleep: docs say 4 h without agent/terminal activity; this VM's
override is 1 h; the worker's built-in fallback is 5 min. Hard stop at
23 h 50 m (`CONDUCTOR_INTERNAL_MAX_LIFETIME_MS`); files + chats survive, processes don't; open =
wake (disk-epoch increments). Restart, archive/unarchive, sleep via API. Multiplayer: org-wide
visibility, presence, shared chats, Follow, **Reassign to** (hand-off). SSH via Mac-managed
aliases (`<name>.conductor` → 127.0.0.1:<port>, root, ~/.conductor/ssh/id_ed25519, PQ KEX),
one-way per-member file sync, cloud/local terminals, port forwarding (22 reserved), previews.

## 9. API, CLI, MCP

- REST `https://api.conductor.build/v0` ("Roundhouse public API 0.0.1", OpenAPI at
  `/v0/openapi.json`): projects; workspaces (list/create/get/rename/archive/unarchive/sleep/
  status/section/preview); sessions (create/get/rename/archive/unarchive/status/cancel/messages);
  messages; `sql` over `session_transcripts_view` (listed, but returned HTTP 503 "temporarily
  disabled" during this research); routines (webhook-triggered prompts, user API
  key only); sections; favorite-models; `/me`. Bearer tokens (user API keys; workspace-issued
  tokens inside VMs; `X-Conductor-Session-Id` attribution). Pagination `{data, offset, hasMore}`,
  transcript cursor `after`, errors carry `userMessage`.
- Hosted MCP `https://api.conductor.build/mcp` (Streamable HTTP; OAuth with Dynamic Client
  Registration + PKCE + refresh, scope `mcp:tools`, bound to one org; API-key bearer fallback);
  20 tools mirroring `/v0`.
- CLI `conductor` (Node bundle) = the same API with keychain/env auth, `--json`, deep links.
- In-session MCP tools for agents (AskUserQuestion, DiffComment, GetDiffComments,
  GetTerminalOutput, GetWorkspaceDiff, RunLocalCommand) are provided by the worker/app (R1).

## 10. What to copy, what to adapt (summary; details in FINAL-02)

Copy: versioned immutable runtime bundles + stable `/zeros` symlinks; disk-epoch; durable
per-session inbox/outbox; boot script + supervisor; Unix-socket Git broker with short-lived
tokens; private-ref checkpoints; org Cloud Computer with build history/activate; per-repo setup
scripts; admin agent; `/v0`-style API + hosted MCP + CLI sharing one contract.
Adapt: provider calls (Boat instead of Vercel), Zeros' stronger credential sealing and
qualification, the desktop's existing relay/replica instead of WDA uplinks where they already work.
