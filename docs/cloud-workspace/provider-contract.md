# Cloud compute provider contract

Provider selection, credentials and allocation identity are separate from the
managed deployment default. The registry resolves the exact provider recorded
on a generation. A missing registration or unavailable customer credential fails
closed; it never borrows another provider's managed account.

## Immutable generations

Explicit customer connections choose their own provider and provisioning
profile. Profiles contain the qualified image, architecture, CPU, memory,
storage and source revision. The legacy flat configuration remains the profile
for the managed default. Additional profiles are independent configuration.

Create and generation-replacement retries calculate their request digest from
the accepted generation's profile. Changing deployment defaults cannot change
an accepted request, redirect a rebuild to another provider, or invalidate a
retry of the same user request. New upgrade requests use the current qualified
profile for the workspace's existing provider. Rollback retains the selected
historical generation's profile and existing authorization checks.

Hosted factories also receive the accepted generation's image and resources;
the deployment's current image is not a substitute for a queued create target.
Delegated resolution retains the exact encrypted credential version, endpoint,
Organization and owner binding. Credential envelope bytes and associated data
remain compatible with existing Daytona records.

Daytona can be registered for customer accounts without a hosted Daytona account.
Only execution limits and Daytona access-host policy are shared by its factories;
the customer credential, endpoint, target and generation profile are explicit
inputs. Customer onboarding uses its own endpoint configuration. The legacy flat
endpoint is a default only while the managed provider is Daytona. Rotating a key
preserves the accepted connection's endpoint and target, including after a
deployment default changes. Moving a connection to another endpoint requires a
separate connection rather than a key rotation.

## Allocation and deletion evidence

Providers may discover allocations by immutable labels or a durable coordinator
ownership journal. Display names are not ownership evidence. The journal is
scoped to a stable provider account identity that survives credential rotation;
it never stores API keys. Provider account changes require an explicit new
scope and continued cleanup access to the old one.

A generation has only one journal account scope. Looking up that generation
through another account fails instead of returning an empty result; a second
account cannot allocate another sandbox under the same generation identity.
The registry currently supports one hosted account per provider. Replacing that
account is not an automatic credential-rotation or provider-default operation.

Before provider allocation, persist the original request key and body digest.
An overlapping wake/create must reuse that key. Bind the returned resource ID
before interpreting nonidentity response fields, so a malformed response does
not discard the allocation's cleanup identity. An expired provider retry window
with an unknown outcome requires reconciliation; never allocate again under a
fresh key merely because the response was lost.

Migration 0093 records each Boat create dispatch before network I/O. A qualified
HTTP 429 rejection records only its allowlisted code, never the provider body.
The exact error envelope must agree on status and code and contain no allocation.
`limit_reached` and `member_limit_reached` are documented allocation refusals;
the strict `trial_compute_limit_reached` envelope is an observed live contract,
not an explicit preallocation guarantee in the public provider documentation.
The `member_limit_reached` envelope, including its `memberMaxActiveSandboxes`
diagnostic, was also observed live under an owner-set concurrent cap. All three
codes share one diagnostic-field allowlist. An unrecognized field, or any value
naming a sandbox or deletion operation, leaves that attempt unknown.
Other 4xx responses, malformed replies, transport failures and timeouts retain
an unknown outcome. A later rejected retry cannot clear an earlier unknown or
in-flight dispatch.

An unallocated generation can close only after every dispatch has a confirmed
rejection and no create/wake intent remains active. Closure is atomic with
dispatch admission, permanent, and separate from physical deletion evidence.
It releases unallocated reservations and permits eventual organization purge.
Wake returns `cloud_workspace_recreate_required` for a closed generation before
changing billing or creating an intent. A failed first allocation has no engine
or checkpoint for the ordinary rebuild flow: create a new workspace to retry.
If a durable checkpoint exists, the existing recovery API can restore it to a
fresh generation. Neither action reopens the closed journal. Attempt rows cannot be deleted independently of an authorized
terminal journal purge.

A journal whose dispatches can never be certified closes only with an operator
absence attestation (migration 0095). It records exhaustive provider-account
inventory evidence: every listed sandbox is bound in the same account scope's
journal or named as a known non-workspace resource, and every covered dispatch
is at least two hours older than the inventory. An attestation covers
dispatches only up to its recorded instant, never erases attempts, cannot close
a bound generation or one with an active create or wake, and is append-only.
The application role can read attestations but cannot create them.

A provider can also lose a bound allocation outright (host loss or
provider-side deletion). Its sandbox and usage meter then return not found,
which alone never proves deletion or a final meter, so lifecycle stops and
compute settlement retry with backoff. Only an operator loss attestation
(migration 0099) resolves it. It names the exact bound resource, records an
account inventory that omits it but lists every other allocation the scope
still holds, and a not-found lookup; it is refused once Zeros has started
deleting the allocation or while an engine still holds its authority. The
journal then records `lost_at`: inspection reports the allocation absent, start,
renewal, metering and access refuse `provider_resource_lost`, wake returns
`cloud_workspace_recreate_required`, deletion bookkeeping cannot start, and
organization purge may consume the journal. Compute reservations finalize as
`allocation_lost` at the last provider meter; unmetered time is released, not
billed. The owner recovers the durable checkpoint into a new generation.

Historical journals remain untracked and cannot infer absence from new receipts.
New journals use a versioned local request digest; an older writer's digest
cannot match them, so it fails before dispatch. The provider HTTP body and
original idempotency key stay unchanged. If an older writer wins an insert race,
the newer writer preserves that row's legacy digest and uncertainty. This fence
also protects rolling deployments; do not backfill the tracking flag or erase
old unknown attempts to make cleanup pass.

Before asynchronous deletion, drain issued access and persist deletion intent.
Retain the exact provider operation receipt across restarts. Verify its account,
target, kind and terminal status. A sandbox disappearing from listings or
returning HTTP 404 does not establish completed data deletion. Missing receipts,
blocked operations and unknown allocations remain unresolved evidence.

The reconciler consults provider absence verification before terminal lifecycle
success and orphan cleanup. Organization purge waits for confirmed provider
deletion; it does not spend repeated purge attempts while waiting. The database
prevents replacement of accepted evidence and removal of unconfirmed records.
Confirmed journal rows may be consumed only with the organization purge.

Drift scheduling is stored on each provider binding. With a registry resolver,
checks include every recorded provider, rather than only the managed default.
Claiming a due check advances its deadline before provider I/O; the exact
deadline fences the observation and its release. Provider errors preserve the
last successful observation and schedule bounded backoff. A crashed observer
loses its claim after the lease expires. A slow or failing allocation must not
prevent other due allocations from being checked. Migration 0074 introduces
this scheduling state without changing existing provider identities.

## Runtime and access

The Linux setup executor uses a fixed image-owned helper, one-use admission,
execution fence and pinned image/source contract. Provider runners transport
that request without interpolating credentials into shell commands. The
original Daytona exports remain compatibility aliases for the shared executor.

Lifecycle allocation does not establish engine readiness or qualify optional
agent, capture, SSH or preview capabilities. Access revocation must complete
before a destructive provider action is treated as drained. Provider API keys
remain in the coordinator; clients receive only scoped Zeros capabilities.
Private preview endpoints use a provider-specific credential header behind the
same client capability. The proxy rejects bearer URLs, unsafe header values and
attempts to overwrite client-capability or forwarding headers before caching.

## Current integration boundary

Production composition accepts managed Boat or managed Daytona. Boat uses the
durable operation journal, restricted one-use bootstrap runner, and authenticated
Zeros runtime listener. It exposes no provider administrator login to clients.
Human SSH is the Zeros runtime service and must be qualified on the exact image.
Boat has live scoped SSH, PTY, SFTP, forwarding and retirement evidence. Daytona
must pass the same tests on a compatible host. Provider configuration and local
tests do not enable the production qualification gates.

Managed Boat Linux VMs are the default provider: an unset
`CLOUD_WORKSPACE_PROVIDER` means `boat`, and Daytona must be selected
explicitly with `CLOUD_WORKSPACE_PROVIDER=daytona`. Customer Daytona
connections stay off unless `DAYTONA_BYO_ENABLED=true`. Managed Boat requires
`BOAT_API_KEY`, a stable `BOAT_ACCOUNT_SCOPE`, `BOAT_BILLING_ORG`,
`BOAT_SNAPSHOT_ID`, `BOAT_IMAGE_BUILD_SHA256`, and `CLOUD_WORKSPACE_STORAGE_MIB`
from the measured image. The
[Boat image kit](../../scripts/cloud-workspace-validation/boat-image/README.md)
builds, attests and saves a new image and prints those values. Boat snapshot names are
mutable. The stored reference is `boat:<name>@sha256:<build-metadata-digest>`;
setup verifies the exact attested metadata digest before launching. A replaced
name cannot silently select a different qualified build.
`BOAT_TTL_SECONDS` is a finite renewable lease from 60 through 3600 seconds.
Managed Boat also requires an explicit price policy and prepaid reservations;
see [compute credits](compute-credits.md). CPU/memory default to 4000 millicores and
8192 MiB; only Boat's exact supported pairs are admitted. Architecture must be
`linux/amd64`. Never change the account scope when rotating a key in the same
account, or reuse an old scope for a different provider account.

`BOAT_BILLING_ORG` names the Boat organization wallet (`team_…`) billed for every
new sandbox. Without it Boat bills the account's dashboard-selected wallet, which
can change outside Zeros. Every create dispatch sends it as the `X-Boat-Org`
request scope; the body and journaled request digest are unchanged. Boat matches
an idempotent create on account, key and body, so a retry returns an earlier
allocation with whatever wallet it was billed to. A sandbox keeps its creation
wallet for resume and usage. Compute is granted only after Boat reports the
configured organization for the allocation, on a fresh create, a create retry,
every resume and every lease renewal; any other answer is read back once. Boat's
`team` field carries the wallet: `null` is the personal wallet, and an absent or
malformed value is unconfirmed. Inspection never reports a sandbox on a
mismatched or unconfirmed wallet as running or provisioning, so no lifecycle or
metering path can admit or renew it, while Stop and deletion still work. A
refused create keeps its bound cleanup identity and requests a managed Stop. An
allocation billed elsewhere is not resumed; recover its workspace into a fresh
generation. The wallet is billing scope, not the journal's account identity, so
changing it does not change `BOAT_ACCOUNT_SCOPE`.

Daytona BYO beside Boat requires `DAYTONA_BYO_ENABLED=true` and independent
`DAYTONA_BYO_SNAPSHOT_ID`, `DAYTONA_BYO_SOURCE_COMMIT`,
`DAYTONA_BYO_CPU_MILLICORES`, `DAYTONA_BYO_MEMORY_MIB`, and
`DAYTONA_BYO_STORAGE_MIB`. Its architecture defaults to `linux/amd64` and can be
set with `DAYTONA_BYO_ARCHITECTURE`. `DAYTONA_API_URL`, `DAYTONA_TARGET`, and
the existing access/toolbox allowlists apply to that connection. No managed
Daytona API key is required or used for BYO. The runtime registry refuses missing
historic managed accounts; a default-provider migration must drain or retain
the former provider deployment before removing its credentials.

`DAYTONA_CONNECTIONS_ENABLED=true` permits credential onboarding independently
of the compute profile. It uses `DAYTONA_API_URL`, `DAYTONA_TARGET` and the
provider credential encryption key for bounded, read-only key verification and
encrypted storage. It does not register a Daytona provisioning profile or enable
allocation. This supports staff API qualification while host isolation remains
unqualified. Enabling a complete BYO compute profile also enables onboarding;
both controls default off beside managed Boat.

Boat allocation accepts only the storage size declared by its qualified image
profile. The provider API has no disk-resize parameter; accepting another size
would misrepresent the reservation. Configuration alone does not prove capacity:
the image qualification and runtime readiness checks must measure available
storage before the profile is enabled.

Daytona snapshot creation inherits CPU, memory, and disk from that snapshot.
The adapter must not send resource overrides alongside a snapshot. It verifies
the returned resources against the immutable generation reservation, including
when recovering a timed-out allocation. Each offered size therefore needs a
matching qualified snapshot; changing configuration cannot resize an image.

Current helpers request version-2 setup materials, which carry the generation's
architecture, CPU, memory, and storage. They compare host and ancestor-cgroup
capacity, tenant CPU/memory limits, and filesystem capacity before launch. The
comparison permits 6% kernel/filesystem accounting overhead and up to 1 GiB
(at most 25%) reserved for VM services. Filesystem size is not evidence of a
provider billing quota. Legacy helpers can still redeem version-1 materials;
new helpers reject a downgraded response.

Image build metadata version 2 records the actual Git source tree and compiled
engine/capture/supervisor hashes. OCI images retain their digest-pinned base.
Native Linux builds use the explicit `native-linux` metadata input and record
OS, package inventory, and Node binary digests. Attestation rechecks these
against the installed image. Native inventory is not represented as an OCI
image digest; the provider snapshot identity remains separate release evidence.

The provider operation journal's Boat retry cutoff is shorter than the
provider's documented key-retention window. Unknown creates beyond that cutoff
and lost deletion receipts that cannot be recovered remain blocked for operator
reconciliation. Never remove their journal records to unblock billing or purge.

See the [client/runtime contract](client-runtime-contract.md) for multi-device
and recovery requirements and the [runtime security gate](root-coordinator-threat-model.md)
for the current production restriction.
