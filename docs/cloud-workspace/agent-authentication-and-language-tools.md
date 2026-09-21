# Native agent authentication and language tools

A workspace grants access to its code, not to another person's agent account.
Each credential has an account owner and a consent revision. Each delegation
names one current collaborator, workspace, compute trust boundary, model list
and expiry. The immutable workspace sponsor funds compute independently.
Every execution is bound to the initiating actor/device session, exact durable
command (when queued), engine instance and generation. Stop, revocation,
identity erasure and image disqualification invalidate that authority.

## Codex subscription renewal

An authenticated owner imports a dedicated native managed `auth.json` through
`PUT /v1/cloud-agent-credentials/:credential/native-codex`. The body contains
`operationId`, `expectedRevision`, `displayName` and `nativeCache`; responses
contain metadata only. A new login is required if this cache is also refreshed
by an unrelated native client: copying a rotating refresh stream between
independent writers is unsupported. Existing API-key and access-only imports
remain available through the original credential endpoint.

The control plane validates the bundle shape and consistent account/subject
claims, then encrypts the native cache separately from access material. Parsing
JWT claims does not establish provider authentication; the pinned provider
endpoint still validates tokens. Expired access may be imported with its strict
native cache, but cannot enter an execution until successfully renewed.

Codex 0.154.0 runs briefly as an authentication-only process with a private
0700 home and 0600 native cache. Its fixed RPC sequence is `initialize`,
`initialized`, and managed `account/read` with `refreshToken: true`. It receives
no repository, tools, model request, inherited environment, custom endpoint,
proxy, MCP server or user configuration. Output and time are bounded; it is
retired before the resulting cache is inspected. RPC success alone does not
prove refresh success. The resulting bundle must change and retain its original
account binding. A refresh-token-only rotation is preserved even if access is
still too old to deliver.

A database reservation is committed before native startup, followed by a durable
dispatched state. Concurrent replicas wait on that same attempt. A dispatched
attempt with an unknown outcome is never retried from its old seed. The original
fenced attempt may still publish a proven late result. Owner replacement,
revocation and erasure win over publication. Workspace access is checked again
before delivery, separately from saving a known rotated cache. No database
transaction remains open across native or provider I/O.

Access-material versions advance independently of owner consent. Existing
explicit delegations remain valid on transparent token rotation. Owner edits
advance consent and revoke delegations. The trusted engine receives only access
token, account identifier and expiry. Refresh and ID tokens never enter the VM,
bridge events, histories, checkpoints or tools. Native
`account/chatgptAuthTokens/refresh` obtains a newer access version under the
same live lease and returns an explicit nullable plan type. A forced callback refuses unchanged access bytes even when a refresh-only cache rotation was safely saved. Its eight-second budget includes queued validation and provider I/O. Native Codex owns
its original-request retry; Zeros does not replay the user's prompt.

The execution lease has an independent monotonic expiry. Serial validation
prevents old HTTP responses from rolling material back. Stop or expiry retires
processes immediately and a late refresh response cannot revive an execution.

Opaque refresh-seed security tombstones prevent duplicate imports, including
imports racing an account purge. Purge erases native caches and owner/credential
associations; tombstones retain only a keyed fingerprint and key version, with
no timestamp. These are security records, not a claim of anonymous data.
Configure `CLOUD_CODEX_REFRESH_FINGERPRINT_KEYS_JSON` and
`CLOUD_CODEX_REFRESH_FINGERPRINT_CURRENT_KEY_VERSION` with a dedicated keyring.
Its keys are distinct from workspace-secret encryption keys. Before changing the current fingerprint version, preload both old and new keys on every replica. All registered
fingerprint versions must remain available; a small registry detects omitted
or silently changed keys without scanning tombstones. This permits ciphertext
key retirement without weakening spent-seed protection. Do not remove or reuse
a fingerprint key version. Native-cache import fails closed if this keyring is
unavailable.

The provider contract is based on the pinned native protocol and the official
[app-server authentication contract](https://learn.chatgpt.com/docs/app-server)
and [CI authentication guidance](https://learn.chatgpt.com/docs/auth/ci-cd-auth).
Native version changes require renewal and uncertain-outcome requalification.

## Portable language tools

`cloudLsp.request` exposes typed TypeScript, JavaScript and Python operations:
start, stop, open/close a disk document, document/workspace symbols and
completions. Positions use zero-based UTF-16 columns. Requests cannot supply
an executable, environment, arbitrary JSON-RPC method, server configuration,
plugin or unsaved document. Results are bounded scalar projections without
commands or server-driven writes. Symbol positions carry an exact document
SHA-256 where possible; a racing edit is rejected. Workspace symbol results
are explicitly best-effort against current disk state.

Human language access requires a current edit-capable workspace actor. Each
connection owns its servers; one device closing them does not close another's.
Human servers run behind the C process supervisor with a read-only worktree,
private PID/proc/network namespaces, empty environment, UID/GID 10001 and 64MiB
scratch. Agent language tools run inside that execution's credential-free
workload and its Code/Design policy, under the same live paid-agent lease as
other agent tools. Personal credentials never enter either language server.

Pinned servers are typescript-language-server 5.1.3 and Pyright 1.1.414, using
the image's pinned TypeScript compiler. There are at most four servers per
engine, 32 open documents per server and eight queued requests per connection.
Inputs are 64KiB per file, RPC messages 1MiB, results 500 entries; symbol traversal
also limits visited entries and attempted file probes. Queries, helper reads,
initialization and retirement have deadlines. Node V8 heap limits are not an
RSS guarantee; the engine's aggregate cgroup remains the memory boundary.
Capacity returns only after process retirement is proven, including a failed
launch with a late child. Unproven cleanup quarantines the affected runtime.

Local native-process, root namespace and regression tests establish these
contracts. Exact Boat/Daytona image, native-account and hosted end-to-end
qualification remain separate release requirements; see
[qualification status](qualification-status.md).

## Runtime qualification and activation

Runtime registration sends actor protocol 2 and the immutable
`zeros-cloud-worker-v3` attestation. The engine checks image metadata ownership,
source-contract files and compiled artifact hashes before registration. The
registered `contractSha256` is the baked image **recipe** digest
(`imageContractSha256`), not a report digest, source commit or metadata-file
hash. The host bootstrap independently verifies the full image provenance.

Application SQL credentials can read qualifications but cannot enable them.
Use `pnpm --dir apps/control-plane cloud-runtime:manage <evidence.json>` with
migration-owner `DATABASE_URL` and
`CONTROL_PLANE_RUNTIME_QUALIFICATION_CHANNEL`. The default is a read-only plan.
The document contains an operation UUID, active platform owner UUID, enabled
flag, reason and `CloudAgentRuntimeEvidenceSchema` evidence. Retain the actual
private qualification artifacts and their digest. The command validates the
operator's assertions; it does not execute those tests or cryptographically
prove that a submitted evidence hash names genuine test results.

After reviewing the exact target and evidence, set
`CONTROL_PLANE_RUNTIME_QUALIFICATION_APPROVAL` to the returned plan hash and
repeat with `--execute`. Plans bind channel, database host/name, routing login
(including PlanetScale's branch suffix), immutable image, recipe, exact
credential kinds, current rows and append-only image revision. Password rotation
does not change the target. A routing/login change or intervening qualification
change requires a new plan. Successful operation retries return their original
receipt even after evidence expires. New enables require evidence at most seven
days old. Disable uses a new operation UUID and preserves all prior receipts.
Only qualified credential kinds are enabled; a successful API-key test cannot
enable subscription authentication. Codex subscription evidence also requires
native renewal. Keep these commands outside the application runtime and public
API. Native provider turn/resume/Stop tests remain necessary for every enabled
image and authentication kind.

## Device connection lifetime

The native access client signs actor admission with its enrolled device and
uses the configured control-plane WSS origin. It never sends a WorkOS bearer
to the sandbox. The short admission deadline applies to the one-use upgrade;
a connected stream is governed by the server's renewable actor lease. A failed
upgrade or disconnect obtains a fresh admission. Retired sockets cannot deliver
events to a replacement workspace.

Main-process handles bind the canonical account and source session. Same-session
access-token rotation preserves connections; a replacement session or account
retires them before auth notifications. An exact-handle native event closes the
renderer connection synchronously, independently of remote revocation. Bounded
renderer-process retirement records reject late IPC descriptors, including after
a bridge remount. Explicit Close retires that device connection; it does not Stop
a shared agent. SSH configuration is validated only when an SSH operation is
requested; direct WSS admission is independent of provider SSH credentials.

## Core execution and native compatibility

The additive `cloudExecution` diagnostic identifies `zeros-cloud-core-v1` on a
privately admitted `zeros-cloud-worker-v3` coordinator. It is not authority or
tool qualification. `designApi: admitted` means the trusted product registration
was admitted; it does not replace a live Design authoring/capture test. Code
sessions can remain usable with `designApi: unavailable` when a Design
registration cannot start.

All three adapters restrict user MCP configuration, additional host directories
and native session fork. Claude also disables native plugins, hooks, configured
subagents and native browser integration. Cursor restricts configured native
agents, local settings and native credential-view tools; Zeros supplies scoped
workspace tools. Codex restricts apps, hooks, multi-agent, native JS REPL, memories,
remote control, the bundled browser plugin and unadmitted host/configuration RPCs;
its native execution server still runs file/process operations inside the
credential-free workload. These limitations are represented by the versioned
provider restriction manifest. Underlying workload restrictions remain visible.
A changed compatibility manifest requires a new core profile.

Full native-provider parity remains a distinct qualification. Its existing
`assertFullCloudBoundary` gate is unchanged. The explicitly selected core smoke
requires the exact declared restricted profile and admitted Design API, a native
successful read, write and command callbacks correlated by execution and native
tool identity, a file challenge whose contents never appear in the prompt,
independently observed file/process effects, and a fresh native continuation.
All challenge files are removed and their absence verified before the second
turn. That turn must recall the marker without any tool activity. The Cursor
check consumes the pinned SDK's custom-tools MCP projection through its actual
translator; a generic tool card or model claim cannot satisfy the checks.
Neither profile may silently fall back to the other. Deterministic workspace
file/process/LSP canaries and actual Code/Design mode policy, API authoring,
capture and revocation evidence are also required for an immutable image's core
tool qualification. Runtime credential security approval alone certifies none
of those capabilities.
