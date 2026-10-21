# Cloud worker runtime

The worker is a Linux process for one organization workspace. It imports shared
protocol code, never the Local engine. Local Personal and organization-local
workspaces retain their existing runtime. Native provider fixtures and boundary
tests verify the separation; no live credentials are needed for these tests.

The renderer's cloud wire maps cloud keys to native values before requests reach
the worker. `workspace.list` returns `{ workspaces: [row] }` with the configured
workspace UUID and absolute checkout path; `workspace.get` returns that row.
File arrays and Git paths remain relative to the checkout. The worker checks both
lexical and descriptor containment, including symlinks, before file access.

Chat metadata and transcript rows are durable worker snapshots, mirrored to the
control plane. Git target metadata lives beside those snapshots in
`workspace.json`; it survives restart and repeated copies of the same config.
A changed configured base branch replaces that metadata. Target selection itself
does not rebase, stash, or change HEAD. An explicit `rebase:true` opts into rebase.

File services provide tree, ignored-directory, bounded read, atomic text write,
and directory listing operations. Git services provide status, independent
comparison counts, line totals, bounded diff, log/show, branch lists, staging,
commit, fetch/push/pull, branch operations, stash, integration and tag operations.
Git mutations share a queue; reads remain independent. Native HEAD/ref changes
and checkout file changes emit `DB_CHANGED` for the native workspace UUID.
PR metadata is cached by branch and invalidated by ref changes and Git mutations.

PTY shells are shared by native session id. App disconnect and relay reconnect
retain the shell; explicit kill removes it. Exited shared rows remain visible
until closed or restarted. Ephemeral terminals are private to one app connection
and close with it. Login terminals are unavailable in cloud. Checked directory
descriptors bind native startup to the checkout, and children inherit only
runtime variables and GitHub broker wiring.

Reattach uses the same xterm resolved-screen serializer as Local. A per-shell
queue orders screen snapshots, subscriptions and live bytes, with native output
paused at 256 KiB pending and resumed below 128 KiB. Terminal dimensions and
registry size are bounded. Pending starts and input/output within the last ten
minutes keep terminals active, including while no app is connected. Quiet shells
survive detach without preventing idle-stop. The 55-second heartbeat repeats
active status and announces idle once when activity expires.

Unsupported operations always return `CLOUD_V2_UNSUPPORTED`. The explicit lists
in `workspace/chat-service.ts` and `workspace/git.ts` have regression tests.
Git reset/restore/clean, hunk mutations, repository creation/catalog operations,
and turn checkpoint history are deferred. No request is silently acknowledged.

Offline acceptance uses temporary Git repositories and a fake relay. Live
provider, Boat, model proxy, and private-GitHub acceptance belongs to the
integration owner; a Linux test does not establish macOS engine parity.

Claude uses one pinned SDK query across prompts and drains native background
output after the foreground result. Native user UUIDs identify turn and steering
receipts; child and unrelated autonomous results cannot complete a newer send.
Stop discards unpulled input, marks unacknowledged delivery uncertain and retires
the query. The next explicit prompt resumes its native conversation. Model
changes use SDK control. Full VM permissions bypass interactive approvals;
unsupported questions and elicitation requests receive immediate cancellation.
Native failures end the turn without an automatic prompt retry. A reserved
Claude UUID is provisional until model content or a successful root result
confirms its native binding; opening a view cannot create a false resume target.

Cursor keeps one native SDK agent per conversation in a separate Node host.
The host receives only Cursor's login plus runtime and Git broker variables;
SDK output uses an IPC channel separate from native logs. Each send has its own
native run and mapper, including callbacks before send resolves. Text steering
uses native receipts; lost receipts remain uncertain and are never replayed.
Stop cancels a pending send as soon as its run appears, with a bounded process
group shutdown if it stalls. Model changes apply to the next send. Question
tools are excluded; an unexpected question ends the turn. The SDK's `request`
frame is ordinary request-id metadata. Final results and bounded, owned child
transcript reads settle before turn completion. Usage comes from the native run;
only an exact run-id billing match supplies cost, with no inferred charges or
late billing polling.

## Image package

Build on Linux with Node 24 LTS, on the same architecture and glibc as the VM:
`pnpm --filter @zeros/cloud-worker build`. Install the entire `dist/` directory
as `/opt/zeros/worker`, owned by root. It includes `worker.mjs`, `cursor-host.mjs`, `git-askpass.mjs`,
`gh.mjs`, executable `bin/gh` and `bin/git-askpass` wrappers, `package.json`,
`runtime-manifest.json`, license notices and a materialized `node_modules/`.
There are no links back to the build checkout or pnpm store. The manifest records
the exact runtime pins, dependency versions and SHA-256 of every shipped file.

The bundle contains the protocol, WebSocket and terminal-screen libraries.
External runtime packages are node-pty (including its native addon), Codex
0.162.1 and its platform binary, Claude Agent SDK 0.3.296 and its platform CLI,
and Cursor SDK 1.0.37 and its platform binaries. Their runtime dependencies and
required peer dependencies are included; nothing downloads at startup.

Boat's stock account is `user`. Run the service as `User=user`, with
`WorkingDirectory=/home/user` and
`ExecStart=/usr/bin/env node /opt/zeros/worker/worker.mjs`.
Put `/opt/zeros/worker/bin` first on PATH for the service and login shells.
The two non-secret boot variables are `ZEROS_WORKER_URL` and
`ZEROS_WORKSPACE_ID`. The worker waits for the owned 0600 token file at
`/home/user/.config/zeros/worker-token` and rereads it for every connection.
State is under `/home/user/.local/share/zeros/cloud-worker`; the checkout is
the absolute path from the relay config. Service logs contain status codes only.

Git HTTPS askpass and the gh wrapper obtain short-lived GitHub tokens from the
private worker Unix socket. Tokens stay in process memory; persistent Git
credential helpers are disabled. A token refusal or a failed command is surfaced
without replaying the Git mutation. Successful gh PR mutations invalidate cached
workspace PR metadata. The real gh executable is `/usr/bin/gh`.
