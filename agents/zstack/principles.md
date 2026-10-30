# Zeros engineering principles

These principles fold the lessons recorded through zstack 0.1.7: 427 change
fragments and their eval cases. Each one names cases that hold it: find a
case with `node scripts/zstack/evals.mjs --list`, read its `symptom` and `rule`
in `evals/cases/<id>.json` (the first cases live in `evals/cases.json`), and
its fix through the PR in `fixedBy`. Skills and playbooks refer to these by
number instead of repeating them.

## Authority and state

1. **Fence async work by exact identity, and recheck after every wait.** Bind
   each operation to the exact owner, placement, workspace and an immutable
   generation of its own. States cycle and timestamps tie, so neither can
   fence an operation. Recheck authority after every await, lock wait,
   signature, write and I/O, at the final admission boundary as well as at
   entry. Fence failed replies exactly like successful ones.
   Cases: `design-node-warming-lifetime`, `cloud-exact-allocation-wait`,
   `design-snapshot-flight-joins-pre-save-read`, `cloud-chat-mirror-admission`.

2. **Unknown is not empty, false or gone.** A missing, NULL, partial, cold,
   failed or timed-out observation stays unknown. It never proves emptiness,
   deletion, denial or health. Decide what NULL means for rows that predate a
   column (`IS DISTINCT FROM` when unknown means different); guards reject NULL
   (`IS NOT TRUE`, an explicit `CHECK` false). A timeout is not a denial, a
   projection miss is not a tombstone, and a saved account is not a healthy one.
   Cases: `copy-incomplete-transcript`, `transcript-incomplete-resume`,
   `seeded-build-qualification-absence`, `cloud-selected-account-health`.

3. **Presentation is not authority.** Keep the last confirmed exact-key
   snapshot through revalidation, retirement and failure. A cache, optimistic
   row or provisional paint never authorizes a send, retry, recovery, deletion
   or edit. Presentation, delivery bookkeeping and authority are separate facts
   with separate owners.
   Cases: `transcript-transient-cache-retention`, `optimistic-send-presentation`,
   `running-turn-presentation`, `cloud-send-acceptance-queue`.

4. **Durable intent comes before effects, and ambiguity is never permission.**
   Persist an operation's identity, intent, key and deadline before provider
   I/O, and reconcile a lost reply with the same key and bytes. Commit durable
   state before publishing its outcome. Delivery has distinct receipts (local
   journal, server receipt, VM inbox ACK, provider acceptance). Uncertainty
   never becomes a resend. Retry identities live as long as their consumer's
   retry window, and queued work carries the version it was queued for.
   Cases: `cloud-prompt-lost-response-identity`, `seeded-cloud-retry-original-command`,
   `durable-cloud-stop`, `ready-open-without-lifecycle-write`.

5. **The first failure survives.** Capture the first closed failure (site,
   phase, predicate) before cleanup, retry, cancellation or reconciliation.
   Later errors, cleanup labels and timeouts never replace it, and it reaches
   the public result and receipt. Never infer a cause from arbitrary text or
   log raw provider output.
   Cases: `qualification-first-failure-survives-cleanup`, `setup-claim-first-failure`,
   `checkpoint-capture-failure-detail`, `native-proof-closed-predicate`.

## Time, retries and load

6. **Deadlines anchor at the start of the observation.** A slow reply, lock
   wait or renewal cannot extend authority. Carry one original deadline through
   every phase, recheck it after the last lock and await, and compare windows
   with documented bounds that tolerate ordinary clock skew.
   Cases: `authorization-window-clock-skew`, `zeros-dev-native-wait-deadline`,
   `compute-drain-deadline-backoff`.

7. **Retry only typed, bounded, idempotent work.** Retry closed transient
   classes from the provider's documented error envelope (pin its wait fields
   and terminal codes), within the original budget and with a minimum delay:
   full jitter can draw zero. A terminal answer, such as a vanished VM or an
   authentication refusal, ends the operation at once with a named reason.
   Cases: `boat-body-retry-hints`, `alpha-release-edit-retry`,
   `typed-admission-retry-boundary`.

8. **Reads take no mutation locks, and capacity is designed.** Materialize
   bounded `SKIP LOCKED` claim sets, keep a connection free beside every
   long-held lock, cap slow step classes below the pool size, and price each
   recurring query: CPU per call times calls per second, against the
   database's vCPU share.
   Cases: `read-path-took-owner-lock`, `control-plane-pool-ownership-acquire`,
   `warm-context-capacity-commit-order`.

9. **Hidden and background work yields.** Hidden or inactive surfaces own no
   timers, polling, measurement or shortcuts; display clocks stop while hidden
   and catch up on reveal. Background producers yield shared resources to
   foreground work and derive their next due time from state. Passive reads
   never wake a cloud VM. Intent warming is a one-shot read that neither
   subscribes nor mints new generations.
   Cases: `empty-renderer-log-poll`, `cloud-catalog-next-due-timer`,
   `background-task-hidden-clock`, `organization-sync-hidden-observation`.

## Change and compatibility

10. **Change every consumer, entry point and placement together.** Before
    changing a contract, inventory its readers and writers: import closures
    (barrel exports and field readers included), transitive helper importers,
    refresh subscribers, install inventories, runtime pins in both placements,
    smoke callers and accessible names. One admission fence covers every entry
    point. After deleting code, search for its path across `scripts/`,
    `agents/`, `.github/` and `docs/`, and fold retired checks to their Local
    branch.
    Cases: `agent-runtime-pin-parity`, `codex-cloud-pin-parity`,
    `portable-census-consumer-faults`, `new-image-ref-form-unhandled-by-vm-helper`.

11. **Compatibility runs in both directions.** New wire fields are optional
    and tested N/N−1 both ways: the old reader with the new artifact and the
    new reader with the old one. Mirrored contracts carry parity tests, new
    runtime methods and capabilities are negotiated opt-ins, migration fixtures
    stay within their historical schema, and persisted identifiers change only
    through a migration.
    Cases: `base-registration-rollback-cache-version`,
    `recovery-migration-historical-checkpoint`, `control-plane-custody-import-boundary`.

12. **One owner per behavior.** Extend the existing lifecycle, primitive, cache
    or shared definition instead of growing a parallel copy: copies drift. When
    two implementations must exist (Local and cloud, engine and renderer),
    compare them on the same fixtures.
    Cases: `claude-tool-name-contract`, `codex-mcp-json-tables`.

## Tests and evidence

13. **Test through the real boundary.** Drive the production producer to its
    consumer: the real dispatcher, shared reducer, strict wire decoder,
    configuration port, PostgreSQL, PTY, the CLI as advertised and the
    executable the real caller launches. Fixtures take the real wire shape and
    real TTLs. Qualify each provider-shaped fixture against one real response,
    parse platform tool output with a fixture captured on that platform, and
    test a refusal against realistic input before tightening it: a guard that
    ordinary input always trips is a broken feature.
    Cases: `archive-suspends-all-design-tools`, `boat-saved-tree-real-shape`,
    `github-review-canonical-target`, `runtime-radar-hosted-identity`,
    `login-shell-path-backslash-entry`.

14. **Hold the condition; never sleep.** Hold the contended boundary (a
    promise, lock, FIFO or protocol relay) until the code under test observes
    it. Join an operation's full completion before asserting, and advance fake
    clocks at events while counting scheduled work, not only requests. Inject
    stubs and clocks through the channel production reads, and assert that the
    race window was open and the fixture's own mutation succeeded, so a test
    cannot pass vacuously. Test budgets are separate from production
    deadlines.
    Cases: `fixed-sleep-lock-contention`, `job-queue-lost-hint-timing`,
    `dev-database-teardown-drain`, `baseline-ingress-fixture-clock`,
    `retention-pagination-test-budget`.

15. **Browser checks use real input and computed results.** Drive real
    pointer, keyboard (Tab, chords) and selection events instead of calling
    `focus()` or setting state. Switch themes through the appearance store, and
    assert computed styles and decoded pixels against the real adjacent surface
    in both themes. Give each scenario its own storage, clock and dev-server
    cache.
    Cases: `dashboard-card-action-keyboard`, `overlay-first-focus-escape`,
    `deferred-focus-ownership`, `ui-smoke-development-cache-isolation`.

16. **Evidence names exactly what it proves.** Measure the build, element and
    process tree that actually ran, and bind evidence to source fingerprints.
    Physical memory is not RSS or heap; a skipped workflow's success is not an
    executed canary; a parent's exit is not its descendants' retirement; a
    launch acknowledgement is not qualification; a no-tests run is unverified.
    Keep failed runs beside the corrected one, read the enforcing constant
    before quoting a limit, and never claim a platform check from another
    platform.
    Cases: `soak-attempts-and-measurement-coverage`,
    `zstack-replay-infrastructure-is-not-a-catch`.

## Security

17. **Open once and validate the held descriptor.** Open without following
    links (and without blocking where a FIFO could appear), validate that
    descriptor and read through it; never check a path and then read it by
    name. Follow a pointer's route one name at a time, pass shell path lists
    NUL-terminated, bind a native reader to the held original, and test
    permission failures with capabilities dropped. A guard on a destructive
    tool validates the effective target, not its spelling.
    Cases: `seeded-computer-self-test-fresh-descriptor`, `computer-log-document-alias`,
    `load-sim-url-guard-lookalike-host`, `zstack-private-receipt-fixtures`,
    `seeded-transcript-file-custody`.

## The pack itself

18. **Encode lessons in structure; prose is the last resort.** A test, type,
    lint, script or eval case beats a sentence. When agents keep taking one
    path, make that path correct instead of documenting another. A rule earns a
    place here only when no structure can hold it, and it replaces a weaker
    rule instead of adding a near-duplicate.
