# Orchestrator amendments to the Phase B and Phase C/D designs (authoritative; 2026-10-04)

These amendments OVERRIDE `design-b-runtime.md` (B) and `design-cd-computer.md` (CD) wherever
they conflict. Goal: working Conductor-style cloud on **Alpha for internal staff use** with tight
scope. Everything not amended stays as designed. Launch hardening is out of scope.

## Phase B amendments

AB-1 **Single redemption; install before redemption.** Remove the two-stage redemption
(materials continuation table/endpoints/`check` operation). The control plane puts the runtime
descriptor AND a short-lived presigned GET URL into the v2 setup input
(`runtime: {...descriptor...}, artifact: {url, expiresAt}`), delivered over the existing
host-key-pinned SSH stdin. The base-owned installer (root, Python stdlib) verifies and installs
the runtime and switches `current` BEFORE any redemption, then execs R's setup helper, which
performs the existing one-use admission redemption unchanged (fresh materials, minted after the
install). The installer grants no authority; engine start still requires the one-use admission.
The presigned URL is bearer material: never logged/persisted, expires ≤ 15 min.

AB-2 **Runtime qualification = control-plane "runtime smoke" on a disposable Boat VM (replaces B §6).**
No CI fixture user, browser-session secret, candidate exception, run/case tables, or definer
finalizer. When a runtime release is registered and its parent release confirmed, a CP background
worker: allocates a disposable VM from the approved v4 base (existing Boat client + provider
operation journaling; name `zeros-v2-qual-<runtime-short>`), runs the SAME fixed installer command
with a build-purpose input (descriptor + URL, no workspace admission), runs the v4 attester
(isolation + manifest/receipt) and a fixed in-runtime self-test entry (engine boots in self-test
mode; Claude/Codex/Cursor native binaries resolve from W and report versions; better-sqlite3 and
node-pty load under bundled Node; ZSR/containment probes; MCP gateway self-test if it can run
without a model), collects the closed diagnostic, deletes the VM, and on success inserts
`cloud_runtime_qualifications` rows for the required credential kinds (claude-setup-token,
codex-chatgpt, cursor-api-key; plus API-key kinds) with `evidence = {mode:"smoke", checks:[...]}`.
`mcp_qualified` only if the MCP self-test ran; optional native capabilities stay false.
Channel-head eligibility accepts smoke evidence only when `CLOUD_RUNTIME_QUALIFICATION_MODE=smoke`
(set on Alpha); the default `full` accepts nothing yet (documented: real-turn per-kind qualification
from the original B §6 is the launch-hardening follow-up). Staff-only internal endpoints: list
runtimes/qualifications, retry smoke for a runtime, revoke a runtime. This builder-VM worker
(create from base → install → run fixed helpers → closed diagnostics → delete) is shared
infrastructure that Phase C's template builds extend.

AB-3 **CI → control-plane auth via GitHub Actions OIDC; no new shared secrets.** The CP verifies
GitHub OIDC JWTs (issuer `https://token.actions.githubusercontent.com`, configured audience,
`repository` equal to the configured repo case-insensitively, exact `workflow_ref`
(`.github/workflows/release-alpha.yml@refs/heads/main` for publication;
`.github/workflows/cloud-runtime-base.yml@refs/heads/main` for base registration), `ref`,
`event_name`, `environment` when used). Provenance (run id/number/attempt/sha) comes from verified
claims; `release_order = run_number` of Release (alpha). Reuse the CP's existing JWT/JWKS
verification utilities (no new dependency unless none exists — ask first).

AB-4 **Base registration and selection.** The manual base workflow `cloud-runtime-base.yml`
(workflow_dispatch, environment alpha, uses existing BOAT_API_KEY/BOAT_BILLING_ORG) builds and
verifies the v4 base, then registers it through an OIDC-authenticated CP endpoint as approved.
The configured v4 base for new workspaces = newest approved, non-revoked v4 base in the registry
(no env var for the base id).

AB-5 **Switch.** `CLOUD_WORKSPACE_NEW_RUNTIME_PROFILE=legacy|v4` (default legacy) selects the
profile for NEW workspaces; v4 creates are staff-only while `CLOUD_RUNTIME_V4_STAFF_ONLY` (default
true). Saved v4 generations always keep working regardless of the switch.

AB-6 The hash-semantics regression is a separate Phase A PR (A3), not part of B.

AB-7 **PR list (replaces B §9 numbering):**
- B1 contracts + schema (migration **0124**): protocol types (manifest, descriptor, v2 setup
  input with artifact, v4 attestation, closed diagnostics), registry tables (base contracts, base
  images, bundles, channel releases, qualifications with `evidence jsonb`), generation/engine/
  attestation pin columns + triggers. No continuation table, no run/case tables.
- B2 verified runtime root across engine/containment/sandbox (+ delegated cgroups).
- B3 bundle builder (deterministic `.tar.gz` + manifest + closure tests).
- B4 v4 base + bootstrap/installer + units + kit profile + `cloud-runtime-base.yml`.
- B5 CP registry, runtime artifact store (create-only presigned PUT, presigned GET), OIDC
  verifier + publication/base-registration endpoints, create-time pin + selection, v2 setup input
  with artifact URL, boat-setup-runner v4 branch, registration/readiness comparison, v4
  qualification predicate in credential discovery/execution, switches, release-identity fields.
- B6 Alpha release jobs: runtime-build + runtime-publish (OIDC) in release-alpha.yml; feed
  publication needs runtime-publish; publish script + workflow tests.
- B7 CP runtime-smoke qualification worker (AB-2) (migration **0125** only if worker state needs
  a table; prefer reusing provider-operation journaling).
- B8 lifecycle pins (wake/retry/recovery copy pins; explicit same-base upgrade), docs, Alpha
  acceptance.

AB-8 Migration numbers are contiguous and assigned in merge order (the sequence check rejects gaps):
B1 = 0124, C1 = 0125, later PRs take the next free number at merge time and rebase/renumber if main
moved. Never edit a merged migration.

## Phase C/D amendments

ACD-1 **No repository cache.** Builds do a fresh shallow clone (depth 1) of each configured repo
at its default branch or requested ref (measured: zeros repo shallow clone 2.3 s). Record exact SHAs.
ACD-2 **Repo authority:** validate the adding admin's own GitHub proof when a repo is added;
builds/workspace initialization mint one-repo contents:read installation tokens through the
existing broker. No separate sharing-consent/authority-revision suspension machinery for Alpha;
a mint failure fails the build/setup with a closed error.
ACD-3 **Secondary repos (D11):** cloned into the template at a fixed root and projected read-write
into the engine/agent view at stable logical paths. Checkpoint/recovery covers only the primary
repo for Alpha (documented limitation). Files UI shows only the primary root for Alpha.
ACD-4 **Admin workspace requires ≥ 1 repo** in the active config; its primary = first configured
repo. No scratch-repo mechanism.
ACD-5 **Build concurrency:** one queued/running build per org (unique index) + a global cap
(config, default 2) via DB state; Boat idempotency keys + GET reconciliation on restart. No new
account-lease table.
ACD-6 **Idempotency:** `expectedRevision` CAS on every write; `operationId` dedupe only for Build,
Activate, Rebuild and admin-workspace creation.
ACD-7 **Retention:** simple idempotent worker after each activation: keep active, previous, any
template referenced by a non-deleted generation, newest 10; delete others via Boat with the
deletion operation recorded. No byte-erasure tracking.
ACD-8 **Fork runtime pin:** a new workspace pins the template's runtime if still eligible
(not revoked, protocol-compatible), else the channel head (installer downloads). Settings shows
"A newer Zeros runtime is available — Build computer to update" when head ≠ template runtime.
ACD-9 Environment as designed (pinned binding versions, precedence org < repo < personal; build
gets no org env).
ACD-10 Build logs: bounded 1 MiB per build, redacted, cursor polling.
ACD-11 C3 template builds extend B7's builder-VM worker; the installer input is AB-1's
build-purpose input (descriptor + URL). Template = sanitized, stopped (archived) sandbox.
ACD-12 Internal gate: new renderer surfaces gate on `useInternalFeatureActive("cloudComputerV2")`
(new internal feature key); every new v2 endpoint requires engineering staff (developer or
platform_owner) server-side.
