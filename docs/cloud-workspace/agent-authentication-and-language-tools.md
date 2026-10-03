# Native agent authentication and language tools

A workspace grants access to its code, not to another person's agent account.
Each credential has an account owner and a consent revision. In the native
execution profile, that account's active access material is available to its
native provider and commands inside the VM, as on a local machine. This is a
trust boundary: repository code and native tools must be trusted with the
active account. Delegation and model checks govern admission; they are not a
credential proxy that limits arbitrary uses of an exported provider token.
Other accounts, control-plane credentials and refresh tokens stay outside it. Each delegation
names one current collaborator, workspace, compute trust boundary, model list
and expiry. The immutable workspace sponsor funds compute independently.
Every execution is bound to the initiating actor/device session, exact durable
command (when queued), engine instance and generation. Stop, revocation,
identity erasure and image disqualification invalidate that authority.

Organization settings can connect these accounts before a workspace exists.
See [organization setup](organization-setup.md) for native sign-in, private
account selection, explicit compute/model consent, and automatic self-delegations.

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

The authentication-only keeper remains qualified at Codex 0.154.0 independently
of the desktop/worker model runtime (currently 0.160.0). Its version is part of
the encrypted cache's authenticated data and the database's runtime constraint;
a routine dependency bump cannot migrate that contract. The package declaration
must match `CODEX_AUTH_RUNTIME_VERSION`. Upgrade it only with an explicit
cache/schema migration and native renewal qualification.

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

The explicit `cloud-engine-launcher.mjs --qualify-agent` entry runs a paid native
canary in a disposable clone of the exact v3 worker snapshot. It is unavailable
through application RPC. Hold the host engine lock and require an idle worker;
do not run it in a user's workspace or inject credentials into an image builder.
Prepare an empty Git repository in the disposable clone's workspace first;
the sanitized image intentionally contains no checkout. Initialization belongs
to the test fixture and must not modify the attested installation.
Its input is the single-use `/srv/zeros/state/.zeros-live-qualification.json`,
owned by the engine host UID 10003 with mode 0600, no symlink or hard link. The
strict version-1 document binds `sourceCommit`, the metadata-file `buildSha256`,
`model`, protocol `material`, and an `expiresAtMs` within fifteen minutes.

The canary consumes that file, uses the production gateway and execution
boundary with an isolated test authority, and reports only fixed checks and
image identity. Version-2/3 reports identify `zeros-cloud-native-v1` and verify
private provider HOME, engine authority isolation, actor admission, native tool
effects, history continuation, Stop and lease revocation. Only successful native
read, edit and shell events plus independently read file bytes count as tool
proof; MCP calls and assistant prose do not substitute for those native file
checks. Version-3 additionally requires a successful stdio MCP probe and an
independently verified VM-side effect. Version-1 credential-free workload
evidence remains readable for older images and cannot qualify this new profile. Challenge files and
the temporary conversation's native history are removed. Destroy the test VM
and retain its deletion receipt afterward. This isolated authority check does
not establish the real control-plane admission chain or end-to-end desktop
streaming; test those after applying valid exact-image evidence. Machine
attestation does not invoke this paid entry or automatically enable a provider.
The private process supervisor retires both its original launcher and adopted
children on Stop. It signals only its own unreaped children, repeats after
adoption, and writes the retirement receipt only after `waitpid` proves there
are no remaining children. A detached launcher exiting first is not proof that
its descendants stopped; Linux regression coverage includes that case and an
unrelated process that must remain alive.
Codex ChatGPT input additionally requires a `renewedCodex` access version with
the same account and different token bytes. Neither version may contain refresh
or ID tokens. The image checks adoption of that newer access and a native
history continuation using it. This does not prove backend renewal: retain the
separate real native-cache rotation and database-publication evidence before
enabling this authentication kind.

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

## Native execution and compatibility

`zeros-cloud-native-v1` runs Claude's normal native preset and Cursor's standard
SDK toolset against the real VM worktree, with the same adapters and transcript
projection used locally. Codex uses its native execution server in the VM; new
threads do not register the generic `zeros_workspace` dynamic tool. The legacy
handler remains for persisted threads created by the old core profile. Resume
retains their history; it does not rewrite provider logs or silently reset a
conversation to remove a persisted tool declaration.

Each execution mounts an ephemeral private HOME over the worker's normal HOME
and exactly one locked conversation history directory. Existing histories are
adopted under that lock when worker identity changes. The provider and its
native commands share the active account's trust. Engine state, other
conversations and other accounts remain outside their view. The original
Code/Design filesystem policy, unprivileged worker identity and process domain
still apply. Stop/revocation must prove descendant retirement before releasing
history or removing HOME. Local launch descriptors retain their version and
behavior; only native cloud launches use the private HOME overlay.

The additive `cloudExecution` diagnostic identifies the installed profile; it
is not authority or runtime qualification. `designApi: admitted` means the
trusted product registration was admitted, separately from a live Design
capture/authoring test. Code sessions can remain usable when that API is
unavailable. Product-specific MCP integrations can still exist; ordinary
repository file and shell operations do not require a workspace MCP replacement.

Organization/member/repository MCP and organization skills have explicit
[snapshot admission](mcp-and-skills.md), gated by version-3 exact-image evidence.
OAuth MCP, additional host directories and native session fork remain unavailable.
Organization settings remain separate from this Mac's settings. Codex host/configuration mutation RPCs remain
allowlisted; connected apps and native review/goal mutation RPCs are not yet
admitted. Full product parity must not be inferred from native file/shell
execution. The old `zeros-cloud-core-v1` restriction manifest remains readable
for compatibility with existing images and qualification artifacts.

The explicitly selected `zeros-cloud-native-v1` smoke requires the declared
profile, admitted Design API, successful native reads/edits/commands, independently
observed file effects, and a fresh execution that recalls a marker solely from
native history. All challenge files are removed and their absence verified
before that continuation. Wrong profiles, MCP bridge evidence, stale execution
IDs or unproven cleanup fail qualification. The stricter `full-native` gate is
unchanged and neither profile silently falls back to another.

Runtime activation requires new exact-image version-2 or version-3 evidence for every enabled
credential kind. Version-2 checks are `privateProviderHome`,
`engineAuthorityIsolation`, `nativeWorkspaceTools`, `actorAdmission`,
`stopAndRevocation`, `nativeTurn`, `nativeResume` and `authentication`. Version-3
adds `nativeMcp` and is required for customization admission. Codex
subscription also requires separate backend native renewal evidence and worker
adoption of refreshed access. These checks do not automatically qualify every
optional provider feature or Code/Design capture workflow.

## Native GitHub and terminal authority

Cloud Git uses the member's integrated **GitHub connected account**. Native
Claude, Codex and Cursor processes and cloud terminals can push and perform
authenticated fetches for the workspace's repository. Cloud workspaces do not
install, configure or expose `gh` CLI authority. PR creation, editing, merging,
comments and checks remain on the existing integrated PR panel. Local Git and
GitHub CLI authentication are unchanged.

Each native Git invocation obtains a fresh short-lived grant through an admitted
Zeros desktop belonging to the same actor:

1. The engine checks its current workspace/generation and the native source
   (agent execution lease or human terminal session) with the control plane.
2. A private bridge request goes to one connected, Git-capable desktop of that
   actor. It bypasses transcript/event capture. Viewers and prompters cannot
   provide or acquire native Git authority.
3. The desktop uses the existing `prepareWrite` route and its integrated GitHub
   App user authorization. `GithubCloudUserAccess` verifies the connected
   account's current repository write permission. The backend rechecks actor,
   source, generation, engine, immutable repository and the member's selected
   cloud GitHub connection before storing a grant.
4. The engine redeems that grant against the responding desktop's admitted
   actor session. Only the operation-specific proxy capability reaches engine
   memory. Git HTTP forwarding uses the existing write proxy and the GitHub
   **user token**, so GitHub acts on behalf of that member, never an installation
   bot. Existing actor noreply commit-author settings are preserved.

Without an authorized connected desktop, native Git fails promptly with
“Open Zeros to authorize GitHub push for this cloud workspace”. An older desktop
that does not advertise this bridge path is treated as unavailable. A desktop
response is bounded to 15 seconds, including account lookup. There is no
installation-token fallback. Bootstrap credentials remain read-only for initial
workspace setup; native process environments do not receive them.

Opening a cloud terminal does not request a Git grant or require the desktop
courier. Terminal admission and author binding remain separate checks. The
broker acquires Git authority only when a Git network operation needs it.

Grants are bound to actor, workspace, generation, engine, immutable repository,
native source, operation, request ID and current branch. Native prepare and
redeemed grants each expire within 60 seconds. The engine obtains fresh authority
automatically for each Git invocation and coalesces that invocation's HTTP
requests. Git exit releases its grant, with expiry cleanup as a fallback.
Execution Stop, terminal loss, desktop/session revocation and engine retirement
reject proxy use; engine retirement also aborts forwarding. Release can delete a
prepared native grant before redemption, so a delayed reply cannot recreate it.
The connected user's underlying GitHub authorization is never revoked merely
because one operation ends.

Native and managed grants fingerprint the selected installation and its cloud
connection revision. Preparation requires that connection both before and after
the GitHub permission check; redemption and every proxy authorization recheck it.
The final check locks the connection through grant insertion or use. Disconnect
deletes pending and redeemed grants, and a new connection gets a fresh revision,
so reconnecting cannot revive a grant or an in-flight preparation. Routine
connection verification preserves the revision.

The engine-owned Git shim and Unix SOCKS socket live outside the checkout, in a
disposable execution directory. No `GH_TOKEN`, `GH_CONFIG_DIR`, `gh` configuration,
GitHub bearer, proxy capability or grant is written to the shared checkout or
native environment. The Git shim preserves canonical remote metadata and routes
GitHub network commands through a fixed Git-only HTTP origin. No TCP relay or
native GitHub REST/GraphQL proxy exists. Human terminals share a UID, so Linux
`SO_PEERCRED` and the exact PTY process ancestry additionally gate socket access;
another terminal cannot borrow that authority. Qualify the worker image's Git/
libcurl Unix SOCKS and Python peer probe together before activation.

The broker belongs to the live PTY, independently of its creating transport.
Disconnect suspends forwarding and revokes that session's in-flight grants;
reattaching as the same member reacquires authority without replacing the shell.
Multiple devices of that member can supply a current admission. Another member
may view the terminal; once another member supplies input, Git authority in that
shell is permanently disabled before delivering the input. Open a new terminal
to authorize Git under your own account. This avoids attributing old/background
processes to a different member. Branch inspection trusts only the exact validated
checkout path, including when the engine and checkout have different UIDs;
inspection errors fail closed instead of being treated as detached HEAD.

| Operation | Allowed scope |
| --- | --- |
| `git fetch`, `git pull`, `git clone`, `git ls-remote` | Connected-account upload-pack for the exact workspace repository |
| `git push` | One current branch, no delete, tags, multiple refs, push options or push certificate |
| PR create/edit/merge/comments/checks | Existing integrated PR panel and connected-account managed operations |
| Native GitHub API or `gh` commands | Unavailable in cloud |

The write proxy validates receive-pack before forwarding any command bytes.
Repository replacement, redirects, unsupported endpoints and expired grants fail
closed. A dispatched write cannot be replayed with the same grant; no automatic
mutation retry occurs. Retry deliberately starts a new Git command and obtains
fresh authority. Pack downloads stream, with credential filtering across chunk
boundaries and fixed diagnostic text. Receive-pack bodies are bounded to 128 MiB.
Migration `0116` extends the existing grant table. Migration `0121` adds the cloud
connection revision and extends disconnect revocation to managed grants. Existing
system-only RLS and role grants continue to apply. Grants prepared before the new
fingerprint are rejected and must be requested again. Roll out migrations and the backend before the
new engine and desktop. Preserve the managed `gh.pr*` operation names as wire
compatibility identifiers; they do not invoke or install the CLI in cloud.

Native qualification is off by default. Explicitly set
`ZEROS_CLOUD_NATIVE_GITHUB_WRITE_SMOKE=1` and
`ZEROS_CLOUD_NATIVE_GITHUB_TEST_REPOSITORY=owner/disposable-test-repo`, and open
that exact workspace in Zeros with the actor's connected GitHub account. Each
provider performs a native push to a unique `zeros-qualification/*-agent` branch
and an authenticated fetch. An independent terminal verifies the remote head,
then pushes its own temporary branch through its separate actor grant. The
helper exits before pushing if `gh` or its authentication environment is present. Both
paths restore the starting branch; temporary remote refs remain for administrator
cleanup because native deletion is denied. No live mutation is performed unless
this explicit flag is enabled. Local real-Git/fake-GitHub tests do not qualify an
exact worker image or real GitHub App installation.
