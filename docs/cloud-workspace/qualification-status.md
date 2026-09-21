# Cloud backend qualification status

Reviewed September 21, 2026. This matrix distinguishes implemented behavior,
live evidence and release qualification. Both production cloud execution flags
remain disabled. Desktop cloud creation UI is outside this backend change.

The current release milestone is an internal pilot for standing Zeros staff
roles `platform_owner` and `developer`. Customer subscription/payment integration
is deferred. Organization ownership, membership, tenant isolation, explicit
operator-funded allowances, quotas and finite compute leases still apply.
Organization creation's staff gate does not by itself prove cloud admission is
staff-only; server admission and staff-revocation tests remain exit requirements.

PlanetScale Postgres is the selected target for hosted database qualification;
the control-plane application remains on Railway. Alpha's main writer has been
cut over with source fencing, row comparison, migration and public API checks.
Beta's source profile and encrypted archive have been independently verified;
Beta and Production writer cutovers remain pending. See
[database qualification](database-qualification.md).

## Current eight-step execution

| Step | Repository implementation and evidence | Open exit condition |
| --- | --- | --- |
| 1. Contracts | Portable client/runtime, provider, command, checkpoint and security contracts; Organization ownership and Personal-local enforcement | Keep advertised capabilities within this matrix |
| 2. Provider registry | Managed Boat and versioned customer Daytona connections; immutable generation routing, independent profiles, key rotation and revocation regressions | Production connection onboarding qualification |
| 3. Secure Linux / Boat | Pinned native image, unprivileged engine/worker separation, setup, admission, heartbeat, lifecycle and finite provider lease; live authorized Boat create/readiness | Exact production deployment, remaining provider deletion proof and host-security release review |
| 4. Shared headless workspace | File/Git/process/PTY, shared Code/Design conversation, API authoring and capture, native agent continuation, private previews and scoped human services exercised on Boat | Production agent-account connection/authentication flow and declared tooling gaps below |
| 5. Devices and commands | Durable queues, approval/Stop receipts, independent device grants, bounded replay; live concurrent and suspended clients on Boat | Fleet/region load qualification and later native client release tests |
| 6. Durability | Dirty Git/index/unpublished HEAD, attachments, native histories and Design restored into a fresh Boat generation; active-turn loss leaves an uncertain command and paused queue | Literal provider-host destruction, target PlanetScale database plus offsite object-store recovery and reviewed RPO/RTO |
| 7. Daytona BYO | Provider and onboarding code plus database regressions; live allocation/cleanup probes | Linux-VM snapshot/region/quota preflight implemented; available test account lacks eligible Linux-VM quota. Full parity remains open |
| 8. Spend and operations | Credit grants, reservations, cumulative meter, finite renewal, budget drain/Stop, settlement, engine-loss Stop, leased cross-provider drift, cleanup, staff admission regressions, deployed WorkOS identity, Alpha main PlanetScale cutover, isolated restore/HA/PITR evidence and encrypted R2 upload/readback/decryption evidence | Beta/Production writer cutover, exact deployed runtime requalification, rejected-create cleanup qualification, deletion completion, operational alerts and sustained load/soak; customer billing deferred |

The eight steps are not all complete. Local tests and a successful Boat runtime
do not clear Daytona or production operations gates.

## Supported native tools and evidence

| Capability | Backend | Live qualification |
| --- | --- | --- |
| Files, search, Git, process execution and PTY | Existing Zeros engine over authenticated portable bridge | Boat |
| Code and Design with one agent conversation | Mode revisions, cloud API authoring, directory lifecycle, capture and durable recovery | Boat |
| Claude, Cursor and Codex native sessions | Existing provider adapters; explicit model credentials remain tenant scoped | Boat with test-authorized credentials; production account connection remains open |
| SSH / SFTP / TCP forwarding | Zeros runtime SSH inside the admitted engine namespace; independent device/service grants and descendant retirement | Boat, including PTY dimensions, stderr/exit, file/tunnel roundtrips and revocation |
| HTTP and HMR previews | Private scoped relay with current authority checks | Boat |
| Ordered live streams, replay and Stop/approval receipts | Shared schemas, durable receipts, bounded buffers, per-device authority | Boat headless clients, including late and suspended receivers |
| Receive-only replicas and immutable copy/fork | Backend services and regression coverage | Signed desktop lifecycle qualification remains open |
| TypeScript, JavaScript and Python language services | Typed disk-backed symbols/completions, actor and execution isolation, bounded RPC and retirement | Real native and root namespace canaries plus actual Boat v3 engine image attestation; Daytona remains open |
| Personal Codex subscription renewal | Encrypted native cache, durable single-use refresh attempts, access-only leases, per-owner consent | Real pinned native cache renewal and paid native turn/resume on qualified Boat images; exact deployed account-connection and delegation qualification remains open |
| Windows/macOS compute, public ports, UDP and simultaneous text editing with conflict resolution | Outside the current Linux pilot | No claim |

## Evidence limits

- Runtime loss testing retired the engine, erased its writable roots and restored
  into another provider allocation without a final checkpoint. It did not
  simulate the provider's physical host disappearing.
- Concurrent headless clients exercise the platform-independent protocol. They
  do not qualify native iOS, iPadOS, Windows or signed macOS applications.
- Earlier engine qualification used fixture identity issuance. Subsequent
  isolated Railway tests exercised normal WorkOS authentication, delivered
  invitations, workspace-scoped guest acceptance, concurrent devices and guest
  revocation through the public API. GitHub App repository-scoped token issue,
  resolution and revocation were tested separately. Main deployment and private
  repository qualification remain distinct exit conditions.
- Isolated PlanetScale restores preserve source rows, enforce NOINHERIT runtime roles and pass same-region HA failover and point-in-time recovery. Separate encrypted R2 evidence verifies upload, readback, integrity and decryption. Alpha's main cutover preserves the original dataset and passes authenticated owner/tenant-isolation and concurrent event-stream checks; cloud execution remains disabled there. Beta/Production migration, end-to-end recovery of the main dataset from R2 and regional recovery remain open.
- Disposable PostgreSQL 15 and 18 final-copy rehearsals cover writer draining,
  connection fencing, dropped-column and enum restore compatibility, sequence
  ownership, role drift, cancellation and uncertain fence acknowledgements.
  A real R2 round trip verifies encrypted evidence by downloading and decrypting
  it. Each remaining channel cutover requires a fresh fenced copy and target comparison;
  source and target collation-library versions must be explicitly qualified.
- The merged backend's Boat image has passed native build/attestation and actual
  Claude, Cursor and Codex turn/resume/Stop canaries. Its named snapshot is ready
  and the isolated API is deployed. Boat allowed an existing image builder to
  resume but rejected the fresh public-API recovery allocation as exhausted
  trial compute; the recovered-generation test has not passed. The rolled-back
  workspace and builder were stopped. Daytona Linux-VM quota remains unavailable.
  Native image tests do not substitute for normal public admission or qualify
  subsequent runtime changes. Registry publication and exact-image public API
  recovery remain activation gates.
- The rejected-create audit found that unbound journals could indefinitely
  retain cleanup and compute reservations. Migration 0093 adds per-dispatch
  rejection evidence and permanent unallocated closure; historical requests
  with incomplete evidence remain unresolved. This repair needs live deployment
  qualification and cannot be used to infer old resources were erased.
- Full-suite verification exposed two concurrent filesystem cleanup races:
  an upload inode can lose its last link during inspection, and another
  deleter can publish a permanent fence before unlink. Bounded reinspection
  preserves the existing file checks and deletion fence. Deterministic
  regressions cover both races, unsafe replacements and persistent ambiguity;
  the repair still requires deployed qualification.
- Provider DELETE acceptance and a subsequent 404 are not data-erasure evidence.
  Storage and cleanup records remain until a matching terminal receipt exists.

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
