# Phase C/D implementation design: Cloud Computer and admin workspace

Date: 2026-10-04. Author: D-CD. Inspected checkout: cec28a25cc1e.
Status: design proposal for the orchestrator; no implementation or live qualification performed.
Scope: internal staff use on Alpha. This document is the only authored file.

## Executive summary

- Build each immutable computer version from a qualified Zeros base, then retain its sanitized, stopped Boat sandbox as the template.
- Create ordinary and admin workspaces by forking a retained active template. Organization creation allocates nothing.
- Enforce D1 in backend creation admission as well as the UI. The first Build action saves an empty/default configuration and queues its build atomically.
- Store editable configuration, build/version history, template availability, and generation runtime pins separately.
- Repository, environment and install-script edits stay unbuilt until an explicit Build action. Repository setup scripts apply to the next workspace without a build.
- Autoactivation compares the exact accepted configuration, base, build runtime, build request and head revision. Failed, cancelled and superseded builds cannot activate.
- Run installation as VM root, then check the base-owned protected-file contract, sanitize, stop and verify capture completion. Routine builds allocate no verifier VM.
- Selected repositories are organization-shared data. Reuse GitHub's existing one-repository read-token broker with explicit organization sharing grants; retain human-bound Git writes.
- Reuse encrypted, versioned secret bindings, but pin exact versions. Never bake organization values or workspace admissions into a template.
- Preserve the current primary checkout paths, add an admitted secondary-repository root, and include those writable files in durable recovery.
- “Configure with an agent” creates a private, marked workspace billed through the existing VM meter to its creating admin. Its shell receives organization environment values.
- Register five execution-scoped product MCP tools in the engine; every operation rechecks the creating admin in the control plane.
- Ship seven Phase C PRs, then three Phase D PRs. Runtime, provider and UI work join through explicit interfaces below.
- M-A measured roughly 4–5 seconds to a minimal command and 42 seconds to stop; complete v4 build/admission latency remains unqualified.
- Locked decisions in FINAL-02 §8 and current scope in §9 override its earlier cumulative-build, restricted-recipe, named-image, verifier and admin-on-base proposals.

## 1. Evidence and current behavior

Paths below are repository-relative. CP means apps/control-plane/src/cloud-workspaces;
E means apps/desktop/src/engine; R means apps/desktop/src/renderer;
S means scripts/cloud-workspace-validation/sandbox; P means packages/protocol/src;
M means apps/control-plane/migrations. These prefixes also make the exact PR file lists concise.
Line references describe the inspected implementation; proposed interfaces are explicitly labeled.

| Evidence | What exists and its implication |
| --- | --- |
| .context/research/FINAL-02-zeros-cloud-v2-plan.md:397–408, 414–437 | D1/D2/D3/D6/D7/D8/D11/D12 and internal-only scope are authoritative. No billing sponsor, new meters, public API or launch-hardening programme belongs in C/D. |
| CP/computer.ts:21–53, 65–123, 133–209 | Strict recipe: at most 20 repositories, 16 KiB install script, 1–900 second timeout; empty default is legal. Organization locks, member reads/admin writes, profile versions and active/previous pointers are reusable concepts. GET may return virtual revision zero without provisioning. |
| M/0108_cloud_computers.sql:3–37; M/0117_cloud_computer_images.sql:2–64 | Existing computer/profile registry, four-state build table, one-running-build constraint, image IDs and durable allocation attempts. Image schema assumes named snapshots and old attestation identity. |
| CP/computer.ts:213–314, 317–441 | Save is revision/operation-CAS and checks each saving admin's private GitHub proof. Explicit Activate/Rollback and image build/log/cancel services exist. Build admission still checks organization, team, Pro, base qualification and account capacity. |
| CP/computer-image.ts:349–489; CP/computer-image-boat.ts:92–142, 177–296 | Current pipeline: fresh base builder → install → sanitize → named snapshot → separate fresh verifier → exact-image qualifications → succeeded; no automatic activation. The builder receives the script and timeout, but does not clone the selected repositories. |
| CP/computer-image-scripts.ts:7–112, 131–230 | Root launcher runs the recipe as UID/GID 10004 in a read-only-root boundary with only /usr/local/zeros-computer writable; output is discarded. Prefix sanitation deletes .git as well as credentials. This runner/sanitizer cannot implement D3 or repository caching unchanged. |
| CP/computer-image.ts:212–283, 492–625; CP/computer.ts:500–522 | Missing org image currently falls back to the base. Allocation/capture uncertainty and deletion evidence are durable. Legacy worker claims builds without image rows; inserting v2 builds into that table would expose them to the wrong worker. |
| CP/boat-account-admission.ts:122–144 | Shared-account maxBuilders defaults to one; reservations currently release only with computeDeleted, and reserve a named-snapshot slot. A retained stopped template needs a distinct verified-stop completion path. |
| CP/boat-provider.ts:247–339; CP/provider.ts:69–77; CP/boat-client.ts:189–192 | Provider create has durable request identity, attempts and wallet verification, but its source is an imageRef. Wallet header coverage is currently incomplete; Phase A owns that fix. |
| CP/routes.ts:135–149, 1977–2000, 2084–2106, 2210–2297 | Creation requires a GitHub source, rechecks the chosen image after remote resolution, and persists generation/settings/setup specs. Add the template/D1 and org-read paths here; a renderer gate alone is insufficient. |
| CP/github-user-access.ts:229–260; CP/github-credentials.ts:71–115, 165–190; CP/setup-materials.ts:1159–1223 | Source proofs are actor-private. Existing broker issues/revokes one-repository read installation tokens and rechecks authority after minting. Reuse the broker, not another admin's proof or a broad automation credential. |
| S/runtime-layout.json:3–13; S/cloud-engine-launcher.mjs:228–238; S/cloud-engine-view.mjs:68–85 | Primary physical checkout is /srv/zeros/files/workspace, logical checkout /srv/zeros/workspace. The files parent is mounted as /srv/zeros with an explicit child allowlist. Adding sibling clones without changing that allowlist fails admission. |
| S/setup-cloud-workspace.mjs:1738–1822, 1891–1985, 2090–2153 | Existing checkout stages a depth-one fetch, verifies exact HEAD and restores checkpoints. Fenced setup journals prevent completed hooks from rerunning on wake; environment is supplied to the setup hook, not generally to engine/agents. |
| M/0027_cloud_workspace_settings_providers_and_replicas.sql:168–230; CP/settings.ts:94–119, 474–554, 777–923, 948–1008 | General environment secret bindings already exist and use tenant/name/version-bound AES-GCM. Today's resolver reads current_version and applies consented personal settings before org settings; neither behavior implements v2's pinned env and precedence contract. |
| CP/customization-store.ts:9–20, 45–81; CP/mcp-contract.ts:28–52 | Organization/member customization encrypts MCP servers and skills. It is not the generic organization environment store. |
| CP/management-routes.ts:151–185, 285–325; CP/management.ts:1759–1777, 2023–2035, 2214–2235 | Repository cloud settings and secret create/rotate/revoke routes exist; reads expose metadata. Revocation schedules security stops, so “remove from draft” must not call revoke. |
| R/features/settings/cloud-computer-panel.tsx:30–79, 121–179, 264–338, 397–484; R/features/settings/cloud-computer-client.ts:9–70 | Existing keyed cache, mutation fences, local draft preservation and active-only polling are reusable. UX still has Save/Build/Activate, restricted-recipe and per-member repository-access copy, and no real live build-log pane. |
| R/features/settings/internal-features.ts:29–46, 73–95, 163–201; apps/control-plane/src/authz.ts:93–126 | Gate effective renderer surfaces and backend access. Engineering staff means developer/platform_owner; support_admin alone is not sufficient. Reuse Phase A's cloud feature gate. |
| E/agents/session-tools.ts:4–107; E/zeros-engine.ts:1964–1997; E/agents/cloud-provider-execution.ts:46–89 | Execution-scoped product tools, revocation and cloud HTTP MCP already exist. Compose the new factory with DesignCodeToolAdmissions. Cloud product stdio is rejected, and user MCP cannot impersonate a product name. |
| CP/agent-credential-routes.ts:70–104; E/cloud-agent-execution-client.ts:10–62; CP/agent-executions.ts:140–165 | Existing authenticated engine → control-plane execution RPC and actor leases are the right authority path. Current generic error mapping loses 409 detail; add typed computer-tool result errors without weakening authorization failures. |
| docs/ui-interaction-performance.md:188–204, 271–299, 439–456; docs/agent-tool-presentation.md:529–597 | Exact-key retention, request sharing, active-only effects and race tests apply. New tools retain native call identity and normal expandable transcript rows. |
| .context/research/orchestrator/docs-cloud_cloud-computer.md:28–54, 72–74, 99–124; .context/research/FINAL-01-conductor-cloud-reference.md:182–193 | Conductor's five tools, hidden saved values, explicit builds, history activation and independently saved cloud setup scripts define the product reference. Copy behavior, not source or implementation. |

docs/cloud-workspace/organization-setup.md:97–114, 233–236 still describes disposable
validation workspaces rather than the newer named-image implementation. Update that guidance
with C; code and migration 0117 are today's authority.

## 2. Phase B boundary and additive model

### 2.1 Required cross-track interfaces

Phase B owns the runtime registry, v4 base/installer, /zeros facade, admission identity,
runtime qualification and v1–v3 compatibility. C uses those facilities. Its in-progress design
arrived during review: .context/impl/design-b-runtime.md:26–35, 70–150, 204–358. B's explicit
Alpha exception uses authenticated registry/admission digests and complete base-owned
verification, with signing deferred (.context/impl/w1-design-b-prompt.md:34–40). C does not
invent a signing service or reinterpret that as protection against compromised CP/CI/root.

~~~ts
type EnvironmentSource =
  | { kind: "base-snapshot"; baseImageId: string }
  | { kind: "org-template"; templateVersionId: string; baseImageId: string };
type RuntimePin = {
  runtimeId: string; manifestSha256: string; baseImageId: string;
  baseCompatibilityId: string; profile: "zeros-cloud-worker-v4";
  engineProtocolVersion: number;
};
type GenerationPins = { environment: EnvironmentSource; runtime: RuntimePin };
type TemplateAdmission = {
  templateVersionId: string; configId: string; repositoryManifestDigest: string;
  builtRuntime: RuntimePin; protectedContractDigest: string;
  // Provider account, wallet, creator, source sandbox and final snapshot stay server-side.
};
~~~

B exposes: resolve a supported base/runtime tuple; verify/install the exact admitted runtime
through the base-owned installer; validate an environment source before setup; qualify native
agent/MCP capabilities by its explicit v4 contract; and include both pins in generation,
readiness, agent admission and retry hashes. Old exact-image checks remain for v1–v3
(CP/computer-image.ts:161–207; CP/agent-executions.ts:97–125; CP/agent-credentials.ts:425–426).

Map RuntimePin to B's six generation columns and cloud_runtime_bundles/base_images/
base_contracts/qualifications tables, not the legacy agent_runtime_profile columns.
B's explicit fork rule copies the template's runtime/base pin before allocation
(.context/impl/design-b-runtime.md:305–315); follow it for C forks and admin workspaces.
An explicit runtime upgrade can select a newer compatible qualified runtime in a new generation
while retaining the same template environment; it must not revert to B's bare-base allocation
and lose installed org software. Thus runtime updates need no environment rebuild, but publication
alone does not change existing or future forks' source pin. Revoked pins fail closed.
Use B's runtime-only redemption then materials continuation, so download/verification cannot
expire repository/engine credentials (.context/impl/design-b-runtime.md:158–177, 319–343).
C adds a build-only installer admission purpose bound to org/build/fence/base/runtime: archive
read plus verified install receipt, with no workspace-material continuation or engine authority.
Keep the supervisor idle; do not fabricate a workspace/generation to call the existing issuer.

The org head records its desired build base/runtime tuple. Selecting a different desired tuple
increments head revision and fences an in-flight build. Autoactivation matches that tuple,
rather than silently substituting a newer runtime at completion. Global default changes do
not rewrite accepted generations; B revocation/compatibility checks still run at completion.

### 2.2 Storage sketch

Use new v2 tables. Do not weaken 0117's named-snapshot constraints or repurpose its image_ref
values. Lazy first save/build creates the existing computer/profile identity if needed, then
its v2 head. Reading an untouched organization returns defaults without creating rows.

The following is a schema sketch, not executable migration SQL. All public IDs are opaque.
Every relationship includes org_id; immutable configuration rows and accepted pin fields
have update guards. Use forced system-only RLS and least-privilege application grants, as
in the existing customization tables. Raw values, provider credentials and user tokens are
absent from these records.

~~~sql
CREATE TABLE cloud_computer_v2_configs (
  id uuid PRIMARY KEY, org_id uuid NOT NULL,
  install_script text NOT NULL, timeout_seconds integer NOT NULL,
  metadata_digest bytea NOT NULL, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
  -- Existing 16 KiB/900 second limits; digest covers metadata and exact secret refs.
);
CREATE TABLE cloud_computer_v2_heads (
  org_id uuid PRIMARY KEY REFERENCES cloud_computers(org_id),
  revision bigint NOT NULL DEFAULT 0, next_version bigint NOT NULL DEFAULT 1,
  draft_config_id uuid, active_template_id uuid, previous_template_id uuid,
  latest_build_id uuid, desired_base_image_id text, desired_build_runtime_id text,
  enabled_at timestamptz NOT NULL
  -- Deferred same-org FKs to configs/builds/templates below.
);
CREATE TABLE cloud_computer_v2_builds (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, version bigint NOT NULL,
  config_id uuid NOT NULL, accepted_revision bigint NOT NULL,
  base_image_id text NOT NULL, base_compatibility_id text NOT NULL,
  runtime_id text NOT NULL, runtime_manifest_sha256 text NOT NULL,
  repository_manifest jsonb, rebuilt_from_id uuid,
  state text NOT NULL, stage text NOT NULL, worker_fence bigint NOT NULL,
  requested_by uuid NOT NULL, deadline_at timestamptz,
  cancel_requested_at timestamptz, error_code text,
  cleanup_state text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (org_id, version), UNIQUE (id, org_id),
  FOREIGN KEY (config_id, org_id) REFERENCES cloud_computer_v2_configs(id, org_id)
);
CREATE UNIQUE INDEX cloud_computer_v2_one_pending
  ON cloud_computer_v2_builds(org_id) WHERE state IN ('queued', 'running');
CREATE TABLE cloud_computer_templates (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, state text NOT NULL,
  account_scope text NOT NULL, billing_org text NOT NULL, creator_subject text NOT NULL,
  sandbox_id text, stop_snapshot_id text, snapshot_generation bigint,
  protected_contract_digest bytea, content_manifest_digest bytea,
  stopped_at timestamptz, retirement_receipt jsonb,
  UNIQUE (id, org_id), UNIQUE (account_scope, sandbox_id),
  FOREIGN KEY (id, org_id) REFERENCES cloud_computer_v2_builds(id, org_id)
);
CREATE TABLE cloud_computer_environment_refs (
  config_id uuid NOT NULL, org_id uuid NOT NULL, name text NOT NULL,
  binding_id uuid NOT NULL, binding_version bigint NOT NULL,
  PRIMARY KEY (config_id, name),
  FOREIGN KEY (config_id, org_id) REFERENCES cloud_computer_v2_configs(id, org_id),
  FOREIGN KEY (binding_id, binding_version, org_id)
    REFERENCES secret_binding_versions(binding_id, version, org_id)
);
CREATE TABLE cloud_workspace_computer_sources (
  workspace_id uuid NOT NULL, generation integer NOT NULL, org_id uuid NOT NULL,
  template_id uuid NOT NULL, config_id uuid NOT NULL, repository_manifest_digest bytea NOT NULL,
  PRIMARY KEY (workspace_id, generation),
  FOREIGN KEY (workspace_id, generation, org_id)
    REFERENCES cloud_workspace_generations(workspace_id, generation, org_id),
  FOREIGN KEY (template_id, org_id) REFERENCES cloud_computer_templates(id, org_id)
);
~~~

Also add narrowly scoped records in those migrations:

- config_repositories: immutable config → canonical repository ID, ordered display metadata,
  requested ref and organization read-grant revision; limit 20, matching the existing product.
- repository_grants: org/repository/installation, approving admin, current authority revision,
  explicit organization-sharing consent and revocation state. This is read authority only.
- provider_operations: build, worker fence, account, operation, original idempotency key,
  body digest, dispatch times, resource/stop/delete receipts and unresolved outcome.
- build_account_leases: account-scoped v2 builder slots, fence and compute-stop proof.
  Keep this small DB queue independent of the old release/R2 admission ledger.
- mutation_receipts: org/actor/operation ID, private request verifier and bounded result.
  Keep receipts across intervening edits; same key/different request is 409.
- build_logs: build/monotonic sequence, timestamp, stage, stream and redacted bounded text.
  Enforce a 2 MiB retained tail/build, bounded rows and explicit first/last sequence/truncation.
- Source pins held by an accepted fork, generation, rebuilding cache read or retirement claim.
  FK existence alone is not permission to delete; retain explicit lifecycle/cleanup states.
- Phase D adds a computer_admin_workspaces sidecar: workspace/org/computer, immutable creator,
  creation operation ID, granted authority revision and retired_at. No agent-controlled marker.

Reuse repository_settings_versions/heads for setup scripts and secret_binding_versions for
values. Do not create a second environment vault or a second mutable copy of repository scripts.

### 2.3 State and compare-and-swap rules

Build state: queued → running → succeeded | failed | cancelled | superseded.
Running stages: allocating → runtime → repositories → install → integrity → sanitation →
stopping → capture-confirmed. Template state: pending → ready → retiring → retired; failure
quarantines a pending template and queues deletion. Cleanup is independently pending/running/
confirmed/unknown, so a terminal build can still hold capacity.

One build ID identifies one version and, if successful, one template. Version numbers advance
even on failure; configuration IDs are separate immutable revisions. Every new build starts
from the base, including history Rebuild. It never layers another installation on a template.

1. All edits, Build, Cancel, Discard and Activate serialize under the existing org advisory lock
   plus the v2 head row. Network calls stay outside database transactions.
2. Save creates a new immutable configuration and advances head revision only. Repo/env/install
   edits make draft_config_id differ from the active configuration. Log/state updates and
   repository setup-script edits do not advance this build-affecting revision.
3. Build validates expectedRevision and previousBuildId, persists any submitted draft/default,
   reserves a version and exact base/runtime, sets latest_build_id, and writes its replay receipt
   in one transaction. Double-click/lost reply returns the same build. A different newer
   configuration is 409, never a last-writer overwrite.
4. An explicit replacing Build cancels/supersedes the old logical request and queues a new one.
   Physical cleanup holds remain until settled; replacement cannot bypass account capacity.
   A plain draft edit does not start another build.
5. Completion atomically checks head revision, draft config, desired base/runtime, latest build
   ID, worker fence, no cancellation, template integrity/capture and B qualification. Only then
   mark succeeded/ready and swap active/previous. CAS loss is superseded and cleanup; it is not
   a successful activatable historical version.
6. Cancel takes the same lock; whichever of cancellation or successful activation commits first
   wins. Cancellation after success reports already-completed and never pretends to roll back.
7. Activate requires a succeeded, retained, stopped ready template and current B/secret/repository
   authority checks. It atomically changes active/previous and head revision, preserves the draft,
   and invalidates older pending activation intents. It never rewrites a running generation.
8. Discard restores the active configuration (default if never built), advances revision and
   fences older builds. It drops references to unbuilt env edits; it does not revoke secrets.
9. Rebuild of retired history copies its recipe and recorded repository SHAs into a new draft/
   build, chooses a supported current base/runtime, and uses normal CAS. Missing/revoked inputs
   are actionable failures; do not silently substitute repository HEAD or a secret's latest value.

Mixed rollout: install additive tables/guards, deploy B/C-aware readers/workers, then opt staff
orgs in. Drain their old image builds first. An enrolled org rejects legacy computer writes
and legacy build inserts. A deferred generation constraint requires the v2 source sidecar for
new first generations, preventing an old create writer from bypassing D1. Existing accepted
v1–v3 workspaces keep their own wake/recovery path; old versions are never relabeled v4.
Old clients get an update-required error for v2 mutations. New v2 workers never use the legacy
build table, whose “no image row” claim logic would otherwise seize them.

## 3. Boat build pipeline, failure handling and retention

### 3.1 Provider facts and limits

| Contract | Evidence and design consequence |
| --- | --- |
| Fork API | .context/research/r3/openapi-boat.json:7671–7792: POST /sandboxes/{sandboxId}/fork, Idempotency-Key, optional type/ttlSeconds/noEnv/env/environment/failFast, 202 action response. Accept documented top-level or nested new sandbox ID; never confuse it with the source. |
| Immutable source | .context/research/r3/boat-docs/snapshots.md:42, 193–195, 419–424: source must exist; filesystem/environment are inherited; stopped sources are free; deleting the source removes future forkability. Retain source pins conservatively until dependency behavior is qualified. |
| Owner and wallet | .context/research/r3/boat-docs/organizations.md:122–135: fork is creator-only, including within a shared wallet. Create/fork/resume each consume the creator's applicable start quota and the shared wallet pool. All templates and their forks must use the same stable Boat principal, account scope and configured wallet. |
| Header | .context/research/r3/openapi-boat.json:194–220 documents X-Boat-Org and idempotency. Fork's operation omits OrgHeader, but M-A sent it on every call and verified every returned wallet (.context/impl/boat-timings/REPORT.md:11). Keep that verification; negative-principal/mismatch cases remain to qualify. |
| Retry window | Same account/key/body can replay for 24 hours; retain the current 23-hour client safety cutoff. Expiry plus an unknown result means reconciliation, not a new key/allocation. |
| Capture | .context/research/r3/boat-docs/snapshots.md:106–117 and .context/research/r3/boat-docs/api__reference__sandboxes__stop-and-archive-sandbox.md:7–13: final snapshot on stop; refused stop leaves compute running. Never force-stop a template or accept an older periodic snapshot as final. |
| Completion proof | .context/research/r3/openapi-boat.json:9034–9070 exposes latest completed snapshot identity/source/status/generation/times. Require observed stopped source and a completed capture after sanitation, with the final manifest in that exact snapshot. A receipt alone is not readiness. |
| No-source-VM cache reads | .context/research/r3/openapi-boat.json:9294–9341 streams a file or subtree out of a stopped snapshot. Unindexed, legacy, base-only or symlink paths can return 409. Use an optional bounded cache-file read with cold-fetch fallback. |
| Logs | .context/research/r3/openapi-boat.json:8214–8239, 8275–8307 supports streamed commands and detached command log tails. Synchronous commands cap at 600 seconds; a 502 can mean the command is already running. Do not blindly redispatch an install script. |
| Cost | .context/research/r3/boat-docs/snapshots.md:12–20: automatic stopped snapshots are free/no count limit; named snapshots have a separate quota/price. D7 keeps build/storage costs with Zeros and preserves existing workspace VM accounting. |

### 3.2 Ordered build steps

1. Under CAS, accept the build, exact input references, desired base/runtime and requested actor.
   Recheck admin/staff, active repository grants, base/runtime support and encrypted references.
   Organization creation and ordinary Save do not enter this queue.
2. Claim through a fenced, bounded DB account queue, initially one v2 builder/account. Reuse
   the existing durable-uncertainty pattern, not the legacy R2 release-admission dependency.
   B's fresh canary lane stays independent; provider limits/backoff arbitrate shared starts.
   Show Queued separately from Running. No new billing policy or launch-scale scheduler.
3. Persist create intent/attempt before I/O. Create a fresh sandbox from the exact Zeros base
   named snapshot with noEnv:true, env:{}, explicit wallet and renewable finite TTL (1800 seconds
   initially). Templates never start from another org version's filesystem.
4. Validate account/creator/wallet/resource identity and await actual boot readiness. Use
   Phase A's >60-second request handling and boat_starting policy, without polling indefinitely.
5. Invoke a fixed base-owned builder helper with structured, bounded inputs. Install/verify the
   pinned B runtime cache. Record the protected-file baseline externally before running user code.
   Never launch an ordinary workspace engine or give the builder agent/model/owner credentials.
6. Resolve and freeze selected repository SHAs. Seed Git objects from an eligible previous
   stopped version when available; fresh-fetch missing objects with scoped org read tokens.
   Recheck the granting authority after minting. Materialize all selected worktrees, then revoke
   clone grants and remove credential helpers before installation.
7. Run the bounded install script as VM root, Bash strict mode, in the documented repository
   parent. A durable local start marker/build fence makes a repeated start an inspection, not
   another execution. Package installation is allowed; isolated agent policy is unchanged.
   Document /usr/local/bin and shared cache paths; root's dotfiles are not agent homes.
8. Drain the script process group/cgroup and build-created writers. On nonzero exit, deadline,
   cancellation or lost authority, fence publication immediately and enter cleanup. Capture
   redacted logs even on failure.
9. Check protected files and the exact repository manifest, run B's credential-free local
   bootstrap/isolation smoke, then sanitize. Runtime/provider qualification comes from B's
   approved v4 evidence; do not fabricate a v3 exact-image qualification row.
10. Write a bounded final template manifest identifying config/base/runtime/repo SHAs/TCB digest.
    Scrub build transport tokens, remote auth, credential homes, setup/admission/registration
    files, keys, engine/session state, epochs, logs, journals and /zeros aliases' private targets.
    Preserve only repository data, approved install outputs and verified runtime/cache assets.
    Normalize writable repo trees to workspace UID/GID 10001 without changing protected runtime
    ownership; validate object metadata and reject unsafe links/special files before traversal.
11. Flush and request graceful stop. Persist the stop receipt. Poll for both stopped compute
    and an exact completed final snapshot whose manifest matches sanitation. A timeout stays
    unresolved; neither a 404 nor “stop accepted” proves completion.
    M-A observed archived with snapshotAvailable=true, not a literal stopped state; normalize
    that documented observed state while still requiring the exact final-capture proof.
12. Under the completion CAS, publish ready/succeeded and active/previous together. Release
    the v2 running-builder lease with positive stop/capture proof, retaining the template's
    provenance/storage record. Never fake deletion or modify the legacy release ledger.
    Retention then runs separately. There is no routine verifier create/fork/resume.

For failed/cancelled builds, verified stopped compute can also release the running slot while
physical deletion remains pending. Prefer stop/confirm before deletion. A bare 404 or unknown
dispatch cannot release a slot. Keep deletion receipts until byte-erasure confirmation.

After ready, the source is immutable by policy: no command, resume, environment update,
template-local Git fetch or TTL wake is allowed. Activation is a metadata operation. A drifted,
missing or unexpectedly running source is quarantined; refuse new forks and show Rebuild.

### 3.3 Protected-file contract and logs

The base-owned contract must cover /opt/zeros-bootstrap, /opt/zeros-infra/<runtimeId>, /zeros
and /opt/zeros facade/pointer targets, any retained /opt/zeros-runtime compatibility paths,
/etc/zeros, Zeros units and all their override/drop-in
search paths, tmpfiles aliases, UID/GID and sudoers policy, namespace/seccomp/AppArmor helpers,
Git/privilege brokers, and the executables/loaders/libraries used to verify and launch them.
Record content hashes, ownership, modes, link targets, file capabilities and allowed directory
entries; detect added override files, writable ancestry, hardlink/symlink substitutions and
capability/setuid changes. Validate UID mappings and current runtime isolation as well as bytes.

The trusted baseline is pinned by B's registry/admission and its digest is held by the control plane;
a script-edited manifest is not its own authority. Apply permitted generated-metadata exclusions
explicitly. Do not compare the entire package inventory: package installation is the feature.
Changing a protected dependency means update the Zeros base/runtime, then rebuild. Keep the
legacy restricted prefix runner for its historical path only.

This catches accidents and obvious tampering; a trusted root admin can subvert an in-VM
checker or persist data deliberately. D3 explicitly accepts that boundary. No claim is made
that this protects against a malicious root administrator. Future supply-chain review is deferred.

Replace discarded output with a bounded helper-owned stdout/stderr spool and monotonic chunk
IDs. The helper runs detached under its own timeout (up to the existing 900-second recipe limit);
short status/log requests reconnect by offset. Use the provider stream only as transport,
not as the durable build journal. A lost command reply first inspects the helper's build marker.
Reuse setup-log redaction and the streaming literal filter, including split-chunk boundaries;
redact before returning output through Boat and before CP persistence. Bound line length,
control/ANSI escapes and total retained bytes. Logs are org-private data, never analytics.
Known-value redaction cannot guarantee removal of deliberately encoded/exfiltrated secrets.

Persist redacted sequence chunks and stage/error codes. UI reads from a cursor with an
explicit truncation marker; GetComputerBuildStatus returns at most the last 200 lines.
The Alpha transport can use active-only 1-second cursor polling (backoff when idle); authenticated
fetch streaming can use the same cursor later. No WebSocket service or new dependency is needed.
Setup logs use the same bounded/redacted contract but remain generation/setup-run scoped.
Use B's closed component/stage/exitCode/timedOut/failedChecks diagnostics for infrastructure
failures (.context/impl/design-b-runtime.md:183–187). Private recipe logs are a separate stream;
raw script output, exception text or paths must not enter CI diagnostics.

### 3.4 Timing, failure and retention policy

M-A's independent Alpha measurements arrived during review
(.context/impl/boat-timings/REPORT.md:9–60, 82–113, 115–130). They used a 6.47 GiB
existing base reporting workerQualified=false, not a qualified v4 build. Samples are too small
for p95/SLO claims; one-second polling also limits timing precision.

| Stage/fixture | Observed M-A evidence | Proposed initial target/deadline |
| --- | --- | --- |
| Base create → first minimal command | n=3, median 4.393 seconds, range 4.142–5.566 | Within 10 seconds when capacity exists; 300-second phase/90-second HTTP deadline. |
| Stopped-template fork → minimal command | Serial 3.918 seconds; concurrent n=3, 3.944–5.208 | Within 10 seconds for this fixture; 300-second phase/90-second HTTP deadline. |
| Stop → archived snapshot available | n=2, 41.905–43.263 seconds | Budget 45–60 seconds; 180-second phase deadline, then reconcile. |
| Runtime read/checksum | One 2.50 GiB tree: 11.608 seconds cold, 2.198 warm | Include full inventory verification; not a v4 installer measurement. |
| Runtime delivery/install | Small public archives only; inferred 1 GiB gzip download/hash/extract sum 30.7 seconds | Actual v4 install target 45–90 seconds, 600-second budget within fenced setup. |
| Empty complete computer build | Not measured; stop alone rules out a credible sub-30-second promise | Initial planning target 75 seconds with verified preseed, 90–120 cold; qualify real v4 before setting acceptance SLO. |
| Usable workspace / repositories / scripts | Not measured | Target 25 seconds for a small cached/preseeded workspace, excluding user hooks; report all stages/bytes and remeasure. |

Older large-image evidence is much slower (.context/research/r3-boat-platform.md:295–297).
Keep custom installation separately bounded at 900 seconds; never hide saving, skip hydration/
verification or claim these targets passed from a fast provider acknowledgement.

Do not start the build deadline while it is queued. Bound running work (initially existing
30-minute total, 900-second script), renew TTL with margin and reconcile a deadline hit.
Preserve separate handling for certified pre-allocation capacity rejection, an unknown create,
known-script failure, failed integrity, failed stop, expired authority and failed cleanup.
An unknown earlier dispatch is never erased by a later certified rejection.

Retention is an idempotent worker over ready template records: keep active, previous, the newest
10 successful retained versions, every accepted/in-flight fork and every live/recoverable
generation's source (including stopped/archived), plus any temporary cache-read pin. Failed
build history stays as metadata; its failed resources are cleaned up. Use source retention
until full child lifecycle independence has been qualified. M-A's four running forks retained
their marker after source DELETE/404, but neither later wake/recovery nor completed physical
purge was proven (.context/impl/boat-timings/REPORT.md:82, 140–154).

Claim retirement under the same org/template lock used by Activate and source-pin creation.
Recheck references immediately before deletion; once retiring, neither Activate nor a new fork
may acquire it. Bind exact account/resource/deletion receipt, and mark retired only with provider
deletion evidence. An unresolved deletion is never shown as successfully reclaimed.
Retain immutable config, repo SHAs, build/log summary and provenance for Rebuild. Retain referenced
secret versions under the existing encrypted key-retention policy; security revocation overrides
historical rebuildability. Protect Zeros base references through B's registry. Named-snapshot
release artifacts retain their own existing policy; stopped templates do not occupy that quota.

## 4. Repository, environment and workspace admission

### 4.1 Repository authority, cache and paths

Adding a repository deliberately grants all organization members access to its cached contents
(D11); show that fact beside the selector. Validate the adding admin's own current source proof,
then persist a separate org read grant for the immutable GitHub repository/installation.
Grant validation includes installation selection/suspension, org membership/role and the linked
connection's authority revision. Losing the approving connection suspends future fetch/build
authority until an eligible admin reauthorizes it; do not borrow another member's private proof.
Previously shared bytes cannot be recalled from an existing workspace.

The CP GitHub App broker issues one-repository contents:read tokens for build/initialization,
never a blanket installation token, personal access token or automation bot credential.
Keep token material in the existing private setup-style transport and bounded helper memory/
tmpfs; no credential-bearing command strings, remote URLs, persisted provider env or Git config.
The org grant intentionally authorizes cached/source reads by a member without personal GitHub
access. It does not authorize pushes, PRs, user impersonation or agent-provider credentials.

For Alpha use a shallow, fully materialized default/requested commit (existing depth-one behavior),
not a blobless checkout whose future reads would need a member's missing GitHub access.
Disable hooks, LFS/filter execution and automatic submodule traversal during trusted preparation;
materialize required LFS contents only through a scoped read path. Explicitly reject unsupported
cross-repository submodule/LFS authority rather than saving credential-dependent placeholder
content. More history may be fetched through an authorized read operation; no implicit promisors.

Cache only sanitized Git objects, shallow boundaries and pinned refs, with a versioned manifest.
Recreate configuration/remotes/hooks from trusted metadata. Prefer a single bounded cache
archive per repo stored in the stopped template, retrieved by the snapshot-file API through
a private CP stream; no extra resumed cache VM and no new R2 cache service. Reject escaping
archive paths, links, device files, credentials, unbounded entries/bytes and invalid object
hashes; run Git object/connectivity checks. Record its digest/size before installation and
verify it afterward. Cache failure falls back to a fresh scoped fetch, never stale OS state.
If that provider API is not qualified, cold clone is safe but the cache acceptance item remains open.

Proposed v4 data layout: physical /srv/zeros/files/repos/<canonical-repository-uuid>,
logical /srv/zeros/repos/<uuid>, with a manifest mapping names to these stable paths.
Build installation sees the same logical paths through a transient base-owned mount namespace, preserving
absolute paths in dependency caches. A primary-repository bind projects the selected clone at
the existing physical /srv/zeros/files/workspace and logical /srv/zeros/workspace; do not move
an installed checkout and silently break virtualenv/shebang paths. Do not invent a /zeros/workspace
alias: B's facade retains /srv/zeros/workspace as the logical cwd. Root-owned empty mount points
and the admitted manifest define the projection, not
repository symlinks. Recreate mounts after each boot; never rely on a captured live mount.

Extend the engine projection allowlist, namespace/native workload roots and Files policy to
exact admitted repo roots; never allow arbitrary /srv/zeros access. Keep engine state and
credential homes excluded. The primary remains the owner of Changes/PR/workspace identity;
other repos appear as associated Files roots and shell paths, not separate managed workspaces.
Managed Git/PRs retain the per-actor broker. A secondary native write must have exact-repository
human authorization; if the broker cannot scope it, fail closed and use a workspace with that
repo as primary. No org build/read token becomes ambient write authority.

Capture writable secondary worktrees and their Git recovery data in a versioned v4 checkpoint
extension keyed by repository ID; do not duplicate the primary bind. Existing primary/native
history formats remain readable. Today's native artifact capture has a single repository root
(E/agents/containment/cloud-checkpoint-artifacts.mjs:55–70, 429–502); source-template retention
alone cannot recover unpushed secondary edits after allocation loss.

### 4.2 Environment and per-repository setup

All organization values, even “non-secret” entries, use the existing encrypted secret store and
are hidden after save. The v2 draft endpoint appends an immutable binding version and stores
exact (bindingId, version, name) refs. Use a private keyed verifier for replay comparison;
never put a hash of low-entropy plaintext values in public config/audit.
Do not call generic rotate/revoke for ordinary draft edits. The old current_version pointer
is compatibility metadata, not what an active v2 workspace resolves.

Generation setup pins active-config org refs. A new draft value/removal, failed build or
Discard cannot alter them. At runtime resolve only still-authorized referenced versions.
Emergency revoke uses the existing security-stop path immediately; activating history with
revoked material fails and offers editing/rebuilding, rather than restoring revoked secrets.

For v2 environment keys only, define precedence:
built-ins → active computer org values → repository shared/cloud values → explicitly consented
personal values → reserved/managed runtime keys. Repository and personal therefore both beat
org values; personal wins their direct collision. Preserve the old resolver for older generations
and do not reorder unrelated settings, MCP or skills. Keep CP/settings.ts:94–119's bans and
reject ZEROS_*, including ZEROS_INTERNAL_* and ZEROS_GIT_AUTH_*, plus execution-injection names.
Do not create a generic ambient override for model-provider credentials or internal tool tokens.

Deliver values from encrypted storage after verified boot through fenced private setup transport; never in
Boat create/fork env, a template, shell argv or managed-settings plaintext. Setup gets its
creating actor's permitted overlay in the hook process. Agents and terminals get a fresh
actor-specific projection at their own admission; never install one member's personal values
in the shared engine environment. Reuse execution-scoped redaction/history encryption for
known env literals as well as MCP secrets. Existing terminals keep their admitted environment
until restart; revocation retires authority promptly. Organization/secret edits do not silently
hot-update existing generation pins.

Interpretation of approved §3.4: routine builds get no organization environment secret values.
Repository clone tokens are the explicit transient exception in the build pipeline. Values
are injected into ordinary/admin workspaces at boot/setup/turn. Private package installation
needing org secrets during a build is an unresolved scope decision, not an assumed capability
or a promise that arbitrary root scripts cannot persist secrets.

Store a repo's cloud setup script in its existing repository cloud settings version.
The narrow update endpoint replaces only setupCommands, preserves unrelated values and uses
expectedSettingsVersion. Empty script disables it; no fallback to local TOML/JSON scripts.
Snapshot the current script version when a new workspace is accepted; it does not affect
computer configuration/build CAS. Run the primary repo's script once, as the workspace UID,
after checkout with its effective env. Do not automatically run every secondary repo's hook.
Existing journals prevent wake from rerunning it. A failed/reclaimed in-progress hook may
need an explicit Retry; record its uncertain/failed state rather than promising exactly-once
arbitrary shell execution. Show stage, bounded redacted log and retry/recreate actions.
Never publish Ready or start the agent until the hook and post-hook Git boundary checks pass.

### 4.3 Create and wake sequence, including D1

1. Renderer warms exact user/org computer and create-options state. “Not built” disables Create
   with “Build your Cloud Computer”; admins can navigate to Settings, members ask an admin.
2. Backend reauthorizes staff, org/team membership, normal entitlement/funding and the source
   selection. Under the org lock, require an active successful ready template and B support.
   Return 409 cloud_computer_build_required before allocation if absent. No shared-base fallback
   for new v2 ordinary or admin workspaces. Only B's DB-bound Alpha qualification-run exception
   may use a bare base through its designated APIs; no request flag/admin role can self-exempt.
3. Ordinary primary selection comes from the active version's repo list, not a member-only
   GitHub catalog. Org reads resolve branch/SHA for a member without personal GitHub access.
   Unbuilt new/removed repos do not alter that list. Adding a new primary requires Build first.
4. Atomically accept workspace ID/owner/billing epoch, generation environment+runtime pins,
   copied source RuntimePin, active config/repo manifest, current setup script/env snapshots,
   source-retention pin and
   lifecycle request digest. Recheck the active version after any external repository lookup;
   reject a changed version rather than mixing old template and new settings. Replay uses the
   already-accepted tuple even if a newer computer has since activated.
5. Persist a fork operation using the generation's normal allocation journal. POST the exact
   source sandbox fork with noEnv:true, env:{}, finite ttlSeconds and explicit wallet/account.
   Preserve the returned allocation ID before interpreting ancillary fields; verify wallet,
   creator scope and source/version identity. Respect capacity/uncertainty rules above.
6. Boot the fork through B's base-owned installer. Verify template manifest/TCB, install or
   validate the source-pinned runtime, create fresh boot/admission/engine identities, and
   only then redeem setup material. Copied stale admissions or image-ready markers have no force.
7. Prepare primary bind and fetch/checkout the requested branch/SHA from its cached clone.
   Verify origin/repository ID, Git-dir containment and exact HEAD. Reconstitute trusted read
   helpers, then revoke initialization credentials. Preserve all other selected clones at their
   build SHAs. Restore a recovery checkpoint instead of resetting existing user files.
8. Resolve/decrypt fenced environment for the setup process, run the pinned primary hook,
   revalidate checkout, launch engine, prove readiness, then admit client/agents/terminals.
   D1 does not let a template fork bypass any of these checks.
9. Wake uses the same generation/source/runtime and journal. Refresh short-lived credentials/
   leases and actor env, skip completed hooks, and retain the existing 10-minute idle behavior
   (docs/cloud-workspace/organization-setup.md:208–225). A computer activation never rebases,
   updates or rebuilds an existing workspace.
10. Explicit runtime upgrade retains this environment/template/base source in its replacement
    generation, selects a later B-compatible runtime and restores the checkpoint. Update both
    normal and automatic recovery paths; B's original bare-base branch must not erase org installs.

## 5. Staff APIs and desktop settings

These are internal application routes, not the deferred public /v0 API. Define
CC = /v1/organizations/:organization/cloud-computer/v2. Additive routing avoids making an old
strict client interpret a new template as an old named image. Standard authenticated account
transport, no-store, strict schemas, byte limits and bounded rate limits apply.
Read means current engineering staff + current org membership; Manage adds owner/admin.
Writes derive actor from authentication, never a body userId. Provider IDs/receipts stay private.

| Method/path | Input | Output and authority |
| --- | --- | --- |
| GET CC | Optional bounded history cursor | Atomic revision, configured/state, draft metadata, active/previous version, build progress, history, canManage; Read. Env names/set state only. |
| PUT CC/draft | expectedRevision, operationId, repositories with own-source proofs for additions, installScript/timeout, explicit env preserve/set/remove operations | revision, configId, dirty state; Manage. Encrypt values immediately; no build. Omitted secret fields preserve exact refs. |
| POST CC/discard | expectedRevision, operationId | New head/draft matching active/default; Manage. No revocation. |
| POST CC/builds | expectedRevision, previousBuildId (nullable), operationId, optional current draft patch/default | 202 buildId/version/revision/stage; Manage. Atomic save-and-build, including first default; explicit replacement uses both guards. |
| GET CC/builds/:build | None | Version, stage, state, failure, first/last log cursor, timestamps, activation result; Read, same org. |
| GET CC/builds/:build/log | after sequence, bounded limit | Redacted entries, next/first cursor, truncation/completion; Read. Separate polling rate budget, reauthorize each read. |
| POST CC/builds/:build/cancel | operationId | cancellation accepted/already terminal, cleanup status; Manage. No optimistic fake success. |
| POST CC/versions/:version/activate | expectedRevision, operationId | New head with active/previous; Manage. 409 retired/revoked/changed; no provider boot. |
| POST CC/versions/:version/rebuild | expectedRevision, previousBuildId, operationId | 202 new version/build and rebuiltFrom; Manage. Historical exact inputs, current supported base/runtime. |
| PUT CC/repositories/:repository/setup | expectedSettingsVersion, operationId, script, timeoutSeconds | New repository settings version; Manage. Narrow update, no computer rebuild. |
| POST CC/admin-workspaces | expectedActiveVersion, operationId | Workspace/lifecycle intent, admin purpose and creating owner, reused flag; Manage, normal VM admission and D1. Phase D only. |
| POST /internal/v2/cloud-workspaces/engine/agent-execution | Existing engine scope, kind=computer-tool, execution lease, one typed tool request | Typed bounded tool result or safe conflict/error; authenticated current engine + creator's live admin lease, never account-cookie fallback. |

General request cap may be 256 KiB with stricter existing script limits; metadata-only errors
never echo secret input. Configuration idempotency verification must cover secret-bearing
changes privately. Domain 409 responses include only current revision/latestBuildId and a
refresh hint. Do not reuse the execution route's generic 403 mapping for an authorized CAS
conflict; unauthorized/mismatched engine scopes retain non-disclosing failures.

Reuse cloud-computer-panel/client, settings-page and their shared primitives. Gate every new
surface, route entry, prefetch and shortcut with Phase A's useInternalFeatureActive gate;
backend staff checks remain authoritative even for a hidden/disabled renderer.

| Settings state/control | Behavior |
| --- | --- |
| Not built | “Not built yet — Build computer.” One click saves default/current input and builds. No hidden provisioning. Configure with an agent stays disabled until that first success. |
| Building | Keep active vN visible if it exists; show queued/running stage, live bounded logs and Cancel. New ordinary workspaces can still use that active version. |
| Active | Show active version, build time and primary Build/Configure actions. No per-build manual Activate step on the happy path. |
| Unbuilt changes | Durable draft plus local editor buffer; show Discard / Build computer immediately. Changes never schedule an automatic build. Serialize draft writes; Build includes the current unsaved delta atomically. |
| Repositories | Current draft selection with org-sharing explanation; immutable IDs, bounded list and explicit unbuilt indicators. Active repo list drives creation until a successful build. |
| Environment | Name rows, set/hidden value marker, replace/remove controls; clear plaintext editor state after accepted save or scope change. Never hydrate saved values into the renderer. |
| Install software | Existing editor and validation, privileged-build/protected-files explanation, bounded timeout. Remove obsolete restricted-prefix-only copy. |
| Repo setup | Per-repo cloud script editor and independent saved version; label “Applies to new workspaces; no build needed.” Conflict preserves the buffer. |
| History | Stable version rows and stage/log details. Ready retained successes offer Activate; retired history offers Rebuild. Pending, failed, cancelled and superseded records never offer Activate. |
| Failed | Keep last active computer usable and draft intact. Show precise safe stage/failure and Retry Build; do not clear useful history/logs during revalidation. |

Cache by account/org and account/org/build, share concurrent reads, retain the last confirmed
exact-key value, and fence late responses by account epoch and mutation revision. Keep bounded
history/log buffers and stable row references. Warm Settings and creation options on pointer/
focus intent; publish navigation with the destination owner synchronously. Hidden settings/log
panes are inert and stop polling, focus, measurements and hotkeys. CAS conflict never overwrites
another admin's changes or silently resets local typing. Sign-out/role loss clears secret editors.
Use primary/secondary associated file roots without changing the primary Changes badge semantics.

Update both dispatcher creation and Open GitHub Project entry points:
R/shell/dispatcher/cloud-create.ts:110; R/shell/dispatcher/dispatcher-modal.tsx:268;
R/shell/dialogs/open-github-project.tsx:133–142; R/platform/cloud-workspaces.ts:276–324.
Remove the unconditional actor-GitHub proof probe only for the explicit active org-shared source
variant; preserve it for legacy/non-shared sources. Local creation remains separate.

## 6. Phase D: marked admin workspace and five tools

Creation uses the same template fork, v4 runtime, org env injection, engine admission, idle
lifecycle and VM accounting as an ordinary workspace. Set creator=owner=assignee/billing owner
to the authenticated creating admin, sharing_mode=private, and insert the admin sidecar in the
same transaction as its generation. Do not accept a client-supplied admin flag, use a build VM
as an admin session, or extend ownership-transfer/billing work. Reopen may reuse only that
creator's matching admitted workspace; testing a newly active version requires an explicit new
admin-workspace request. An existing admin VM is never upgraded by an unrelated build.

D1 interpretation is explicit: the older first-admin-on-shared-base suggestion in
FINAL-02:196–198 is superseded by locked D1. Build the empty/default computer first.
For an empty repo list, add a v4 setup-source discriminant for an internal scratch repository.
Preserve existing NOT NULL repository columns via a reserved canonical forge=zeros-internal,
repo identity scoped to org/computer, no remote URL/GitHub installation, and an initialized
scratch .git. Mark it through the server-owned admin sidecar; it is never a selectable GitHub
repo and never passes the GitHub mint/write path. The old setup source remains unchanged.
Existing constraints permit a non-GitHub canonical forge (M/0026_cloud_workspace_identity_and_entitlements.sql:113–146);
the current route and redemption contract do not (CP/routes.ts:141–149; CP/setup-materials.ts:184–191).
Test empty scratch through readiness/native agent canaries, catalog hiding and recovery.

Use an execution-scoped in-engine HTTP MCP server registered as the reserved product name
cloud-computer. Compose its factory with existing Design/workspace tools; do not replace those
tools or globally register admin tools. Reuse MCP header materialization and native adapter
plumbing; no stdio product server, hosted public MCP, OAuth ceremony or new dependency.
Expose a computerToolsVersion capability only after qualified v4 execution admission.
Unknown/older runtimes fail with an update-required message, not a weaker fallback.
An older active computer may need an explicit C5 runtime upgrade for the admin workspace before
tools can start; expose that action and test it without forcing an environment rebuild.

Each call travels over the existing authenticated engine execution RPC. CP independently checks
current org, staff flag/role, admin role, marked workspace, immutable creating admin, current
generation/setup fence/engine, live initiating execution lease and authority revision. Resolve
actor from that lease and require it to equal the creator; another workspace collaborator or
another admin does not inherit the capability. Recheck on every read and write and revoke on
role removal, workspace retirement, lease loss or Stop/disposal. A body organization/actor,
filesystem marker, prompt, tool name or copied shell environment never establishes authority.

| Tool | Arguments/result and permitted operation |
| --- | --- |
| ListComputers | No cross-org selector. Return the bound org's computer identity, state, active/draft/build IDs and capability flags; at most this one computer. |
| GetComputerConfiguration | Bound computer ID; return install script, repo metadata, setup scripts, revision/latestBuildId and env names/set markers. No saved values or credential material. |
| CreateComputerConfiguration | installScript, optional bounded timeout, expectedRevision, previousBuildId; engine supplies stable operation ID tied to native tool call. Carry current repos/env refs unchanged; atomically save and explicitly start/replaces build. Return new revision/buildId/version. |
| GetComputerBuildStatus | Same-org build ID; return stage/state/error/activation plus last 200 redacted log lines and cursor. No provider admin IDs or access URLs. |
| UpdateRepositorySetupScript | Selected repository ID, expectedSettingsVersion, script/timeout; atomically replace only that repo's cloud setup commands. Return version; no build. |

Both previousBuildId and expectedRevision are required for configuration writes: an admin can
edit repos/env without starting a build, so previousBuildId alone does not detect the conflict.
Return 409 and require refresh/review of new inputs; do not silently retry against the new head.
A replayed native call returns its original operation receipt. Agent Stop retires tool authority;
a build already accepted as a durable explicit action keeps its own normal cancellation policy.

There are no tools/accepted extra fields for repositories, environment values, members,
credentials, old-version activation or arbitrary control-plane requests. The initial context
says the workspace can edit computer settings and should not edit repository code unless asked.
D12 means its ordinary shell can read injected org secrets. Restricting the five tools protects
control-plane mutations, not secrets from a shell already authorized to use them. Reuse
execution transcript redaction; no extra per-tool confirmation flow is part of this product.

## 7. PR sequence (seven C, then three D)

Sizes describe review/implementation breadth: S small, M moderate, L spans multiple boundaries.
All files listed with the prefixes from §1 are exact proposed paths; “new” means not present
at the inspected commit. Migration paths below provisionally use 0128/0129; the latest inspected
migration is 0123 and B now proposes 0124/0125 (.context/impl/design-b-runtime.md:520–533).
The orchestrator must allocate final contiguous numbers across tracks; never overwrite a slot.

Every PR runs the repository baseline: pnpm typecheck, pnpm lint, pnpm check:ui,
pnpm test:git, pnpm check:secrets. Run adjacent Vitest suites after each meaningful edit.
The additional check groups below are required wherever named:
CP = pnpm test:control-plane and pnpm --dir apps/control-plane typecheck;
DB = pnpm check:control-plane-migrations and pnpm check:migration-phases;
Runtime = pnpm check:runtime-pins and pnpm check:licenses;
Wire = pnpm check:protocol; UI = pnpm build:ui and pnpm test:ui-smoke.
Linux/VM runtime qualification is additional to those checks; pnpm smoke:engine belongs on macOS.
No new npm dependency is proposed. Any bug fix starts with its failing regression.

Live steps below are future Alpha qualification, not actions performed for this report. Use
zeros-v2-test- names where supported, record automatically assigned IDs, and prove cleanup.
Keep real values out of logs/reports. B's authenticated digest verification and provider qualification remain mandatory.

### C1 — Add versioned computer configuration and fenced build requests

Branch: cloud-v2/c1-versioned-computer-model. Size: M. Depends: Phase A gate; B pin identity contract.

- Files: M/0128_cloud_computer_v2.sql (new, proposed number); CP/computer-v2.ts, CP/computer-v2-contract.ts, CP/computer-v2-routes.ts (new); CP/computer.ts, CP/routes.ts; P/cloud-computer.ts (new), packages/protocol/package.json.
- Interface: §2 immutable config/version/source-pin/receipt records and §5 typed staff API; B registry types enter through an adapter, not duplicated image/runtime identity. Keep v2 allocation disabled until C5.
- Tests: CP/computer-v2.integration.test.ts and CP/computer-v2-routes.test.ts (new); extend CP/computer.integration.test.ts. First fail save/build replay, simultaneous admins, same build/different config, default-build atomicity, org/role isolation, stale/cancel CAS and old-worker/mixed-writer rejection.
- Checks: baseline + CP + DB + Wire. Live: Alpha staff test-org metadata save/read/conflict/replay; verify no provider allocation on org creation or draft save.
- Parallelism: C2 and C4 may start after the schema/API contract lands; UI mocks may be prepared independently. Coordinate shared computer-v2 service ownership.

### C2 — Authorize organization repository sharing and cache clean Git seeds

Branch: cloud-v2/c2-shared-repository-seeds. Size: L. Depends: C1; B v4 layout/installer and A snapshot-file client contract.

- Files: CP/computer-repositories.ts, CP/computer-repository-cache.ts (new); CP/github-credentials.ts, CP/github-user-access.ts; S/prepare-computer-repositories.mjs (new), S/cloud-engine-view.mjs, S/cloud-engine-launcher.mjs; CP/computer-v2.ts.
- Interface: org read grants, RepoManifest v1 and bounded Git-object cache archive; stable logical repo roots and build view from §4.1. Export trusted checkout inputs for C3/C5; no per-human write-policy change.
- Tests: CP/computer-repositories.integration.test.ts, CP/computer-repository-cache.test.ts (new); adjacent github-credentials/user-access suites; S helper coverage from CP/computer-repository-scripts.test.ts (new). Fail other-admin proof reuse, revoked installation, token persistence, archive escape, duplicate repo IDs, bad object digest and removed-repo carryover.
- Checks: baseline + CP + Runtime; B layout/containment suites. Live: build two fixture repos, compare cold/warm exact SHAs, revoke the fetch token, read all materialized files without member GitHub grants, and verify snapshot-file cache fallback/cleanup.
- Parallelism: can run beside C4; C3 consumes its helper contract. B owns changes to protected manifest generation.

### C3 — Build privileged stopped templates with logs and automatic activation

Branch: cloud-v2/c3-privileged-template-builds. Size: L. Depends: C1/C2, A lifecycle fixes/timings, qualified B base/runtime.

- Files: CP/computer-template-worker.ts, CP/computer-template-boat.ts, CP/computer-template-logs.ts, CP/computer-template-capacity.ts (new); S/build-cloud-computer.mjs (new, base-packaged); CP/boat-client.ts, CP/computer-v2.ts, CP/computer-v2-routes.ts; apps/control-plane/src/index.ts.
- Interface: B build-only installer admission; fixed builder protocol, stage/log cursors, TCB/sanitation manifest, DB compute-slot release and ready TemplateAdmission. Call C1 CAS; keep legacy image/release ledger separate.
- Tests: CP/computer-template-worker.integration.test.ts, CP/computer-template-boat.test.ts, CP/computer-template-logs.test.ts, CP/computer-template-sanitation.test.ts (new); existing computer-image suites. Fail root install restrictions, edited protected file/drop-in/sudoers, stale baseline, secret artifacts, split log tokens, crash replay, lost command response, late stop/cancel, missing final manifest and premature slot release.
- Checks: baseline + CP + Runtime; B registry/base packaging/TCB checks. Live: empty build and package-install build, deliberate protected-file failure, cancellation/restart, verified sanitized stopped template and automatic activation; count exactly one builder and zero routine verifiers, then delete fixtures with evidence.
- Parallelism: C6 history/retention may start once template publication and reference contracts stabilize. Changes to A's Boat client must build on its landed fixes.

### C4 — Pin organization environment and independently version repository setup

Branch: cloud-v2/c4-environment-and-setup. Size: L. Depends: C1; B fenced setup/agent/terminal material contract.

- Files: CP/settings.ts, CP/setup-materials.ts, CP/management.ts, CP/computer-v2.ts, CP/computer-v2-routes.ts, CP/agent-executions.ts; P/cloud-agent-execution.ts; E/agents/cloud-agent-lease.ts, E/agents/containment/cloud-native-boundary.ts, E/agents/cloud-provider-execution.ts, E/pty/service.ts; S/setup-cloud-workspace.mjs.
- Interface: exact encrypted env refs and actor-scoped projection at setup/turn/terminal admission; narrow CAS repo setup update; qualified v4 capability only. Reuse existing encrypted secret/history services and secret-revocation behavior.
- Tests: extend CP/settings.test.ts, CP/management.integration.test.ts, CP/setup-materials.integration.test.ts, CP/agent-executions.integration.test.ts and E/agents/__tests__/cloud-agent-lease.test.ts; add CP/computer-environment.integration.test.ts. Fail unbuilt/current-version leakage, personal/org collision, reserved names, ordinary delete-as-revoke, another actor's overlay, rotated literal replay and wake rerunning a completed hook.
- Checks: baseline + CP + Runtime + Wire; adjacent PTY/containment tests. Live: set org/repo/personal canaries, prove precedence by masked equality assertions, edit without Build, then build and create a fresh workspace; verify old generation unchanged and setup-only edit needs no build.
- Parallelism: independent of C2/C3's provider work, but serialize edits to computer-v2 and setup material interfaces with C5.

### C5 — Fork active templates and enforce workspace creation admission

Branch: cloud-v2/c5-template-workspace-forks. Size: L. Depends: C2/C3/C4 and B generation/admission/checkpoint support.

- Files: CP/provider.ts, CP/boat-provider.ts, CP/provider-resolver.ts, CP/provider-deployment.ts, CP/routes.ts, CP/reconciler.ts, CP/generation-transitions.ts, CP/automatic-recovery.ts, CP/setup-materials.ts; S/setup-cloud-workspace.mjs, S/cloud-engine-launcher.mjs; E/agents/containment/cloud-native-boundary.ts, E/files/cloud-file-policy.ts, E/files/cloud-workspace-ownership.ts, E/cloud-durability-runtime.ts, E/agents/containment/cloud-checkpoint-artifacts.mjs, E/agents/containment/cloud-checkpoint-artifacts.d.mts.
- Interface: B six-field RuntimePin plus C EnvironmentSource through every allocation/retry/recovery/upgrade path; fork copies source runtime, explicit upgrade retains template environment; stable primary bind, associated roots and v4 multi-repo recovery. Keep v1–v3 unchanged.
- Tests: fail D1 fallback before implementing it in CP/routes.integration.test.ts; extend boat-provider.test.ts, setup-materials/setup-worker/reconciler/generation transition integration suites and E/agents/containment/__tests__/cloud-checkpoint-artifacts.test.ts. Cover double fork/lost reply, wallet/principal mismatch, changed active version, old replay pins, missing org GitHub grant vs permitted cached read, exact HEAD, mount escapes and allocation-loss recovery of secondary edits.
- Checks: baseline + CP + Runtime + Wire; B qualification, applicable native checkpoint contract suites; macOS smoke:engine before rollout. Live: fork two members from v1, edit/build v2, verify only new creates use it; sleep/wake and recover a disposable multi-repo workspace, with all provider receipts reconciled.
- Parallelism: C6 can develop against C1/C3's reference API; final retention race tests must include this PR.

### C6 — Activate retained history and retire unreferenced templates

Branch: cloud-v2/c6-computer-history-retention. Size: M. Depends: C1/C3; integrates with C5 source references.

- Files: CP/computer-template-retention.ts (new), CP/computer-v2.ts, CP/computer-v2-routes.ts, CP/computer-template-worker.ts; apps/control-plane/src/index.ts; docs/cloud-workspace/provider-contract.md, docs/cloud-workspace/organization-setup.md.
- Interface: transactional Activate/Rebuild, active/previous/last-10 retention, B base references, exact provider deletion receipts. Stopped compute completion and permanent deletion stay distinct.
- Tests: CP/computer-template-retention.integration.test.ts (new), extend CP/computer-v2.integration.test.ts. Force activate/delete/fork races, cache-read pin, retired/absent source, base/runtime/secret revocation, stopped/archived recoverable generation, historical SHA rebuild and unknown deletion.
- Checks: baseline + CP; deletion/retention integration suites. Live: activate a retained prior version without starting compute, prove a pinned source survives and a small unreferenced fixture retires/offers Rebuild; last-10 boundary is covered in integration tests. Confirm cleanup receipts.
- Parallelism: largely independent of C5 until end-to-end pin/race validation. No launch-scale GC drill is included.

### C7 — Deliver Cloud Computer settings and first-build creation guidance

Branch: cloud-v2/c7-computer-settings. Size: L. Depends: C1/C3/C4/C5/C6; Phase A effective gate.

- Files: R/features/settings/cloud-computer-client.ts, R/features/settings/cloud-computer-panel.tsx, R/features/settings/settings-page.tsx; R/features/settings/cloud-computer-history.tsx and R/features/settings/cloud-computer-environment.tsx (new); R/platform/cloud-workspaces.ts, R/platform/files.ts; R/shell/workbench/tabs/workspace-file-tree.tsx, R/shell/workbench/tabs/files-tab.tsx; R/shell/dispatcher/cloud-create.ts, R/shell/dispatcher/dispatcher-modal.tsx; R/shell/dialogs/open-github-project.tsx; R/harnesses/harness-cloud-settings.tsx.
- Interface: §5 snapshot/log/API contracts and org-shared create-source variant. Use the existing native account transport; do not create new credential IPC or public provider fields.
- Tests: R/features/settings/__tests__/cloud-computer-client.test.ts, R/features/settings/__tests__/cloud-computer-state.test.ts (new), R/shell/dispatcher/__tests__/cloud-create-cold-project.test.ts, R/shell/workbench/tabs/__tests__/files-tab-containment.test.ts; scripts/ui-smoke-cloud-computer.mjs, scripts/ui-smoke-cloud-settings.mjs, scripts/ui-smoke-cloud-workspace.mjs. Cover associated-root containment, exact-key A→B→A, dedup, stale responses, hidden polling, conflicts, log gaps, staff loss and all D1 entry points.
- Checks: baseline + UI; full required UI smoke on supported macOS and browser harness checks. Live: signed Alpha desktop first build, saved unbuilt edit, Discard, manual Build, streaming logs, independent setup edit and Activate/Rebuild.
- Parallelism: UI mocks can start after C1, but merge the complete behavior only after backend/retention admission is available. This is Phase C's acceptance boundary.

### D1 — Add private admin workspaces with durable creator authority

Branch: cloud-v2/d1-admin-workspaces. Size: M. Depends: completed Phase C and B scratch-source/native admission.

- Files: M/0129_cloud_computer_admin_workspaces.sql (new, proposed number); CP/computer-admin.ts (new), CP/computer-v2-routes.ts, CP/routes.ts, CP/setup-materials.ts, CP/agent-executions.ts, CP/access.ts; S/setup-cloud-workspace.mjs; P/cloud-computer.ts.
- Interface: immutable admin sidecar, private creator-owned lifecycle, scratch source for empty config, normal generation pins/env and existing billing epoch. Admission emits a qualified admin-tool capability only for the creator's authorized execution.
- Tests: CP/computer-admin.integration.test.ts (new); extend authorization/access/setup-materials suites. Fail client-spoofed markers, nonstaff/support-only/nonadmin, wrong creator, no successful build, empty-default startup, ordinary-source bypass, duplicate request and owner removal. Assert existing VM meter/owner binding rather than adding a meter.
- Checks: baseline + CP + DB + Runtime + Wire. Live: default empty build → private admin workspace with org env; reopen/retry without duplicate allocation, demote the creator and verify tool authority retirement; confirm existing VM accounting attribution and cleanup.
- Parallelism: D2 may implement the tool schemas against this contract, but no D surface ships before Phase C acceptance.

### D2 — Provide the five execution-scoped computer tools

Branch: cloud-v2/d2-computer-agent-tools. Size: L. Depends: D1; B MCP/runtime qualification.

- Files: CP/computer-tools.ts (new), CP/agent-executions.ts, CP/agent-credential-routes.ts, CP/mcp-contract.ts; P/cloud-computer-tools.ts (new), P/cloud-agent-execution.ts, packages/protocol/package.json; E/agents/cloud-computer-tools.ts (new), E/agents/session-tools.ts, E/agents/cloud-agent-lease.ts, E/agents/mcp-registry.ts, E/cloud-agent-execution-client.ts, E/zeros-engine.ts.
- Interface: §6 strict tool schemas over existing engine RPC, typed authorized 409 results, composition with Design product tools, reserved product name and per-execution cleanup. No broad management token enters the provider.
- Tests: CP/computer-tools.integration.test.ts and E/agents/__tests__/cloud-computer-tools.test.ts (new); extend session-tools, mcp-registry, cloud-agent-execution-client and provider product-tool adapter suites. Force stale revision with unchanged previousBuildId, call replay, forbidden extra fields, copied/wrong lease, role loss during mutation, ordinary workspace spoof, wrong org/generation and simultaneous Design tools.
- Checks: baseline + CP + Runtime + Wire; Claude/Codex/Cursor native MCP qualification for the changed runtime. Live: each provider lists/gets, updates install script, starts a build, reads redacted status and updates a repo hook; verify prohibited mutations are rejected and no secret value is returned.
- Parallelism: D3 UI can use contract fixtures while these authority tests land; engine admission composition needs one owner.

### D3 — Complete the “Configure with an agent” desktop flow

Branch: cloud-v2/d3-admin-workspace-flow. Size: M. Depends: D1/D2.

- Files: R/features/settings/cloud-computer-panel.tsx, R/features/settings/cloud-computer-client.ts; R/platform/cloud-workspaces.ts; R/state/cloud-workspace-lifecycle.tsx; R/shell/dispatcher/dispatcher-modal.tsx; R/harnesses/harness-cloud-settings.tsx; scripts/ui-smoke-cloud-computer.mjs; docs/cloud-workspace/organization-setup.md, docs/cloud-workspace/mcp-and-skills.md.
- Interface: server-reported admin purpose/creator, atomic workspace+route selection, explicit new admin VM to test an updated computer; existing conversation/tool transcript UX. Admin badge derives from admitted metadata, never a title or prompt.
- Tests: add R/features/settings/__tests__/cloud-computer-admin-flow.test.ts; extend workspace publication/cache/race tests and cloud-computer smoke. Cover creator-only reuse, cross-org navigation, no-build guidance, demotion while hidden, failure/retry and five tools without replacing Design tools.
- Checks: baseline + UI + Wire if workspace DTO changes; supported macOS smoke:engine/UI smoke. Live: signed Alpha Configure → inspect repositories → edit script → build/autoactivate → fresh ordinary workspace runs it; verify D12, creator VM attribution and idle stop.
- Parallelism: renderer/doc work may proceed against D1/D2 fixtures; merge and accept only after backend/agent qualification passes.

## 8. Alpha acceptance, unresolved dependencies and validation

### 8.1 End-to-end acceptance

Use an Alpha staff test org, two admins, a member lacking direct access to one selected private
fixture repo, two provider-account identities for negative fixtures, and synthetic env canaries.
Use existing approved test identities and authorizations; do not put credentials in assertions.
Negative principal/wallet outcomes should use fixtures unless the Alpha operator authorizes a
second live provider account. Record stage timing, source/build/generation/runtime IDs and
cleanup receipts in private qualification evidence, not product logs.

| Scenario | Required observation |
| --- | --- |
| First build/D1 | Org creation and draft saves allocate nothing. Every UI/API create path rejects before first success. A double-click/lost first-build response creates one default config/version. An empty repo list builds and later admits the scratch admin workspace. |
| Installation/TCB | An allowed root package install survives the fork and is usable by isolated agents. Editing a protected file, adding a Zeros unit override or changing sudoers fails before activation. Template has no agent/engine/admission/clone credential or org env material. |
| Logs and recovery | Live stdout/stderr, reconnect, long output and failure are bounded and ordered. Split synthetic secrets are redacted before persistence. Reclaimed build jobs inspect rather than rerun an uncertain script. |
| Manual changes | Saved repo/env/install edits show Unbuilt changes. New workspaces still use the old active version. Discard restores it. An explicit build activates only its exact accepted tuple. Failed/cancelled/superseded builds never activate. |
| Shared repos | Every selected repo is readable offline by the member lacking GitHub access, including when selected as primary. Token revocation after preparation does not break cached file reads. Human-authorized writes remain scoped; unavailable actor Git rights fail. Removed repos disappear only in newly built/newly created workspaces. |
| Environment | Masked equality checks prove org < repo < personal precedence and actor isolation across setup, agents and new terminals. Unbuilt edits do not leak, a successful build changes only future generation pins, and revocation immediately fences affected authority. Saved API/tool reads never reveal values. |
| Setup scripts | Editing only a repo hook does not build a template. Next accepted workspace runs its new pinned hook once as workspace UID, after checkout; wake does not rerun it. Failure blocks Ready and offers a clear retry/recreate path. |
| Races/uncertainty | Two admins, config/base/runtime changes, replacement, cancellation at completion, lost fork/stop replies, expired provider keys and 404s produce no extra allocation or stale activation. Unknown cleanup retains its hold. No routine verifier is allocated. |
| Pin separation | Fork copies source runtime A. Explicit upgrade to compatible B keeps the template environment and verifies B through the base installer. Existing generations and grandfathered v3 workspaces retain their original pins/behavior; an older admin workspace can upgrade to tool-capable B without rebuilding its computer. |
| History/retention | Activate retained history starts no compute and affects new creates only. Unit/integration tests prove last-10 and all reference categories; Alpha proves a live pinned source cannot retire and one unreferenced source can, with deletion evidence and a working Rebuild row. |
| Durability/idle | Primary and secondary unpushed edits survive graceful sleep/wake and disposable allocation-loss recovery; checkpoints remain encrypted native format. Idle policy stays 10 minutes; active work and live terminals prevent sleep. |
| Admin workflow | Creator opens the marked private workspace, runs all five tools via each supported provider, builds successfully, and tests a fresh ordinary workspace. Org values are available to its shell (D12); tools cannot edit/read values or repositories/credentials/members/old activation. Demotion, wrong creator and copied leases fail every call. |
| Desktop isolation | Staff-only surfaces and direct backend access agree. Exact-key navigation, A→B→A drafts, conflicts, hidden polling/inertness, role loss and log replay pass the signed desktop/harness matrix. Existing Design tools and normal transcript rows remain usable. |
| Accounting/cleanup | Admin VM seconds retain the creator's existing billing-owner epoch. No org sponsor, agent-cost accounting or build/storage charge is added. All test allocations/sources/stop/delete operations are recorded and cleaned up or explicitly retained by the operator for qualification. |

Enable C only after its provider source/capture/qualification and durability cases pass.
Enable D only after C and all five tools pass creator/role/replay tests with qualified runtimes.
Report API acceptance, disk-readable time, complete verification, engine Ready and first usable
agent separately; do not label a fast fork response as a fast ready workspace.

### 8.2 Open dependencies and explicit interpretation choices

1. M-A supplies startup/stop timings and positive wallet/source-deletion observations (§3.4).
   Still qualify other-principal refusal, final snapshot-to-manifest proof, stopped-file cache
   transport, actual v4 build/admission and the same source's fork/wake after physical purge.
2. B's draft supplies runtime IDs, schema, boot/admission and source-pin rules. Finalize the
   build-only admission, repo-root mounts/checkpoint extension, tool/env capabilities and
   migration slots with B. Its base inventory must account for observed hydration scratch
   behavior without a broad runtime-file exemption (.context/impl/boat-timings/REPORT.md:92–98).
3. A missing/corrupt repo cache may safely cold-fetch. An unprovable final stopped capture may
   not publish. If Boat cannot meet the default-build target, report the measured result and
   revisit the product target; do not add routine verifier VMs or skip verification.
4. Build-time organization secret injection is not settled by the locked wording. This proposal
   follows §3.4's boot/turn-only handling. Authenticated private package setup can run in a new
   workspace; adding transient privileged build secrets requires an explicit scope decision and
   a statement that root can persist them. D12 for the admin workspace is already settled.
5. Personal-versus-repository env collision uses personal-last in this proposal; only their
   shared precedence over org values is locked. Confirm this narrow tie rule with the settings
   owner and test it without changing legacy or MCP/skills ordering.
6. Qualify same-principal key rotation and child/source deletion dependence. Until then retain
   all recoverable source pins, never resume a ready source, and require the original account
   scope for cleanup. Restoring new children from deleted sources is not promised.
7. Document the Alpha fixture bounds and supported LFS/submodule cases. Unsupported materialized
   content must fail clearly; do not satisfy D11 with empty placeholders needing a private token.

### 8.3 Deferred work and follow-ups

No public API/CLI/hosted MCP, billing sponsor/payment/limit changes, org member-cap rollout,
ownership transfer, broad repo-history service, extra package dependencies, multi-provider
templates, cumulative OS images or ordinary admin-root agent execution. Launch-scale
retention/DR drills, full root-build supply-chain review, quota/start-budget planning and
production rollout are deferred by FINAL-02 §9. The bounded retention worker, capture evidence,
race protection and secret sanitation required to make this Alpha feature correct are in scope.
Leave unrelated renderer, release and legacy stored identifiers unchanged.

### 8.4 Checks performed for this report

This was read-only source/design work; the following local checks ran against the unchanged
checkout. The full repository/database/native suite is impractical for this Linux design pass;
targeted contract suites were used rather than claiming the implementation acceptance above.
M-A independently reports 40 full-suite test failures caused by missing browser/bwrap/socat
prerequisites (.context/impl/boat-timings/REPORT.md:164–169); the targeted passes do not clear that gate.

- pnpm typecheck — passed.
- pnpm lint — passed with two existing warnings: unnecessary escape at R/features/agent/chat-title.ts:56 and hook dependency at R/features/design-workspace/design-canvas.tsx:4869.
- pnpm check:ui — passed.
- pnpm check:secrets — passed, 5,572 tracked files; the ignored report is reviewed separately.
- pnpm test:git apps/desktop/src/renderer/features/settings/__tests__/cloud-computer-client.test.ts apps/desktop/src/engine/agents/__tests__/session-tools.test.ts — 2 files, 10 tests passed.
- pnpm --dir apps/control-plane exec vitest run src/cloud-workspaces/computer-image.test.ts src/cloud-workspaces/computer-image-boat.test.ts src/cloud-workspaces/boat-provider.test.ts src/cloud-workspaces/boat-client.test.ts — 4 files, 154 tests passed.
- pnpm --dir apps/control-plane typecheck — passed.

No migration, runtime asset, protocol, UI implementation or tracked source was changed.
No provider API call/mutation, commit, PR or branch rename was made. No live resources were
created, so there are no cleanup IDs. Full pnpm test:git/test:control-plane, migration/runtime/
license/build gates and UI/native smoke were not run for this document. macOS engine and signed
desktop checks were not run from this Linux VM and remain required for the implementation PRs.
