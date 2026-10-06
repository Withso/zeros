# Local workspace impact audit

Task LA, audited 2026-10-06 against main at `3cf8a572`.
Read the merged diffs using `gh pr diff` for
[#330](https://github.com/Withso/zeros/pull/330),
[#334](https://github.com/Withso/zeros/pull/334),
[#339](https://github.com/Withso/zeros/pull/339),
[#340](https://github.com/Withso/zeros/pull/340),
[#342](https://github.com/Withso/zeros/pull/342),
[#343](https://github.com/Withso/zeros/pull/343),
[#320](https://github.com/Withso/zeros/pull/320),
[#323](https://github.com/Withso/zeros/pull/323) and
[#325](https://github.com/Withso/zeros/pull/325), then traced their shared callers.
The evidence links below pin the audited source rather than moving with main.

## Local workspace impact

No unintended local behavior change was found in these nine diffs. This is a
source review and automated-test finding, not native macOS qualification.
No production fix, migration, dependency, persisted-key or protocol-version
change is needed for the audited local paths. The full Linux UI smoke run is
**not green**: model-menu assertions and a Design inspector harness deadline
remain unresolved. See Verification for the baseline comparison and limits.

The execution boundary is workspace placement, independent of organization
ownership. Device Personal rows have `organization_id = NULL, placement = local`;
an organization's local-placement rows retain their organization ID and still
use the local sidecar. Only cloud-scoped keys route through a cloud peer and
the VM's `cloudWorker`. See [Workspace placement](../organizations-and-teams.md#workspace-placement).
The new routing guards exercise both local owner representations while a cloud
peer is open, preserving the original Git request parameters and response.

The intentional shared changes are the all-tab status frame in #334, the
additive remote branch-list operation in #320, and Review diff-freshness handling
in #342. The new GitHub actor context is cloud-only; local token revalidation
already existed before #342. #334 keeps local engine state separate from
cloud setup state. Its existing six-reason rejection tests verify the original
update/sign-in toast when no local frame is visible, dismissal while a frame
represents it, restoration when the last frame hides, and clearing on recovery.

Added 22 local regression cases across ten test files:

- Local `CONNECTED` precedes synchronous listeners; readiness is immediate with
  no probe or cloud diagnostics. Forty queued requests flush in order without
  the cloud in-flight cap. Sent work rejects on disconnect rather than replaying;
  cancellation and reconnect-queue expiry retain their existing behavior.
- Personal and organization-owned local Fetch/Pull/Push stay on the sidecar
  without cloud grants. Engine dispatch for those operations and GitHub reads
  has no cloud actor, Git author or read/write context.
- Local Undo/Redo omit cloud source-generation preconditions, retain the local
  wire shape, and update only the local Design snapshot beside a cloud snapshot.
  Existing local service tests also exercise real durable Design Undo/Redo.
- Local provider availability and model choices retain the confirmed local
  registry while cloud runtime qualification changes. Local transcript hydration
  continues while cloud background reads are disabled.
- Local GitHub PR/branch reads use the local token during a concurrently held
  cloud read, then recheck token replacement/sign-out. Local inline review retains
  GitHub's viewer resolve/unresolve permissions.
- All local folders share sidecar availability, including the original
  reconnect grace/escalation, independently of a failed cloud setup.

## Cloud workspace impact

This PR adds tests and an audit report; it changes no runtime path. Existing
cloud readiness probes/in-flight limits, actor Git/GitHub contexts, provider
qualification, and Design generation checks remain in place. The local guard
fixtures also keep a cloud peer/cache/read active to prove owner/placement
isolation. Existing cloud suites ran in the broad root run; this is automated
coverage, not a live Alpha or multi-device qualification.

The covered cases are device Personal/local, organization/local, and
organization/cloud. Switching between them retains exact-key snapshots and
keeps cloud grants/runtime qualification from changing local reads or menus.

## Classification and requirements

- **a**: cloud-only behavior, with its guard or guarded caller cited.
- **b**: intentional shared behavior, with its requirement cited. Additive
  exports, regression fixtures and harnesses also fall here and do not alter
  existing local runtime behavior.
- **c**: unintended local behavior change. None found; therefore no failing
  production-regression/fix pair is claimed.

Requirement **H** is #330's authenticated attachment/ordered replay fix; the
shared handshake ordering preserves immediate local readiness.
Requirement **W** is #334's explicit all-tab feedback requirement and
[design-system feedback contract](https://github.com/Withso/zeros/blob/3cf8a572/docs/design-system.md#L243).
Requirement **G** is #342's requirement to preserve Local/v3 token reads and
courier writes while introducing v4 actor reads, including coherent Review diff
revalidation. Requirement **C** is #320's additive branch-source API/reuse for
Cloud Computer creation, with unchanged behavior outside computer mode. The
linked PR descriptions record these requirements.

Path prefixes in the tables: `R` = `apps/desktop/src/renderer`, `E` =
`apps/desktop/src/engine`, `P` = `packages/protocol`, `S` = `scripts`.
The tables account for every desktop/protocol file touched by the nine PRs:
137 file occurrences, including tests and harnesses. #325 has no shared
desktop/protocol file; its cloud setup worker is included explicitly.
Control-plane changes and operator diagnostics are cloud-only services/scripts,
not local sidecar callers; this audit does not change or qualify their live paths.

## Test references

These references identify coverage; command results are recorded in Verification.
Paths use the same prefixes as the audit table. New local guards are marked **new**.

| Ref | Suites / browser coverage |
| --- | --- |
| L1 | **new** `R/platform/bridge/__tests__/ws-client-local-lifecycle.test.ts`; existing `ws-client-actor-lifecycle.test.ts`, `ws-client-errors.test.ts` in the same directory |
| L2 | `R/platform/bridge/__tests__/workspace-runtime-client.test.ts` (**new** Personal/org local Git cases) |
| L3 | **new** `E/__tests__/local-workspace-dispatch.test.ts`; existing cloud-managed Git/read-dispatch suites in the same directory |
| L4 | **new** `E/git/__tests__/github-local-read.test.ts`; `github-inline-review.test.ts` (**new** local viewer-permission cases); existing `github-cloud-read.test.ts` |
| L5 | `R/platform/bridge/__tests__/design-bridge.test.ts` and `R/features/design-workspace/__tests__/design-workspace-cache.test.ts` (**new** local Undo/Redo cases); existing `E/workspace/__tests__/service.test.ts` durable local history cases |
| L6 | `R/features/agent/__tests__/workspace-agent-registry.test.ts` (**new** local hook/model case); existing `cloud-native-ui.test.ts` local command/warning cases and `model-catalog.test.ts` |
| L7 | `R/features/agent/__tests__/transcript-hydration-retries.test.ts` (**new** local retry case); existing `R/state/__tests__/chat-reconciliation.test.ts` local mirror cases |
| L8 | `R/state/__tests__/workbench-availability.test.ts` (**new** local owner/cloud-setup isolation case, existing six-reason hand-off cases); `R/shell/workbench/__tests__/tab-status.test.ts`, `tab-status-contract.test.ts`; exact-key/race suites and full `pnpm test:ui-smoke`, including `S/ui-smoke-workbench-status.mjs` |
| L9 | `pnpm test:workspace-lifecycle`, including local Git, settings, workspace persistence/ownership and `E/workspace/__tests__/service.test.ts`; `E/git/__tests__/github.test.ts` branch listing and `R/platform/bridge/__tests__/workspace-bridge.test.ts` |
| L10 | `R/shell/__tests__/workspace-file-data-cache.test.ts`, `workspace-files-cache.test.ts` retain local exact-key data on read failures |
| L11 | Existing `R/shell/dispatcher/__tests__/cloud-computer-v2-create-gate.test.ts` Personal/flag/staff/activity isolation, cloud computer source/cache/create suites; `R/features/settings/__tests__/cloud-computer-v2-client.test.ts`, `R/platform/__tests__/cloud-create-options.test.ts`; Cloud Computer browser scenario |

## Shared runtime files

| PR | Shared file | Classification | Evidence | Test |
| --- | --- | --- | --- | --- |
| #330 | `R/app-shell.tsx` | a | Cloud availability callback; local chats return before it. [R/state/chat-reconciliation.ts:17](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/state/chat-reconciliation.ts#L17) | L7 |
| #330 | `R/features/agent/sessions-provider.tsx` | a | Hydration suppression requires a cloud-scoped chat ID. [R/features/agent/sessions-provider.tsx:4844](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/agent/sessions-provider.tsx#L4844) | L7 |
| #330 | `R/features/agent/transcript-hydration-retries.ts` | a | Local retries bypass cloud availability. [R/features/agent/transcript-hydration-retries.ts:57](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/agent/transcript-hydration-retries.ts#L57) | L7 |
| #330 | `R/platform/bridge/cloud-agent-connection.ts` | a | Snapshot coordination is instantiated only by openCloudRuntime. [R/platform/bridge/open-cloud-runtime.ts:105](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/bridge/open-cloud-runtime.ts#L105) | L1, L2 |
| #330 | `R/platform/bridge/cloud-event-reader.ts` | a | Ordered event reader belongs to the cloud peer; local events use the sidecar. [R/platform/bridge/open-cloud-runtime.ts:102](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/bridge/open-cloud-runtime.ts#L102) | L1, L2 |
| #330 | `R/platform/bridge/open-cloud-runtime.ts` | a | Creates a RuntimeClient with a cloud descriptor, then cloud-only readers. [R/platform/bridge/open-cloud-runtime.ts:65](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/bridge/open-cloud-runtime.ts#L65) | L1, L2 |
| #330 | `R/platform/bridge/ws-client.ts` | a + b | Cloud probe/cap are guarded; CONNECTED-before-listeners is the intended authenticated attachment fix (H). Local is immediately ready. [R/platform/bridge/ws-client.ts:1211](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/bridge/ws-client.ts#L1211) | L1 |
| #330 | `R/state/chat-reconciliation.ts` | a | Local mirroring still depends only on confirmedLocalChats. [R/state/chat-reconciliation.ts:17](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/state/chat-reconciliation.ts#L17) | L7 |
| #330 | `R/state/cloud-workspace-catalog.ts` | a | Background readiness reads the exact cloud document; only cloud callers consult it. [R/state/cloud-workspace-catalog.ts:86](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/state/cloud-workspace-catalog.ts#L86) | L7, L8 |
| #330 | `P/package.json` | a | Adds a private cloud diagnostics export; does not change existing exports. [P/package.json:16](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/packages/protocol/package.json#L16) | L1 |
| #330 | `P/src/cloud-bridge-diagnostics.ts` | a | Diagnostic output requires cloud scope; the bounded pure close classifier has no local side effects. [R/platform/bridge/ws-client.ts:1145](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/bridge/ws-client.ts#L1145) | L1 |
| #334 | `R/features/browser/use-cloud-preview-admission.ts` | a | Admission requires a cloud key and active internal-feature gate. [R/features/browser/use-cloud-preview-admission.ts:99](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/browser/use-cloud-preview-admission.ts#L99) | L8 |
| #334 | `R/features/browser/use-iframe-webview.ts` | b | Awaitable reload reports iframe load/error while retaining the loaded URL. Requirement W. [R/features/browser/use-iframe-webview.ts:752](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/browser/use-iframe-webview.ts#L752) | L8 |
| #334 | `R/features/code-review/review-feedback.tsx` | b | Moves managed passive review failures into the frame. Requirement W. [R/features/code-review/review-feedback.tsx:20](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/code-review/review-feedback.tsx#L20) | L8 |
| #334 | `R/features/code-review/use-code-review.ts` | b | Retry returns the existing exact-key cache refresh flight. Requirement W. [R/features/code-review/use-code-review.ts:227](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/code-review/use-code-review.ts#L227) | L8 |
| #334 | `R/features/code-review/use-github-review.ts` | b | Exposes awaitable exact-PR retry; confirmed review content stays retained. Requirement W. [R/features/code-review/use-github-review.ts:272](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/code-review/use-github-review.ts#L272) | L8 |
| #334 | `R/features/design-workspace/design-workbench-surface.tsx` | b | Only successful Design lookup exposes configuration; confirmed content remains visible. Requirement W. [R/features/design-workspace/design-workbench-surface.tsx:63](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/design-workspace/design-workbench-surface.tsx#L63) | L5, L8 |
| #334 | `R/features/design-workspace/design-workspace.tsx` | b | Design refresh failure participates in the shared frame. Requirement W. [R/features/design-workspace/design-workspace.tsx:112](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/design-workspace/design-workspace.tsx#L112) | L5, L8 |
| #334 | `R/features/design-workspace/state/use-design-lifecycle-feedback.ts` | b | Passive Design lookup failure becomes persistent read status. Requirement W. [R/features/design-workspace/state/use-design-lifecycle-feedback.ts:12](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/design-workspace/state/use-design-lifecycle-feedback.ts#L12) | L5, L8 |
| #334 | `R/platform/bridge/use-bridge.tsx` | b | Wires reason-specific local rejection toast/frame hand-off; transport still owns recovery. Requirement W. [R/platform/bridge/use-bridge.tsx:37](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/bridge/use-bridge.tsx#L37) | L1, L8 |
| #334 | `R/shell/terminal/terminal-session-view.tsx` | b | Reports spawn/read failures without replacing confirmed scrollback. Requirement W. [R/shell/terminal/terminal-session-view.tsx:46](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/terminal/terminal-session-view.tsx#L46) | L8 |
| #334 | `R/shell/terminal/terminal-workbench-layout.tsx` | b | Terminal toolbar occupies the shared frame toolbar slot; ownership is retained. Requirement W. [R/shell/terminal/terminal-workbench-layout.tsx:70](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/terminal/terminal-workbench-layout.tsx#L70) | L8 |
| #334 | `R/shell/workbench/design-deck.tsx` | b | Retained Design tab receives a frame; hidden activity stays gated. Requirement W. [R/shell/workbench/design-deck.tsx:12](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/design-deck.tsx#L12) | L5, L8 |
| #334 | `R/shell/workbench/tab-content.tsx` | b | All tab adapters receive the structural frame and one status slot. Requirement W. [R/shell/workbench/tab-content.tsx:12](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/tab-content.tsx#L12) | L8 |
| #334 | `R/shell/workbench/tab-status-model.ts` | b | Local connecting/reconnecting and rejection copy use sidecar state. Requirement W. [R/shell/workbench/tab-status-model.ts:145](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/tab-status-model.ts#L145) | L8 |
| #334 | `R/shell/workbench/tab-status.tsx` | b | Stable single banner aggregates availability and exact-target read failures. Requirement W. [R/shell/workbench/tab-status.tsx:153](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/tab-status.tsx#L153) | L8 |
| #334 | `R/shell/workbench/tabs/browser-tab.tsx` | b | Preview load/retry joins the frame while explicit action toasts remain. Requirement W. [R/shell/workbench/tabs/browser-tab.tsx:117](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/tabs/browser-tab.tsx#L117) | L8 |
| #334 | `R/shell/workbench/tabs/changes-diff-viewer.tsx` | b | Diff reads use the frame instead of duplicate error controls. Requirement W. [R/shell/workbench/tabs/changes-diff-viewer.tsx:30](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/tabs/changes-diff-viewer.tsx#L30) | L8 |
| #334 | `R/shell/workbench/tabs/changes-scope-menu.tsx` | b | History loading/errors move to the owning frame. Requirement W. [R/shell/workbench/tabs/changes-scope-menu.tsx:268](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/tabs/changes-scope-menu.tsx#L268) | L8 |
| #334 | `R/shell/workbench/tabs/changes-surface.tsx` | b | Primary and secondary Changes sources share one Retry. Requirement W. [R/shell/workbench/tabs/changes-surface.tsx:308](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/tabs/changes-surface.tsx#L308) | L8 |
| #334 | `R/shell/workbench/tabs/changes-tab.tsx` | b | Awaitable retry retains confirmed exact-workspace commit/turn menus. Requirement W. [R/shell/workbench/tabs/changes-tab.tsx:845](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/tabs/changes-tab.tsx#L845) | L8 |
| #334 | `R/shell/workbench/tabs/file-viewer.tsx` | b | File loading errors use the frame; exact-path content stays retained. Requirement W. [R/shell/workbench/tabs/file-viewer.tsx:67](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/tabs/file-viewer.tsx#L67) | L8, L10 |
| #334 | `R/shell/workbench/tabs/files-tab.tsx` | b | Files loading errors use the frame instead of clearing confirmed listing. Requirement W. [R/shell/workbench/tabs/files-tab.tsx:66](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/tabs/files-tab.tsx#L66) | L8, L10 |
| #334 | `R/shell/workbench/tabs/ignored-entries.ts` | b | Ignored listing failures retain prior roots and participate in Retry. Requirement W. [R/shell/workbench/tabs/ignored-entries.ts:349](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/tabs/ignored-entries.ts#L349) | L8 |
| #334 | `R/shell/workbench/tabs/review-data.ts` | b | Read-error payload throws; prior exact-PR snapshot remains confirmed. Requirement W. [R/shell/workbench/tabs/review-data.ts:612](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/tabs/review-data.ts#L612) | L8 |
| #334 | `R/shell/workbench/tabs/review-tab.tsx` | b | PR data and diff failures use the frame; exact-PR data survives refresh. Requirement W. [R/shell/workbench/tabs/review-tab.tsx:66](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/tabs/review-tab.tsx#L66) | L8 |
| #334 | `R/shell/workbench/tabs/setup-tab.tsx` | b | Setup reads/spawn state use the shared frame; run/stop outcomes remain actions. Requirement W. [R/shell/workbench/tabs/setup-tab.tsx:73](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/tabs/setup-tab.tsx#L73) | L8, L9 |
| #334 | `R/shell/workbench/tabs/terminal-tab.tsx` | b | Terminal availability uses the shared frame without replacing xterm. Requirement W. [R/shell/workbench/tabs/terminal-tab.tsx:53](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/tabs/terminal-tab.tsx#L53) | L8 |
| #334 | `R/shell/workbench/tabs/workspace-file-tree.tsx` | b | Listing errors join the frame while prior tree data stays retained. Requirement W. [R/shell/workbench/tabs/workspace-file-tree.tsx:55](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/tabs/workspace-file-tree.tsx#L55) | L8, L10 |
| #334 | `R/shell/workspace-file-data-cache.ts` | b | Transport/error payload rejects instead of overwriting confirmed file content. Requirement W. [R/shell/workspace-file-data-cache.ts:111](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workspace-file-data-cache.ts#L111) | L10 |
| #334 | `R/shell/workspace-files-cache.ts` | b | Listing failures retain confirmed files and expose failure subscriptions. Requirement W. [R/shell/workspace-files-cache.ts:166](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workspace-files-cache.ts#L166) | L10 |
| #334 | `R/state/workbench-availability.ts` | b | All local owners share one sidecar state; visible frame controls rejection toast. Requirement W. [R/state/workbench-availability.ts:49](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/state/workbench-availability.ts#L49) | L8 |
| #334 | `R/state/cloud-workspace-lifecycle.tsx` | a | Cloud-only connection/open failures are handed to the affected cloud frame. [R/state/cloud-workspace-lifecycle.tsx:49](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/state/cloud-workspace-lifecycle.tsx#L49) | L8 |
| #339 | `E/zeros-engine.ts` | a | Local dispatch bypasses cloud author and GitHub courier; cloud pull composes both. [E/zeros-engine.ts:8910](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/zeros-engine.ts#L8910) | L2, L3 |
| #339 | `P/src/github-auth.ts` | a | Expanded cloud write set is consumed only inside cloud dispatch. [E/zeros-engine.ts:8915](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/zeros-engine.ts#L8915) | L2, L3 |
| #340 | `E/agents/cloud-agent-lease.ts` | a | Optional v3 customization is requested only by the cloud provider factory. [E/agents/cloud-provider-execution.ts:60](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/agents/cloud-provider-execution.ts#L60) | L3, L6 |
| #340 | `E/agents/cloud-provider-execution.ts` | a | Cloud provider execution is selected only when cloudWorker is configured. [E/zeros-engine.ts:1165](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/zeros-engine.ts#L1165) | L3, L6 |
| #340 | `R/features/agent/agent-chat.tsx` | a | Cloud capability guidance renders only for a cloud execution boundary. [R/features/agent/cloud-native-ui.ts:7](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/agent/cloud-native-ui.ts#L7) | L6 |
| #340 | `R/features/agent/cloud-native-ui.ts` | a | No cloud boundary means no warnings; local commands return unchanged. [R/features/agent/cloud-native-ui.ts:22](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/agent/cloud-native-ui.ts#L22) | L6 |
| #340 | `R/features/agent/workspace-agent-registry.ts` | a | Cloud qualification modifies a separate cache; local hook returns local snapshot. [R/features/agent/workspace-agent-registry.ts:104](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/agent/workspace-agent-registry.ts#L104) | L6 |
| #340 | `R/platform/cloud-workspaces.ts` | a | Adds optional qualification/capability fields to cloud delegation parsing. [R/platform/cloud-workspaces.ts:165](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/cloud-workspaces.ts#L165) | L6 |
| #340 | `P/src/cloud-agent-execution.ts` | a | Adds version 3 to the private cloud customization schema only. [P/src/cloud-agent-execution.ts:76](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/packages/protocol/src/cloud-agent-execution.ts#L76) | L3, L6 |
| #342 | `E/cloud-actor-policy.ts` | a | PR discovery joins cloud actor reads; local engine does not use actor policy. [E/cloud-actor-policy.ts:14](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/cloud-actor-policy.ts#L14) | L3 |
| #342 | `E/cloud-github-read-client.ts` | a | Repository-bound transport is called only by v4 worker dispatch. [E/zeros-engine.ts:8901](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/zeros-engine.ts#L8901) | L3, L4 |
| #342 | `E/cloud-runtime-registration.ts` | a | New read proxy request is used only through the v4 worker transport. [E/cloud-runtime-registration.ts:532](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/cloud-runtime-registration.ts#L532) | L3, L4 |
| #342 | `E/git/github-read-context.ts` | a | Only v4 cloud dispatch establishes this context; absent scope returns undefined for local reads. [E/git/github-read-context.ts:12](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/git/github-read-context.ts#L12) | L4 |
| #342 | `E/git/github.ts` | a | Proxy/auth-retry bypass requires read context; the pre-existing local token, cache and refresh path remains unchanged. [E/git/github.ts:532](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/git/github.ts#L532) | L4, L9 |
| #342 | `E/git/github-inline-review.ts` | a + b | Cloud edit hint overrides only when defined; local viewer permissions survive. Shared diff revalidation is intentional (G); see also line 368. [E/git/github-inline-review.ts:173](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/git/github-inline-review.ts#L173) | L4, L8 |
| #342 | `E/zeros-engine.ts` | a | Read context is installed only for cloudWorker version 4. [E/zeros-engine.ts:8901](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/zeros-engine.ts#L8901) | L3, L4 |
| #343 | `E/design/route-params.ts` | a | Source-version validation is called only when options.actor exists. [E/design/routes.ts:462](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/design/routes.ts#L462) | L5, L9 |
| #343 | `E/design/routes.ts` | a | Cloud actor/source revision checks do not apply to local desktop history. [E/design/routes.ts:462](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/design/routes.ts#L462) | L5, L9 |
| #343 | `R/features/design-workspace/state/design-workspace-cache.ts` | a | Only cloud IDs send render source-version preconditions for Undo/Redo. [R/features/design-workspace/state/design-workspace-cache.ts:1956](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts#L1956) | L5 |
| #343 | `R/platform/bridge/cloud-runtime-wire.ts` | a | Cloud adaptation runs only after cloud target selection; local wire bypasses it. [R/platform/bridge/workspace-runtime-client.ts:704](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/bridge/workspace-runtime-client.ts#L704) | L2, L5 |
| #343 | `R/platform/bridge/design-bridge.ts` | a | Optional history field omitted for unchanged three-argument local call. [R/platform/bridge/design-bridge.ts:447](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/bridge/design-bridge.ts#L447) | L5 |
| #343 | `R/platform/git.ts` | a | Optional history argument forwarded; local cache passes undefined. [R/platform/git.ts:518](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/git.ts#L518) | L5 |
| #320 | `E/git/github.ts` | b | Adds bounded branch listing beside existing PR listing; existing local reads keep their token path. Requirement C. [E/git/github.ts:1957](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/git/github.ts#L1957) | L4, L9 |
| #320 | `E/git/index.ts` | b | Adds branch-list export without changing existing exports. Requirement C. [E/git/index.ts:302](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/git/index.ts#L302) | L9 |
| #320 | `E/workspace/service.ts` | b | Adds gh.branchList; local owner/repo handling stays unchanged. Requirement C. [E/workspace/service.ts:5323](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/workspace/service.ts#L5323) | L3, L9 |
| #320 | `R/features/settings/cloud-computer-v2-client.ts` | a | Opt-in active repository field belongs to organization Cloud Computer reads. [R/features/settings/cloud-computer-v2-client.ts:277](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/settings/cloud-computer-v2-client.ts#L277) | L11 |
| #320 | `R/features/settings/cloud-computer-v2-create-gate.tsx` | a | Requires active internal feature, a non-Personal organization and signed-in member. [R/features/settings/cloud-computer-v2-create-gate.tsx:43](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/settings/cloud-computer-v2-create-gate.tsx#L43) | L11 |
| #320 | `R/platform/bridge/workspace-bridge.ts` | b | Adds gh.branchList wrapper; other local bridge operations unchanged. Requirement C. [R/platform/bridge/workspace-bridge.ts:1674](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/bridge/workspace-bridge.ts#L1674) | L2, L9 |
| #320 | `R/platform/cloud-workspaces.ts` | a | Only explicit computer-v2 create options skip personal GitHub proof. [R/platform/cloud-workspaces.ts:296](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/cloud-workspaces.ts#L296) | L11 |
| #320 | `R/platform/git.ts` | b | Adds branch-list wrapper without replacing local Git branch catalogs. Requirement C. [R/platform/git.ts:1992](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/git.ts#L1992) | L4, L9 |
| #320 | `R/shell/dispatcher/cloud-computer-repository-picker.tsx` | a | Cloud repository picker mounted only in computerMode. [R/shell/dispatcher/dispatcher-modal.tsx:587](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/dispatcher/dispatcher-modal.tsx#L587) | L11 |
| #320 | `R/shell/dispatcher/cloud-computer-repository-selection.ts` | a | Selection has an exact user/organization cloud-computer owner key. [R/shell/dispatcher/cloud-create.ts:130](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/dispatcher/cloud-create.ts#L130) | L11 |
| #320 | `R/shell/dispatcher/cloud-computer-source.tsx` | a | Remote-only source picker mounted only in computerMode. [R/shell/dispatcher/dispatcher-modal.tsx:672](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/dispatcher/dispatcher-modal.tsx#L672) | L11 |
| #320 | `R/shell/dispatcher/cloud-create-request.ts` | a | Conflict recovery invoked only for cloud computer source. [R/shell/dispatcher/dispatcher-modal.tsx:299](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/dispatcher/dispatcher-modal.tsx#L299) | L11 |
| #320 | `R/shell/dispatcher/cloud-create.ts` | a | Computer mode requires enabled gate and confirmed ready snapshot. [R/shell/dispatcher/cloud-create.ts:129](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/dispatcher/cloud-create.ts#L129) | L11 |
| #320 | `R/shell/dispatcher/create-from-source.tsx` | b | Exports existing source UI helpers for reuse by the cloud picker; local source implementation is unchanged. Requirement C. [R/shell/dispatcher/create-from-source.tsx:498](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/dispatcher/create-from-source.tsx#L498) | L9, L11 |
| #320 | `R/shell/dispatcher/dispatcher-modal.tsx` | a | Replaces project/source selectors only in cloud computerMode; local create route retained. [R/shell/dispatcher/dispatcher-modal.tsx:587](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/dispatcher/dispatcher-modal.tsx#L587) | L9, L11 |
| #320 | `R/state/read-caches.ts` | b | Adds separate bounded cloud-computer source caches to common invalidation; existing local cache keys unchanged. Requirement C. [R/state/read-caches.ts:115](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/state/read-caches.ts#L115) | L9, L11 |
| #320 | `P/src/cloud-computer-v2.ts` | a | Adds active repository schema only to private Cloud Computer state. [P/src/cloud-computer-v2.ts:93](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/packages/protocol/src/cloud-computer-v2.ts#L93) | L11 |
| #323 | `R/platform/cloud-workspaces.ts` | a | Optional setupFailure field belongs to CloudWorkspaceDocument schema. [R/platform/cloud-workspaces.ts:63](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/cloud-workspaces.ts#L63) | L8 |
| #323 | `R/shell/conversation/cloud-workspace-details.tsx` | a | Setup failure is rendered only in CloudWorkspaceDetails. [R/shell/conversation/cloud-workspace-details.tsx:31](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/conversation/cloud-workspace-details.tsx#L31) | L8 |
| #323 | `R/shell/conversation/cloud-workspace-setup-failure.tsx` | a | Cloud-only details/Setup consumers pass the cloud document failure. [R/shell/conversation/cloud-workspace-setup-failure.tsx:3](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/conversation/cloud-workspace-setup-failure.tsx#L3) | L8 |
| #323 | `R/shell/workbench/tabs/setup-tab.tsx` | a | Failure/document lookup requires a parsed cloud workspace key; local setup uses sidecar setup state. [R/shell/workbench/tabs/setup-tab.tsx:128](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/tabs/setup-tab.tsx#L128) | L8, L9 |
| #323 | `R/state/cloud-workspace-catalog.ts` | a | Setup failure affects generated cloud rows only. [R/state/cloud-workspace-catalog.ts:177](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/state/cloud-workspace-catalog.ts#L177) | L8 |
| #325 | `S/cloud-workspace-validation/sandbox/cloud-setup-process.mjs` | a | No shared desktop/engine/protocol files. Resolver selection is in Linux cloud setup worker only. [S/cloud-workspace-validation/sandbox/cloud-setup-process.mjs:186](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/scripts/cloud-workspace-validation/sandbox/cloud-setup-process.mjs#L186) | Existing cloud-setup worker tests; L9 sidecar lifecycle |

| PR | Shared test, fixture, harness or guidance | Classification | Evidence | Test |
| --- | --- | --- | --- | --- |
| #330 | `R/features/agent/__tests__/transcript-hydration-retries.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/agent/__tests__/transcript-hydration-retries.test.ts) | Existing suite / UI smoke |
| #330 | `R/platform/bridge/__tests__/cloud-agent-connection.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/bridge/__tests__/cloud-agent-connection.test.ts) | Existing suite / UI smoke |
| #330 | `R/platform/bridge/__tests__/cloud-event-reader.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/bridge/__tests__/cloud-event-reader.test.ts) | Existing suite / UI smoke |
| #330 | `R/platform/bridge/__tests__/ws-client-actor-lifecycle.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/bridge/__tests__/ws-client-actor-lifecycle.test.ts) | Existing suite / UI smoke |
| #330 | `R/platform/bridge/__tests__/ws-client-errors.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/bridge/__tests__/ws-client-errors.test.ts) | Existing suite / UI smoke |
| #330 | `R/state/__tests__/chat-reconciliation.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/state/__tests__/chat-reconciliation.test.ts) | Existing suite / UI smoke |
| #330 | `R/state/__tests__/cloud-workspace-catalog.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/state/__tests__/cloud-workspace-catalog.test.ts) | Existing suite / UI smoke |
| #334 | `R/features/browser/__tests__/iframe-load-state.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/browser/__tests__/iframe-load-state.test.ts) | Existing suite / UI smoke |
| #334 | `R/features/design-workspace/__tests__/design-workbench-status.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/design-workspace/__tests__/design-workbench-status.test.ts) | Existing suite / UI smoke |
| #334 | `R/harnesses/harness-workbench-status.html` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/harnesses/harness-workbench-status.html) | Existing suite / UI smoke |
| #334 | `R/harnesses/harness-workbench-status.tsx` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/harnesses/harness-workbench-status.tsx) | Existing suite / UI smoke |
| #334 | `R/shell/__tests__/workspace-file-data-cache.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/__tests__/workspace-file-data-cache.test.ts) | Existing suite / UI smoke |
| #334 | `R/shell/__tests__/workspace-files-cache.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/__tests__/workspace-files-cache.test.ts) | Existing suite / UI smoke |
| #334 | `R/shell/workbench/__tests__/tab-status-contract.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/__tests__/tab-status-contract.test.ts) | Existing suite / UI smoke |
| #334 | `R/shell/workbench/__tests__/tab-status.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/__tests__/tab-status.test.ts) | Existing suite / UI smoke |
| #334 | `R/shell/workbench/tabs/__tests__/review-data-race.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/workbench/tabs/__tests__/review-data-race.test.ts) | Existing suite / UI smoke |
| #334 | `R/state/__tests__/workbench-availability.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/state/__tests__/workbench-availability.test.ts) | Existing suite / UI smoke |
| #339 | `E/__tests__/cloud-managed-git.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/__tests__/cloud-managed-git.test.ts) | Existing suite / UI smoke |
| #339 | `R/platform/bridge/__tests__/workspace-runtime-client.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/bridge/__tests__/workspace-runtime-client.test.ts) | Existing suite / UI smoke |
| #340 | `E/agents/__tests__/cloud-agent-lease.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/agents/__tests__/cloud-agent-lease.test.ts) | Existing suite / UI smoke |
| #340 | `E/agents/__tests__/cloud-provider-execution.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/agents/__tests__/cloud-provider-execution.test.ts) | Existing suite / UI smoke |
| #340 | `R/features/agent/__tests__/cloud-native-ui.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/agent/__tests__/cloud-native-ui.test.ts) | Existing suite / UI smoke |
| #340 | `R/features/agent/__tests__/workspace-agent-registry.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/agent/__tests__/workspace-agent-registry.test.ts) | Existing suite / UI smoke |
| #342 | `E/__tests__/cloud-actor-policy.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/__tests__/cloud-actor-policy.test.ts) | Existing suite / UI smoke |
| #342 | `E/__tests__/cloud-github-read-client.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/__tests__/cloud-github-read-client.test.ts) | Existing suite / UI smoke |
| #342 | `E/__tests__/cloud-github-read-dispatch.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/__tests__/cloud-github-read-dispatch.test.ts) | Existing suite / UI smoke |
| #342 | `E/git/__tests__/github-cloud-read.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/git/__tests__/github-cloud-read.test.ts) | Existing suite / UI smoke |
| #342 | `E/git/__tests__/github-inline-review.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/git/__tests__/github-inline-review.test.ts) | Existing suite / UI smoke |
| #343 | `E/design/__tests__/history-source-versions.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/design/__tests__/history-source-versions.test.ts) | Existing suite / UI smoke |
| #343 | `E/workspace/__tests__/cloud-design.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/workspace/__tests__/cloud-design.test.ts) | Existing suite / UI smoke |
| #343 | `R/features/design-workspace/__tests__/design-workspace-cache.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/design-workspace/__tests__/design-workspace-cache.test.ts) | Existing suite / UI smoke |
| #343 | `R/platform/bridge/__tests__/cloud-design-wire.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/bridge/__tests__/cloud-design-wire.test.ts) | Existing suite / UI smoke |
| #320 | `E/git/__tests__/github.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/git/__tests__/github.test.ts) | Existing suite / UI smoke |
| #320 | `E/workspace/__tests__/service.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/engine/workspace/__tests__/service.test.ts) | Existing suite / UI smoke |
| #320 | `R/features/settings/__tests__/cloud-computer-v2-client.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/settings/__tests__/cloud-computer-v2-client.test.ts) | Existing suite / UI smoke |
| #320 | `R/features/settings/__tests__/cloud-computer-v2-fixtures.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/features/settings/__tests__/cloud-computer-v2-fixtures.ts) | Existing suite / UI smoke |
| #320 | `R/harnesses/harness-cloud-settings.tsx` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/harnesses/harness-cloud-settings.tsx) | Existing suite / UI smoke |
| #320 | `R/platform/__tests__/cloud-create-options.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/__tests__/cloud-create-options.test.ts) | Existing suite / UI smoke |
| #320 | `R/platform/bridge/__tests__/workspace-bridge.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/bridge/__tests__/workspace-bridge.test.ts) | Existing suite / UI smoke |
| #320 | `R/shell/dispatcher/__tests__/cloud-computer-create.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/dispatcher/__tests__/cloud-computer-create.test.ts) | Existing suite / UI smoke |
| #320 | `R/shell/dispatcher/__tests__/cloud-computer-repository-picker.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/dispatcher/__tests__/cloud-computer-repository-picker.test.ts) | Existing suite / UI smoke |
| #320 | `R/shell/dispatcher/__tests__/cloud-computer-source-cache.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/dispatcher/__tests__/cloud-computer-source-cache.test.ts) | Existing suite / UI smoke |
| #320 | `R/shell/dispatcher/__tests__/cloud-computer-v2-create-gate.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/dispatcher/__tests__/cloud-computer-v2-create-gate.test.ts) | Existing suite / UI smoke |
| #320 | `R/shell/dispatcher/__tests__/cloud-create-cold-project.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/dispatcher/__tests__/cloud-create-cold-project.test.ts) | Existing suite / UI smoke |
| #320 | `P/src/__tests__/cloud-computer-v2.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/packages/protocol/src/__tests__/cloud-computer-v2.test.ts) | Existing suite / UI smoke |
| #323 | `R/harnesses/harness-cloud-workspace.tsx` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/harnesses/harness-cloud-workspace.tsx) | Existing suite / UI smoke |
| #323 | `R/platform/__tests__/cloud-workspace-documents.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/platform/__tests__/cloud-workspace-documents.test.ts) | Existing suite / UI smoke |
| #323 | `R/shell/__tests__/cloud-setup-tab.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/__tests__/cloud-setup-tab.test.ts) | Existing suite / UI smoke |
| #323 | `R/shell/__tests__/cloud-workspace-details.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/shell/__tests__/cloud-workspace-details.test.ts) | Existing suite / UI smoke |
| #323 | `R/state/__tests__/cloud-workspace-catalog.test.ts` | b | Coverage for the merged PR; no production behavior. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/apps/desktop/src/renderer/state/__tests__/cloud-workspace-catalog.test.ts) | Existing suite / UI smoke |
| #334 | `docs/design-system.md` | b | Requirement W documents intended feedback on every tab. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/docs/design-system.md) | Existing suite / UI smoke / check:ui |
| #334 | `.agents/skills/zeros-ui/SKILL.md` | b | Generated mirror of W; no runtime code. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/.agents/skills/zeros-ui/SKILL.md) | Existing suite / UI smoke / check:ui |
| #334 | `.claude/skills/zeros-ui/SKILL.md` | b | Generated mirror of W; no runtime code. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/.claude/skills/zeros-ui/SKILL.md) | Existing suite / UI smoke / check:ui |
| #334 | `.cursor/rules/zeros-ui.mdc` | b | Generated mirror of W; no runtime code. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/.cursor/rules/zeros-ui.mdc) | Existing suite / UI smoke / check:ui |
| #334 | `scripts/ui-smoke-workbench-status.mjs` | b | Browser coverage of the shared frame and cloud toast behavior (W); local rejection hand-off has separate Vitest coverage. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/scripts/ui-smoke-workbench-status.mjs) | Existing suite / UI smoke / check:ui |
| #334 | `scripts/ui-smoke/scenarios.mjs` | b | Registers workbench smoke with existing local scenarios. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/scripts/ui-smoke/scenarios.mjs) | Existing suite / UI smoke / check:ui |
| #334 | `scripts/ui-smoke/shards.json` | b | Partitions browser coverage; no runtime code. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/scripts/ui-smoke/shards.json) | Existing suite / UI smoke / check:ui |
| #334 | `scripts/__tests__/ui-smoke-shards.test.ts` | b | Coverage inventory fixture updated for workbench scenario. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/scripts/__tests__/ui-smoke-shards.test.ts) | Existing suite / UI smoke / check:ui |
| #339 | `docs/cloud-workspace/git-github-audit.md` | b | Documents cloud grants and local compatibility. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/docs/cloud-workspace/git-github-audit.md) | Existing suite / UI smoke / check:ui |
| #339 | `scripts/__tests__/repository-layout.test.ts` | b | Document inventory fixture only. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/scripts/__tests__/repository-layout.test.ts) | Existing suite / UI smoke / check:ui |
| #340 | `docs/cloud-workspace/runtime-bundles.md` | b | Documents cloud qualification; does not change local providers. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/docs/cloud-workspace/runtime-bundles.md) | Existing suite / UI smoke / check:ui |
| #342 | `docs/cloud-workspace/git-github-audit.md` | b | Documents G and local token compatibility. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/docs/cloud-workspace/git-github-audit.md) | Existing suite / UI smoke / check:ui |
| #343 | `docs/design-mode-roadmap.md` | b | Documents cloud history generations; native local history remains authoritative. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/docs/design-mode-roadmap.md) | Existing suite / UI smoke / check:ui |
| #320 | `docs/cloud-workspace/template-forks.md` | b | Documents Cloud Computer source selection. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/docs/cloud-workspace/template-forks.md) | Existing suite / UI smoke / check:ui |
| #320 | `scripts/ui-smoke-cloud-computer-v2.mjs` | b | Browser coverage of Cloud Computer source mode and flag/staff isolation; Personal gating has separate Vitest coverage. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/scripts/ui-smoke-cloud-computer-v2.mjs) | Existing suite / UI smoke / check:ui |
| #323 | `scripts/ui-smoke-cloud-workspace.mjs` | b | Browser coverage of closed cloud setup errors. [File](https://github.com/Withso/zeros/blob/3cf8a57244e7c2b54f4335a1f1554758dac98798/scripts/ui-smoke-cloud-workspace.mjs) | Existing suite / UI smoke / check:ui |

## Verification

### Initial audited base (`3cf8a572`)

Run on the Amazon Linux Conductor VM, without provider credentials. OS/browser
prerequisites installed locally: `sudo dnf install -y bubblewrap socat`,
`sudo dnf install -y nmap-ncat`, and `pnpm exec playwright install chromium`.
`pnpm install --frozen-lockfile` restored the existing dependency graph without
changing dependencies or lockfiles.

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Passed, including desktop, Electron and packages. |
| `pnpm lint` | Passed; two existing warnings in `chat-title.ts:56` and `design-canvas.tsx:4899`. |
| `pnpm check:ui` | Passed, clean. |
| `pnpm check:protocol` | Passed; zero wire files changed. |
| `pnpm check:preload` | Passed; 97 commands in sync. |
| `pnpm check:runtime-pins` | Passed; existing Claude wrapper compatibility advisory. |
| `pnpm check:licenses` | Passed; 641 package/version records, 287 documents current. |
| `pnpm check:secrets` | Passed; 6,168 tracked files scanned. |
| `pnpm test:workspace-lifecycle --maxWorkers=2` | Passed: 43 suites, 1,016 tests. |
| `pnpm test:git` | Completed: 1,452 suites passed, 3 skipped, 5 failed; 16,135 tests passed, 45 skipped, 11 failed. See isolated rerun below. |
| `pnpm exec vitest run --config vitest.config.ts scripts/__tests__/repository-layout.test.ts` | Passed: 42 tests. The fixed documentation inventory includes this report. |
| `git diff --check` and `git diff --cached --check` | Passed. |

The initial local guard batch passed **10 suites / 168 tests**:

```sh
pnpm exec vitest run --config vitest.config.ts --maxWorkers=2 \
  apps/desktop/src/engine/__tests__/local-workspace-dispatch.test.ts \
  apps/desktop/src/engine/git/__tests__/github-local-read.test.ts \
  apps/desktop/src/engine/git/__tests__/github-inline-review.test.ts \
  apps/desktop/src/renderer/features/agent/__tests__/transcript-hydration-retries.test.ts \
  apps/desktop/src/renderer/features/agent/__tests__/workspace-agent-registry.test.ts \
  apps/desktop/src/renderer/features/design-workspace/__tests__/design-workspace-cache.test.ts \
  apps/desktop/src/renderer/platform/bridge/__tests__/design-bridge.test.ts \
  apps/desktop/src/renderer/platform/bridge/__tests__/workspace-runtime-client.test.ts \
  apps/desktop/src/renderer/platform/bridge/__tests__/ws-client-local-lifecycle.test.ts \
  apps/desktop/src/renderer/state/__tests__/workbench-availability.test.ts
```

After strengthening the queued-response-timeout assertion, the adjacent command
also passed **4 tests**:

```sh
pnpm exec vitest run --config vitest.config.ts apps/desktop/src/renderer/platform/bridge/__tests__/ws-client-local-lifecycle.test.ts
```

The full Git run's failing suites are unchanged by this PR. Five SSH cases
required `/usr/bin/nc`, which was missing; the other six failures were test
deadlines in Cursor startup, cloud capture/checkpoint and Design page migration.
Resource contention is an inference: the full run overlapped compiler/browser
checks. After installing netcat, rerunning all five suites serially passed
**224 tests, 1 skipped**. The original full run is recorded as failed, not green.

```sh
pnpm exec vitest run --config vitest.config.ts --maxWorkers=1 \
  apps/desktop/src/engine/agents/adapters/cursor-sdk/__tests__/model-passing.test.ts \
  apps/desktop/src/engine/__tests__/cloud-durability-runtime.test.ts \
  apps/desktop/src/engine/agents/containment/__tests__/cloud-checkpoint-artifacts.test.ts \
  apps/desktop/src/engine/design/__tests__/pages-migration.test.ts \
  apps/desktop/electron/__tests__/cloud-workspace-native-ssh.test.ts
```


### Rebased main validation (`d200f9d5`)

Rebased the audit commit onto the latest fetched main, preserving its new
cloud/local registry and Design upload tests. The local model-menu guard
now exercises `modelsForWorkspaceAgent`, main's actual selection helper.
The adjacent conflict-resolution check passed **2 suites / 17 tests**:

```sh
pnpm exec vitest run --config vitest.config.ts --maxWorkers=2 \
  apps/desktop/src/renderer/features/agent/__tests__/workspace-agent-registry.test.ts \
  apps/desktop/src/renderer/platform/bridge/__tests__/design-bridge.test.ts
```

The rebased `pnpm test:git` subset passed **11 suites / 219 tests**, including
42 repository inventory tests. This is a subset; the broad root run and
browser runs above/below used `3cf8a572`.

```sh
pnpm test:git --maxWorkers=2 \
  apps/desktop/src/engine/__tests__/local-workspace-dispatch.test.ts \
  apps/desktop/src/engine/git/__tests__/github-local-read.test.ts \
  apps/desktop/src/engine/git/__tests__/github-inline-review.test.ts \
  apps/desktop/src/renderer/features/agent/__tests__/transcript-hydration-retries.test.ts \
  apps/desktop/src/renderer/features/agent/__tests__/workspace-agent-registry.test.ts \
  apps/desktop/src/renderer/features/design-workspace/__tests__/design-workspace-cache.test.ts \
  apps/desktop/src/renderer/platform/bridge/__tests__/design-bridge.test.ts \
  apps/desktop/src/renderer/platform/bridge/__tests__/workspace-runtime-client.test.ts \
  apps/desktop/src/renderer/platform/bridge/__tests__/ws-client-local-lifecycle.test.ts \
  apps/desktop/src/renderer/state/__tests__/workbench-availability.test.ts \
  scripts/__tests__/repository-layout.test.ts
```

Rebased checks:

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Passed: desktop, Electron and package checks. |
| `pnpm test:workspace-lifecycle --maxWorkers=2` | Passed: 43 suites, 1,019 tests. |
| `pnpm check:secrets` | Passed, 6,216 tracked files scanned. |
| `pnpm build:ui` | Passed, existing large-chunk advisory. |
| `pnpm lint` | Passed, two existing warnings (`chat-title.ts:56`, `design-canvas.tsx:4900`). |
| `pnpm check:ui` | Passed, clean. |
| `pnpm check:protocol` | Passed, zero changed wire files. |
| `pnpm check:preload` | Passed, 97 commands in sync. |
| `pnpm check:runtime-pins` | Passed, existing wrapper compatibility advisory. |
| `pnpm check:licenses` | Passed, license bundle current; existing dependency audit advisories. |
| `pnpm check:control-plane-migrations` | Passed, 132 migrations, including 0131/0132, forward-only versus origin/main. No migration created. |
| `pnpm check:migration-phases` | Passed, 11 phased migrations. |
| `pnpm ci:plan` | Passed; selects desktop renderer/engine, Design containment, cloud runtime, repository contracts, runtime bundle and macOS. No extra labels needed; full UI smoke was run locally. |

No production control-plane, workflow, runtime-asset or protocol file changed
in this PR. Control-plane database/live suites and Actions checks therefore
were not required for this test/report diff.

### Linux UI smoke

Executed the requested full command twice at the audited `3cf8a572` base:

```sh
ZEROS_UI_SMOKE_SCREENSHOT_DIR=/home/vercel-sandbox/zeros/.context/local-impact-audit/screenshots pnpm test:ui-smoke
```

- First run: exit 1 after 169 successful check messages. Sidebar legacy-filter
  reload reached `window.appSidebarState` before that harness function existed
  (`scripts/ui-smoke-app-sidebar.mjs:291`). A harness readiness race is an
  inference; this sidebar scenario passed on the second run.
- Second run, without the broad root test running: exit 1, 510 successful check
  messages and two failed model-menu assertions, “an active default keeps its
  star directly beside its configuration” and “favorite click keeps catalog
  open and search focused” (`scripts/ui-smoke/core-inline.mjs:1129,1137`).
  Design inspector races then stopped at line 50: a style event occurred before
  the fixture's artificial 1,500 ms save window elapsed (expected 0, received 1).
- The reached local scenarios passed: Personal workspace creation, local Git
  controls, retained local sidebar selection, local Design Undo/Redo, source
  adoption/restart, and hidden-surface/conflict behavior. The shared all-tab
  status/browser scenario passed six checks and the narrow/light rejection
  toast check; that browser fixture uses cloud workspaces. Local engine
  rejection/frame/toast hand-off is verified separately by L8 Vitest cases.

Supported shard commands used the same screenshot-directory environment:

```sh
ZEROS_UI_SMOKE_SCREENSHOT_DIR=/home/vercel-sandbox/zeros/.context/local-impact-audit/screenshots pnpm test:ui-smoke --shard=1/3
ZEROS_UI_SMOKE_SCREENSHOT_DIR=/home/vercel-sandbox/zeros/.context/local-impact-audit/screenshots pnpm test:ui-smoke --shard=3/3
```

Shard 1 passed all 22 scenarios (308 successful check messages, including the
harness-declared skip for stylesheet cascade authoring). Shard 3 exited 1
with 240 successful check messages, the same two model-menu failures and an
inspector 300 ms predicate timeout at line 42. Shard 2 was not run separately.
Neither the full run nor shard 3 is claimed as green. The inspector crash
prevents qualification of later scenarios in those runs.

Baseline evidence: none of the nine reviewed PRs touched the model-menu
production component, its catalog assertions, or the Design inspector-races
fixture/harness. A temporary detached checkout of `5c33708d`, immediately before
#330, used the unchanged existing dependencies and those unchanged smoke
methods. The first diagnostic (`node .context/local-impact-audit/baseline-ui-check.mjs`)
passed 128 checks, then reproduced the inspector 300 ms timeout. Repeating
just the menu (`node .context/local-impact-audit/baseline-ui-check.mjs --models-only`)
stopped at the same default-star lookup with a 30 s bounding-box timeout
(`core-inline.mjs:1127`). The baseline's first menu run passed: the repeat
shows lookup instability, not reproduction of both exact failed assertions.
This comparison predates #330/#334/#339/#340/#342/#343; #320/#323/#325 do not
touch those paths. It is evidence of an existing harness/UI limitation, not
a claim that all historical UI behavior is qualified. The temporary server,
processes, dependency symlink and detached worktree were removed.

Run logs and screenshots were saved under `.context/local-impact-audit/`
(gitignored). They contain local fixtures, not provider resources.

### Live verification and manual limits

No live provider operations or resources were created; no Alpha credentials
were required. `pnpm smoke:engine` and native Electron UI smoke on macOS were
not run: this workspace is an Amazon Linux VM with no Mac access. Linux
Playwright smoke uses the renderer harness, not the native sidecar.

Manual macOS follow-up: create a device Personal local workspace and an
organization-owned local-placement workspace, open a cloud workspace beside
each, switch between them, and check local model choices, Fetch/Pull/Push,
GitHub Review and Design Undo/Redo. Restart the local sidecar and confirm
local reconnect/update/sign-in frames and rejection toasts recover correctly,
while the cloud tab retains its own state. With networking unavailable,
verify local-only work, editing and durable history still function; restore
networking for provider-dependent Git/GitHub checks. These checks are
requested, not reported as passed.

## Follow-ups (out of scope)

- Investigate the model-menu default/favorite lookup and focus failures and
  the Design inspector timing fixture on the Linux harness. The full UI smoke
  run remains red; fixing paths untouched by the audited PRs requires a
  separate scoped task.
- Complete native macOS local/cloud switching and offline/restart verification
  above. This audit does not replace native engine qualification.
