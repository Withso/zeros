# Cloud workspace security

Cloud workspaces execute untrusted repositories and agent-generated commands on
internet-connected infrastructure. The execution environment, repository,
agent output, browser content, network peers, and client input are all untrusted
boundaries.

## Required authorization layers

1. The client authenticates to the control plane.
2. Every workspace API authorizes the actor against the workspace's current
   tenant, Organization membership and role when applicable, workspace role,
   and any narrower Team grant. Personal is local-only and cannot own a cloud
   workspace; paid account membership alone does not enable Personal cloud.
3. Provisioning credentials remain server-side and are never returned to a
   renderer or placed in a sandbox.
4. A remote engine connection uses a short-lived grant bound to account,
   workspace, audience, expiry, and protocol purpose.
5. The engine validates that binding before accepting privileged bridge
   messages.
6. Every mutation also validates the current workspace authority epoch. A
   retired cloud generation, device replica, or ownership epoch cannot continue
   writing with an otherwise well-formed request.

The current validation harness uses a revocable provider preview capability, a
separate mandatory Zeros bridge token, and a required asymmetric account JWT
whose subject must match the immutable worker owner. A privileged cloud-worker
cannot start with HS256, optional binding, or malformed verifier material. The
JWT remains in the client `CONNECTED` frame and never enters image/sandbox
creation state. The production desktop runtime admission adds tenant,
workspace, generation, purpose, account, and revocable-lifecycle binding. The
operator-owner validation identity remains only for protected qualification.

The production lifecycle foundation stores only a SHA-256 digest for each
endpoint grant, revokes every endpoint grant and cancels active setup before
stop/archive/delete intent dispatch, and keeps provider resource ids out of
user-facing API documents. Drift, permanent failure, and superseded provider
results enforce the same generation fence. The setup admission broker
can mint a one-use token only for the current workspace/generation/account and
an exact live setup-run fence; issue and consume both recheck membership and
lifecycle eligibility. The guarded internal endpoint now consumes that token,
rechecks repository authority, resolves encrypted setup secrets, and mints an
exact repository-scoped GitHub credential plus one engine-registration grant.
The image helper, root-only supervisor, engine registration, heartbeat lease,
and private readiness proof are wired behind a separate operator gate. With the
gate off, a provisioned provider resource is still never reported as ready.
The setup material also carries the control plane's exact account-verifier
contract. WorkOS mode requires `zeros-access-v1`, the desktop client ID, and one
exact HTTPS issuer together; the image and worker supervisor preserve those
fields through engine launch. The explicitly selected Auth0 rollback mode
carries no WorkOS contract or client ID. Either shape fails closed when
partially configured, so a WorkOS deployment cannot silently degrade to
issuer/audience-only verification.

Authorization loss is database-enforced rather than dependent on one HTTP
route. Membership removal retires issuing/active client grants, endpoint grants,
and engine leases even when a self-leave runs under user-context FORCE RLS.
Organization or Team soft deletion additionally cancels setup and generation
replacement and queues provider-verified deletion for every generation.
Workspace authority is bound to `owner_user_id` and an immutable billing
epoch. Account deletion or membership loss retires owner-funded work so paid
compute cannot remain ownerless. These transitions block new authority
immediately; provider deletion and provider-wide SSH revocation remain durable
work whose completion must be observed.

## Files, context, and saved history

Qualified org VM clients use an explicit primary-checkout file policy, separate
from the paired-desktop relay policy. Readers can list ignored repository files;
developer, manager and owner roles can read and edit repository `.env` and PEM
files. Viewer/prompter roles retain the sensitive-file read restriction and
cannot edit. Immutable worker configuration and current actor admission enable
this policy; client parameters cannot enable it or select another checkout.
Lexical and realpath checks exclude engine state, credential homes, Zeros
internal storage and nested registered owners/checkouts. Opened descriptors and
hardlink checks protect file reads and atomic writes. Generic Files writes still
refuse Design territory. The paired-desktop relay keeps its existing refusals.

Cloud context list/scaffold/share and sparse working-directory selection use
the Local implementations and mutation lifecycle barriers. Context listing and
moves apply the same private-path/owner checks. Sparse selection preserves
Local's dirty-file and Design-directory rules and refuses nested owners.

Saved transcript search uses the control-plane projection without engine
admission or compute. Each bounded page reauthorizes the account and tenant;
continuations bind workspace, account, query, scope and projection revision.
Deleted chats/messages are excluded. The renderer fences late account changes
and limits pages, hits and retained bytes. Search uses PostgreSQL simple full-text
matching with stable entity-ID pagination; it does not promise Local FTS5's
relevance ordering. A changed projection retries the complete search once.

## Agent execution model

The workspace VM is the isolation boundary, with one trust domain per workspace.
The engine, provider CLIs, their tools, MCP children, terminals/SSH/LSP and capture
run as one non-root user, `zeros-engine` (VM UID/GID 10003), without an agent sandbox,
in the real checkout. They use normal VM egress; there is no per-agent bwrap,
user namespace, SRT, proxy, allowlist or switch to a separate worker account.

Physical per-conversation HOME, XDG and provider configuration/history directories
owned by 10003 provide state separation, not a security boundary between agents.
Agents can read engine data on their VM, including the owner credential vault,
VM credential and other conversations. Mode 0700 does not hide engine state from
processes sharing its UID. Application admission binds
actor/device, workspace generation, funding and credential epochs, model, cwd
and context; it does not create isolation from another process with that UID.
Provider working credentials still enter the CLI environment. Infrastructure,
signing and production database credentials remain outside that environment.
Output redaction and bearer-free renderer IPC remain required.

Cloud workload custody requires one shared workload cgroup owned by the original
broker, with entry before exec. Engine and control processes stay outside it;
there are no per-launch cgroups. A per-conversation Stop proves only the original
process group: escaped or detached descendants are not proven retired by that
operation. Local Host process-group behavior is unchanged.

The delegated common parent is `engine-runtime`. Cgroup v2 migration checks
destination and common-ancestor write access, not the target UID. Root ownership
alone does not make a process unmovable: `/host` and every root process stays
outside engine-runtime, with no root helper inside the delegated tree. The root
broker owns custody from outside that tree.

Idle requires a fresh complete census of the whole `engine-runtime` tree,
including the engine leaf and any new sibling, exempting only exact infrastructure
births. A worker-UID scan cannot distinguish agents from the engine. Unknown means busy and must
surface a bounded diagnostic and recovery path. The C3 quiet populated-shell
exception applies only to a confirmed original quiescent terminal shell, with
executable dev/inode, foreground/session/TTY, direct-child and sampled kernel
State S proof; builtin loops, exec replacements and other descendants remain
work. This exception permits idle classification, not retirement. VM drain closes
new launches; checkpoint and seal complete before kill. The outside root broker
then uses whole-tree `cgroup.kill` and owns the final verified `populated=0`
receipt, since that kill also terminates the engine. A quiet shell does not waive
the final empty proof.
Live actor/authority guards and checkpoint barriers remain mandatory.

Cloud retains API authoring for now as instruction and API policy, not an
OS-enforced Design filesystem restriction. Local Personal and organization-local
workspaces retain their normal provider tools, permissions, native Code/Design
editing and Host lifecycle. Chromium and iframe sandboxing protect browser
content independently of the provider execution model.

## VM and bootstrap requirements

- Isolate workspaces at the provider VM boundary; keep the generation's approved
  base/runtime and minimum engine privileges.
- Deny inbound traffic except the intended bridge/health boundary.
- Use only fixed image-owned setup/bootstrap entrypoints through the bounded
  provider command adapter. Repository names, revisions, settings and secrets
  are data, never concatenated into command text.
- Revalidate the physical Git directory, origin, top level and HEAD after
  repository-controlled setup and before readiness.
- Retire ephemeral authority on stop/delete and verify provider resource deletion.
- Treat snapshots and caches as sensitive copies subject to encryption,
  retention and deletion policy.

## Protected bootstrap and compatibility

Only worker profile 4 with saved v2 source and actor protocol 2 executes.
Profiles 1–3 remain retired. A missing cloud marker selects Local; a present
unsupported marker fails before cloud credential preparation. Historical records
remain readable for audit and cleanup; no old root exception admits v4.

Current execution uses namespace and VM UID/GID **10003** with the exact
`10003->10003` map (length 1) for both UID and GID; all capability sets are empty.
The root broker completes the locked mount namespace before dropping to 10003.
NoNewPrivs and seccomp remain enabled. This change grants no sudo privileges.
The approved Boat base/bootstrap, account inventory and compatibility bytes remain
unchanged. Base accounts 10001/10002/10004 and old `0->10003` maps remain archived
reader contracts, not new runtime roles. Legacy mutable checkout/HOME ownership
is adopted to 10003 by the root broker only after the old engine is positively drained.
See [runtime bundles](runtime-bundles.md).

VM-root bootstrap still owns verified installation, attestation and lifecycle.
Root-controlled deployment, exact manifests, source/runtime pins, setup journals
and fixed-schema privileged operations remain distinct from the shared writable
checkout and engine state. Actor/device/credential revocation, queue idempotency,
redaction, current generation/epoch checks and checkpoint/seal ordering remain
application integrity requirements. They do not create confidentiality between
the engine, agents and other processes running as `zeros-engine` in that workspace.

Qualification must exercise the exact non-root identity/map and empty capabilities,
the pinned base/runtime,
setup/readiness, providers, Git/Files/Design, PTY, SSH/preview/tunnels, recovery
and positive cleanup. Offline read-only archive namespaces test dependency
closure only; they do not prove provider isolation or a successful model turn.
Old sandbox status/backend/profile/session names and `__zsr_cap` URL readers
remain compatibility contracts and cannot emit new sandbox-enforcement success.
See [qualification status](qualification-status.md).

Boat bootstrap uses the provider API only for public SSH material and fixed
image-owned operations. The setup admission crosses host-key-pinned OpenSSH on
stdin. The runner installs its temporary key with the fixed setup command,
short server-side expiry, and forwarding/PTY restrictions in the same append;
there is no intermediate unrestricted login key. Directory-relative descriptors,
file locks and inode checks protect installation/revocation from aliases and
concurrent replacement. Cleanup requires an explicit revocation result and
destroys the local private key. Uncertain execution or cleanup never becomes
successful setup. The SSH destination must be a literal public address, excluding
special-purpose and transition-tunnel ranges, and the host key is pinned from the
authenticated provider channel. Transport tests alone do not enable the Boat
provider in production startup.

## Repository and agent credentials

Prefer short-lived, repository-scoped grants. Separate clone/fetch permissions
from branch-limited push permissions where possible. Never pass a user's broad
personal token to an untrusted workspace merely because the local application
already has it.

The current setup broker is deliberately locked to GitHub.com: its API origin,
recorded installation account, and clone owner must agree. A future GHES or
second-forge variant needs its own end-to-end host/identity contract before it
may mint credentials.

The image clone path also binds askpass to an exact `https://github.com`
prompt, disables Git HTTP redirects, and keeps the installation token out of
URLs and argv. A redirect or lookalike host therefore cannot reuse the setup
credential.

Agent authentication and redistribution terms are independent release gates.
A technically functioning runtime must not ship until its supported
authentication flow, license, and redistribution rights are approved.

For the initial cloud release, provider model keys use their normal raw
environment/file representation inside the tenant VM. There is no sentinel
masking or credential-injection proxy. This does not permit provisioning,
control-plane, signing, production database, or broad repository credentials in
the worker; those remain external or narrowly scoped as described above.

An admitted native provider, its shell, MCP children and enabled repository hooks
share the active account's trust. Hooks retain native Plan semantics; Plan is
not a credential boundary. In `boot-owner-v1`, run-capable workspace roles
authorize shared funding: **members' agents can use and read the owner's active
provider keys**. Provider model consent does not constrain arbitrary uses of
the raw key after native delivery. Role revocation immediately removes that
member's run authority; credential removal uses the fenced stop protocol.
See [boot funding and removal](agent-authentication-and-language-tools.md#negotiated-boot-funding).
Other actors' provider HOME and engine authority stay
outside that worker domain. Repository config cannot choose auth, endpoint,
provider/model or protected launch environment. Raw project/plugin sources remain
disabled unless native precedence is proved; current instruction/configuration
parity uses an engine-owned bounded projection. See
[native agent configuration](agent-authentication-and-language-tools.md#repository-instructions-and-configuration)
and [exclusive MCP admission](mcp-and-skills.md).

## Provider connections and owner-funded work

A provider connection belongs to a user or Organization and is stored through
an encrypted credential boundary. Workspace/generation rows reference its
opaque ID. Boat provider credentials stay in coordinator configuration and never enter
the sandbox or renderer. Historical customer credential envelopes remain
persisted but do not authorize supported compute operations.

Agent and compute usage records snapshot actor, billing owner, billing epoch,
provider/agent connection, and idempotency identity. Reassignment does not
change those bindings. Agent account/key changes apply through acknowledged
background publication to the next run; entered runs keep their original
selection. Funding-owner transfer requires restart to establish a new boot
binding, while compute/provider lifecycle authority retains its own fences.
A database owner update cannot retarget an already entered run or substitute
for a runtime security boundary.

## Secret binding verification and key rotation

Secret binding values are AES-GCM encrypted with binding identity, tenant,
version, and name in the authenticated context. New versions also store a
domain-separated HMAC-SHA-256 verifier derived from the corresponding envelope
key and bound to that same context. They never store a raw value hash: possession
of a database copy alone must not provide an offline dictionary oracle for
low-entropy environment values.

Rows migrated from the former raw-digest schema use verifier scheme 0 and a
null verifier. Equality checks for those rows authenticate and decrypt the
ciphertext, then compare in constant time inside the coordinator. A normal
secret rotation writes a new version under the configured current key and
scheme 1. Persisted `key_version` remains a compatibility contract for both
binding ciphertext and one-use setup material.

`CLOUD_WORKSPACE_SECRET_KEY_V1` is the single-key compatibility form. A rotated
deployment supplies every still-readable version in
`CLOUD_WORKSPACE_SECRET_KEYS_JSON` and chooses new-write authority with
`CLOUD_WORKSPACE_SECRET_CURRENT_KEY_VERSION`. Add the new key before selecting
it; remove an old key only after retained binding versions, outstanding setup
material, affected generations, and restorable backups no longer require it.
Fail startup or secret resolution when a referenced version is missing. Never
reuse this keyring for object blobs, provider credentials, endpoint grants, or
other digest domains.

## Desktop transcript cache

The durable latest-window cache stores selected sanitized presentation fields,
not raw tool input/results, credentials, secret-question answers or attachment
bytes/paths. Main independently derives account identity and gates IPC by an
opaque cache epoch; retirement rotates it before I/O, and failed purge blocks
further access until cleanup succeeds. Renderer additionally requires confirmed
catalog read authority and exact semantic owner/chat identity. Local IDs bypass
cache IPC. Tombstones/denial/catalog removal prune disk and memory.

Bounds are 512 entries/64 MiB total and 200 rows/512 KiB per window. Per-file/index
atomic replacement is a recoverable presentation cache, not a transactional
durable feed. Cached rows grant no execution permission and cannot settle a
prompt, mask an uncertain receipt or override native streaming/current history.
Optional cache failure cannot abort Local command registration. See
[client/runtime contract](client-runtime-contract.md).

## Local replica and copy boundary

- Register every trusted device with a revocable user-bound public identity.
- Issue a short-lived grant for one workspace/user/device/replica/authority
  epoch. Pausing one replica revokes only that grant.
- Keep absolute local paths, local settings, and OS credential-store references
  on the device. Do not expose them to teammates, analytics, or cloud logs.
- Normalize and authorize every relative path below the replica root. Reject
  absolute paths, traversal, NUL/control characters, unsupported special files,
  parent symlink escapes, case collisions, and configured bounds.
- Stage and hash content before atomic replacement. Preserve local divergence;
  never use cloud authority as permission to silently destroy local bytes.
- Exclude `.git`, Zeros databases, credential material, sockets/devices, and
  configured generated/cache paths. Do not synchronize executable Git hooks
  from an untrusted remote checkout.
- A local↔cloud copy requires a fresh destination UUID and an integrity-checked
  snapshot/checkpoint. It cannot stop, re-own, delete, or reuse the identity of
  its source.
- Copying Organization work to Personal is an export subject to role, policy,
  audit, and data-loss-prevention checks. Local placement alone never performs
  that export.
- Device/member revocation can stop future sync and access but cannot guarantee
  deletion of bytes already downloaded to an offline device. State this
  limitation explicitly.

## SSH, previews, and forwarded ports

- Mint SSH access only on demand after current authorization checks; bind it to
  account, workspace, generation, purpose, and expiry, and support immediate
  revocation.
- Prefer authenticated preview tokens carried outside the URL. Signed URLs are
  short-lived, explicit shares and must be auditable/revocable.
- A desktop forward binds `127.0.0.1` by default and obtains a fresh grant after
  reconnect. App exit, workspace stop, generation change, membership loss,
  ownership transfer, or device revocation closes it.
- Treat the previewed service as untrusted web content. Preserve navigation,
  download, origin, iframe, cookie, and local-network protections; never make a
  provider preview URL a privileged app origin.
- Rate-limit discovery, grant issuance, SSH attempts, and forwarding. Restrict
  reserved/internal ports and block metadata/control-plane addresses at the
  appropriate proxy/network boundary.

The current coordinator implements account/Team/current-generation checks,
5–60 minute grants, verifier-only persistence, lifecycle/member-triggered
revocation, localhost-only tunnel documents, isolated per-grant preview origins,
and a pre-auth preview IP ceiling. Resource-wide SSH revocation fences every
sibling grant: the caller proves possession to Zeros, no bearer enters a
provider URL, and every active SSH/tunnel row for that sandbox is retired. A
desktop must treat any such revocation as invalidating all of its forwards and
obtain a fresh grant. WebSocket previews use the SSH tunnel path; the HTTP proxy
returns `426` rather than attempting an unauthenticated upgrade.

Authority retirement and normal lifecycle work share a client-access → endpoint-
grant → engine-instance lock order (with setup work between grant and engine
where needed). Registration and readiness publication lock the consumed
registration grant before the matching engine. Before a provider-wide SSH
revoke, the coordinator takes the workspace lock and moves every matching
`issuing`, `active`, or already-pending row into the durable pending state. That
committed pre-revoke fence prevents a new issuance from crossing the provider
drain. After the provider acknowledges it, the coordinator terminally fences the
same set; an issuance already inside its provider call is therefore included and
cannot publish afterward. Concurrent PostgreSQL regressions force the
membership/lifecycle, issuance/revocation, and grant/engine interleavings rather
than relying on timing alone.

The preview proxy also coalesces exact provider-endpoint lookups and bounds
completed/in-flight lookup caches. After capability verification, it permits at
most 4 concurrent streaming responses per grant and 32 per service process;
the slot is held until the body finishes or is cancelled. These are application
backstops, not substitutes for distributed provider-edge rate limiting.

The current desktop access client is an Electron-main broker, not a renderer
credential client. It validates the exact HTTPS control-plane origin and
response contract, bounds response bodies and deadlines, and retains each raw
SSH/preview verifier outside IPC responses. Terminal and tunnel launches use an
owner-private `0600` SSH config, a verified baked `known_hosts` document in
packaged builds, structured process arguments, and exact loopback forwarding;
TOFU requires an explicit development-only flag. A tunnel is not
reported ready until its OpenSSH control socket answers. Copy SSH writes the
command directly to the native clipboard only after an explicit product action.
Crash-leftover one-shot SSH directories are removed before a new broker lifetime
can project another credential.
Cloud preview responses must use one random 32-hex label under a baked/exactly
configured DNS suffix. Their headers are exact-origin, expiry, and Chromium-
frame-ancestry scoped, so a renderer fetch or sibling iframe cannot obtain the
capability.
Local capacity overflow fails closed and unpublished/malformed grants are
revoked before the client returns an error. Local tunnel teardown is attempted
before remote revocation, but a local cleanup error cannot prevent retirement of
provider authority.

The retained Cursor/VS Code launcher uses the fixed `zeros-cloud` SSH alias
rather than a short-lived runtime identity, but editor launch is hidden pending
qualification of multi-connection SSH. Terminal and forwarding remain available
through their independently admitted native flows. Each launch gets an owner-private isolated
user-data directory whose settings point Remote-SSH at the matching `0600`
OpenSSH config; the provider credential therefore stays out of process argv and
recent-workspace state. The launch directory is removed immediately when the
account/app authority ends, after expiry, and on a launch failure, while an
existing local extension directory may be reused without copying credentials
into it. Signed macOS qualification must still prove that both supported IDEs
honor this configuration and cleanup contract. Disposal is terminal for that
broker/runtime lifetime: a provider issuance that resolves after disposal is
revoked before any native launch, so it cannot recreate erased authority.

## Bridge and protocol

- Use TLS end to end across every non-local hop.
- Keep credentials in headers or an equivalent protected handshake; do not put
  them in URLs, analytics, or logs.
- Enforce message schemas, size limits, backpressure, and authorization at the
  receiving boundary.
- Rate-limit connection attempts and privileged operations.
- Fail closed on protocol, account, workspace, or capability mismatch.
- Resume from bounded acknowledged state; never trust an arbitrary client
  revision without server validation.

The implemented cloud listener requires a bounded `CONNECTED` frame first,
waits for asynchronous account verification before releasing later messages,
expires silent handshakes, caps HTTP/WebSocket peers and the pre-auth queue,
and requires exactly one canonical credential carrier. Authenticated work is
bounded across the transport—not multiplied per socket—to 32 ordinary handlers
plus an 8-handler control lane. Ordinary and control queues, per-peer shares,
aggregate retained bytes, frame size, and per-peer/aggregate outbound buffers
all have package-owned ceilings. The control lane keeps cancellation, steering,
close, permission, and question settlement actionable under long-running
ordinary work without allowing those messages to bypass earlier work for their
own session. WebSocket and partial-HTTP shutdown are bounded, and disconnect
state finalizes once.

JWKS verification coalesces concurrent lookups and enforces separate fetch and
streamed-body deadlines. It cancels a decompressed response once it crosses
1 MiB, caps key count and `kid`, rejects duplicate/incompatible signing keys,
disallows HS256 fallback on the JWKS path, and bounds configured clock skew.
Provider ingress must additionally rate-limit attempts before they reach the
worker; the signed preview capability is not a substitute for production edge
abuse controls.

## Multi-tenant data

All control-plane and durable-record queries require tenant-scoped
authorization. Database row-level controls supplement application checks; they
do not replace them. Background workers must set an explicit tenant/system
context and keep audit records for privileged operations. Setup workers use a
workspace-before-run lock order, execute outside the transaction, renew only an
unexpired lease, and publish only while their lease owner and execution fence
still match. Lifecycle cancellation clears the lease and revokes setup and
repository grants before a late executor can publish readiness. Setup
admissions are additionally bound to that exact run/fence and must be retired
before success. The worker persists an immutable structured attestation and
publishes `ready` atomically; exit code zero, free-form logs, or a listening port
are never readiness evidence.

## Release blockers

- missing exact provider/edge plus signed-macOS qualification of the implemented
  native catalog/details/SSH/preview/tunnel boundary;
- the setup-worker gate is enabled before exact-image, provider lifecycle, and
  v4 bootstrap/engine isolation qualification is complete;
- unverified tenant isolation or deletion behavior;
- secrets appearing in images, snapshots, URLs, logs, or transcripts;
- an unqualified provider lifecycle or unresolved reconciliation/orphan race;
- missing backup restoration and disaster-recovery exercise;
- no signed-macOS qualification of replica path/symlink/case handling,
  divergence preservation, device sleep/resume, or per-device revocation;
- SSH/preview/forward tokens in client-facing URLs, renderer persistence,
  analytics, or logs;
- unsupported agent/runtime redistribution or authentication;
- unresolved high-impact reachable dependency findings; or
- no signed/notarized client validation for the platform being released.
