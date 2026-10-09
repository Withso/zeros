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

## Sandbox requirements

- Isolate tenants at the provider's strongest supported compute boundary.
- Run as a non-root user with the minimum filesystem and process privileges.
- Deny inbound traffic except the intended bridge/health boundary.
- Treat outbound traffic as direct tenant-VM traffic for the initial release.
  Per-agent egress policy is not a ZSR claim and may be added later at the
  provider/VM boundary.
- Do not mount control-plane credentials, signing keys, production database
  credentials, or broad Git tokens in the environment.
- Destroy ephemeral credentials on stop/delete and verify resource deletion
  through reconciliation.
- Invoke only fixed image-owned setup/bootstrap entrypoints through the bounded
  provider command adapter. Repository names, revisions, settings, and secrets
  are data inputs; never concatenate them into a shell command.
- Revalidate the physical Git directory, origin, top level, and HEAD after all
  repository-controlled setup commands and before engine readiness.
- Treat snapshots and caches as sensitive copies subject to encryption,
  retention, and deletion policy.

## Protected bootstrap and v4 engine boundary

Only worker profile 4 with a saved v2 source and actor protocol 2 executes. Profiles 1–3,
including the old VM-root engine, are retired and have no production root
exception. A missing cloud marker is the Local path; a present unsupported
marker fails before cloud credential preparation or execution. Historical
metadata/schema records remain readable for audit/cleanup. See
[runtime bundles](runtime-bundles.md) for immutable layout and witnesses.

The v4 engine is namespace root mapped to **VM UID/GID 10003**. Worker 10001,
capture 10002 and private coordinator 10004 are separately mapped; VM root and
the provider login identity are absent. The fixed launcher supplies read-only
protected deployment and explicit workspace/state views, no supplementary
groups, `NoNewPrivs` and seccomp. Namespace capabilities allow checked ownership
publication and child containment without VM-root authority.

`CAP_SETFCAP` is retained through exec into the ZSR supervisor for Linux nested
UID 0 mapping, confined to this namespace. Inherited `NoNewPrivs` prevents gaining
privilege from file capabilities. Nonzero worker/capture/coordinator/setup
children drop all capabilities. Process-local procfs permits nested worker and
browser namespaces; VM-global controls remain unmapped-root owned and unwritable.
Admission checks real procfs UID maps, read-only deployment, host-process/root-
link and ancestor-namespace denial, finite cgroup ancestry, memory/CPU/PID bounds
and actual nested execution. A provider broker filter cannot substitute for
engine confinement. Malformed/unbounded evidence fails admission.

On restricted AppArmor hosts, the initial-host-user-namespace launcher loads the
image-owned `zeros-cloud-engine` profile for the fixed namespace helper and its
descendants; it never disables global restrictions. A provider-owned outer user
namespace keeps its own policy. Hosts needing unavailable policy support fail
closed. Bounded root-owned provider FUSE sysctl reads are distinct from real
procfs identity maps. Only the exact `/sys` and `/sys/fs` sysfs ancestors permit
unmapped owners; writable cgroup controls still require UID 0/cgroup-v2 identity.
Private shared memory is a bounded 512 MiB tmpfs charged to the engine cgroup.

The minimal VM-root bootstrap/broker owns verified runtime installation,
attestation and lifecycle. Its mode-0700 state/0600 socket, setup journals, provider
login homes and root credentials are absent from the engine view. Engine launch
material uses a separate private projection. Fixed exact-schema operations
accept no arbitrary executable/path/environment; prepare is a one-use session.
A lifetime kernel lock prevents replacing a live endpoint; retirement drains
engine/setup cgroups, including detached descendants, before a new launch.

| Threat | Current control | Remaining qualification |
| --- | --- | --- |
| Repository replaces privileged code | Root-controlled pinned tree/manifest/receipt, checked ancestry/links/modes and restored-tree verification before launch. | Exact base/kernel/provider restoration and tamper negatives. |
| Engine or parser compromise | VM root unmapped; deployment read-only; minimal root protocol, separate worker/capture/coordinator views and grants. | Engine still sees its own working credentials and workspace state; qualify actual namespaces and broker isolation. |
| Stale proof or overlapping engines | Boot/session/mount/cgroup/runtime-bound one-use proof, shared locks and complete descendant retirement. | Cold/warm restore, stale-session and crash/ambiguous-reply boundaries. |
| Resource exhaustion | Finite memory/CPU/PID ancestry, bounded processes/commands/I/O and explicit deadlines. | Exact provider resource envelope and edge abuse limits; no per-agent egress guarantee. |
| Runtime/client authority survives stop/revocation | Current actor/device/generation/epoch checks, durable grant retirement and positive cleanup. | Actual provider and signed Mac cleanup/expiry races. |
| Desktop or preview obtains bearer | Main-only keys/configs, exact frame/origin header injection and bearer-free IPC. | Packaged native trust, frame isolation and multi-connection/editor behavior. |

Qualification must exercise the actual worker/engine identities, base/runtime
pair, setup/readiness, native tools, Git/Files/Design, PTY, SSH/preview/tunnels,
recovery/rollback and cleanup. Code/Linux root probes are insufficient. No old
root exception can qualify v4; keep unqualified release capabilities gated.
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
