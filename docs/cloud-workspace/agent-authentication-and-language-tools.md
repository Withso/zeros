# Native agent authentication and language tools

A workspace's run authority and its provider funding authority are separate.
Each credential has an account owner and a consent revision. In the native
execution profile, that account's active access material is available to its
native provider and commands inside the VM, as on a local machine. This is a
trust boundary: repository code and native tools must be trusted with the
active account. Delegation and model checks govern admission; they are not a
credential proxy that limits arbitrary uses of an exported provider token.
Repository hooks, when enabled, share that trust and keep native semantics,
including running in Plan. Plan constrains agent permissions; it does not make
repository hooks safe to run with an account's credentials.
Other accounts, control-plane credentials and refresh tokens stay outside it. Each delegation
names one current collaborator, workspace, compute trust boundary, model consent
and expiry. The immutable workspace sponsor funds compute independently.
Every execution is bound to the initiating actor/device session, exact durable
command (when queued), engine instance and generation. Stop, revocation,
identity erasure and image disqualification invalidate that authority.

Organization settings can connect these accounts before a workspace exists.
See [organization setup](organization-setup.md) for native sign-in, private
account selection, explicit compute/model consent, and automatic self-delegations.

The legacy default grant uses the sending user's control-plane account UUID. An identity
provider subject is not that UUID, and selecting another member's credential
requires an explicit delegation. Account and organization switches fence pending
grant responses; Local workspaces never enter this cloud admission path.

## Negotiated boot funding

`boot-owner-v1` is an explicitly activated mode with an exact generation,
engine, boot, writer and funding-owner epoch. Prompter/Developer invitations and
General access role grants are the owner's consent to workspace-role funding;
the unchanged share dialog needs no extra note, toggle or confirmation. CP
records that consent. The sending member's verified actor/device authority,
Git attribution, private customization and conversation scope remain independent
of the funding owner. Viewers cannot run. Member, role, account and device
revocation still take effect immediately.

This mode currently requires `zeros-managed` compute. Non-Zeros-managed compute
is refused before provider material is selected or delivered. Legacy explicit
delegation remains unchanged; alternate-compute support for this mode is deferred.

**Members' agents can use and read the owner's active provider keys.** The key
is delivered to the native provider and its commands, not hidden behind a
credential proxy. Granting a run-capable role therefore trusts that member's
agents and repository code with the owner's connected account. Provider model
consent governs Zeros admission; it cannot constrain arbitrary uses of a raw
key once delivered. CP, provisioning and refresh credentials remain outside
the worker. The share dialog is unchanged.

### Next-run adoption and cards

Background refresh installs the next provider selection; Send does not issue
a new grant, validation or credential fetch in this mode. Each run captures its
original selection and first-write reservation. Pending publication parks new
starts rather than fetching or using obsolete material on Send. A running turn
keeps its captured account; the next run adopts the acknowledged replacement.
Codex access renewal happens through CP near expiry in the background; refresh
and ID tokens never enter the VM. Legacy cloud keeps its real per-execution
leases. Both Local placements keep native device accounts.

The information notice follows actual native use, never selection or a receipt
commit. It compares the opaque account/key adoption identity with the last used
identity per provider; token, label and model-only changes are silent. An initial
unknown identity establishes a silent baseline; explicit missing-to-ready or a
different trusted initial identity shows the notice. Original first-use order is
retained independently of later ACK delivery and bounded recovery snapshots.
The above-composer information card reads `Using <account> for <provider>.`
Only an owner transfer shows **Agent credentials changed · Restart workspace**,
bound to the current boot and current server management capability. It uses the
existing restart confirmation; a key/account change alone never requests restart.
The old boot cannot silently rebind to the new owner.

### Warm conversations and Stop

Warm reuse keeps the exact eligible conversation's native host, owned process
group, physical HOME, history lock and admitted context across successful turns. It does
not share a HOME or process across conversations or actors. A new turn gets a
new command, claim and original first-write reservation even when its native
execution ID stays the same. Changed native auth, actor, model or MCP/context
eligibility requires fresh preparation; an unrelated label or cache revision
alone does not recycle an otherwise eligible host.

Stop immediately fences that conversation, then proves whole-scope descendant
retirement, including late allocations and background children. Sibling
conversations and the boot cache survive. The next Send needs a fresh scope;
it cannot revive the stopped native execution. Closing a tab or connection
does not issue Stop.

### Removing a connection

Organization Remove and global revoke first fence all affected future starts
and obtain positive live inventory, including reserved starts and old credential
epochs. Organization Remove affects that organization's funded workspaces;
global revoke covers every organization using the connection. Disconnect and
Dev-reference local/organization/global removals retain their own exact scopes.
Only agents funded by that source are stopped.

**All running agents will be stopped** is shown only when CP confirms running
funded scopes. With positive idle proof, removal needs no dialog. No preserves
the key; Yes stops affected agents and removes the source after positive
retirement. Later runs receive typed missing-provider guidance. Durable decisions
are first-wins and replayable, with explicit removed/cancelled/expired or pending
outcomes. A submitted Yes or unknown decision ACK is not cancelled on unmount.
An unreachable engine remains pending proof, never evidence of idle or removal.
These changes require the matching CP, engine and desktop negotiation; source
tests do not establish deployed activation or provider-success qualification.

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
Human servers run as engine-owned process groups with a bounded server
environment and the real worktree. Language tools use the same non-root
`zeros-engine` identity (10003) as the engine, without an agent sandbox. Agent language
tools follow that execution policy under the same live paid-agent lease as
other agent tools in legacy mode, or the admitted boot-session lifetime in
new mode. Personal credentials never enter either language server.

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
contracts. Exact Boat image, native-account and hosted end-to-end
qualification remain separate release requirements; see
[qualification status](qualification-status.md).

## Runtime qualification and activation

Current registration requires actor protocol2 and an exact
`zeros-cloud-worker-v4` pin/attestation: runtime/manifest/base/installer receipt,
boot/session and the live setup/enrollment fence. The engine validates protected
runtime identity before registration; setup publishes ready only after fresh
registration, authenticated readiness and initial durable synchronization.
Saved source, pin and current registry revocation are independently checked
before credential delivery. Unsupported worker profiles1–3 or actor1 refuse
execution; there is no v3 credential-qualification fallback.

Current discovery/admission joins exact v4 runtime/base/credential-kind evidence
in the configured smoke/full mode. Basic `runtimeQualified` and `mcpQualified`
are distinct: customization schema 3 permits a basic non-admin turn without
user MCP/organization skills when only basic evidence exists. Computer-admin
workspaces and admitted MCP require enabled current MCP proof. Renewal/replay
cannot add or remove an already admitted customization snapshot. Native goal,
review and fork capabilities require their own advertised proof.

Qualification must exercise real native reads/edits/shell effects, private HOME,
engine-authority isolation, actor admission, Stop/descendant retirement, native
turn/continuation and authentication for each enabled kind. Assistant prose or
an MCP bridge call alone cannot stand in for independent file/tool effects.
Codex subscription additionally needs real native-cache rotation, backend
publication and adoption of renewed access without refresh/ID tokens entering
the VM. A successful API-key canary cannot qualify subscription authentication.
Smoke self-tests without credentials do not establish paid native turns.

Use the current [runtime registry/qualification contract](runtime-bundles.md)
and [release gates](qualification-status.md), with explicitly authorized
private evidence and disposable resources. The retired paid
`cloud-engine-launcher.mjs --qualify-agent` v3 entry no longer exists.
Historical `cloud-runtime:manage` image approvals and versioned native evidence
remain readable for Dev image-kit and cleanup/audit contracts, not v4 workspace
admission. The opt-in v3 release-worker promotion lane is
[retired](release-worker-qualification.md). App SQL cannot publish operator
qualifications; immutable evidence
and revocation are not overwritten on retry. Flat-image publication remains a
separate cutover/qualification follow-up.

## Device connection lifetime

Credential owners can use every supported provider model through their own
cloud connections, including older self-grants with `allModels: false` or a
one-model list. This read behavior does not rewrite stored model lists, flags
or write receipts. Owner-to-member delegations admit only the models explicitly
listed in that grant and supported by the provider catalog. The API and database
prohibit `allModels: true` grants to another member. Grant renewal retains expiry,
actor and compute trust checks and rechecks the current member model list.

Model discovery and admission use the control plane's curated provider
catalog. `agent-models.test.ts` checks the standalone server mirror against
`catalogs/models-v1.json`; update both when curating provider models. All-model
consent cannot authorize unknown or cross-provider IDs. Member lists retain
exact-ID consent only within that catalog. Runtime/credential
qualification is still required; catalog inclusion is not a paid-turn proof.
The Dev connection broker preserves the same flag through its separate additive
0004 migration, renewal and metadata restore. Canary consent remains separate.

Cloud model discovery retains the effective model IDs from qualified delegations.
The menu and new-chat defaults intersect those IDs with the provider catalog;
context variants such as `[1m]` do not widen consent. A cloud fallback does not
rewrite the user's global favorite. Existing conversations retain their recorded
model and must select an authorized model before continuing if consent changed.
The shared workspace catalog refresh invalidates cached agent discovery while
retaining the last confirmed snapshot. Only active consumers revalidate, so
credential changes on another device and runtime upgrades become visible without
keeping hidden conversations polling.

Admission reports closed model-consent, credential-expiry/revocation and runtime
upgrade causes. Exact command receipts retain the cause even when an older
engine settles a generic dispatch failure. The renderer restores a refused
prompt without resending it, refreshes discovery, and offers cloud provider
settings for model consent or reconnection. Persisted refused prompts are not
agent turns and show neither an elapsed timer nor an “Agent stopped” footer.
Generic dispatch failures are ambiguous: retain the transcript and ask the user
to review it, rather than assuming the provider never started. Wake waits belong
to the preparation queue. Local provider authentication and transcripts do not
use this classification.

The native access client signs actor admission with its enrolled device and
uses the verified runtime target described in
[portable ingress](client-runtime-contract.md#portable-runtime-ingress). It never sends a WorkOS bearer
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

The accepted durable command is the sole prompt dispatcher: the CP queue in
legacy mode, or the [VM-local FULL queue](data-and-sync.md#negotiated-local-queue-and-compact-history)
in `boot-owner-v1`. Admission binds
the actor/device, provider, exact model/key and factory-verified managed cwd;
the adapters use that immutable cwd for creation, resume, tools and configuration.
Renderer cwd values cannot choose another checkout, and a valid managed root
does not require `.git` metadata. A cloud refusal never falls back to Local.

Each cloud conversation has physical HOME/XDG/provider configuration directories
and one locked history directory owned by `zeros-engine` (10003). These provide
state separation, not a security boundary between agents. Agents, their tools and
cloud terminals use the real checkout with normal VM egress and no agent sandbox.
Ordinary same-user filesystem access can reach other agents' working state or
credentials. Agents can read engine data, including the owner credential vault,
VM credential and other conversations: there is one trust domain per workspace.
Mode 0700 does not hide this state from same-user agents. History adoption
retains its original lock and compatibility markers. A per-conversation Stop
proves only its original process group, not escaped or detached descendants.
The original broker's complete engine-runtime tree census governs VM idle,
including engine and new siblings, with only exact infrastructure births exempt.
Final VM drain closes launches and completes checkpoint/seal before the outside
root broker's whole-tree `cgroup.kill` and final `populated=0` receipt.
Local launch descriptors retain their version and ordinary Host behavior.

### Repository instructions and configuration

Repository configuration cannot replace provider credentials, login/auth helpers,
endpoints, proxies, headers, provider/model/profile selection or protected
HOME/config/state, PATH/loader, engine, Git and Computer environment. Raw native
project/plugin sources stay disabled where their precedence cannot enforce that
contract. The engine captures a bounded data projection from the admitted cwd
and passes it through a supported native instruction/configuration channel;
the provider never rereads the raw config as a trusted source.

| Provider | Shipped repository projection | Remaining restrictions |
| --- | --- | --- |
| Claude | Root `CLAUDE.md` and `AGENTS.md` appended to the native preset. Regular UTF-8 files, at most 64 KiB each and 128 KiB combined. | Native project/local settings, hooks and plugins remain disabled. |
| Codex | Safe data settings from `.codex/config.toml`; root instructions prefer `AGENTS.override.md`, then `AGENTS.md`, then validated flat fallback names. Native config/developer-instruction channels receive the immutable snapshot on start/resume/fork. | Provider/auth/model/env/MCP/permission fields are excluded. Ancestor/nested instructions, hooks/plugins and custom prompt body execution are unproved. |
| Cursor | Root `AGENTS.md` plus at most 15 immediate `.cursor/rules/*.md` or `*.mdc` files, captured once and prepended through SDK user-message text on each turn. At most 64 KiB/file and 128 KiB combined. | Native project/plugin/team sources remain disabled. The projection does not implement native nested/ancestor or conditional rule matching. |

Reads reject final symlinks and escaping file descriptors and preserve explicit model,
credential and permission choices. Codex's safe keys are `developer_instructions`,
`model_reasoning_summary`, `model_verbosity`, `personality`,
`project_doc_max_bytes` (at most 64 KiB) and bounded basename-only
`project_doc_fallback_filenames`. Combined Codex instructions are at most 64 KiB
(96 KiB JSON encoded). Repository `.agents/skills` discovery is native and tested;
bounded `.codex/prompts/*.md` discovery supplies command metadata only.

Explicit Ask, Plan and read-only intent wins over repository defaults, resumed
state and helper output. Cloud Claude's approval is session-only and labelled
“this chat”; a stale project-persistence choice is rejected. Any future cloud
project approval must be engine-owned and keyed by workspace plus actor, never
written into the shared checkout. Cursor keeps its native auto-review and JSONL
resume behavior. Local Personal and organization-local keep their existing native
configuration and approval behavior.

The [MCP snapshot](mcp-and-skills.md) stays exclusive, including at initialization.
Admitted member/organization skills remain in private read-only native mounts.
Native browser binding and additional host directories are unavailable; plugins,
account/team settings and optional native fork/review/goal capabilities require
separate safe admission and exact-runtime proof. These projections establish
bounded instruction/configuration behavior, not complete Local feature parity.

The additive `cloudExecution` diagnostic identifies the installed profile; it
is not authority or runtime qualification. `designApi: admitted` means the
trusted product registration was admitted, separately from a live Design
capture/authoring test. Code sessions can remain usable when that API is
unavailable. Product-specific MCP integrations can still exist; ordinary
repository file and shell operations do not require a workspace MCP replacement.

Organization/member/repository MCP and organization skills have explicit
[snapshot admission](mcp-and-skills.md), gated by current exact-v4 MCP evidence.
OAuth MCP and additional host directories remain unavailable; native session fork
requires its independent qualified capability and current actor/engine authority.
Organization settings remain separate from this Mac's settings. Codex host/configuration mutation RPCs remain
allowlisted; connected apps and native review/goal mutation RPCs are not yet
admitted. Full product parity must not be inferred from native file/shell
execution. The old `zeros-cloud-core-v1` restriction manifest remains readable as persisted
compatibility data; it does not enable retired executable worker profiles.

The explicitly selected `zeros-cloud-native-v1` smoke requires the declared
profile, admitted Design API, successful native reads/edits/commands, independently
observed file effects, and a fresh execution that recalls a marker solely from
native history. All challenge files are removed and their absence verified
before that continuation. Wrong profiles, MCP bridge evidence, stale execution
IDs or unproven cleanup fail qualification. The stricter `full-native` gate is
unchanged and neither profile silently falls back to another.

Historical native evidence versions2/3 remain serialization contracts for retained
image-kit consumers. Current v4 activation requires exact runtime/base evidence
for every enabled credential kind and independent MCP/native capabilities. Version-2 checks are `privateProviderHome`,
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
