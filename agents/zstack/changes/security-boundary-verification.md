Security checks can pass while a different runtime layer still owns the real
operation. Use the effective provider configuration, the native DOM in an
isolated world, immutable authorization generations and the descriptor used by
the actual reader. Capture shared VM images before delivering source or setup,
and preserve historical source scope across restore. These contracts are encoded
in the repository authority, cloud source, browser DOM, filesystem and MCP
regression suites added with this change.

A mock looking only for a literal secret misses its encoded form in command
arguments. Keep secret input separate from command text and test both forms;
the Boat input regression covers the authenticated upload, private directory,
unlink-before-execution and cleanup. Provider-shaped tests still require live
qualification before release.

Native ESM bindings can bypass a spy on a built-in module's default export.
Synchronize the built-in exports in deterministic filesystem race fixtures and
restore them afterward; require an assertion failure, not a missing-file or
environment error, as red evidence. The development ancestor-swap and macOS
system-alias contract tests encode this. Aliases owned by the OS do not permit
following mutable workspace descendants; native macOS verification remains a
separate requirement.

Shared development plugins cross standalone dependency graphs. Keep their
declarations structural instead of exporting one install's private Vite types,
preserve upstream secret exclusions, and qualify the explicit serving roots
with the complete UI smoke suite. CJS helper paths also need an actual bundled
execution from an unrelated working directory; a source-module test cannot
establish packaged resolution.

A production-only dependency audit does not cover the tools that build and
test the release, or standalone deployment lockfiles. Audit each graph, retain
advisory floors, and inspect the resolved peer versions: pnpm can keep an old
auto-installed peer even after an override changes its required range. Preserve
local dependency patches when upgrading and execute their behavioral tests.
Report an unpatched advisory and its actual reachable path instead of hiding
it with an audit exception.

Do not hydrate dependency graphs or run other Vite-server fixtures during the
full UI smoke run. They can replace the shared optimized-dependency cache and
cause stale-module 504s midway through otherwise passing scenarios. Complete
installs and unit tests first, then run the smoke against a stable graph; an
interrupted or stale-cache run is not a UI pass.

Real-shell fixtures must observe the process exit before removing its home
directory. Bash can still write `.bash_history` after a kill was requested;
that races recursive cleanup even when every product assertion passed. The
cloud terminal tests now exit explicitly and await the native exit event.

An explicit serving allowlist also needs positive import tests for shared
synthetic harness data. A production build does not exercise those imports.
Admit the exact fixture file, retain HTTP checks that neighboring scripts and
private paths stay denied, then rerun the real harness that imports it.

Exercise normal development as well as the HMR-disabled smoke mode. React's
refresh module uses a reserved virtual ID that resembles an absolute path;
admit only that exact plugin-owned ID and keep HTTP tests for both Vite apps.

For access to a set of repositories, retain each original observation deadline
through the complete check and the final durable identity reads. A slow later
repository must not extend an earlier cached grant or conceal its reconnect.
Test expiry during both remote checks and final identity reads, plus a normal
retry that refreshes only stale observations.

In a browser fixture reset, leave the old document before clearing storage.
Its pagehide/beforeunload handlers can otherwise restore durable drafts after
the clear, and eager imports can read them before the next fixture resets.
Clear from an empty same-origin document, preserve intentional reload tests,
and reproduce isolation failures with the actual preceding scenario included.

Source-bearing build logs need the same complete-scope freshness check as
legacy workspaces, including a final check after the log read. A loop of
individually valid repository checks can disclose a combined response after
an earlier observation expires or reconnects. Temporary credential cleanup is
also remote I/O: recheck human permission and durable generation after it,
before releasing the credential. The source-authority HTTP regressions and
repository-authority cleanup regressions retain both failures.

Native Browser smoke exposed confirmation prompts on standalone buttons whose
effective type is submit but which have no form owner. Preserve the explicit
form-ownership observation; use type alone only when ownership is unknown.
The Chromium DOM regression retains absent, invalid and mixed-case button types
alongside the consequential-action and unknown-ownership controls.

A successful app build and source-helper test did not prove the compiler could
load its packaged module. Electron main resolves Sass inside app.asar, while
its Node-mode child cannot read that archive. Unpack the actual compiler and
dependency closure, translate the trusted path, and execute a real compilation
from a staged archive built with the shipping configuration. The staged-asar
Sass regression also catches a future dependency missing from that layout.

An immediate raw command on a newly forked Boat VM returned a transient 502;
the production lifecycle's bounded boot-readiness retry succeeded. Live probes
must exercise that production entry point and preserve the initial failure,
rather than change product retry policy to match an incomplete harness. Keep
resource receipts until provider deletion has been positively observed.

The real development reset failed because its CLI returned an inventory promise
without awaiting it before finally closed the database pools. Helper-only tests
missed the operation's owning scope. Keep the pools alive through transaction
settlement, and test the actual stdin CLI over a held asynchronous acquisition,
including its failure and redaction path. The cloud-local-database-cli regression
reproduces both premature closes without needing provider credentials. The next
real reset exposed a dynamic-import cycle: the drain imported the still-running
CLI entry point to reach an ownership helper. Import the helper's owning module
directly, and retain an actual CLI drain case; helper-only calls do not exercise
Node's top-level-await evaluation or prove that reset can reach cleanup.

A Linux Xvfb diagnostic of the Mac Browser fixture captured a stale cyan frame
with both the patched and original Browser sources. Retain the image and the
base comparison; do not call an unsupported-platform failure a new regression
or substitute it for the required macOS compositor check.

A repository owner/name can be reassigned after a transfer. Rechecking that
name before and after a log read still authorizes the replacement. Record
server-observed immutable IDs before queueing source-bearing work, preserve
them through saved recipes, reactivation and refresh, and include them in
credential scope and authorization-cache keys. Legacy unknown provenance stays
unknown; retain the data and refuse release. The Computer provenance database,
HTTP, authority and real-Git transfer regressions cover this boundary, including
failed/partial build logs and ID-based pinned setup selection.

Resolve provider identity before taking database mutation locks, then compare
the exact configured revision and active-build selection under the lock before
writing. Otherwise slow GitHub reads can exhaust the lifecycle query pool or
publish over a newer edit. The existing lock-wait/admin tests and the held
provider/CAS regression exercise both fences. Store source identity separately
from strict public recipe JSON so clients cannot submit trusted provenance;
enforce build-binding immutability in SQL as well as at the service boundary.

Source resolution is another asynchronous admission step. A builder must
recheck its resource lock after that I/O, immediately before delivering clone
credentials, running setup or activating the result. Retained lock-loss
regressions reproduce both a clone dispatched after loss and an activation
after final source verification outlived the lock. Register new trigger-only
privilege withdrawals by exact statement in the migration phase guard; a SQL
annotation alone is not a reviewed exception.

Integrating a newly added media reader needs more than resolving overlapping
imports and options. Carry the approved canonical root through metadata and
range reads, and use the same bounded descriptor for buffered video as for
images and text. A second path lookup can otherwise widen an earlier grant
after the workspace is replaced. The file-boundary and Electron range-read
regressions replace the directory during inspection and after native approval;
both failed on the mechanically combined implementation.

HTTP fixtures that verify private-path refusal must create their scratch parent
in a clean checkout. A local workspace's pre-existing `.context` hid a fixture
setup failure in both Vite apps; the full fresh-checkout run exposed it before
the requests executed. The serving suite now creates that private parent and
retains every refusal and positive-serving assertion.
