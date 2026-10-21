# Playbook: bug fix

Lessons that name v1 cloud subsystems (checkpoints, seals, custody, accepted
commands, final saves, boot owners) describe code retired by cloud v2. Keep
their general method; those subsystems no longer exist.

1. **Reproduce.** Capture the exact symptom: a closed error code, a failing
   check or user-visible behavior. Note the revision and environment.
2. **Red.** Write the smallest regression test that fails for the stated
   reason. For a race, reproduce it deterministically: hold the contended
   condition, or inject the delay. Never add a sleep and hope.
   For a scheduler, drive the real producer and consumer with a fake clock:
   assert no scheduled work after the queue drains, not just no requests.
   Cover records arriving during a pending flight and an open failure circuit.
   For display clocks, test multiple real consumers: one visible timer, zero
   hidden timers, immediate wall-time catch-up on reveal, and final-unsubscribe
   cleanup. A snapshot read must not consume another consumer's next tick.
   For detached terminal proofs, exercise the real serialized terminal grid
   and replay/live boundary. Persist allocation intent before starting work,
   refuse uncertain restarts, and recheck output after the file read settles.
   Bounded native output proves only the native task, never an agent transcript.
   For hidden observation, start the real consumer hidden, then hold reads and
   invalidations across hide/reveal and A → B → A. Count sibling observers too.
   Assert timers are cancelled, async tails cannot start hidden reads, and a
   superseded response cannot replace confirmed content before catch-up lands.
   Skip intermediate producer states too: a hidden reset can replace a log with
   equal or greater length. Append only when the full snapshot extends the
   confirmed prefix; otherwise replace the rendered buffer.
   When hiding a display clock, advance wall time with the next read held and
   require reset/countdown labels to catch up on reveal from retained data.
   Keep account/owner clearing active when gating passive observation. Hold each
   awaited boundary across hide and account resets, including late clear ACKs;
   serial requests and a final owner-ID comparison alone do not fence A → B → A.
   Let a held read observe hidden state before the visibility event runs; retiring
   that read must still leave one catch-up for a quick reveal.
   For a scoped gate, drive the real request dispatcher for every op it names;
   calling the gate helper directly cannot show that dispatch never selects it.
   For terminal admission refusals, drive repeated passive snapshots through
   optional preparatory writes and the real mirror dispatcher. Retain the exact
   owner refusal until explicit reauthorization or identity replacement; keep
   transient recovery, newer edits and held A → B → A failures independent.
   For history consistency, hold the real service before and after its SQLite
   read. Capture rows and restore metadata together at that synchronous boundary;
   an admission-time global revision must not reject unrelated writes. Retain
   writer/actor fences and bound fresh reads after legacy image I/O, checking
   the original snapshot before persisting any rewritten rows.
   For canonical history, drive production turn persistence and the original
   pinned redactor through queue settlement. Collide a configured literal and
   a one-character prefix with routing fields; filter content by record kind
   while keeping independent identity and watermark refusal controls. Decode
   payload JSON before filtering; arbitrary tool data gets no key-name exemption.
   A suspension holds prompt preparation until it resumes; Stop still ends the
   wait.
   For durable Stop, hold native retirement after a paused ACK, replace the
   transport, and retain the exact operation and command above it. A late Stop
   must not cancel a successor crossing preparation. Also stop a queued
   successor while an earlier command prepares: shared pause blocks future
   claims, not unrelated current admission. Retain legacy Stop fences through
   lost claim replies. Cover late enrollment,
   receipt visibility, the initial connection deadline, and renderer reattachment;
   provider terminal events alone cannot settle the pending Stop.
   For cloud Retry, observe the original accepted command before preparing a
   new send; fresh exact terminal custody must precede any separate attempt.
   Pair close callbacks with the real adapter ACK and workspace reducer: cover
   missing routes, retired neighbors during the wait, and later navigation.
   For warm provider reuse, complete a real first turn and prepare the next
   through the production configuration port and adapter. Preserve the admitted
   cloud model when a composer snapshot omits it; keep Local snapshot semantics
   and reject changed or retired authority. A mocked configuration port cannot
   catch creation-only environment values being cleared on a follow-up.
3. **Root cause.** Trace to the mechanism (`file:line`). If you can only
   observe the symptom, say so, and fix only what the evidence supports.
   Before calling a before/after snapshot "stable", sample the live row for a
   full poll period of every worker that writes it (retry caps included).
   Tolerate only a flip the system's own pollers make without new evidence,
   and pin a transition that must still be refused.
   For worker failures, retain the first closed diagnostic before cleanup and
   across reconciliation, including late heartbeats and expired-claim recovery.
   For deploy handoffs, hold the real stop callback across in-flight work. Yield
   only at verified checkpoints; retain helper identity and the original deadline
   while fencing the old process. Never infer safe replay from a dead worker.
   For optional lifecycle evidence, test old strict wires and isolate reporting
   from authority/ingress budgets. Race cancellation against exact-request
   receipts; canonicalize identifiers before applying replay and storage bounds.
   For a stalled checkpoint, instrument the actual engine stage before awaiting
   its gate. Use finite, coalesced observations on an optional bounded transport;
   a report must never hold up sealing, renew authority, or change heartbeat
   compatibility. Preserve the first failure before cancellation and cleanup.
   For resume bugs, test a real sealed store across fresh engine/writer identities;
   a fresh database cannot expose inherited fences. Require authenticated
   predecessor custody for any atomic scope migration and retain old ACKs.
   For populated checkpoint inventories, inject monotonic time at real SQLite
   reads: cold reads beyond 100 ms must not invalidate a valid proof. Bound the
   whole synchronous proof, share its deadline across nested scans, and check
   empty/final pages. Assert each intended delayed stage actually ran. Distinguish
   native startup failure from the later readiness timeout; registration without
   renewal alone does not prove heartbeat refusal.
   Exercise the actual history rebuild across controls, queue and CP activation
   crash points. Prepared namespaces need fresh CP custody; verify latest heads
   against immutable edit/delete and terminal receipts before issuing new proof.
   Test the next clean stop after recovery and repeated activated unsealed
   handoffs. Retained lineage needs a CP-committed digest or an acknowledged
   successor inventory; an unsealed origin cannot acquire a fabricated seal.
   Repeat complete handoffs and an interrupted, unsealed handoff on that same
   FULL store. Retain closed checkpoint failure sites through setup and cleanup;
   repeating a claim cannot repair missing lineage or authorize an older writer.
   For periodic full cuts, hold original support/mount references, join pending
   freeze before thaw, and join positive thaw before export or network IO.
   Validate inert record schemas and complete coverage independently of hashes.
   A local journal, task freezer or interrupted native receipt cannot stand in
   for Host custody, kernel IO completion or a complete user-data prefix.
   Reproject canonical controls with the predecessor's outbox above the successor's
   cursor. Validate each position in its own writer, retaining native identity and
   refusing uncovered or changed controls without recreating live events.
   A new native stream can have a lower event head than retained history. Compare
   seal event cursors only within their original writer or stream; keep all
   restored NORMAL record coverage and pending-work gates across origins.
   For stop/seal races, hold background replies across the admission fence and
   local cancellation. Assert authority and heartbeats survive through a real
   seal, while explicit revocation and wrong identities remain terminal.
   For cancelled final checkpoints, keep authenticated final control separate
   from record-write admission. Retry against the original frozen writer without
   reopening NORMAL or claims; exercise heartbeat delivery, failed handoff flush,
   lost seal ACK, cancellation ACK, replacement final capture and original drain
   tickets together. A generic cancellation label does not identify the failed gate.
   Keep accepted destructive recovery separate from finite attempt retirement.
   An ambiguous commit retains exact journaled bytes and key after all admitted
   I/O joins. A successor needs positive predecessor retirement and the same
   native custody at consumption. Old claims that ignore RETURNING must fail in
   SQL, and pending/retired app observations must reach every terminal facade.
   Bound draining compute retries by the next finite stop deadline, and attempt
   due escalation before provider I/O. Test both stopped-but-unsettled metering
   and already-expired budgets so a past deadline cannot create a hot retry loop.
   Trace seal refusals through the dedicated transport and local ACK boundary;
   preserve strict request and stored-receipt compatibility when adding evidence.
   For packaged imports, reproduce against staged
   sources; a checkout import or bundled CLI can hide a missing source file.
   For periodic disconnects, inspect client retirement timers before blaming
   server idle limits. Test real server closure, reconnect acknowledgement,
   durable replay and bounded backoff; distinguish planned rotation in logs.
   For actor cleanup, count shared sockets, pending admissions, durable commands and
   unproved native work. Fence old confirmation and context flights before
   releasing registry capacity; test more historical sessions than the live
   cap, final-release timer cleanup and same-session readmission races.
   For accepted cloud executions, cross actor/context observation deadlines
   with a real owned child. Preserve original work/provider/runtime deadlines,
   explicit Stop and real revocation; observation loss cannot mint or retire
   authority. Hold acceptance through Stop and join late receipt cleanup.
   Test actual deadline passage separately from a concurrent row mutation:
   SERIALIZABLE retry can mask the elapsed-time branch.
   For redundant lifecycle writes, test explicit destination navigation with
   admission held across idle drain. Selected-row input alone misses a
   different-row or programmatic open, and joining a retiring flight can
   consume its wake intent. Keep passive reconnect and later Stop inert.
   For pool isolation, test the boot composition and nested DB-bound services,
   not only pool sizes. Hold capacity on real Postgres, prove expired promise
   and callback acquires leave no queued work, and drain every owned pool.
   Inventory independent session-lock holders and hold them concurrently across
   provider barriers; their callbacks and an unrelated worker transaction must
   still progress. Count every lock pool in steady and rollout surge budgets.
   When batching lifecycle reads, retain full post-I/O checks for no-dispatch
   results and retry the whole DB-only admission after a confirmed abort.
   Prove expiry while the actual row lock is held: a clock in a locking SELECT's
   target list can be evaluated before that wait. Keep original deadlines after
   funding, and measure complete passes as well as the shortened region.
   For finite compute leases, distinguish unavailable DB proof from revoked
   authority. Terminate the real connection before and after COMMIT, exhaust
   pool capacity and transaction retries, then re-observe the same allocation,
   reservation, generation and claim. Preserve existing prepaid runway only;
   never replay provider I/O or ambiguous funding. Keep monotonic DB-time bounds,
   closed throw sites, deadline stops and permanent-corruption controls covered.
   For observation-driven rechecks, assert both durable-job and domain-claim
   eligibility. Hold the lease row and provider I/O separately; preserve
   requests after the claim snapshot, retry floors and independent meter lag.
   Pin allocation identity before I/O, including same-resource lease replacement.
   An enqueue or SKIP LOCKED write alone does not prove durable scheduling.
   For exact allocation waits, first observe the real allocator refusal, then
   freeze one edge with no monetary foreign key. Test both settlement/edge
   commit orders and overlapping uncommitted producers: the edge can commit
   and drain before settlement commits, so a visible-waiter conditional hint
   loses that wakeup. Also test a running job and lost enqueue, unchanged pending waits,
   held lease/owner rows, and original claim loss after funding. Recheck the
   frozen scope at final result publication as well as before provider I/O.
   A current-allocation stop proof cannot be reused as a historical proof after
   a legitimate new allocation: retain its exact receipt and test saved source
   retirement together with settlement. Freeze only complete original resource
   identities: test normal first binding before and after publication, including
   a nullable allocation result. Incomplete proof keeps ordinary retry before
   scope comparison; never weaken immutable equality to adopt a later binding.
   Assert fixture mutations themselves
   succeed in the production system role before counting an outcome as red;
   a caught fixture SQL error can otherwise look like a product retry.
   For renewal telemetry, test real success, refusal, concurrency and retirement
   paths. Use a separate monotonic clock, closed labels and bounded aggregates;
   never let logging alter authority outcomes or add idle timers. State exactly
   which boundary completed: a valid transport response is not final admission.
   An audit inside a transaction can record only its pre-insert timing; use the
   existing completed transaction hook for time through COMMIT/rollback, without
   inventing a commit outcome. Keep DB-clock waits separate from monotonic spans,
   add no observation queries or provider calls, and fence closed nested scopes.
   For stop/resume races, hold the final checkpoint open across a real lease
   tick. Preserve its lifecycle intent; test every direct provider-stop caller,
   the native writer seal, and refusal of unsaved dispatch after deadline expiry.
   A stop decision is not provider retirement proof or older-checkpoint custody.
   For migration fixtures, seed historical receipts against the schema at the
   migration cutoff. A current completion service can require tables that did
   not exist then; inspect the underlying SQL error before weakening a guard.
   Checkpoint/stop changes also run `recovery-migration.integration.test.ts`
   alongside the current-schema content, lease and reconciler suites.
   Drive the actual worker and its deadline reader across a lazy migration;
   manually calling adoption can hide an eligibility filter that prevents it.
   Retain earlier engine incarnations: historical erasure custody is not live
   dispatch proof. Bound adoption batches and preserve unproved-work backoff.
   Classify retired legacy attempts consistently in adoption, SQL enrollment
   and erasure claims. Already enrolled loss needs an exact owner receipt;
   preserve its capture facts and accepted Delete, then prove ordinary provider
   completion and physical erasure without converting loss to saved proof.
   For Delete during initial setup, distinguish enrollment, registration, active
   writer and sealed save proof. Replay the accepted Delete through readiness and
   the real recovery worker; preserve its original source and failure clocks.
   Count mutable file projections after record purge even when content heads are
   gone. Test same-org/foreign-org siblings and rollback after DELETE executed.
   For canaries with durable fixtures and moving defaults, test unchanged,
   moved, unavailable and mid-run selection. Refresh at most once against the
   captured qualified tuple, with separate build/lifecycle/cleanup budgets.
   For public admission failures, inject the fault after grant creation. Keep
   a closed phase through confirmed cleanup; only typed transient provider
   errors offer retries. Test unknown defects, failed cleanup and repeated
   grant retirement through the HTTP boundary, without raw exception logging.
   For fixture cleanup, distinguish compute retirement from physical erasure.
   Require the original accepted delete, every generation, fresh exact provider
   proof and a post-I/O authority recheck; preserve storage debt and the D1 gate.
   Test the actual record purge so a signed carry can later retire from positive
   retained proof, never from a missing row or a provider 404 alone.
   Drive the real provider adapter and reconciler from an archiving binding
   through stopped compute with a pending/failed snapshot and a storage-blocked
   DELETE. Retain positive compute evidence only under its live claim and exact
   authority/binding, without inventing a resumable snapshot; then exercise the
   retirement endpoint. A fixture seeded already stopped hides this failure.
   For a failed delete followed by a fresh accepted retry, bind cleanup to the
   successor without rewriting the failed intent. Replay the older key after
   the successor and after its job fails; neither replay may rebind or reset
   that job. Recheck current intent failure and replacement across provider I/O.
   Also replay a successor accepted by the old producer before deployment:
   deployment alone cannot repair request-time linkage. Require unambiguous
   exact intent custody, keep its key and preserve worker progress and leases.
   Cover operator skips after physical completion; linkage reconciliation must
   not turn into an implicit retry of a failed record purge.
   If an operator must replace a failed DELETE, retain the original attempt
   and append exact signed cleanup-only custody. Exercise exporter, Actions
   restore, fresh successor proof and consumed replay together; recovery must
   neither redispatch DELETE nor relabel the failed source as successful.
   For account selection, observe the exact selected revision and material;
   vault presence and refresh metadata are not authority. Re-read durable state
   after expiry, require positive release or retirement, and commit bounded
   closure progress. Preserve explicit IDs and committed lost-ACK replay; only
   a later explicit request may start a separately fenced successor.
   For owner-discard restore, exercise a fresh allocation with only an older
   ACKed checkpoint and no live FULL ledger. Missing custody is a distinct
   authenticated request mode, never permission to borrow stale history.
   Retain CP command IDs, edit/delete fences and unknown coverage without
   inventing native ACKs or replaying prompts. Include next-seal lineage and
   stream-local bounds, shared inventory deadlines, and a maximally escaped
   transport body. A failed candidate needs explicit retry after exact cleanup;
   test the real restricted CLI, plan drift, rollback, and original-receipt
   replay separately from the new candidate's eventual readiness.
   For owner-discard Delete, drive the actual initiating Stop producer and
   allocation adoption. An engine-failure reason on a compute-produced Stop
   does not cover an engine-health Stop key. Keep expired undelivered capture,
   undispatched intent, exact allocation and live-engine refusal controls.
4. **Fix** the root cause with the smallest change. Keep compatibility.
   Local and cloud placements must both stay correct.
5. **Green.** Run the regression, the adjacent suites and the static gates
   (`zstack-verify`).
6. **Review** your own full diff (`zstack-review`), then deliver
   (`integrate-pr.md`).
7. **Learn.** If the bug escaped an existing check, add an eval case and
   strengthen that check (`zstack-learn`).
