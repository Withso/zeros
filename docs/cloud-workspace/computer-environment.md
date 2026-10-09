# Cloud Computer v2 environment and repository setup

Cloud execution requires a valid saved `cloud_workspace_computer_sources` row,
a complete v4 worker runtime pin, and actor protocol 2. Generations without a
source, with an invalid saved template, or with an unpinned/retired worker are
refused with the closed `cloud_workspace_v2_required` code before setup,
credentials, wake/fork, or replacement/recovery admission. The server and client
show: “This workspace uses a retired cloud runtime — create a new workspace.”
This refusal is terminal for setup and automatic recovery.

The saved row's `config_id` selects exact
`cloud_computer_environment_refs(binding_id, binding_version)`; neither the
current draft nor a binding's latest version supplies org values to an existing
generation. A revoked, missing, retired or unauthorized pinned version fails
with `computer_environment_revoked`, including when a higher layer overrides it.
Concurrent authority changes fail closed and retry with `computer_environment_busy`.

Saved metadata and transcript history remain authorized reads. Retirement does
not delete resources, change existing pins, select today's template, or silently
create a source sidecar. Owners may create a fresh v2 workspace or explicitly
delete a retained workspace through normal resource cleanup. Runtime updates
within a supported generation do not convert a legacy workspace; automatic
legacy-data conversion is deferred. Local and organization-owned local
workspaces continue to use their normal local settings and runtime paths.

Environment precedence, lowest to highest, is:

1. Built-in defaults.
2. The generation's pinned org computer environment.
3. The primary repository's shared, then cloud settings.
4. The admitting actor's explicitly consented personal values.
5. Managed policy and runtime-owned authentication, configuration and locations.

Repository and managed-policy versions are pinned in the generation's immutable
settings snapshot. Personal consent is checked afresh for the actor at setup,
turn or terminal admission. Personal secret references and personal setup
commands are not inherited. Explicit empty repository/personal values override
lower layers; org secret creation still requires a nonempty value.

The resolver removes `values.env` from the materialized settings document.
Nonempty values use existing encrypted setup-secret envelopes; empty overrides
are resolved from their source document at delivery. Org values never enter Boat
create/fork environment, templates, process arguments or plaintext managed TOML.
Reserved names (`ZEROS_*`, `CONDUCTOR_*`, `GIT_*`, loaders, shell startup and
credential redirects) are rejected by the draft and delivery validators.
Provider-owned `ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*`, `CODEX_*` and `CURSOR_*`
settings remain under engine authority for agent processes. Ordinary terminals
may receive configured provider API keys; runtime paths and Git authority stay
managed in both paths.


The engine, agents, tools, terminals/SSH/LSP and capture use the [normal VM execution model](security.md#agent-execution-model):
one non-root `zeros-engine` user (10003), the real checkout and normal VM egress, without an agent sandbox.
The approved base's setup recipes and account inventory remain immutable. The root broker adopts
legacy mutable checkout/HOME ownership from 10001/10002 to 10003 only after positive old-engine drain.
Agents can read engine data on their VM: one trust domain per workspace. Conversation directories
separate state, not agents from each other.

## Delivery and lifetime

- Setup redeems its creating actor's effective environment through the private
  one-use material endpoint. Authority is checked again after minting the Git
  credential; failed publication revokes that credential. Updated personal
  consent can change delivered secret-reference metadata without changing the
  immutable generation snapshot identity.
- Agent admission opts in with private `environmentVersion: 1`. It receives an
  actor-specific environment and keyed revision. Lease validation recomputes the
  revision; a change retires the process. V2 admission fails closed for runtimes
  without this capability. Another actor cannot take over the execution even
  when both actors share an agent-credential delegation. The same filtered values
  reach workload tools and Codex's separate executor. Codex shell inheritance
  allows only admitted names and managed runtime paths; its argv contains names,
  never the values or provider credentials.
- V4 terminal admission requests the private `terminal-environment` capability.
  Values enter only that shell's child environment. Reattachment retains its
  admitted environment, and another member cannot attach or operate it. Restart
  a shell to pick up changed personal consent. Org binding revocation also
  reaches the existing workspace security-stop path.
- The existing execution redactor filters org/repository/personal literals from
  agent output and errors. Encrypted native-history authority retains previous
  literals up to 65,536 UTF-8 bytes and separates actor histories, retaining the
  4 MiB encrypted-history limit. Terminal filtering precedes live
  publication and replay. No personal values are installed in the shared engine
  environment. User code can deliberately write its own files; literal filtering
  is not a data-loss-prevention boundary for arbitrary transformations.

Creation/fork integration (C5) must insert `cloud_workspace_computer_sources`
**before** `resolveDatabaseCloudWorkspaceSettings` and settings persistence, in
the same creation transaction. Every new generation must carry its intended
source row. A v2 row paired with a legacy settings snapshot fails closed at
delivery. Builders must not insert workspace source rows or invoke this resolver
to obtain org environment; builder input isolation belongs to C3.

## Repository setup API

`PUT /v1/organizations/:organization/cloud-computer/v2/repositories/:repository/setup`
accepts `{ expectedSettingsVersion, operationId, script, timeoutSeconds }` and
returns `{ repositoryId, version }`. `:repository` is GitHub's canonical numeric
ID, as in the computer config. The generic settings API still uses the internal
repository UUID. The admin tool translates that UUID and invokes the exported
`updateRepositorySetupScript` service within its existing authority transaction.

The actor must have an active account and a current org owner/admin role.
Ordinary members receive 403; unavailable accounts receive 404. Staff status
is not a prerequisite. The repository must occur in the active or draft config.
Only cloud `setupCommands` are replaced, under the same repository lock as
generic settings writes. Other values, secret references and shared settings
remain intact. An empty/whitespace script disables setup. Scripts are bounded
to 16 KiB UTF-8 and 1–900 seconds. Version zero means no prior cloud settings.
Stale versions return `cloud_settings_version_conflict`; `operationId` is an
audit identity and does not override CAS on retries. This operation neither
changes the computer revision nor requests a build.

The frozen v4 base helper runs only the primary repository's cloud commands,
after checkout, under its legacy workspace UID 10001 contract. The root broker
adopts mutable checkout/HOME ownership to 10003 after positive old-engine drain;
engine start and Ready follow successful setup and adoption.
The root-owned journal records running/failed/completed state. Wake verifies the
journal and skips completed commands. Interrupted or failed hooks require an
explicit new setup run, using the existing failed-workspace wake/retry action;
automatic retries of the same run cannot rerun them. An explicit retry can repeat
side effects from an interrupted command, so setup hooks should be idempotent.

Failures normalize ANSI/control sequences before literal and truncated-prefix
redaction, then retain at most 16 KiB of UTF-8 output in the
root setup log and existing setup-run log fields. The private helper's version-3
error envelope is accepted only on v4 and only for hook failures. Other provider
output keeps the existing withholding boundary. Existing version-1 journals
remain readable by the supported v4 helper; retired helpers cannot execute.
Publish a runtime bundle with the
updated helper and engine together with the control-plane change.

## Alpha live runbook

Run only from the orchestrator's credential-bearing Alpha workspace after the
control plane and matching runtime are available. This change does not deploy
them. End-to-end generation checks also require C5's source-row integration.
No live resources were used to develop this change.

Prepare a disposable org named `zeros-v2-test-...`, with one selected repository
and an existing cloud settings version. Keep all its fixtures synthetic and
quiesce other settings writers. Record the org, repository UUID, GitHub numeric
ID, config, build, template, workspace and binding IDs used. Supply these
run-specific entries in the root `.env.agent` (mode 0600); never pass tokens in
command arguments or include them in reports:

- `ZEROS_C4_ALPHA_ORGANIZATION_ID`
- `ZEROS_C4_ALPHA_REPOSITORY_ID` (internal UUID for the same GitHub repository)
- `ZEROS_C4_ALPHA_GITHUB_REPOSITORY_ID`
- `ZEROS_C4_ALPHA_ADMIN_TOKEN` (active org owner/admin)
- `ZEROS_C4_ALPHA_MEMBER_TOKEN` (active ordinary org member)
- `ZEROS_C4_ALPHA_NONSTAFF_TOKEN` (nonstaff org owner/admin)

Run `node scripts/cloud-workspace-validation/c4-environment-setup.mjs --run`.
The script pins the public Alpha API origin, bounds response bodies and emits
only closed check names, IDs and settings version numbers. It exercises member
403, nonstaff-admin stale-CAS 409 without a write, preservation and disabling, and checks that the computer
revision stays unchanged. It restores the prior cloud document with CAS in
`finally`, including after a lost response. `cleanup: "required"` means cleanup
was not confirmed: stop and restore the dedicated fixture through its ordinary
settings API before continuing. Never overwrite a concurrent edit. Synthetic
immutable version/audit rows remain associated with the disposable fixture for
its normal lifecycle cleanup; do not delete individual history rows.

For the VM paths, use that same disposable fixture and the supported workspace
creation/stop/wake/delete operations:

1. Set distinct synthetic org-only, repo-collision and personal-collision values;
   consent personal values separately for two actors. Keep one personal name
   unconsented. Configure a primary-repo hook that checks its cwd, UID and
   effective values in memory and writes only an execution counter and pass/fail.
2. Create a v2 generation, verify its source config ID, and wait for Ready. Check
   setup, both actors' new terminals and both actors' turns against the precedence
   above. Have the processes emit synthetic literals and confirm output is
   redacted in live, replay and failed-turn views. Compare provider transport
   payloads in memory; record only booleans for absence from argv/create/fork env,
   templates, shared engine env and managed settings. Never dump these payloads.
3. Save a different unbuilt draft. Existing generation admissions must keep the
   pinned active value. Revoke a pinned binding version and verify the closed
   error and security-stop path, even if a repo/personal value overrides it.
4. Stop/wake after a completed hook; the counter must stay unchanged. On a new
   disposable generation, fail the hook after emitting a synthetic literal.
   Confirm bounded redacted failure output, no Ready/agent start, no automatic
   rerun, and successful execution only after the explicit Retry action.
5. Restore repository settings and personal consent, revoke test bindings, and
   remove the test draft. Delete every created workspace and template through
   the owning lifecycle service; verify provider deletion before removing the
   disposable org fixture. Record each ID and confirmed cleanup state. Remove
   temporary session-token entries from `.env.agent`. Do not claim live success
   while any of these checks or cleanup confirmations remain outstanding.

C3's builder must separately prove that org environment never reaches builder
input. The existing checkout helper also uses directory renames; Boat resume
semantics require the creation/template work to address that independently.
