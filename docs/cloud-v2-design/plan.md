# Zeros Cloud v2 — Conductor-style Cloud Computers and workspaces on Boat (PLAN v2)

Status: plan v2 by the orchestrator (2026-10-04). Built from first-hand inspection plus seven
research/review tracks: R1 Conductor VM runtime, R2b Conductor product/API, R3 Boat, R4 Zeros
audit, R5 Beta/Production diagnosis, R6 runtime-bundle design, RV independent review (which
rejected plan v1's Phase 0 and is addressed here). Verification log:
`orchestrator/verification-log.md`. **No code was changed.** Companion:
`FINAL-01-conductor-cloud-reference.md`.

---

## 0. Executive summary

1. **Beta/Production cloud today.** Servers are healthy and cloud is switched on, but every channel
   serves one old Boat worker image (`zeros-qualification-aa11196c97a6`, source 2026-09-23, 101
   commits behind the Beta/Production API) whose agent-runtime qualification matrix is **not
   confirmed complete** (`workerQualified=false`). Missing per-credential-kind approval is the
   leading explanation for "doesn't work": agent runs then fail
   (`403 cloud_agent_authority_rejected`, or the app hides the agent / says "This workspace's agent
   runtime needs an update…"), Build computer needs at least one base approval
   (`409 cloud_computer_qualification_required` if none), and the old engine rejects some newer
   prompt settings (`[1m]` models, `max`/`ultracode` effort). Row counts could not be read (DB 403),
   so the first failing gate must be confirmed on a real account before repair.
2. **Why it keeps happening.** Zeros bakes its runtime into the Boat image and derives every org
   image from that exact base; the only way to ship a runtime is a new image + canaries + audited
   per-channel qualification + publication through the worker lane — and that lane is wired into
   the release graph, so enabling it makes Boat a release blocker. Conductor instead ships a
   versioned runtime (`/conductor-infra/<sha>`) behind stable `/conductor` selectors, builds an org
   **Cloud Computer** from repos + env + install script, and boots workspaces from the active build.
3. **Target.** Same separation on Boat: a rarely-changing base, a signed runtime bundle per release
   (qualified once per runtime/base/credential kind), and org Cloud Computer versions (lazy "Build
   computer", history, rollback), with `/zeros` as the in-VM entry point — while keeping Zeros'
   stronger pieces (isolation, sealed per-user credentials, durable control-plane record).
4. **Accounts.** Pro stays per user; Pro users may create orgs (today staff-only); ≤10 members/org
   (today none); workspace **owner** pays and can be **reassigned** (today the sponsor is immutable
   by DB trigger); metered **without product caps** for now (today 500 h and quotas are fixed).
5. **Sequence and size (RV-adjusted, one engineer, person-days):** Phase 0 repair 4–10 after the
   failing gate is known; Phase 1 runtime bundle 12–18 pilot / 30–50 production; Phase 2 Cloud
   Computer 15–25 MVP (20–35 full); Phase 3 accounts/billing 15–30; Phase 4 admin agent 10–15;
   Phase 5 public API/CLI/MCP 20–35; Phase 6 hardening 5–10.

---

## 1. Diagnosis: Beta/Production cloud today (evidence and leading explanation)

| Layer | Beta | Production | Evidence |
|---|---|---|---|
| Server release | 1dc0d625, migrations current | same | `GET /v1/release-identity` (2026-10-04) |
| Cloud switch | enabled, ready, healthy | same | same |
| Worker image | boat:zeros-qualification-aa11196c97a6 (built 2026-09-23) | same | same; `git log aa11196c` |
| `workerQualified` | false (matrix incomplete or unreadable — not proof of zero rows) | false | release-identity.ts:22-30, 93-107 |
| How enabled | PR #270 adopted Alpha's tuple with `ZEROS_WORKER_PROMOTION` off; worker jobs skipped | same | Actions runs 37139687132 / 37139689222 / 37139681211 / 37142659660 |

Gates in order (first failing gate wins):
1. **Desktop**: Production app on nisha-10482 is 0.1.22 (cloud capability baked true). Zeros Beta
   there is 0.1.21-beta.31 because it was last opened 2026-10-03 16:59Z, before Beta 0.1.22-beta.32
   was published (updates on next launch). Both logged `[cloud-replica] host session rejected` only
   while their server's cloud was still off; no cloud workspace was created from that Mac after
   enablement.
2. **Org / Team / Pro / GitHub source / funding / credential** gates — user-specific, unobserved.
3. **Workspace create** on the shared base image — needs no qualification (computer-image.ts:212-246).
4. **Agent turn** — credential binding JOINs `cloud_agent_runtime_qualifications` on exact
   provider/image/runtime-contract/profile/credential-kind (+MCP) (agent-executions.ts:97-125,
   agent-credentials.ts:414-437). A missing row for that kind ⇒ 403 / hidden agent / "runtime needs
   an update" (cloud-workspaces.ts:175).
5. **Build computer** — needs ≥1 enabled approval for the base (computer.ts:404-407); activating
   the result additionally needs fresh exact-image qualification (computer-image.ts:161-207).
6. **Old-engine drift** — old `.strict()` prompt schema rejects `[1m]` model ids and `max`/`ultracode`
   efforts (packages/protocol/src/cloud-commands.ts OLD:27-35 vs NEW:63-81); `permissionMode` is sent
   only when negotiated (cloud-agent-connection.ts:705), native operations are capability-gated.

---

## 2. What we copy from Conductor (and what we don't)

Copy (verified on this VM / Conductor docs; see FINAL-01): versioned runtime directories behind
stable selectors with per-machine state beside them (`sessions/`, `logs/`, `state/`, `disk-epoch`);
a boot script + native host (reaper, authenticated ingress, PTY, file sync, ports, cgroups, memory
watchdog, telemetry) + worker over private stdio; outbound HTTP from VM to control plane;
org **Cloud Computer** with builds, history, one-click activation and per-repo setup scripts;
an admin agent with narrow tools and optimistic concurrency; idle sleep / wake / max lifetime;
REST `/v0` + hosted MCP + CLI over one contract.

Do not copy: agent access to the provider login's sudo; a general token-return Git endpoint (Zeros'
per-actor broker with operation/branch policy is stronger); a local outbox as the authority (Zeros'
control-plane durable record is stronger); undocumented billing on reassignment.

---

## 3. Target architecture

### 3.1 Three artifacts and the identity split

| Artifact | Built by / when | Identity | Contains |
|---|---|---|---|
| **Base snapshot (v4)** | Zeros CI, rarely | named snapshot shared by channels | Boat Ubuntu 24.04 + pinned toolchain (keep the qualified Node 22 ABI first; Node 24 is a separate change), `/opt/zeros-bootstrap`, systemd units, tmpfiles alias, isolation policy (uids, AppArmor, cgroups) |
| **Runtime bundle** | Zeros CI, every release | `runtimeId` + signed manifest digest + runtime contract (digest over every deployed file and protocol/ABI/policy field) | engine bundle, PTY/Cursor hosts, ZSR supervisor, native helpers, pinned Claude/Codex native packages + Cursor SDK, Node, wrappers; ~0.8–1.2 GiB |
| **Org Cloud Computer version** | Org admin "Build computer" | immutable named snapshot per version | base or previous version + runtime cache + repos + restricted recipe output |

A generation pins (R6 §2.3): (a) environment image + provenance digest + provider snapshot id,
(b) base compatibility id + bootstrap/isolation policy version, (c) runtime id + manifest digest +
runtime contract, (d) protocol capabilities, (e) existing fences. Qualification is recorded for
exact runtime + base + credential kind + profile; org versions additionally pass an independent
environment/TCB-integrity verification. Because recipes stay restricted (uid 10004, read-only
system), a verified org version on a qualified base may reuse the runtime's qualification; v3's
exact-image rule is never waived globally. A privileged (sudo) build would change the TCB and is a
separate, weaker profile (D3).

### 3.2 VM layout (new v4 bases only; mirrors `/conductor`)

Boat captures only `/home/user` and changes under `/etc`, `/usr`, `/opt`, `/root`, `/srv`; restore
is a reboot (enabled units restart; hand-started processes don't). Hence:

```
/zeros -> /opt/zeros                         alias recreated each boot (tmpfiles: L /zeros - - - - /opt/zeros)
/opt/zeros-bootstrap/                        immutable qualified bootstrap (part of the base)
    bin/boot, bin/host-dispatch, bin/install, public-keys/, compatibility.json, state/ (install journal)
/opt/zeros-infra/<runtimeId>/                verified immutable runtime bundles (current, previous, pinned)
/opt/zeros/                                  v4 facade (root-owned real directory, like /conductor)
    current -> ../zeros-infra/<runtimeId>    the one pointer flipped (atomic rename)
    previous -> ../zeros-infra/<priorId>     receipt-backed rollback target
    bin -> current/bin                       zeros CLI, git/gh wrappers (dispatch into the per-actor broker)
    worker -> current/worker                 engine, hosts, ZSR, MCP adapters
    manifest.json -> current/manifest.json
    sessions/                                local delivery/ack cache (authority = control-plane DB)
    logs -> /srv/zeros/log, state -> /srv/zeros/state   compatibility projections
    disk-epoch                               once per boot (observability; authority = fresh boot id)
/srv/zeros/{files/workspace,workspace,state,log,home/*}  existing v3 data roots — unchanged
/run/zeros/                                  ephemeral proofs, locks, sockets, admission
/etc/systemd/system/zeros-boot.service, zeros-host.service
/etc/zeros/                                  profile markers (decide path meanings; v1–v3 untouched)
/usr/local/zeros-computer                    restricted org-recipe output
```

On v1–v3 images `/opt/zeros` stays the baked source tree; the facade exists only where the profile
marker says v4. Existing generations keep waking on their saved images.

### 3.3 Boot, admission, install (two-phase; R6 §4)

```
Boat create/resume/fork → systemd
├─ tmpfiles alias; zeros-boot (root oneshot): dirs/perms, boot id, epoch once per boot, recover
│   interrupted installs, verify the cached runtime (see integrity contract) — no network/admission
└─ zeros-host: base-owned dispatcher → root broker, IDLE (no engine, no credentials)
    ├─ control plane: exec probes bootstrap/host key (no bearer); restricted host-key-pinned SSH
    │   delivers one-use admission + expected manifest/profile/base on stdin (today's channel)
    ├─ redeem (workspace/org/generation/setup fence) → artifact delivery grant + fresh engine/bridge creds
    ├─ installer if pinned ≠ current: requested → admission-validated → fetching → materialized →
    │   verified → prior-runtime-drained → pointer-published → live-attested → engine-ready
    │   (failures keep the prior pointer, leave receipts, fail the setup; never "latest")
    └─ re-attest isolation → one-use launch proof → engine → register → readiness = accepted pin
```

**Integrity contract (RV finding 5):** every executable/native/policy byte is verified against the
signed manifest before it runs, by code rooted in the base bootstrap (not by the candidate); a
cached directory is reusable only with that verification or with a qualified authenticated
immutable-storage mechanism. Deferrable checks are limited to non-executable data and must be
named. Measure hydration/verification time on Boat instead of skipping checks.

### 3.4 Credentials, Git, durability, isolation

- Model credentials stay per human, delegated per execution, never in snapshots; org env/secrets are
  injected at boot/turn, never baked; repo/personal vars override org vars; reserved prefixes
  `ZEROS_*`, `ZEROS_INTERNAL_*`, `ZEROS_GIT_AUTH_*`.
- Git: existing per-actor native broker + GitHub write proxy; `/zeros/bin` wrappers dispatch into
  it (report auth failures, link created PRs). Commits keep the initiating human as author.
- Durability: control-plane durable record/command queue remains the authority; `/zeros/sessions`
  is a local cache; checkpoints stay in Zeros' encrypted native checkpoint format.
- Isolation: keep uid/user-namespace/ZSR separation, root broker, read-only deployment for pilot and
  launch; agents never get the provider login's sudo.

### 3.5 Cloud Computer v2

- **States:** `not_built` → `building(vN+1)` → `active(vN)`; failed/cancelled/superseded never
  activate. Org creation provisions nothing (already true). Settings: "Not built yet — Build
  computer"; first click saves a default recipe and builds (single action).
- **Configuration** (versioned, CAS): repositories, install script (restricted recipe), env/secret
  refs, per-repo setup scripts (no rebuild needed), base + runtime pins.
- **Build:** reserve version under a per-org lock and an **account build queue** (fairness,
  backpressure, capacity diagnostics; today maxBuilders=1 and holds persist until deletion proof) →
  builder `from` active version ("Update computer") or base ("Rebuild from scratch", first build,
  base change) with `noEnv: true`, explicit wallet, renewed finite TTL (today 1,800 s) → install
  runtime cache → clone/fetch pinned repo SHAs with build-scoped short-lived tokens → restricted
  recipe (runner must accept an existing prefix for cumulative builds — computer-image-scripts.ts:60,103)
  → sanitize (extended to v4 facade, sessions, logs, epoch, journals, grants, clone credentials) →
  immutable named snapshot → fresh verifier + integrity verification + required qualification →
  **CAS activate** only if config/base/runtime/build identity is still current (D2) → retention.
- **Uncertain outcomes:** operation ids and receipts on every provider call; `cancelled`/404/
  minimal-response fixtures; a late successful save never activates a superseded configuration;
  documented operator recovery for stuck builders (never release holds without cleanup evidence).
- **Retention:** keep artifacts for active, previous, every accepted/recoverable generation
  (including stopped/archived), child bases and configured bases (current rule); storage inventory,
  wallet-balance and paid-extra deletion alerts (Boat deletes unpaid extras after 7 days).
- **Repository seeds (RV 11):** decide whether selected repos are org-wide shared data or project
  only the workspace's repository; test members with different repo grants and removed repos.
- **Admin agent (Phase 4, RV 12):** enforce admin identity/scope in the control plane; either a
  secret-free admin workspace or a documented statement that a shell can read injected env;
  first admin workspace boots on the shared base (D1).

### 3.6 Lifecycle

Engine-observed idle stop (10 min today; keep until cost/start data says otherwise — D6) with final
checkpoint → Boat stop → wake on open/message (new boot id); finite renewable TTL leases as outer
lifetime (Boat has no idle timer; create, fork and resume each consume a start — budget starts across
wakes, builders, verifiers and canaries with headroom).

### 3.7 Accounts, ownership, billing

- **Org creation:** Pro or staff (today staff-only, authz.ts:111).
- **Member cap 10:** distinct members incl. owner; pending invites reserve; all writers (routes.ts
  586/763/1270, workos-sync-events.ts 624/945, auth.ts 1275) under one org lock + DB invariant;
  non-destructive grandfather policy for over-cap orgs.
- **Owner + reassignment:** `created_by` immutable; `owner_user_id` reassignable via the existing
  `cloud_workspace_ownership_transfers` scaffolding (offer → accept, 7-day expiry) or a documented
  pre-authorized spending policy. Cutover under lock: validate recipient org/team/Pro/repo
  eligibility → fence live work (drain/checkpoint/stop or funded continuation — D4) → settle old
  reservations → close old epoch / open new → atomically move owner/assignee/slot 1/access epochs →
  retire old engine/actor/preview/GitHub/background authority and credential consents → fresh setup.
  Historical usage lands on its own epoch via authenticated execution evidence (fix usage.ts:276,
  don't just delete the guard). The `cloud_workspace_pro_sponsor_immutable` trigger is replaced by a
  contract-phase migration (expand lint rejects `CREATE OR REPLACE`) planned like 0101/0103.
- **Owner loss:** on owner departure/downgrade, fence new work and stop/drain or force reassignment
  of running compute — not "wait for next resume".
- **Meters (D5):** VM weighted seconds (billable), agent wall time (informational unless priced —
  never double-charged with VM time), invocations/tokens, build/verifier/admin compute and snapshot
  storage. Each meter binds to its own source identity — agent usage → execution; VM/admin compute →
  allocation lease; build/verifier → build operation; storage → artifact + metering interval — with
  a common payer/sponsor epoch and stable idempotency for all, plus actor, model and credential owner
  where meaningful; transfer-safe. Provider tokens bill the selected credential's account unless you
  choose owner-funded model usage (requires explicit owner credential delegation and consent).
- **No product caps for now:** classify each cap as product (monthly allowance, org quotas, 8
  agents/workspace) vs safety/provider bound (TTL leases, relay budgets, start limits); define the
  uncapped development policy's eligible users/channels and an audited finite-demand funding path
  for **ordinary Pro** beyond 500 h (today only staff can extend; compute_credit_exhausted otherwise);
  for new allowance policies add a **new** policy/extension table with dual-read funding logic,
  leaving the historical 0104 file, the live `pro-monthly-v1` table constraint and issued history
  untouched (purely additive — no contract step needed). Say "metered without product caps";
  provider capacity can still queue/reject.
- **Build/storage sponsor (D7):** an explicit billing sponsor identity and epoch per org, with
  consent and transfer/removal behaviour; Boat's platform invoice stays separate from customer meters.

### 3.8 Public API, CLI, MCP (Phase 5)

One schema/auth/authorization contract for REST `/v0` (OpenAPI from zod), hosted MCP `/mcp`
(Streamable HTTP, OAuth DCR + PKCE, org-bound scopes, API-key fallback) and the `zeros` CLI
(macOS + VMs). Resources: projects/repos, workspaces (create/get/list/rename/sleep/archive/
unarchive/status/preview/reassign), sessions, messages (`after` cursor), cancel, computers/builds,
owner-scoped usage, `/me`. Org-bound user API keys; workspace-issued tokens with explicit,
tested scopes (Conductor's workspace-issued token listed multiple caller-visible workspaces/projects;
cross-user/private access and write scope were not tested — design Zeros' scopes independently); idempotency keys + durable receipts; structured errors (`userMessage`, code,
retryable, traceId); parity tests across REST/MCP/CLI.

---

## 4. Gap analysis (verified; R4 §7)

| Target | Today | Status | Change |
|---|---|---|---|
| T1 one computer/org, versioned lineage | per-org registry + active/previous; builds always from release base (computer.ts:404) | Partial | parent = active (update) or base (rebuild); immutable versions; activate any retained |
| T2 lazy first build | nothing at org creation; Save creates row; Build/Activate separate; unbuilt orgs use shared base | Provisioning satisfied; UX partial | single-click first build; `not_built` UX; CAS auto-activate |
| T3 `/zeros` runtime | baked into image (`/opt/zeros`, `/opt/zeros-runtime`, `/etc/zeros`, `/srv/zeros`) | Missing | Phase 1 |
| T4 Pro per user, many orgs | Pro per user ✓; org creation staff-only | Partial | Pro-or-staff policy (authz.ts:108-126, routes.ts:727, :451) |
| T5 ≤10 members/org | "ten" = writers per workspace | Missing | Phase 3 |
| T6 owner pays | compute follows owner epoch; no agent-usage producer; actor recorded as engine owner | Partial | producer + payer epochs + D5 |
| T7 reassign → future billing | scaffolding table unused; sponsor-immutable trigger | Missing | Phase 3 cutover |
| T8 no limits now | 500 h fixed (TS + SQL CHECK); pro-v1 quotas 10/5; 8 agents; staff-only extensions | Partial | product-cap policy + ordinary-Pro funding path |

---

## 5. Implementation phases

Every phase follows AGENTS.md/RULES.md: failing regression test first for bugs; additive
expand migrations, contract migrations only through the dated operator path; adjacent Vitest per
edit; handoff checks (`pnpm typecheck`, `lint`, `check:ui`, `test:git`, `check:secrets`,
`test:control-plane`, `--dir apps/control-plane typecheck`, `check:control-plane-migrations`,
`check:migration-phases`, `check:protocol`, `check:actions`, `check:runtime-pins`,
`check:licenses`, macOS-only checks on macOS).

### Phase 0 — Restore working cloud on Beta/Production (diagnose first; ~4–10 person-days after the gate is known)
1. **Confirm the first failing gate** per channel with a staff account and an ordinary Pro account:
   create → attach → one turn per agent (valid model/effort for that credential) → Build → note exact
   codes; operator read of actual `cloud_agent_runtime_qualifications` rows per channel.
2. **Diagnose the recurring worker-image attestation failure** ("Worker image attestation failed;
   private command receipt retained") from value-free phase/exit/hash diagnostics. Hypotheses:
   uncaptured Boat base tooling drifting under an exact native-inventory check; lazy hydration
   slowing hash-heavy attestation.
3. **Decouple cloud publication from releases (RV 3):** today `hosted-promotion.yml` `promote`
   needs the worker job to succeed or be skipped, and Production publish needs hosted. Add an
   independent, retryable cloud-worker publication workflow (or dispatch the worker lane outside
   the release graph) so releases keep the last-good compatible worker or close cloud admission
   explicitly; test that a Boat failure during release does not block desktop/hosted publication.
4. **Channel runbook (RV 1)** — `cloud-provision apply` cannot replace an existing tuple (it keeps a
   complete tuple and refuses Alpha apply); the worker lane (`scripts/release/worker.ts`) owns it:
   select the exact source on the permitted branch (Alpha `main`; Beta/Production `release/X.Y.Z`)
   matching the deployed API source → validate credential designations and shared-account admission →
   apply Boat hygiene fixes the build path needs (explicit wallet on snapshot saves/allowance reads;
   `boat_starting` retryable; org client timeout > 60 s; `cancelled` state; >100 named snapshots) →
   build the exact candidate → canaries + cleanup + audited operator qualification → publish the
   tuple via the worker lane → **redeploy** (variables use `skipDeploys`) → read back the served tuple
   from release-identity → run the acceptance matrix → keep the previous tuple as rollback target.
   Order: Alpha → Beta → Production.
5. **Acceptance matrix per channel:** ordinary Pro + staff; base create/attach/turn per agent,
   checkpoint, stop/wake; Build → fresh exact-child qualification → activate → create from the
   child; an org with an old active Computer (current rule rejects a child of a different base for
   new creates — rebuild or document); a workspace pinned to the old worker (recovery/replacement
   procedure preserving data and native history, or disclose the limitation).
6. Raise product quotas for Zeros' own orgs with the existing audited operator tool
   (`manage-cloud-workspace-quota`); ordinary-Pro uncapped funding waits for Phase 3.

### Phase 1 — Runtime bundle and `/zeros` (12–18 pilot; 30–50 production)
1. Regression test + fix for the hash-semantics mismatch: the engine reports `imageContractSha256`
   as its runtime contract (cloud-runtime-attestation.ts:51) while dev org-image qualification joins
   on `image.source_contract` (dev-agent-qualification.ts:95) — different digests.
2. v4 profile + identity split (§3.1); historical v1–v3 meanings untouched; forward migrations only.
3. Bundle build in CI from an exact commit; complete closure tested with the checkout
   inaccessible; signed manifest; content-addressed R2 storage; licenses/notices.
4. v4 base: bootstrap + units + tmpfiles + cgroup layout designed for systemd (today's helpers use
   absolute root-level cgroups and forbid delegation) + AppArmor qualification.
5. Control plane: pin runtime under the create lock; compare the engine's reported manifest identity
   to the admitted pin at registration and readiness; qualification keyed per §3.1.
6. Integrity contract (§3.3) and installer receipts; rollback without irreversible state migrations.
7. Pilot on one dedicated v4 test base (boot, resume, fork, rollback, existing exact
   environment-image qualification preserved), then production migration; existing workspaces move
   only through an explicit "Update runtime" generation transition.

### Phase 2 — Cloud Computer v2 (15–25 MVP; 20–35 full)
Versions + history/activate (CAS); single-click first build; cumulative update vs rebuild-from-base;
account build queue, start budget, uncertain-outcome handling; retention + wallet alerts; repo seed
access rule; per-repo setup scripts; build logs in settings.

### Phase 3 — Accounts and billing (15–30, plus contract-migration calendar time)
Pro-or-staff org creation; 10-member cap across all writers; reassignment cutover + owner-loss
policy; contract-phase trigger replacement (bridge → expand → backfill → mixed-version validation →
dated contract → new rollback target); usage producer + payer epochs; product-cap policy +
ordinary-Pro funding path; build/storage sponsor. Acceptance: Pro beyond 500 weighted hours, a 9th
agent, >5 running / >10 created workspaces, one user across orgs without duplicate monthly grants,
simultaneous transfers, recipient refusal, late usage, owner departure.

### Phase 4 — Admin agent (10–15)
Admin workspace + control-plane-enforced admin tools mirroring Conductor's five; secret policy;
first-build bootstrap on the shared base.

### Phase 5 — Public API/CLI/MCP (20–35, or a narrower MVP)
§3.8 with scopes, OAuth, parity and lifecycle tests.

### Phase 6 — Launch hardening (5–10)
Turn on launch limits (e.g. Pro 500 h), pricing, GC drills, log shipping, security review of the
bundle supply chain and integrity contract.

---

## 6. Decisions needed from you

| # | Decision | Recommendation |
|---|---|---|
| D1 | Workspaces before the first build | Keep today's behaviour (shared Zeros base until the org's first build activates) with a prominent "Build your Cloud Computer" prompt; "blocked until built" only for strict Conductor parity |
| D2 | Auto-activate successful builds? | Yes, with CAS on the exact config/base/runtime/build identity and only after integrity + required qualification; stale/cancelled builds never activate |
| D3 | VM trust model | Conductor's layout/lifecycle now; keep Zeros' isolation for agents; restricted recipes first; an opt-in "privileged build" (sudo apt/dnf like Conductor) later as a named weaker profile with independent qualification of the changed base |
| D4 | Reassignment rules | Initiators: workspace owner, org admins; recipient must accept new spending (or a documented pre-authorization) and be eligible (Pro or staff, repo access); running work is drained/checkpointed at cutover |
| D5 | "Owner pays agent usage" — Zeros meters only, or also the model-provider cost? | **Needs your call.** Recommendation: Zeros meters (VM seconds, builds, storage, agent time as informational) bill the owner; provider tokens stay on each user's own connected account |
| D6 | Idle sleep | Keep 10 minutes until cost/start-rate data justifies longer |
| D7 | Who pays builds/verifiers/admin workspaces/snapshot storage | An explicit per-org billing sponsor (default: the org creator), recorded now, not charged while uncapped |
| D8 | Update builds vs always rebuild | Default "Update computer" from the active version with pinned repo SHAs; "Rebuild from scratch" button; rebuild required when the base changes |
| D9 | Non-Pro members; owner downgrade/departure | Non-Pro members may join and view; running/owning cloud work needs Pro; on owner loss, fence new work and drain/stop or reassign |
| D10 | Runtime/base/protocol compatibility policy | Define support by admitted runtime/base/protocol identities, separating the release test floor, artifact retention and authority to wake old generations: pinned generations stay wakeable until an authorized "Update runtime" transition or an announced deprecation with recovery; revoked (unsafe) runtimes fail closed. Keep the existing rule that contract SQL waits until live API rollback targets and the 30-day desktop support window no longer need the removed schema (docs/deployment-environments.md:979-983) |
| D11 | Repository seeds | Treat selected repos as org-shared data only if you accept that every member's workspace can read them; otherwise project only the workspace's repo |
| D12 | Admin agent and secrets | Secret-free admin workspace by default: no org/repo/personal environment secrets injected; the agent's own delegated model connection still follows the existing sealed execution path |
| D13 | Contract-migration timing | Date the sponsor-trigger contract step after the bridge rollout proves no live API rollback target or supported desktop (30-day window) needs the old semantics; the allowance change is additive and needs no contract step |

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Qualification weakened by the identity split | Separate environment-integrity, runtime identity, base compatibility; operator gates kept; restricted recipes; privileged builds = weaker named profile |
| Boot deadlock / duplicate host | Base-owned dispatcher independent of admission and candidate bytes; idle broker; kernel lock; full drain before switching |
| Executing unverified cached bytes | Integrity contract (§3.3): verify every executed byte or qualified immutable storage |
| Admission breaks on symlinks/hard links | v4 verifier with resolved-root pin; v3 untouched |
| Incomplete bundle / ABI mismatch | Closure tests with checkout inaccessible; keep Node 22 ABI first |
| systemd/cgroup/AppArmor fit | Design and qualify the exact final units and cgroup layout |
| Torn upgrade; rollback reading new state | One pointer, fsynced receipts, fenced drain, no irreversible migrations in routine bundles |
| Boat API drift and uncertain outcomes | Hygiene fixes + fixtures (`boat_starting`, `cancelled`, pagination, legacy header warning); receipts; never assume a failed call did nothing |
| Build throughput and start limits | Build queue/backpressure; start budget with headroom; plan tier sized to wakes + builds |
| Snapshot storage and provider deletion of unpaid extras | Retention rules; wallet alerts; explicit wallet scoping; rebuild strategy |
| Money paths (transfer, uncapped funding) | Payer epochs, immutable history, idempotent receipts, race tests |
| Persisted contract migrations | Expand/contract with dated operator contract steps; mixed-version tests |
| Native harness redistribution | License gate, exact versions/hashes, per-bundle qualification |
| Release coupling to Boat | Independent cloud publication lane; last-good worker or explicit cloud closure |

---

## 8. Decisions recorded with the owner (2026-10-04)

| # | Status | Decision |
|---|---|---|
| D1 | Locked | Like Conductor: cloud workspaces only after the org's Cloud Computer has a successful build (Create disabled with a "Build your Cloud Computer" prompt). Changes to repos/env/install script show "Unbuilt changes — Discard / Build computer"; rebuild is a **manual** Build computer click. Setup-script changes apply without a build. Builds must be fast — measure Boat first; no separate verifier VM for routine builds. |
| D2 | Locked | Auto-activate with CAS on exact config/base/runtime/build identity, only after integrity + required qualification; stale/cancelled builds never activate. |
| D3 | Locked | Phase 2 ships install scripts with **privileged (sudo) builds** (Conductor parity) plus a post-script protected-file/TCB check (catches accidents and obvious tampering, not a malicious admin — org admins are trusted with root on the org image, as in Conductor). Agents keep isolated execution. |
| D4 | Locked | Owner/org admins initiate; recipient accepts new spending (or documented pre-authorization) and is eligible (Pro or staff, repo access); running work drained/checkpointed at cutover. |
| D5 | Locked | Users connect their own agent accounts; Zeros never meters or manages model-provider cost. |
| D6 | Locked | Idle sleep stays 10 minutes. |
| D7 | Locked (overrides D5's builds/storage) | No billing sponsor; builds, verifiers and snapshot storage are not metered or charged (Zeros absorbs). At launch Zeros meters only workspace VM running seconds (to the owner); agent time informational. Admin-workspace VM seconds are metered to the admin who created it, like any workspace. |
| D8 | Locked | Conductor model (new immutable version per build, fresh install from base, cached repos, history + one-click activate). **Storage on Boat (proposed):** each build version is a *stopped template sandbox* (Boat: stopped sandboxes and their snapshots are free, no count limit) and workspaces are created by forking the active one; named snapshots ($1.70/month each above 10 per wallet) only for Zeros base images. Retention: keep active, previous, every version a live workspace was forked from, and the last ~10 builds; older history keeps config + repo SHAs and offers "Rebuild" instead of "Activate". Existing workspaces run on their own disks and are unaffected when an old version is removed. |
| D9 | Locked | Non-Pro members may join and view; running/owning cloud work needs Pro; on owner loss fence new work and drain/stop or reassign. |
| D10 | Locked | As in §6 D10. |
| D11 | Locked (interpretation) | Conductor parity: every repo on the Cloud Computer is present in every member's workspace (org-shared data), including for members without GitHub access to that repo. |
| D12 | Locked | Admin workspace = Conductor's "Admin workspace (can edit settings)"; org environment secrets **are injected** (parity). |
| D13 | Locked | Date the sponsor-trigger contract step after the bridge rollout proves eligibility; allowance change is additive. |


---

## 9. Revised plan — internal Conductor parity first (2026-10-04, current)

Scope: Cloud Computers and cloud workspaces working with Conductor parity for **Zeros owners and
developers only**, so the team can test and build features. Deferred until public launch: billing,
payments and usage limits; Public API/CLI/MCP; launch hardening; account-model changes.

| Phase | Scope | Exit criteria | Effort (person-days, one engineer) |
|---|---|---|---|
| A — Foundations | Diagnose the worker-image attestation failure; decouple cloud worker publication from the release graph; Boat client fixes (`X-Boat-Org` on create/fork/snapshot/allowance calls, `boat_starting` retry, >60 s timeouts, `cancelled` state, >100 named snapshots); hash-semantics regression fix; cloud surfaces behind the internal feature gate (`useInternalFeatureActive`), staff-only orgs (already), quotas raised for internal orgs with the existing operator tool; measure Boat create/fork/stop/resume/save timings | Releases never wait on Boat; Boat timings known; internal gate in place | 5–10 |
| B — Runtime bundle + `/zeros` (internal-ready) | v4 base (bootstrap, systemd units, tmpfiles alias, isolation); signed runtime bundle built in CI; two-phase boot + installer; identity split; runtime pinned per generation; agent qualification per runtime bundle run automatically in CI; v3 workspaces keep working | Staff create a v4 workspace on Alpha with the `/zeros` layout, run Claude/Codex/Cursor, sleep/wake, receive a new runtime | 20–30 |
| C — Cloud Computer v2 | D1 (no workspaces before first build; Unbuilt changes → manual Build computer); D2 (CAS auto-activate); D3 (privileged sudo install scripts + protected-file check); D8 (stopped template sandboxes, fork per workspace, history/Activate/Rebuild, retention); D11 (org-shared repos); org env/secrets injection; per-repo setup scripts; build logs; cached repos for fast builds | Fresh org builds in tens of seconds (target set from Phase A measurements); edit → rebuild → new workspaces use the new build while old ones keep running; Activate rolls back instantly | 15–25 |
| D — "Configure with an agent" | Admin workspace ("can edit settings"), admin tools (list/get/create configuration, build status, update repo setup script), org secrets injected (D12), VM time metered to the creating admin with existing meters | Admin agent configures and builds the computer end to end | 10–15 |
| E — Workspace parity pass | Verify/finish on v4: terminals, SSH, port forwarding/previews, one-way file sync, 10-minute idle sleep/wake (D6), shared workspaces for staff | Daily internal use without workarounds | 5–10 |

Total internal scope ≈ 55–90 person-days. Develop on **Alpha** (auto-ships from `main`); Beta and
Production receive the same builds through the normal release train, still internal-only.

**Deferred to pre-launch (decisions stay locked):** Pro users creating orgs and the 10-member cap
(T4, T5, D9); VM-second metering, limits (e.g. 500 h) and payments (D5, D7); reassignment with
billing cutover and the sponsor-trigger contract migration (D4, D13); Public API/CLI/MCP; launch
hardening (remaining production runtime migration work, GC/retention drills, security review of
privileged builds and the runtime supply chain, start-budget/capacity planning, observability).
Existing allowance/metering code keeps running unchanged; staff already receive complimentary Pro
with audited extensions, so internal use is not capped in practice.
