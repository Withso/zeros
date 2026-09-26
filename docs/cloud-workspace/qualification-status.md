# Cloud backend qualification status

Reviewed September 25, 2026. This matrix distinguishes implemented behavior,
live evidence and release qualification. Both production cloud execution flags
remain disabled. Desktop cloud creation UI is outside this backend change.

The current release milestone is an internal pilot for standing Zeros staff
roles `platform_owner` and `developer`. Customer subscription/payment integration
is deferred. Organization ownership, membership, tenant isolation, explicit
operator-funded allowances, quotas and finite compute leases still apply.
The isolated deployed API has passed staff-admission withdrawal and restoration,
including denial when a staff account lacks its own Pro entitlement. Provider
runtime admission remains a separate qualification boundary.

The repository now also contains the [Pro backend](pro-backend.md) policy and
migrations `0101`–`0104`: individual sponsorship, complimentary staff Pro,
monthly allowances, ten assigned writers and unlimited Read-only Pro guests.
This is backend implementation, not hosted rollout evidence. The channel table
below remains the recorded deployed state; hosted migrations, Alpha enablement
and desktop qualification are separate work.

Alpha, Beta and Production now use PlanetScale Postgres; the control-plane
application remains on Railway. All three cutovers passed source fencing, data
comparison, forward migrations, runtime-role and public API checks. Normal app
access is restored; cloud execution remains disabled. Batch 4 covers deployed
account connection, collaboration and image publication. Batch 6 requalified
managed Boat through the isolated deployment's public API, and Batch 7
exercised recovery, fault injection, sustained load and operations there.
Daytona worker isolation is still unqualified. See
[database qualification](database-qualification.md).

## Release state

Batch 8 closed the staff backend milestone on September 24, 2026.

| Channel | Backend | Migration ledger | Cloud execution |
| --- | --- | --- | --- |
| Alpha | current `main`, deployed automatically | through `0100` | off |
| Beta | September 25 release (`release/0.1.19`) | through `0100` | off |
| Production | September 25 release (`release/0.1.19`) | through `0100` | off |

- Managed Boat Linux VMs are the default provider. Daytona remains a separate
  adapter, used only when explicitly selected: its worker isolation is
  unqualified, and it is kept for a future Windows sandbox.
- Beta and Production moved to the current backend in `release/0.1.19`
  (`c3653385`) on September 25: `release-migration:manage` applied
  `0094`–`0100` after an on-demand backup of each database, then the API, web
  and desktop builds were promoted as described in
  [deployment environments](../deployment-environments.md). Beta deploys from
  the release branch again; Production deploys stay manual.
- The isolated qualification deployment used for Batches 4–8 is retired. Its
  evidence is summarized here and in
  [infrastructure and operations](infrastructure-and-operations.md#recovery-drills-and-measured-limits).
- Enabling cloud execution on Alpha for desktop UI wiring needs its own Boat,
  object-store, keyring and operator configuration. That is the first step of
  the UI wiring phase, not a backend gap.

## Current eight-step execution

| Step | Repository implementation and evidence | Open exit condition |
| --- | --- | --- |
| 1. Contracts | Portable client/runtime, provider, command, checkpoint and security contracts; Organization ownership and Personal-local enforcement | Keep advertised capabilities within this matrix |
| 2. Provider registry | Managed Boat and versioned customer Daytona connections; immutable generation routing, independent profiles, key rotation and revocation regressions; isolated deployed Daytona onboarding, distinct valid-key rotation, replay, rejected rotation and revocation | Qualification with an enabled compute profile |
| 3. Secure Linux / Boat | Pinned native image, unprivileged engine/worker separation, setup, admission, heartbeat, lifecycle and finite provider lease; live authorized Boat create/readiness | Exact production deployment, remaining provider deletion proof and host-security release review |
| 4. Shared headless workspace | File/Git/process/PTY, shared Code/Design conversation, API authoring and capture, native agent continuation, private previews and scoped human services exercised on Boat | Production agent-account connection/authentication flow, Codex on the current image and declared tooling gaps below |
| 5. Devices and commands | Durable queues, approval/Stop receipts, independent device grants, bounded replay; live concurrent and suspended clients on Boat; a 30-minute two-workspace, six-device soak with complete replay after a disconnect | Multi-region and fleet-scale load, and later native client release tests |
| 6. Durability | Dirty Git/index/unpublished HEAD, attachments, native histories and Design restored into a fresh Boat generation; public recovery from a stopped workspace, rollback and upgrade on the current image; active-turn loss leaves an uncertain command and paused queue; a workspace whose provider host was destroyed recovered from its last durable checkpoint after an operator loss attestation; a point-in-time database restore with every referenced object verified and measured RPO/RTO | Cross-region recovery, and recovery after losing the object store itself |
| 7. Daytona BYO | Provider and onboarding code plus database regressions; live allocation/cleanup probes; off by default, selected only explicitly | Deferred. Linux-VM snapshot/region/quota preflight implemented; the tested host fails user-namespace creation as the actual worker identity. Full parity remains open |
| 8. Spend and operations | Credit grants, reservations, cumulative meter, live Boat rejected-create closure and settlement, ledger-to-provider meter reconciliation, finite renewal, budget drain/Stop, settlement, engine-loss Stop, leased cross-provider drift, cleanup, staff admission regressions, deployed WorkOS identity, Alpha/Beta/Production PlanetScale cutovers, isolated restore/HA/PITR evidence and encrypted R2 upload/readback/decryption evidence; operator-attested loss settlement, emailed health alerts, an external uptime probe, a measured load baseline and object-key rotation | Production deployment and provider deletion completion; customer billing deferred |

The eight steps are not all complete. Local tests and a successful Boat runtime
do not clear Daytona or production operations gates.

## Supported native tools and evidence

| Capability | Backend | Live qualification |
| --- | --- | --- |
| Files, search, Git, process execution and PTY | Existing Zeros engine over authenticated portable bridge | Boat |
| Code and Design with one agent conversation | Mode revisions, cloud API authoring, directory lifecycle, capture and durable recovery | Boat |
| Claude, Cursor and Codex native sessions | Existing provider adapters; explicit model credentials remain tenant scoped | Boat with test-authorized credentials: Claude and Cursor on the current image, Codex on the previous image only; production account connection remains open |
| SSH / SFTP / TCP forwarding | Zeros runtime SSH inside the admitted engine namespace; independent device/service grants and descendant retirement | Boat, including PTY dimensions, stderr/exit, file/tunnel roundtrips and revocation |
| HTTP and HMR previews | Private scoped relay with current authority checks | Boat |
| Ordered live streams, replay and Stop/approval receipts | Shared schemas, durable receipts, bounded buffers, per-device authority | Boat headless clients, including late and suspended receivers |
| Receive-only replicas and immutable copy/fork | Backend services and regression coverage | Signed desktop lifecycle qualification remains open |
| TypeScript, JavaScript and Python language services | Typed disk-backed symbols/completions, actor and execution isolation, bounded RPC and retirement | Real native and root namespace canaries plus actual Boat v3 engine image attestation; Daytona remains open |
| Personal Codex subscription renewal | Encrypted native cache, durable single-use refresh attempts, access-only leases, per-owner consent | Real pinned native cache renewal and paid native turn/resume on qualified Boat images; exact deployed account-connection and delegation qualification remains open |
| Windows/macOS compute, public ports, UDP and simultaneous text editing with conflict resolution | Outside the current Linux pilot | No claim |

## Evidence limits

- Batch 7 destroyed a running Boat sandbox at the provider. The control plane
  marked the workspace failed once the provider reported it gone, and never
  treated the 404 as deletion or as a final meter. After an operator loss
  attestation, compute settled at the last meter and the owner recovered the
  last durable checkpoint into a new generation: a file written before that
  checkpoint came back and a file written after it did not.
- Batch 7 also killed the engine mid-command, replaced and crashed the control
  plane, restored the database to an exact point in time with every referenced
  object decrypted, rotated the object-encryption key across every object and
  ran a 30-minute multi-device soak. The killed command's receipt became
  uncertain and was never re-dispatched. Everything ran in one region against
  the isolated deployment; measured limits are in
  [infrastructure and operations](infrastructure-and-operations.md#recovery-drills-and-measured-limits).
- Concurrent headless clients exercise the platform-independent protocol. They
  do not qualify native iOS, iPadOS, Windows or signed macOS applications.
- Earlier engine qualification used fixture identity issuance. Subsequent
  isolated Railway tests exercised normal WorkOS authentication, delivered
  invitations, workspace-scoped guest acceptance, concurrent devices and guest
  revocation through the public API. The current isolated API also passes Claude
  and Cursor credential connection, delegation, rotation and revocation; Codex
  account metadata and duplicate refresh-seed rejection; and independent staff
  and Pro withdrawal checks. A disposable private repository passed scoped
  GitHub App token issue, a real Git fetch, token revocation and anonymous denial.
  Batch 6 later cloned that repository on the provider host and ran Claude and
  Cursor turns on the current image; no interactive native sign-in ceremony is
  claimed. A membership created directly at the identity provider is projected
  but never materialized as a Zeros grant.
- Deployed Daytona connection checks verified the supplied key without allocating
  compute. Personal onboarding and guest provider administration were denied;
  a stored valid key could not create a workspace while its compute profile was
  absent. Invalid rotation preserved the existing version, and revoked connection
  reuse was denied. Live rotation between two distinct valid keys verified both
  encrypted versions, retirement of the unused prior version, idempotent replay,
  stale-version rejection and revocation without allocating a generation.
- Revoking an owned WorkOS test session closed both of its open event streams
  and denied API access while another user's session remained valid. Revocation
  took about 60 seconds through the isolated deployment's event-polling fallback.
  This proves session isolation, not instant revocation or native-device behavior.
- Isolated PlanetScale restores preserve source rows, enforce NOINHERIT runtime roles and pass same-region HA failover and point-in-time recovery. Separate encrypted R2 evidence verifies upload, readback, integrity and decryption. All three main cutovers preserve their original datasets and pass authenticated owner/tenant-isolation and concurrent event-stream checks; cloud execution remains disabled. Encrypted backup recovery has separate evidence. Batch 7 added a same-region restore drill of the database with its objects; regional recovery remains open.
- Disposable PostgreSQL 15 and 18 final-copy rehearsals cover writer draining,
  connection fencing, dropped-column and enum restore compatibility, sequence
  ownership, role drift, cancellation and uncertain fence acknowledgements.
  A real R2 round trip verifies encrypted evidence by downloading and decrypting
  it. Any future cutover requires a fresh fenced copy and target comparison;
  source and target collation-library versions must be explicitly qualified.
- Batch 6 rebuilt and attested the Boat image from merged main and exercised it
  through the isolated deployment's public API, billed to an explicit
  organization wallet. A stopped workspace recovered into a fresh generation.
  Rollback to the previous image and upgrade back restored repository and
  Design content. Two-device PTY/Git, Design authoring and capture, Claude
  durable turns with cross-device approvals, Cursor durable turns, a
  Code-to-Design-to-Code conversation, mid-turn Stop with explicit queue resume, stop/wake/archive and
  a rejected agent startup without engine loss passed. The run also verified
  the Cursor product-tool and workload file-ownership fixes. Codex was not
  requalified on this image because its account usage limit was exhausted.
  Ledger usage matched Boat's organization meter exactly. Daytona allocation
  probes reached the host, but unprivileged worker namespace creation failed;
  a privileged-root success does not clear that boundary. Native image tests
  do not substitute for public admission or qualify later runtime changes. The
  protected registry publication workflow records source provenance separately
  from provider qualification.
- The rejected-create audit found that unbound journals could indefinitely
  retain cleanup and compute reservations. Migration 0093 adds per-dispatch
  rejection evidence and permanent unallocated closure; historical requests
  with incomplete evidence remain unresolved. Live qualification under an
  owner-set Boat member cap first found a refusal diagnostic the adapter did not
  recognize, which left every attempt unknown. On the fixed deployment every
  dispatch was a qualified refusal. Stop closed the generation, the reservation
  settled without a debit, wake required recreation and deletion needed no
  provider receipt. Closure cannot be used to infer old resources were erased.
- Full-suite verification exposed two concurrent filesystem cleanup races:
  an upload inode can lose its last link during inspection, and another
  deleter can publish a permanent fence before unlink. Bounded reinspection
  preserves the existing file checks and deletion fence. Deterministic
  regressions cover both races, unsafe replacements and persistent ambiguity;
  the repair still requires deployed qualification.
- Provider DELETE acceptance and a subsequent 404 are not data-erasure evidence.
  Storage and cleanup records remain until a matching terminal receipt exists.
  Batch 6's sandbox deletion receipts were still provider-blocked at review
  time, so those workspaces keep their storage reservation and `deleting` state.

## Requalification

Run the repository verification matrix and adjacent regression suites. Database
suites must use an isolated test database and run serially. Build and attest the
exact source/image, then exercise the headless matrix through normal public
admission rather than provider administrator access. Reserve provider budget
and cleanup headroom before allocation. Use provider administration only for
explicit fault injection and independent observation. Keep raw secrets and
operational evidence outside the repository.

For Daytona, qualify the required namespaces/cgroups as the actual worker UID
before running paid agents. A privileged-root probe alone is insufficient.
Use a compatible host configuration; do not disable worker isolation to make a
provider test pass. See the [roadmap](implementation-roadmap.md),
[provider contract](provider-contract.md), [compute credit contract](compute-credits.md)
and [runtime threat model](root-coordinator-threat-model.md).
