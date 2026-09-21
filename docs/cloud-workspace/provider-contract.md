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

The existing Daytona deployment variables retain their defaults. To select
managed Boat, set `CLOUD_WORKSPACE_PROVIDER=boat`, `BOAT_API_KEY`, a stable
`BOAT_ACCOUNT_SCOPE`, `BOAT_SNAPSHOT_ID`, `BOAT_IMAGE_BUILD_SHA256`, and
`CLOUD_WORKSPACE_STORAGE_MIB` from the measured image. Boat snapshot names are
mutable. The stored reference is `boat:<name>@sha256:<build-metadata-digest>`;
setup verifies the exact attested metadata digest before launching. A replaced
name cannot silently select a different qualified build.
`BOAT_TTL_SECONDS` is a finite renewable lease from 60 through 3600 seconds.
Managed Boat also requires an explicit price policy and prepaid reservations;
see [compute credits](compute-credits.md). CPU/memory default to 4000 millicores and
8192 MiB; only Boat's exact supported pairs are admitted. Architecture must be
`linux/amd64`. Never change the account scope when rotating a key in the same
account, or reuse an old scope for a different provider account.

Daytona BYO beside Boat requires `DAYTONA_BYO_ENABLED=true` and independent
`DAYTONA_BYO_SNAPSHOT_ID`, `DAYTONA_BYO_SOURCE_COMMIT`,
`DAYTONA_BYO_CPU_MILLICORES`, `DAYTONA_BYO_MEMORY_MIB`, and
`DAYTONA_BYO_STORAGE_MIB`. Its architecture defaults to `linux/amd64` and can be
set with `DAYTONA_BYO_ARCHITECTURE`. `DAYTONA_API_URL`, `DAYTONA_TARGET`, and
the existing access/toolbox allowlists apply to that connection. No managed
Daytona API key is required or used for BYO. The runtime registry refuses missing
historic managed accounts; a default-provider migration must drain or retain
the former provider deployment before removing its credentials.

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
