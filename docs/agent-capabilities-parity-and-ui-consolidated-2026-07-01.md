# Zeros Agents — Capabilities, Conductor Parity & Chat‑UI Reference (consolidated)

**Date:** 2026-07-01 · **Agents in scope:** Claude Code, Codex, Cursor · **Single source of truth for everything agent-related** (capabilities, Conductor parity, chat UI, and the wire vocabulary).

## What this document is

This single file **replaces four earlier docs** and re-verifies every claim against the current code:

- `conductor-parity-gap-analysis.md` — mined Conductor's runtime/changelog for reliability bugs "we will hit too."
- `claude-codex-capability-audit-2026-06-16.md` — per-adapter capability-gap report (Claude / Codex / Cursor) with UI tags.
- `agent-chat-ui-surface-inventory-and-test-plan.md` — the chat-UI surface catalog, per-agent matrix, design polish, and test plan.
- `agent-events-and-coverage.md` — the canonical wire-event vocabulary + shipped-state coverage audit (now **Appendix A** and **Appendix B** below, re-audited against the code).

Every item below was **re-audited against the codebase on 2026-07-01** by a fan-out of code-reading agents (per-adapter, engine/MCP/auth, UI renderers, tests, and — for the appendices — the `packages/core/src/agent-events.ts` vocabulary + which variants each adapter actually emits). **Where a source doc's status disagrees with the code, the code wins** — and many statuses changed (MCP end-to-end, Cursor `settingSources`, stuck-running reconciliation, most lifecycle resilience, `@pierre/diffs` diffs, and the removal of `ErrorCard`/`hover-preview`/`EditHistory` are all now shipped, while a few things silently regressed — e.g. the `ThinkingBlock` shimmer/redacted badge and the token/cost pill are no longer rendered).

> **Research note / limitation.** SDK and protocol facts here are grounded in the **local type surfaces** the audit read directly (`@anthropic-ai/claude-agent-sdk/sdk.d.ts`, `codex/generated/v2/*`, `@cursor/sdk/**/*.d.ts`) plus the prior adversarially-verified research baked into the source docs. A planned pass of fresh 2026-07 **web** validation of the latest Claude/Codex/Cursor SDK releases and Conductor's newest changelog did **not** complete (session limit). The pinned versions are current as of this audit (below); treat the "newer since docs" surface as worth a periodic web re-check.

**Pinned versions (from `package.json`):** `@anthropic-ai/claude-agent-sdk ^0.3.170` · `@openai/codex ^0.139.0` (`codexProtocolVersion 0.139.0`, enforced by `scripts/check-codex-pin.mjs`) · `@cursor/sdk 1.0.18` (exact-pinned). Codex app-server `minCliVersion 0.131.0`.

---

## 0. How to read this

**Status** (verified against code 2026-07-01):

- ✅ **DONE** — shipped and working (often with tests).
- 🟡 **PARTIAL** — partly wired; a concrete piece is missing.
- ❌ **MISSING** — not implemented.
- ➖ **REMOVED / N-A** — deliberately deleted, or the premise is obsolete against the current protocol.

**UI-work tag** (what kind of front-end work an item implies):

- 🎨 **UI work** — needs a *new or changed* user-visible surface (toggle, card, pill, banner, popover).
- 🔍 **UI-verify** — engine/wiring only, but the result must be *confirmed in the running app*.
- ⚙️ **No UI** — pure engine / protocol / test; nothing user-visible.

**Priority:** P0 (correctness/safety, users hit fast) · P1 (parity users notice) · P2 (hardening/polish) · P3 (nice-to-have) · ✦ (design polish).

---

## 1. How the agent system works (user-centric)

**Zeros is a Conductor-style app for running many coding agents in parallel.** A user opens a chat, picks an agent (Claude / Codex / Cursor) from the `+` menu, optionally sets a model, permission mode, effort, and plan toggle, then talks to it. The agent reads and edits files, runs commands, searches the web, and asks for permission or clarification — all inside a live transcript. Multiple chats (even across different agents) run at the same time, each bound to its own worktree.

### The three agents and how each connects

| Agent | What the user gets | How it runs (transport) |
| --- | --- | --- |
| **Claude Code** | The most complete agent: 5 permission modes, plan mode, live model/effort switching, slash commands, subagents, real cost readout. | `@anthropic-ai/claude-agent-sdk` persistent `query()` (bundled, pinned CLI); permissions via the in-loop `canUseTool` gate. |
| **Codex** | 4 sandbox/approval modes, per-turn model+effort, thread resume from real on-disk history, typed Read/Grep/List cards. | `codex app-server` — long-lived JSON-RPC 2.0 over stdio; permissions via `requestApproval`. |
| **Cursor** | Native cross-restart resume, image input, live model catalog, subagent "Task" cards streamed from disk. | `@cursor/sdk` local `Agent.create/resume` + `run.stream()`, run in a Node subprocess host (`cursor-host.cjs`) under bun; auth via `CURSOR_API_KEY`. No CLI/ACP fallback. |

**Auth posture (load-bearing):** Zeros never stores/transmits/logs vendor tokens — probes check existence/expiry only. Sign-in opens the vendor CLI flow in Terminal (Claude/Codex) or takes a pasted key (Cursor). (Roster + auth-probe detail: **Appendix B**.)

### From agent event → pixel (the render pipeline)

1. **Adapters** (`src/engine/agents/adapters/{claude-sdk,codex,cursor-sdk}/`) translate each agent's native protocol into one shared vocabulary of `sessionUpdate` events (`agent_message_chunk`, `agent_thought_chunk`, `tool_call(_update)`, `plan`, `usage_update`, `available_commands_update`, `current_mode_update`) plus out-of-band `onPermissionRequest`/`onAgentStderr`. *(Full audited wire vocabulary — every variant + which adapter emits it: **Appendix A**.)*
2. The **renderer registry** (`renderers/registry.ts`) is one dispatch table: text-by-role → tool custom matchers → tool-by-kind → fallback → unknown.
3. **`MessageView`** resolves a renderer per message and attaches the inline permission cluster + auto-decision chip beneath the row.
4. Most tools render as **one flat inline `EventRow`**; four kinds peel off to specialized cards — `edit`→`EditCard` (syntax diff), `switch_mode`→`ExitPlanModeCard`, `question`→`QuestionCard`, `subagent`→`SubagentCard`, plus Cursor `task`→`CursorTaskCard`.
5. **`turn-event-list` + `turn-partition`** split each turn into a **working group** (tools, thinking, in-between narration, sub-agents) and the **final answer** (trailing agent text). While the turn is live the working group is a fully-expanded reasoning feed; the instant it settles it folds into one **`N tool calls, M messages, K agents`** chip with a deduped icon strip, leaving the bright answer below.

**Design intent:** while the agent works you watch it reason and act live (Conductor pattern); the moment it finishes, all of that collapses to a single chip and only the final answer stays bright. This is achieved *structurally* (collapse) and with *semantic colors* (tool names at `fg1`, command/path text at `fg2`) — not an opacity wash.

---

## 2. What already works (verified baseline)

### 2.1 Capability matrix (re-verified)

Legend: ✅ shipped · 🟡 partial/degraded · ❌ not supported.

| Capability | Claude | Codex | Cursor |
| --- | :--: | :--: | :--: |
| Streaming events / tool cards | ✅ | ✅ | ✅ (whole-message granularity) |
| Per-tool permission round-trip | ✅ `canUseTool` | ✅ `requestApproval` | ❌ (SDK exposes no resolver — sandbox only) |
| Plan mode | ✅ | ✅ (`read-only`) | ✅ (`plan`) |
| Accept-edits / auto / full-access | ✅ | ✅ | 🟡 (`agent` mode; no gating UI) |
| Resume across turns / cross-restart | ✅ | ✅ (from **real disk** thread id) / 🟡 (see §3.1) | ✅ (agentId == sessionId) |
| Session listing (history) | ✅ | ✅ | ✅ (`Agent.list`) |
| Image input | ✅ | ✅ | ✅ |
| MCP injection (all sources) | ✅ | ✅ | ✅ |
| Slash-command discovery (`available_commands_update`) | ✅ | ✅ | ❌ (built-in floor only — no emit) |
| Subagent **picker** (`available_subagents_update`) | ➖ dormant (never emitted; see App. A.6) | ➖ | ➖ |
| Subagent live internals (rendered) | ✅ (native stream) | ❌ (no subagent tool) | ✅ (on-disk transcript, live-polled) |
| Model picker reaches runtime | ✅ | ✅ (per-turn) | ✅ |
| Reasoning effort control | ✅ (6-tier) | ✅ | ❌ (pill hidden) |
| Cost / token telemetry captured | ✅ (real cost) | ✅ (tokens only) | ❌ | 
| **…but rendered anywhere?** | ➖ **no** (pill removed) | ➖ **no** | ➖ **no** |
| Cancel mid-turn (no context loss) | ✅ | ✅ | ✅ |

### 2.2 Per-agent solid baseline

- **Claude** — `claude_code` preset **always** attached (the cwd invariant; pinned by a test); `settingSources:['user','project','local']` loads CLAUDE.md/rules; live `setModel`/`setPermissionMode`; 1M context via the verbatim `[1m]` model-id suffix; **real per-turn cost** (`total_cost_usd`) captured; `canUseTool` synchronous gate where **Deny ≠ kill turn** (tested); first-turn-never-resumes + cross-restart resume; `interrupt()` (keeps process alive) vs `abort()` (teardown only) with **no signal bleed**; the turn promise **always settles**; partial-message streaming; slash + skill discovery; mid-session effort/Fast/`/add-dir` changes apply **live**, max-turns restarts **resume-preserving** (all tested). **Security hardening (H9):** a privileged default mode (bypass/accept-edits/auto) in an in-repo `.claude/settings.json` is refused — only the user's own `~/.claude` may set one (RCE-by-clone guard).
- **Codex** — full **v2 dual-approval trio** (command exec / file change / expand-permissions) with `accept / acceptForSession / decline / cancel` mapping and sandbox+approval policy from the 4 Zeros modes; per-turn model / effort / serviceTier; `turn/start` + `turn/interrupt`; cwd retarget on resume; turn settles on child-exit and on a 10-min timeout; **Sessions browser resumes from the real on-disk thread id**; dynamic model catalog + effort ladder; slash/skill discovery; typed **Read / Grep / List-files** cards from `commandActions` (tested); reasoning + plan streaming; failing-bash shows its error.
- **Cursor** — native cross-restart resume (SDK `agentId` **is** the Zeros sessionId); image input; live model catalog + a bounded 2-attempt model-gating fallback; `local:{force:true}` recovers wedged runs; `loadSession` **self-heals** a missing agent (→ fresh `Agent.create` in the same cwd, tested); terminal-error recovery reads the SDK's on-disk SQLite `errorCode` that `run.wait()` drops; the bun→Node host workaround; agent/plan mode carriage; and the **subagent transcript reader** → live-polled `CursorTaskCard`.

### 2.3 Cross-cutting resilience that is DONE (many former parity gaps, now closed)

These were open items in the parity/audit docs and are **now shipped** — re-verify in-app as noted, but the engine work is done:

| Theme | Status | User-centric result | Where |
| --- | :--: | --- | --- |
| **MCP end-to-end** (register → dedupe → per-session resolve → inject) | ✅ | Declare an MCP server once in Settings → MCP (or `settings.toml`) and it works across Claude/Codex/Cursor with no restart; repo/workspace-scoped servers only appear for chats in that repo. | `gateway.ts:344/366/378/701/747`, `index.ts:610/641` |
| **MCP config union** (stdio \| http, env/headers) + Keychain secrets + OAuth 2.1 gateway | ✅ | Add a local-command or remote-HTTP server, lock secrets in the OS keychain, click "Sign in" for OAuth — no TOML editing. Committed-repo stdio servers are refused (RCE-on-clone guard). | `types.ts:107-120`, `mcp-registry.ts`, `gateway/server.ts`, `mcp-panel.tsx` (🔍) |
| **Stuck-running reconciliation** (Conductor fixed 4×) | ✅ | A chat never freezes on "responding" — finish, error, cancel, or process death all return the composer to ready / a clear reconnecting-failed state. | `index.ts:1591-1639`, `sessions-store.ts:596`, adapters |
| **Cancellation correctness** (no signal bleed / context loss / phantom interrupt) | ✅ | Stop halts cleanly, the next message keeps full context, and no bogus "error/interrupted" flashes after a cancel. | `claude-sdk/adapter.ts:791-818`, `app-server-adapter.ts:437`, `sessions-provider.tsx:1256/1537` |
| **Session persistence** (no stuck-running on reopen) | ✅ | Reopening a chat closed mid-turn shows it idle + ready with the partial transcript, never a frozen spinner. | `sessions-provider.tsx:583-628` |
| **Continuation hygiene** (no PR/other-chat leak; per-turn file attribution) | ✅ | A new/continued chat doesn't drag stale PR context or another chat's edits; a turn's Changes list shows only what *that* turn touched. | `db/turns.ts:15-18`, `agent-chat.tsx:951-956` |
| **Tri-agent concurrency** (custom exec paths + keys) | ✅ | Run Claude, Codex, and Cursor side by side, each with its own account/key/binary, no interference. | `gateway.ts:232/657/690` |
| **Agent-switch without summary block** | ✅ | Switching agents is instant (a fresh chat via `+`), no wait on summary generation. | `agent-chat.tsx:951-956` |
| **Orphan watchdog + process-group teardown** | ✅ | Crashed engine/agent processes are reaped on next launch; stopping an agent kills its whole subprocess tree. | `electron/sidecar.ts:438`, `shared/stdio-process.ts:83` |
| **Runtime reload after app update; dev HMR defers mid-turn; ZEROS_* env** | ✅ | Auto-update relaunches on the new engine; saving engine code in dev doesn't kill a live reply; the agent always knows its worktree path. | `electron/updater.ts`, `sidecar.ts:1005`, `gateway.ts:216` |
| **Auth invalidation self-heal** (TTL + credential-mtime) | ✅ | The connected dot goes gray seconds after a login expires and greens again on re-sign-in/refresh — no restart. A generic protocol error no longer falsely grays the dot. | `gateway.ts:290-320/598/914` |
| **Session-expired classification** (engine↔renderer, regex-parity tested) | ✅ | A stale thread shows a recoverable "start fresh" message, not a scary error toast, consistently. | `app-server-adapter-failures.test.ts` (99 tests) |

---

## 3. Open capability gaps & tasks (by theme)

Columns: **St** = status · **P** = priority · **UI** = UI-work tag. "User-facing meaning & what's left" is the plain-language workflow + the concrete remaining work. Keep the file:line as the fix anchor.

### 3.1 Lifecycle & transport reconnect

| Task | Agent | St | P | UI | User-facing meaning & what's left | Key files |
| --- | --- | :--: | :-- | :--: | --- | --- |
| **Mid-turn reconnect / recreate-on-next-turn** | codex | ✅ | P1 | 🔍 | Shipped (PR #124; verified 2026-07-10). A mid-turn child death surfaces as a recoverable transport-closed; the renderer auto-rebuilds (reboots the child, `thread/resume`) and resends the same prompt — no manual re-send. If the turn had already streamed content, the duplicate-turn guard keeps the partial answer instead of re-running, and the footer shows an **AGENT STOPPED** pill (2026-07-10: derived from the persisted `failed` turn row so it survives reload; suppressed while a retry is warming; a successful retry rewrites the row to `completed`). A later "continue" resumes the same thread with the partial work in context. Tests: `app-server-adapter-reconnect.test.ts`, `turn-footer.test.ts`. | `app-server-adapter.ts:1101-1150`, `sessions-provider.tsx:1276-1500`, `turn-footer.tsx:67` |
| **Per-session (not agent-wide) crash signalling** | codex | ✅ | P1 | 🔍 | Shipped (PR #124; verified 2026-07-10). `handleRuntimeExit` emits the idle-crash exit with the session's `zerosSessionId`; `AGENT_AGENT_EXITED` carries it end-to-end and `applyBridgeAgentExit` flips ONLY the bound chat — siblings stay live, the agent pool isn't cooled, actively-driven (streaming/warming) chats are left to the prompt-retry path, and terminal states aren't downgraded. Agent-wide exits (no sessionId) still flip every chat. Tests: `sessions-store-agent-exit.test.ts` (7 cases) + the reconnect suite's idle-crash case. | `app-server-adapter.ts:1144`, `sessions-store.ts:692-745` |
| **Mid-turn transient stream-error tolerance** | claude | ✅ | P2 | 🔍 | Shipped 2026-07-10. (1) `system/api_retry` is now consumed: the CLI retries the SAME call itself, and the translator emits ONE `error_notice` row per retry burst (`code:"api_retry"`) so a backoff stall is explained, not silent — the turn continues with nothing lost. While the burst is live the row renders as a shimmer + "Reconnecting agent" (fg1, `event-row-renderer.tsx`); once the stream resumes it settles to a compact static row with the technical message on expand. (2) Exhausted retries (result `is_error` with a network-shaped message) now reject as RECOVERABLE `transport-closed` + a transcript error row — previously they resolved as a silent "refusal" (turn just ended, no error, no retry). Recovery resumes the same Claude session id (full context); if content already streamed, the partial answer is kept + AGENT STOPPED pill (no double-billing re-run). Non-network `is_error` results keep the old resolve. **Codex parity (2026-07-10):** `error{willRetry:true}` notifications (codex retries the same turn itself) now emit the same `code:"api_retry"` notice — one per burst — instead of being silently filtered, so Codex blips show the identical "Reconnecting agent" row. **Cursor:** its SDK has no mid-turn retry phase (status events are terminal-only: FINISHED/CANCELLED/ERROR/EXPIRED), so there's no vendor retry to consume — but a network-shaped stream death now leaves a "Cursor: connection lost — reconnecting" error row before the recoverable throw (`reconnect-notice.test.ts`), so the app-level rebuild+resend is never silent. Non-network deaths stay terminal with no row. Tests: `translator.test.ts` (api_retry burst semantics), `adapter.test.ts` (network→transport-closed, non-network unchanged, timeout wording), `app-server-translator.test.ts` (willRetry burst + never-terminal). | `claude/translator.ts:onApiRetry`, `claude-sdk/adapter.ts` (`TRANSIENT_NETWORK_RX` + result branch) |
| **Host-crash classified recoverable** | cursor | ✅ | P1 | 🔍 | Shipped 2026-07-10. `host-client.onExit` stamps `code:"CURSOR_HOST_EXITED"` on the rejection when the Node host dies UNEXPECTEDLY (no `fatal` line); `classifyCursorSdkError` checks that code first → `transport-closed` (recoverable): the renderer silently rebuilds (`Agent.resume`, host respawns lazily) + resends, and the transcript gets the "Cursor: connection lost — reconnecting" row instead of a hard toast. Kept terminal on purpose: spawn failures ("couldn't start the Cursor SDK host") and `fatal`-preceded deaths (e.g. @cursor/sdk failed to load) — a respawn would fail identically. Tests: `host-client.test.ts` (tagged vs fatal-untagged death + classify round-trip), `classify.test.ts` (code→transport-closed, spawn-failure terminal), `reconnect-notice.test.ts` (mid-turn crash → recoverable + row). | `host/host-client.ts` (`CURSOR_HOST_EXITED_CODE`, `onExit`), `adapter.ts` (`classifyCursorSdkError` check 0) |
| **Host respawn backoff / crash-loop guard** | cursor | ✅ | P2 | ⚙️ | Shipped 2026-07-10. An "early" death (before the host's `ready` line, or within 5s of spawn) counts toward a consecutive-crash counter; a healthy run resets it. From the 2nd consecutive early death, respawn is held off exponentially (1s → 2s → … capped 30s; requests during hold-off fail fast without spawning). From the 3rd, rejections turn TERMINAL (no `CURSOR_HOST_EXITED` tag) with an actionable message (check `[cursor-host]` log lines / reinstall / `ZEROS_PTY_HOST_RUNTIME`), so the renderer stops silently retrying into a dead host. A single early death keeps NO hold-off — the renderer's one silent retry still heals a one-off boot blip seamlessly. **Follow-on UX fix (field report 2026-07-10):** a `failed` chat used to be a dead end (error toast + disabled Send, no banner since 01u) — Send is now enabled in `failed`/`auth-required` and acts as the retry: `handleSend` rebuilds the session, one attempt per explicit send (`agent-chat.tsx` `canSend` + status-recovery block). Also: `sidecar.ts` no longer clobbers an explicitly-set `ZEROS_CURSOR_HOST_SCRIPT`/`ZEROS_CURSOR_SDK_ENTRY` (documented override knobs; needed to exercise this guard in dev). Tests: `host-client.test.ts` "crash-loop guard" (hold-off + no-spawn fast-fail, terminal at 3rd + actionable message + classify, healthy-run reset). | `host/host-client.ts` (`ensure`/`onExit`/`request`), `agent-chat.tsx`, `electron/sidecar.ts` |
| **Engine parent-death self-exit** | engine | ✅ | P2 | ⚙️ | Shipped 2026-07-10. `setupParentDeathWatchdog` (engine/index.ts): armed ONLY when the Electron host passes `ZEROS_PARENT_PID` (sidecar.ts) — standalone `zeros serve`/cloud runs are untouched (a supervisor spawning with stdin at /dev/null would otherwise see instant EOF and self-kill at boot). Two triggers: stdin EOF (the host-control pipe; works on Windows where ppid goes stale) and a 15s ppid poll (reparent to launchd/init is definitive on macOS/Linux). Exit is a BOUNDED graceful stop (3s race, mirroring cli.ts shutdown) → `process.exit(0)`; the next-launch orphan sweep remains as backstop. | `engine/index.ts` (`setupParentDeathWatchdog`), `electron/sidecar.ts` (`ZEROS_PARENT_PID`) |
| **Reconcile orphaned `status='running'` turn rows at boot** | engine | ✅ | P3 | ⚙️ | Shipped 2026-07-10. `reconcileOrphanRunningTurns(endedAt)` (db/turns.ts) settles `running` rows as `failed` (ended_at backfilled, rev bumped); called from engine `start()` next to `setup.reconcileStaleRuns` (same "nothing can be running at boot" invariant), best-effort + logged. Bonus: a settled `failed` row makes the turn footer show its honest **AGENT STOPPED** record on reopen after an app crash mid-turn. Idempotent-tested in `turns.test.ts`. | `db/turns.ts` (`reconcileOrphanRunningTurns`), `engine/index.ts` boot janitors |

### 3.2 Permissions & approvals

> **§3.2 status: COMPLETE (2026-07-11)** — every task is ✅ shipped or ⏭️ deliberately skipped (reason in-row). **Skipped:** *Legacy v1 approval shims* (protocol-only — the pinned ≥0.131 Codex speaks v2, so the v1 auto-reject path is dead code) and *Cursor per-tool approval round-trip* (the SDK's `type:'request'` event is contentless — only ids — **and** unanswerable via any resolver, so surfacing it would be pure noise). **Descoped:** the *Sandbox* half of Cursor safety-gating (orthogonal containment axis outside the read→act mode ladder; left on the `CURSOR_SANDBOX=1` env hatch) and the Codex per-file *diff body* on file-change approvals (the file-count/path already answers "what am I approving"; a full diff was judged over-engineering).

| Task | Agent | St | P | UI | User-facing meaning & what's left | Key files |
| --- | --- | :--: | :-- | :--: | --- | --- |
| **`allowDangerouslySkipPermissions` for Full Access / Bypass** | claude | ✅ | **P0** | 🔍 | **Fixed 2026-07-11.** `bypassPermissions` is inert without the companion flag (the SDK "requires allowDangerouslySkipPermissions"), so Full Access kept calling `canUseTool` and prompting per action. `buildOptions` now sends `allowDangerouslySkipPermissions:true` — **scoped to bypass ONLY** (permissionMode stays the sole gate in every other mode, so a wrong assumption can't silently skip a non-bypass chat). Because the query is PERSISTENT and the flag is creation-only, switching INTO bypass on a flagless live query schedules a resume-preserving `pendingRestart` (tracked by `queryAllowsBypass`, rebuilt once) so the flag takes hold mid-chat too. Tests: 4 in `adapter.test.ts` (flag-in-bypass, never-in-non-bypass, live-query rebuild, + bypass-question-via-onUserDialog). **Verified in the running app:** the SDK emits `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` ("canUseTool will not be invoked") — confirming bypass now actually engages (prompts stop). **Question-shadowing follow-up — audited then VERIFIED 2026-07-11:** bypass shadows `canUseTool`, and AskUserQuestion rides `canUseTool` (path B, `adapter.ts:1333`), so questions in Full Access fall entirely to the `onUserDialog` fallback (path A) gated by a *guessed* `supportedDialogKinds`. **Runtime-confirmed working:** a live Full Access turn raised + answered a question (`AGENT_QUESTION_RESPONSE` observed with `permissionMode=bypassPermissions` and the shadow warning active). Since `canUseTool` is definitively not invoked under bypass and the ONLY two question-raise paths are `handleAskUserQuestionTool` (via canUseTool) and `onUserDialog`, the question MUST have routed through `onUserDialog` — so the `supportedDialogKinds` guess is correct and questions survive Full Access. Deny rules + ExitPlanMode unaffected. **Risk CLOSED.** | `claude-sdk/adapter.ts` (`buildOptions`, `setMode`, `queryAllowsBypass`, `onUserDialog`) |
| **"Allow always" persists to Claude settings** | claude | ✅ | P1 | 🎨 | **Shipped 2026-07-11 (commit `ff550e58`).** The card now has 4 options — Yes / **Allow for this chat** / **Allow for this project** / No. "Allow for this chat" is the prior chat-scoped localStorage policy (relabeled; no settings write). "Allow for this project" returns `updatedPermissions` from the SDK's `suggestions` re-destined to `localSettings` → persists to `.claude/settings.local.json` (honored across chats/CLI, survives reload; session stops re-prompting). **Safety (adversarial-review-hardened):** only the SDK's SCOPED `addRules` are persisted — exec tools never get a synthesized tool-wide rule (no RCE-by-default) and a Bash call with no scoped suggestion gets no project option; edit tools (Write/Edit/MultiEdit/NotebookEdit) instead offer **"Allow all edits in this project"** persisting the edit-tool family as H9-safe allow rules. Also: a Tab-focused card button now activates on Enter (was: global "Allow once"). New `PermissionOptionKind:"allow_always_project"` (Codex/Cursor unaffected). Tests: 8 in `adapter.test.ts`. | `claude-sdk/adapter.ts` (`canUseTool` + `EDIT_TOOLS`), `permission-card.tsx`, `agent-events.ts` (`allow_always_project`) |
| **Path-aware permission copy** | claude | ✅ | P1 | 🎨 | **Shipped 2026-07-11 (via the permission-card redesign).** The card's `describePermission` now reads the tool's file ref straight from `rawInput` (`file_path`/`notebook_path`/`path`) and shows it **workspace-relative** (Claude's `file_path` is absolute; `relativizePath` strips the chat cwd, wired through `agent-chat.tsx`) with a kind-correct icon — Read/Write/Edit render "which file" instead of a bare "Bash"/tool name. The deeper SDK-field enrichment (`options.title`/`blockedPath`/`decisionReason`) was unnecessary once the card reads the path directly. Tests: `permission-card.test.ts` (relativizePath edge cases + Read/Write/Edit/NotebookEdit path display). | `permission-card.tsx` (`describePermission`, `relativizePath`), `agent-chat.tsx` (cwd wiring) |
| **File-change approval shows paths** | codex | ✅ | P2 | 🎨 | **Shipped 2026-07-11.** A fileChange approval's params carry only the `itemId` (no `changes[]`), so the adapter now caches each streamed fileChange item's `changes[].path` by itemId (`wireFileChangeCapture`, populated on item/started before the approval fires) and re-destines them onto the approval's `rawInput.filePaths`. Because **one Codex patch can span several files in a single gate**, the shared card branches on count: a one-file patch shows the single workspace-relative path (as before), a **multi-file patch collapses to a count** — title "Apply changes to N files?" + label "Edit N files", no misleading single path. Absent correlation (rare) it degrades to the old pathless copy. Tests: 4 in `permission-card.test.ts` (single/multi/fallback) + 3 in `app-server-adapter-params.test.ts` (`fileChangePaths`). **Descoped:** the per-file **diff** body — the file list + count already answers "what am I approving", and a full inline diff was judged over-engineering for the gate. | `app-server-adapter.ts` (`wireFileChangeCapture`, `fileChangePaths`, `mapApprovalToCanonical`), `permission-card.tsx` (`describePermission`) |
| **Inline anchoring of Codex approvals** | codex | ✅ | P1 | 🔍 | **Shipped + audited 2026-07-11 — via a different mechanism than planned.** Rather than making the approval's `toolCallId` equal the card's minted UUID, BOTH ends key on the raw codex `item.id`: the tool card carries it as `nativeToolCallId`, the approval as `toolCall.toolCallId` (= `params.itemId`), and the renderer matches EITHER (`event-stripe.tsx:81`). Audit confirmed command + file-change approvals both anchor; regression test locks both ends onto the same id (and documents the no-`itemId` → detach fallback). Tests: 3 in `inline-anchoring.test.ts`. | `app-server-adapter.ts` (`mapApprovalToCanonical`), `app-server-translator.ts` (`nativeToolCallId`), `event-stripe.tsx:81` |
| **Legacy v1 approval shims** | codex | ⏭️ | P3 | ⚙️ | **Skipped 2026-07-11 (deliberate).** On an *older* Codex that emits `execCommandApproval`/`applyPatchApproval`, approvals would silently auto-reject (`-32601`). But Zeros pins Codex ≥0.131, which speaks the **v2** approval protocol exclusively — so the v1 path is unreachable dead code. Registering v1 aliases only becomes worthwhile **if the Codex CLI is ever unpinned/downgraded**; until then it's pure protocol surface with no user-facing effect. | `generated/ServerRequest.ts:19` |
| **Cursor per-tool approval round-trip** | cursor | ⏭️ | P2 | 🎨 | **Skipped 2026-07-11 (deliberate, product decision).** Cursor runs tools with no in-app approval prompt: `respondToPermission` is a no-op and the SDK exposes **no resolver**. The proposed "non-blocking notice on `type:'request'`" was rejected because the SDK's `SDKRequestMessage` is **contentless** (`{agent_id, run_id, request_id}` — no tool, command, path, or reason), so any notice would be an uninformative "something asked for approval" the user **cannot act on** (there's no channel to answer it). A real round-trip would need a file-based preToolUse hook the SDK doesn't provide. Cursor's actual safety surface is the **Auto-review mode** (see next row); this per-tool notice adds noise, not safety. | `cursor-sdk/adapter.ts` (`respondToPermission` no-op), `translator.ts` (`case "request"`) |
| **Cursor safety-gating UI (Auto-review; Sandbox descoped)** | cursor | ✅ | P2 | 🎨 | **Auto-review shipped 2026-07-11 as a composer MODE, not a toggle.** The Cursor mode picker went from 2→3: **Ask** (sdk `plan`), **Auto** (sdk `agent` + `local.autoReview:true` — the classifier gate), **Full access** (sdk `agent`, no gate; renamed from "Edit"). Since `autoReview` is a CREATE-TIME `@cursor/sdk` option (absent from `LocalSendOptions`), switching in/out of Auto mid-chat lazily rebuilds the agent via `Agent.resume` on the next prompt (`ensureAutoReview`, best-effort — a failed rebuild keeps the turn alive and retries). New chats are **born in Auto** (posture `auto`→native `auto`; degrades to full access when the backend lacks the classifier, so never *more* permissive than the old default). Full access maps to the `danger` posture. **Sandbox intentionally deferred** — it's an orthogonal *containment* axis that doesn't fit the read→act ladder; the hidden `CURSOR_SANDBOX=1` env path stays as the power-user escape hatch. Tests: 4 in `model-passing.test.ts` (mode→sdk mapping + rebuild-only-on-gate-flip + failed-rebuild), catalog assertions in `model-catalog.test.ts`. | `cursor-sdk/adapter.ts` (`CURSOR_SDK_MODES`, `sdkModeFor`/`autoReviewFor`, `ensureAutoReview`, `buildLocalOpts`), `model-catalog.ts`, `composer-pills.tsx` |
| **Approval decision-mapping + "unapproved never runs" tests** | codex | ✅ | P1 | ⚙️ | **Shipped 2026-07-11.** The decision-mapper (highest-severity safety class) is now covered: `mapResponseToCodexDecision` across all 4 options × the 3 methods, the cancelled outcome, an unknown-option safe-fallback, the permissions mirror-on-accept + empty-grant-on-reject, `defaultMethodResponse`, plus the app-server `defaultDenyResponse` (no-handler auto-deny) and `defaultCancelResponse` (timeout/dispose). Headline invariant asserted directly: a Decline / Cancel / cancelled / timeout / no-handler NEVER maps to an accepting decision or any granted permission ("unapproved never runs"). Tests: 32 in `approval-decision-mapping.test.ts`. | `app-server-adapter.ts` (`mapResponseToCodexDecision`, `defaultMethodResponse`), `app-server.ts` (`defaultDenyResponse`, `defaultCancelResponse`) |

> **Baseline confirmations:** Claude's `canUseTool` gate (incl. Deny-keeps-turn) and Codex's v2 dual-approval trio + policy mapping are shipped and (for Claude) tested. Note the doc-3 implication of *separate* Codex "command/file/expand" renderer cards is inaccurate — **all** Codex approvals route through the **shared** `InlinePermissionCluster` / `PermissionBar`.

### 3.3 Elicitation — the agent asks the user a question

> **§3.3 status: SETTLED (2026-07-12)** — the blocking question round-trip is ✅ **shipped** for both Claude and Codex (PR #124 *unified question card*, 2026-07-04; hardened in PR #130) and code-verified 2026-07-12; the Cursor notice is ⏭️ **skipped** (reconciled with the §3.2 decision — the SDK event is contentless and unanswerable); the MCP-elicitation cluster is ⏸️ **on hold — deliberate deferral, will ship later** (design settled, see `.context/elicitation-3.3-before-after-ui-2026-07-12.html`). UI note: all questions render on the two-surface pattern — a blocking interactive `QuestionCard` in the **composer slot** (single/multi-select, free-text "Other" with secret masking, `‹ ● ● ● ›` carousel, Dismiss ✕, "Skips in m:ss" countdown) plus a durable read-only "User input" record row in the transcript (Awaiting response → Answered/Skipped).

| Task | Agent | St | P | UI | User-facing meaning & what's left | Key files |
| --- | --- | :--: | :-- | :--: | --- | --- |
| **`item/tool/requestUserInput` ("ask" tool)** | codex | ✅ | P1 | 🎨 | **Shipped in PR #124 (2026-07-04), hardened in PR #130; verified 2026-07-12.** A structured Codex question now blocks the turn on the unified QuestionCard and resolves **in place** — no more silent `-32601` / blind turn. Mechanism (twin of the approval flow): handler registered at `app-server.ts:544` (mints `questionId`, arms the `APPROVAL_TIMEOUT_MS` auto-empty timer), `pendingUserInputs` map (`:543`), `respondToUserInput` (`:863-869`); `mapUserInputToQuestion` (`app-server-adapter.ts:1874`) maps `questions[]` → canonical `QuestionRequest` (`options:null`/`isOther` → free-text row — a PR #124 review fix so pure free-text asks are answerable; `isSecret` → masked input; single-select default since the generated type has no `multiSelect`); answers return via `mapQuestionAnswerToCodex` (`:1928`) → same-turn JSON-RPC response `{answers:{[id]:{answers:[label,…]}}}`. `cancel()` clears `pendingQuestions` (no zombie card); unanswered questions auto-resolve empty on timeout and the record chip flips to SKIPPED. Tests: `app-server-adapter-reconnect.test.ts:232`, `app-server-translator.test.ts:449`, `app-server-adapter-cancel.test.ts:64`. | `codex/app-server.ts:543-869`, `codex/app-server-adapter.ts:753/1463-1946`, `generated/v2/ToolRequestUserInputParams.ts`, `question-card.tsx` |
| **`experimentalApi` capability at `initialize`** (root blocker) | codex | ✅ | P1 | ⚙️ | **Shipped in PR #124; verified 2026-07-12.** `initialize` now sends `capabilities:{experimentalApi:true}` (`app-server.ts:427-438`), paired at spawn with `-c features.default_mode_request_user_input=true` + `-c suppress_unstable_features_warning=true` (`app-server.ts:337-342`) — without the config flag Codex only offers the ask-tool in *plan* mode. Side effect to remember: Codex now actually **sends** the experimental requests, so the still-unwired MCP-elicitation methods (next row) hit our `-32601` fallback live — which is why that row shouldn't slip forever. | `codex/app-server.ts:337-342/427-438`, `generated/v2/InitializeCapabilities.ts` |
| **MCP-elicitation + dynamic-tool-call cluster** | codex | ⏸️ | P2 | 🎨 | **On hold (2026-07-12) — deliberate deferral; will ship later.** Still unwired: `mcpServer/elicitation/request` and `item/tool/call` have no handlers, so both fall to the `-32601` default (`shared/jsonrpc.ts:268-276`) and an MCP server needing a form/URL mid-turn silently fails (the user only sees the downstream tool failure). The generated types are already in-repo and unused (`McpServerElicitationRequestParams` — `form` / `openai/form` / `url` modes; `DynamicToolCallParams`). **Design settled** (see the .context report): register both handlers next to the requestUserInput twin; `form`/`openai/form` → QuestionCard carousel pages (field → free-text row, `secret` → masked, never stamped into the transcript record); `url` → open-external link card (`shell.openExternal`, explicit continue/dismiss); timeout must resolve as a **decline** (an empty accept could read as consent); `item/tool/call` → visible-decline transcript row first, real rendering only once a pinned Codex build is observed sending it. | `codex/app-server.ts` (handlers TBD, next to `:531-544`), `generated/ServerRequest.ts:20`, `generated/v2/McpServerElicitationRequestParams.ts`, `shared/jsonrpc.ts:268` |
| **`AskUserQuestion` answered in place (Claude)** | claude | ✅ | P1 | 🎨 | **Shipped in PR #124/#130; verified 2026-07-12.** `canUseTool` special-cases AskUserQuestion (`claude-sdk/adapter.ts:1333`) → `handleAskUserQuestionTool`, returning **before** any permission request is built — the duplicate Allow/Deny card is impossible, and the thread no longer splits. The answer resolves **same-turn**, via a deliberate deviation from this row's original proposal: path B (canUseTool) resolves `{behavior:'deny', message: formatAnswerForClaude(answers)}` rather than `{behavior:'allow', updatedInput}` — allowing would trigger the CLI's native dialog, which a headless client can't collect; the deny *message* carries the answer and Claude continues in place. The defensive `onUserDialog` channel (path A, `:1496`) dedupes onto the same card by `toolUseID` (`raiseQuestion:1517`) and resolves `{behavior:'completed', result: buildAskUserQuestionOutput(...)}`. Delivery is guaranteed by the settle-echo watchdog (`sessions-provider.tsx:1836-1911`): miss 1 silently resends; only miss 2 cancels the turn and delivers the answer as a prompt (with toast) — the old "answer as next-turn prompt" survives **only** as this degraded fallback. Verified working under Full Access/bypass via path A (§3.2 audit 2026-07-11). Tests: `adapter.test.ts` question block (~1387-1765), `question-queue.test.ts`, `pending-question-tools.test.ts`. Minor residual: no direct unit test for the interactive `QuestionCard` render/submit (covered indirectly). | `claude-sdk/adapter.ts:1333/1463-1693`, `claude/translator.ts:854`, `question-card.tsx`, `renderers/question-card.tsx`, `sessions-provider.tsx:1803-1911` |
| **Cursor `type:'request'` notice** | cursor | ⏭️ | P2 | 🎨 | **Skipped 2026-07-12 (reconciled with the §3.2 decision of 2026-07-11 — this row previously contradicted it).** Same underlying event as the skipped per-tool approval round-trip: the SDK's request message is **contentless** (`{agent_id, run_id, request_id}` — no tool, command, path, or reason) **and unanswerable** (no resolver; `respondToPermission` is a structural no-op), so any notice would be an unactionable "something asked for approval" — noise, not safety. `case "request"` stays a silent `break` (`cursor-sdk/translator.ts:215-218`); Cursor's real safety surface is the Auto-review composer mode (§3.2). Revisit only if the SDK ever adds content or a resolver. Leftover hygiene (not UI): the stale "Phase 3" comments at `translator.ts:215-218` and `adapter.ts:1065-1070` should state this skip decision so nobody re-opens it. | `cursor-sdk/translator.ts:215-218`, `cursor-sdk/adapter.ts:1065-1070` |

### 3.4 Cancellation & mid-turn steering

> **§3.4 status: COMPLETE (2026-07-12)** — both rows shipped. Steering landed in PR #141 (*queued message steering*) via a deliberately better mechanism than this section's original ask: instead of auto-routing a mid-turn submit to `turn/steer`, a message typed while a turn runs **queues** (QueuedMessagesCard, docked above the composer — 2026-07-06 queue redesign), and each queued row's **"Send now"** (⌘↵) steers the running turn explicitly. The user chooses interject-now vs. wait-for-next-turn.

| Task | Agent | St | P | UI | User-facing meaning & what's left | Key files |
| --- | --- | :--: | :-- | :--: | --- | --- |
| Cancellation correctness (no bleed / loss / phantom) | all | ✅ | P0 | 🔍 | *(Done — see §2.3.)* Stop is clean; next message keeps context; no phantom interrupt. | `sessions-provider.tsx:1256/1537` |
| **`turn/steer` mid-turn steering** | codex (+claude) | ✅ | P2 | 🎨 | **Shipped in PR #141 (`23bd0f4c`); verified 2026-07-12 — the "no call site" note is stale.** Mid-turn nudges work without cancelling: typing while a turn runs queues the message; the queued row's **Send now** calls `steerQueued` (`sessions-provider.tsx:2107`) → the adapter's `steer()`. Codex sends `turn/steer {threadId, input, expectedTurnId}` (`app-server-adapter.ts:616-645`) — `expectedTurnId` is a server-side precondition, so a completed-in-flight race fails the RPC rather than mis-routing into a later turn. Claude (bonus, same surface) pushes into the SDK's streaming-input queue (`claude-sdk/adapter.ts:817-848`), its native mid-run path; the model sees the nudge at its next inference step, same turn. Capability-gated on `agentCapabilities.steering` (`agent-chat.tsx:1887-1892`): Claude/Codex advertise it; Cursor doesn't — its Send-now arrow is disabled with a tooltip while running (plain out-of-order flush still works when idle). Hardened: the queue entry is claimed *before* the steer round-trip (no double-send if the turn settles mid-flight); a failed steer re-queues at the head + toasts "stays queued, will send when the current turn finishes". | `codex/app-server-adapter.ts:616-645/1687`, `claude-sdk/adapter.ts:817-848`, `sessions-provider.tsx:2107-2200`, `queued-messages-card.tsx`, `agent-chat.tsx:2332` |

### 3.5 Context, compaction & checkpoints / rollback

> **§3.5 status (2026-07-12):** the compaction/context cluster ("Package 1": the three rows below) is ✅ **shipped 2026-07-12** together with the earlier-shipped native-instructions row — all four wire-verified against live binaries and covered by tests (full suite: 1059 green). The shared UI is the **context gauge** (a 16px ring in a ghost button beside Send: `fg2` its whole life, `red-primary` only ≥90% — the two-state design of 2026-07-12) with a **Context popover** (`bg3`, fraction, bar, Free-space-first category rows, Compact-now footer), plus the **two-state compaction tool-call row** ("Compacting.." spinner → "Context compacted" + no-icon DONE StatusChip). Cursor renders the DISABLED ring + "Context usage is unavailable for Cursor." popover (its SDK reports no usage; user decision 2026-07-12). **§3.5 closed 2026-07-13:** the three rollback rows below are ⏭️ **skipped** (user decision 2026-07-13) — Zeros' NATIVE per-turn checkpoint system (v13 turns: hidden `refs/zeros/turns/*` pre/post whole-tree snapshots + tool-call attribution + the per-turn "Reset to this point" footer action, `git/turns-git.ts` / `turn-footer.tsx`) already gives EVERY agent (Claude, Codex, Cursor — and any future adapter) turn-level file revert with 3-way-merge concurrency safety and full undo (files + conversation). The per-agent SDK rollbacks would duplicate a weaker version of it: agent-specific, no cross-chat merge safety, no undo, and (for `thread/rollback`) transcript-only unless paired with exactly the git plumbing we already have.

| Task | Agent | St | P | UI | User-facing meaning & what's left | Key files |
| --- | --- | :--: | :-- | :--: | --- | --- |
| **`/compact` actually compacts** | codex | ✅ | P2 | 🔍 | **Shipped 2026-07-12; wire-verified (`thread/compact/start` accepted + resolved on codex-cli 0.144.1).** `/compact` in a Codex chat (typed or picker) now routes to the real compaction RPC instead of sending literal text the model would answer with a role-played (billed, useless) summary: `slashCommandKind` gained a codex inline branch (`CODEX_INLINE_ACTIONS`), the composer's inline handler branches by family (Claude keeps its CLI-native prompt path), and a new fire-and-forget pipeline carries it — `session.compactContext()` → `AGENT_COMPACT` (new bridge message, schema-validated) → engine → `gateway.compactContext` → adapter `compactContext()` → `thread/compact/start {threadId}`. The gauge popover's **Compact now** uses the same path. Progress streams back as codex's own `contextCompaction` item → the two-state row. Tests: `builtin-commands.test.ts` (codex inline mapping), `app-server-adapter-reconnect.test.ts` (RPC routing + dead-session guard). | `builtin-commands.ts` (`CODEX_INLINE_ACTIONS`), `agent-chat.tsx` (`case "compact"`), `messages.ts`/`schemas.ts` (`AGENT_COMPACT`), `engine/index.ts`, `gateway.ts`, `codex/app-server-adapter.ts` (`compactContext`) |
| **Compaction-aware context accounting** | codex | ✅ | P2 | 🎨 | **Shipped 2026-07-12 — via a better mechanism than the proposed re-baseline.** `usage_update.used` now reports **current window fill** (`tokenUsage.last.inputTokens + outputTokens` — the last inference call's full prompt IS the context) instead of the lifetime `total.totalTokens` odometer, so the reading **drops naturally after any compaction** (auto or manual) with no baseline arithmetic to drift; falls back to the total only when `last` is absent. The `contextCompaction` item also got its first-class row (kind `compaction`): "Compacting.." (spinning lucide `loader`) while streaming → relabeled in place to "Context compacted" + DONE chip on completion. Rendered by the new `CompactionRecordCard`. Tests: 3 usage-semantics cases (incl. an explicit drop-across-compaction fixture) + 2 row-lifecycle cases in `app-server-translator.test.ts`. | `codex/app-server-translator.ts` (`onTokenUsage`, `describeItem`, `mapItemKind`, `onItemCompleted`), `renderers/compaction-card.tsx`, `renderers/registry.ts` |
| **Compaction banner + `getContextUsage()` breakdown** | claude | ✅ | P2 | 🎨 | **Shipped 2026-07-12.** (1) `compact_boundary` no longer falls through `onSystem` silently: it emits the compaction row in its SETTLED state ("Context compacted" + DONE — Claude's signal arrives *at* the boundary, so no fake "Compacting.." phase), durable in the transcript, with `trigger`/`pre_tokens` stamped into the expandable detail. Per design rev 2 this row replaced the originally-proposed ✂ hairline banner. (2) `query.getContextUsage()` is now called after every settled turn (fire-and-forget control call, zero model tokens; feature-detected for older CLIs): it emits a `usage_update` carrying the REAL window numbers (`maxTokens`/`totalTokens` — replacing the cumulative-billing figure whose own comment admitted ">100%" readings) plus the new optional `categories[]` (with "(deferred)" suffixes) that fills the gauge popover's by-category rows; cost deliberately omitted so the billing update's `costUsd` survives. Tests: 2 boundary cases in `translator.test.ts`, 2 context-usage cases (categories mapping + older-CLI tolerance) in `adapter.test.ts`. | `claude/translator.ts` (`onSystem` compact_boundary), `claude-sdk/adapter.ts` (`emitContextUsage`), `agent-events.ts` (`categories`), `context-gauge.tsx` |
| **Codex `thread/rollback` turn-revert** | codex | ⏭️ | P2/L | 🎨 | **Skipped 2026-07-13 (user decision).** Covered by the native per-turn checkpoint system: "Reset to this point" already reverts a Codex turn's files (from that turn's own pre/post snapshots) AND truncates the transcript, with undo. `thread/rollback(threadId,numTurns)` would only rewind Codex's native thread state — the file half would still be our git plumbing — and the truncated engine transcript is already authoritative on resume. Revisit only if a resumed Codex thread answering "as if the reverted turns happened" becomes a real complaint. | `generated/v2/ThreadRollbackParams.ts` (no call site — intentional) |
| **Claude file checkpoint / rewind** | claude | ⏭️ | P2/L | 🎨 | **Skipped 2026-07-13 (user decision).** `enableFileCheckpointing:true` + `query.rewindFiles(userMessageId)` is a Claude-only, no-undo, whole-tree rewind; the native checkpoint system already does per-turn file revert for Claude with concurrency-safe attribution, 3-way merge against concurrent chats, and undo (files + conversation). Running both would double-snapshot every turn. | `sdk.d.ts:1449/2390` (not enabled — intentional) |
| **Cross-agent "revert to here" surface** | all | ⏭️ | P2/L | 🎨 | **Skipped as already-covered 2026-07-13** — this row's "none exists today" was stale: the v13 turn footer's **Reset to this point** (`turn-footer.tsx`, every settled turn, every agent) IS the per-turn cross-agent revert affordance, backed by the native checkpoints (`refs/zeros/turns/*`) rather than per-agent SDK rollbacks. Known edges of the native system (crash-mid-turn turns record no files; `.gitignore`d/submodule paths not checkpointed; >100-turn chats prune old checkpoints — the confirm dialog warns) are documented in `docs/native-checkpoint-audit-2026-07-13.md`. | `turn-footer.tsx`, `git/turns-git.ts` |
| **`baseInstructions`/`developerInstructions`** | codex | ✅ | P2 | ⚙️ | **Shipped 2026-07-12 (§3.5 "Package 2").** The Zeros preamble now rides Codex's NATIVE instruction channel instead of a fake first user turn: the adapter declares `nativeSystemInstruction` (new `AgentAdapter` capability), the gateway builds the UNWRAPPED body (`buildFirstTurnInstructionBody`, new in `@zeros/core/system-instructions`) and passes it as `systemInstruction` to newSession/loadSession, and the adapter attaches it as **`developerInstructions`** on `thread/start`, `thread/resume` (covers pre-native sessions too), AND the degraded resume-→-fresh-`thread/start` fallback — then the gateway pre-marks the session instructed so `withSystemInstruction` never also prepends the in-band block. Deliberately `developerInstructions`, NOT `baseInstructions` (base would REPLACE Codex's entire built-in system prompt). Claude/Cursor keep mechanism A (in-band) unchanged; the `/add-dir` mid-chat notice stays in-band by design. Benefits: survives compaction (matters once §3.5 Package 1 lands), never quoted back as user speech, clean first turn in the native thread history. **Wire-verified 2026-07-12** against codex-cli 0.144.1: `thread/start` with `developerInstructions` accepted (thread created). Tests: 5 in `gateway-native-instructions.test.ts` (native pass-through + no-prepend, mechanism-A untouched, true/degraded resume × native/non-native), 2 in `app-server-adapter-params.test.ts` (dev-not-base mapping, omit-when-absent), 1 in core `system-instructions.test.ts` (body = wrapped minus tags). | `gateway.ts` (`nativeInstructionFor`, newSession/loadSession), `codex/app-server-adapter.ts` (`nativeSystemInstruction`, `bootSession`, `buildThreadStartParams`), `types.ts` (`AgentAdapter.nativeSystemInstruction`), `system-instructions/build.ts` |

> ✅ **Not a gap:** Codex `persistExtendedHistory` (a parity-doc TODO) is **obsolete** — the current protocol resumes full history by `threadId` from disk automatically.

### 3.6 Models, effort & budget

> **§3.6 status (2026-07-13, evening):** **all six rows implemented** in one pass against the design catalog (`.context/design-3.6-models-effort-budget-2026-07-13.html`), same-day user decisions baked in: R5 distinct stop reasons (named text-only footer pills + a below-footer **Continue**), R2 `fallbackModel` (+ the "Model switched · FALLBACK" tool-call record + Settings row), R3 `maxBudgetUsd` (+ the "Turn stopped · BUDGET · CLAUDE" tool-call record replacing a footer pill + Settings toggle/amount), R4 **reduced to option (b)** — a one-time-per-chat cost-bump toast on model/effort change (no Off tier, no inline flash), R6 per-model usage (persisted per turn, circle-dollar footer button, popover opens above), and R1 **reopened and shipped** — the Grok 4.5 low/medium/high effort ladder via id-swap (curated base flipped to level-free `grok-4.5`, `applyCursorReasoning` re-targets/completes, locking tests relaxed). Reasoning-tokens stay scope-cut for ALL agents (2026-07-13 decision). Suite 2119/2119 green, typecheck + lint clean.
>
> **Settings-drift fix (2026-07-13, night — all agents):** a user report ("pill says Haiku, the turn ran Opus") exposed a class of paths where the composer's model/effort never reached the live session: (1) `sendPrompt`'s session-recovery created sessions with NO chat env (cwd only) — the engine then ran the agent CLI's own default model; (2) `session.setModel`/`updateConfig` silently no-op while a session is warming (no sessionId yet); (3) the chat view's `envKey` respawn detector stamped a change as applied before its null-chat bail (swallowing it) and trusted any pre-existing session unverified; (4) a `null` chat.model omitted the model env var entirely while the ModelPill displayed the catalog default. Fixes: the recovery path now passes `envForChat`; every session bind stamps `appliedChatEnvKey` (the chat env it was ACTUALLY created with) on the slot; `sendPrompt` reconciles it against the chat's current env before EVERY prompt and force-respawns (resume — context survives) on mismatch — the single choke point that covers claude (live-capable) and codex/cursor (respawn-only, no adapter setModel/updateConfig); the envKey effect bails before stamping; and `envForChatSettings` resolves a null model to the same `models[0]` the pill displays instead of omitting the var. Suite 2122/2122 green.

| Task | Agent | St | P | UI | User-facing meaning & what's left | Key files |
| --- | --- | :--: | :-- | :--: | --- | --- |
| **Reasoning-effort control for Cursor (Grok 4.5)** | cursor | ✅ | P2 | 🎨 | **Shipped 2026-07-13 (row reopened by user decision — "let's ship the effort for Cursor's Grok 4.5").** Grok 4.5 now shows the real three-tier Low/Medium/High effort pill; not a per-request knob but an **id-swap**, exactly like the shipped Fast pill. Mechanism: the curated base flipped `grok-4.5-xhigh` → level-free `grok-4.5` with `effortLevels:["low","medium","high"]` (alias `grok-4.5-xhigh → grok-4.5` keeps persisted picks resolving); `resolveModel` now applies reasoning BEFORE catalog validation (a level-free base would otherwise fall back to Composer); `applyCursorReasoning` gained **level re-targeting** (a persisted `grok-4.5-xhigh` + an explicit level honours the pick instead of silently ignoring it) and **id-completion** (a non-live bare base completes to `-xhigh` rather than leaking a dead id). Composer 2.5 stays genuinely effort-less. Locking tests relaxed + 3 new test groups. | `catalogs/models-v1.json` (v6), `cursor-sdk/adapter.ts` (`applyCursorReasoning`/`resolveModel`), `model-passing.test.ts`, `model-catalog.test.ts`, `models-catalog-validity.test.ts` |
| **`fallbackModel` (auto-fallback on failure)** | claude | ✅ | P2 | 🎨 | **Shipped 2026-07-13.** Settings → Models → "Fallback model" (defaults Sonnet 5; "None (fail fast)" restores old behavior) rides `CLAUDE_FALLBACK_MODEL` → `Options.fallbackModel`. When the swap fires, the transcript records a collapsible **"Model switched · FALLBACK"** tool call (repeat-2 icon, EventRow + StatusChip recipe, expandable detail) inline where it happened — never a toast (user spec). Detection: per-message `assistant.message.model` vs the armed primary (top-level messages only; subagents excluded; deduped per turn; re-arms each turn since the SDK re-tries the primary), plus the SDK's explicit `model_refusal_fallback` system message for refusal-triggered swaps. Setting change stages a query restart (creation-time option). | `claude-sdk/adapter.ts` (buildOptions/updateConfig/setModel), `claude/translator.ts` (`armFallbackDetection`/`emitModelSwitched`), `renderers/model-switch-card.tsx`, `reliability-settings.ts`, `settings-page.tsx` |
| **Budget / cost caps** | claude | ✅ | P2 | 🎨 | **Shipped 2026-07-13 (Claude only — Codex/Cursor expose no budget hook).** Settings → Models → "Cap spend per turn" (off by default) + "$ Maximum per turn" (default $5) rides `CLAUDE_MAX_BUDGET_USD` → `Options.maxBudgetUsd`. On a hit the turn ends cleanly: stop reason `budget_exhausted`, a **"Turn stopped · BUDGET · CLAUDE"** tool call right above the footer (it REPLACES a footer pill and stays out of the collapsed working group via turn-partition), and the below-footer **Continue** starts a fresh turn — the adapter stages a query restart after a budget stop so the resumed session runs under a fresh cap. Note: the SDK accounts `maxBudgetUsd` per query run (turns since the last respawn), so the cap is the ceiling any single turn can spend; the post-stop restart resets it. | `claude-sdk/adapter.ts`, `claude/translator.ts` (budget branch), `renderers/budget-stop-card.tsx`, `turn-partition.ts`, `reliability-settings.ts`, `settings-page.tsx` |
| **"Thinking off" tier + live `max`** | claude | ⏭️ | P2 | 🎨 | **Resolved 2026-07-13 (user decisions, after the SDK re-check):** the **Off tier is dropped** (user: skip it) and the inline "applies to next message" flash is dropped (no room next to the pill; Max-only trivia). The re-audit corrected the record: only **Max** needs a respawn (low→xhigh + ultracode apply live via `applyFlagSettings`; `setModel` is live too). What actually mattered — the **cost bump** on any mid-conversation model/effort change (prompt cache is keyed by model AND effort) — ships as R4's one-time toast (next row). | `adapter.ts` (`SETTINGS_EFFORTS`/`pendingRestart`), `sdk.d.ts:6144` |
| **Cost-bump heads-up on model/effort change (R4, option b)** | all | ✅ | P2 | 🎨 | **Shipped 2026-07-13 (rev same day: per WORKSPACE).** Changing the model or effort **mid-conversation** shows a **one-time-per-workspace toast** — "Changing the model or effort re-reads the conversation — your next reply is slower and costs more." Gated on real transcript messages (never the promoted-title heuristic), so a fresh conversation can't show it; the shown-flag is keyed by the workspace folder (per-device, localStorage `zeros.model-cost-toast.v2`). Mirrors Conductor's toast / Claude Code's confirm. | `agent-chat.tsx` (`maybeShowCostBumpToast`), `device-local.ts` |
| **Distinct stop reasons** (max_tokens / budget / blocking) | claude | ✅ | P1 | 🎨 | **Shipped 2026-07-13.** The translator now reads `result.stop_reason` + `terminal_reason` and maps named endings BEFORE the generic `is_error → refusal` fallback: `max_tokens` → **"TOKEN LIMIT — ANSWER TRUNCATED"** (was dead code — a truncated answer rendered as complete), `blocking_limit` → **"BLOCKED BY USAGE LIMIT"**, `prompt_too_long` → **"PROMPT TOO LONG"**, `error_max_budget_usd`/`budget_exhausted` → the budget tool call (no pill). Pills are text-only (no severity dot, user spec); `StopReason` union extended in core; persisted on the turn row so reloads keep the pill. The two recoverable stops (token cap, budget) get a one-click **Continue** on its own row below the footer (lucide play; last turn only; sends "Continue" to the same session). | `claude/translator.ts` (onResult), `packages/core/src/agent-events.ts:571`, `turn-footer.tsx` (`STOP_REASON_LABELS`/`continuableStopReason`), `agent-chat.tsx` |
| **Per-model usage** (reasoning tokens scope-cut) | claude | ✅ | P2 | 🎨 | **Shipped 2026-07-13.** The translator itemizes `result.modelUsage` → `TurnUsage.perModel[]` (priciest first); the engine persists per-turn usage on the turn row (migration **v20**: `turns.usage` JSON) so it survives reloads; the turn footer gains a quiet **circle-dollar button** (only when usage exists — Cursor reports none, so it never shows there) opening a popover **above the icon** (Radix `side="top"`, flips below only when out of room): one row per model (catalog display names) with in/out tokens + cost, a Total row, and **Copy breakdown** (markdown). **Scope cut holds:** `reasoningTokens` rendered for NO agent (Codex's value stays analytics-only). | `claude/translator.ts`, `engine/db/turns.ts` + `migrations.ts` (v20), `engine/index.ts` (finishTurn), `native/turns.ts`, `turn-footer.tsx` |

> ✅ **Baselines:** live model catalogs + model-family resolver (tested), per-turn model/effort/serviceTier (Codex), 1M context + real cost capture (Claude), Cursor's bounded gating retry, and **PR creation never force-downgrades the model** (it's a pure `gh`/git op) are all confirmed.

### 3.7 Plan mode

| Task | Agent | St | P | UI | User-facing meaning & what's left | Key files |
| --- | --- | :--: | :-- | :--: | --- | --- |
| Deny `ExitPlanMode` keeps session | claude | ✅ | P1 | ⚙️ | *(Done + tested.)* "Stay in Plan mode" keeps planning, doesn't kill the turn. | `adapter.test.ts:919` |
| ExitPlanMode stuck-pending / no disabled buttons | claude | ✅ | P2 | 🎨 | *(Done — 2026-07-14, solved a different way than first scoped.)* Plan review is now a standalone `PlanReviewCard` above a still-live composer (actions left `tool-exit-plan-mode.tsx`, now display-only). **Stuck-pending:** a turn that settles with the gate still pending — the adapter's 30-min auto-deny, or a turn that died mid-plan — self-heals via `clearStrandedPlanReview` in the turn-settle `finally` (store-tested), so buttons can no longer click into an already-resolved gate. **Double-click:** handled without disabling buttons — `respondToPermission` clears `pendingPermission` synchronously and guards on it, so a second click is a harmless no-op, and the still-live composer is the "reply to continue" path; no explicit "expired" fallback or disabled-button state is needed. | `sessions-store.ts` (`clearStrandedPlanReview`), `sessions-provider.tsx:1743`, `plan-review-card.tsx` |
| No-stuck-after-rapid-enter/exit; approval ordering | claude | ✅ | P2 | 🔍 | *(Done + tested — 2026-07-14.)* Each Plan on/off toggle applies live via `setPermissionMode`, now **guarded by adapter tests**: rapid `plan → default → plan → default` toggles apply live *in order* and leave the session on the final mode (never wedged in planning) while staying interruptible; and an `ExitPlanMode` approval request **carries the plan body**, so the prompt renders as one unit with the plan text rather than a bare gate. | `adapter.test.ts` (rapid-toggle + ExitPlanMode-approval tests), `adapter.ts:1273` (setMode), `:1481` (canUseTool) |
| Approve-with-feedback in the plan card | claude | ✅ | P3 | 🎨 | *(Done — a different way than first scoped.)* Approve-with-feedback works through the still-live composer directly below the card: typing a follow-up denies the gate (Claude keeps planning) and rides as the next prompt, so the user refines the plan and continues in one step. The optional inline-textarea affordance was deliberately **not** built — the composer already is the feedback channel; a second inline editor would duplicate it. | `plan-review-card.tsx`, `agent-chat.tsx` (`denyPlanReview` + handleSend plan-review branch) |

> **2026-07-14 update.** Line refs in this section were refreshed — since 2026-07-01 the plan-review actions were extracted from `tool-exit-plan-mode.tsx` (now display-only) into a standalone `plan-review-card.tsx` rendered above a still-live composer, and `adapter.ts` grew substantially. The stranded plan-card class (row 2) is fixed: `clearStrandedPlanReview` (sessions-store) is called from the turn-settle `finally` in `sessions-provider.tsx` to drop a plan-review `pendingPermission` that outlived its turn, gated behind `isPlanReviewRequest` so real Allow/Deny gates are untouched. A plan gate blocks its turn, so this is a no-op in the happy path (Approve / a typed follow-up already cleared the gate) and only fires on the strand. Covered by `src/zeros/agent/__tests__/sessions-store-plan-review.test.ts`. Rows 3–4 also closed the same day: row 3 gained adapter tests for rapid Plan-toggle settling + `ExitPlanMode` approval/plan ordering (`src/engine/agents/adapters/claude-sdk/__tests__/adapter.test.ts`), and row 4's approve-with-feedback is served by the live composer (type a follow-up → deny gate → next prompt), so the optional inline affordance was intentionally left unbuilt. **§3.7 is now fully green.**

### 3.8 Auth & providers

| Task | Agent | St | P | UI | User-facing meaning & what's left | Key files |
| --- | --- | :--: | :-- | :--: | --- | --- |
| Auth invalidation self-heal | engine | ✅ | P1 | 🔍 | *(Done — see §2.3.)* | `gateway.ts:290-320` |
| In-flight work survives token refresh | engine | 🟡 | P2 | ⚙️ | MCP-gateway single-flight coalesces concurrent 401 refreshes; agent CLIs refresh under their long-lived process. *Left (if wanted):* a `didRefreshFor401` one-shot guard for agent auth; proactive idle-session reap on re-auth. | `gateway/server.ts:91`, `gateway.ts:598` |
| `SessionEnd`/auth-status → immediate sign-in | claude | ❌ | P2 | 🔍 | Signing out of Claude mid-chat isn't noticed until the next message fails (auth is inferred heuristically from error text). *Left:* register `SessionEnd` hook / consume `SDKAuthStatusMessage`. | `adapter.ts:97-106/656-714` |
| First-class Bedrock / Vertex hosting | claude | 🟡 | P2 | 🎨 | A user can route Claude via a custom gateway base_url + API key, but native Bedrock/Vertex isn't one-click (the env vars are only in a security blocklist). *Left:* a Bedrock/Vertex provider mode if BYO-cloud is in scope. | `providers-panel.tsx`, `env-names.ts:100-105` |

### 3.9 Tool-content visibility & streaming

| Task | Agent | St | P | UI | User-facing meaning & what's left | Key files |
| --- | --- | :--: | :-- | :--: | --- | --- |
| **Tool-result image rendering (bug)** | claude | 🟡 | P1 | 🎨 | A tool that returns a screenshot/image (browser MCP) shows **nothing** — the translator flattens all tool_result content to text and drops image blocks, even though the renderer can display them. *Left:* preserve image blocks → `{type:'content',content:{type:'image',…}}`. | `claude/translator.ts:376-397/705-714`, `event-row-renderer.tsx:122-130` |
| **Exec output APPENDs, not REPLACEs** | codex | ❌ | P1 | 🔍 | While a long Codex command streams, the card shows only the latest fragment flickering; full text appears only at completion. *Left:* accumulate output deltas and emit the running total. | `app-server-translator.ts:433-448`, `core/agent-messages.ts:403` |
| **`willRetry` error bubble guard** | codex | 🟡 | P1 | 🔍 | A transient error Codex silently retries still shows a red "⚠ Codex error" above the successful reply. The runtime guards `willRetry`; the translator's bubble doesn't. *Left:* skip the bubble when `willRetry===true`. | `app-server-translator.ts:506-526`, `app-server.ts:543-548` |
| **`thread/status/changed` → unlock composer** | codex | ❌ | P2 | 🔍 | A Codex `systemError` (no turn-completion) can keep the composer locked up to the 10-min timeout. *Left:* add a case that settles the turn as failed on `systemError`. | `app-server-translator.ts:144-202` |
| **Reasoning summary-part disambiguation** | codex | ❌ | P2 | 🔍 | Multiple distinct reasoning-summary parts merge into one blob; new-part boundaries are ignored. *Left:* key accumulation by `${itemId}:${summaryIndex\|contentIndex}` and handle `summaryPartAdded`. | `app-server-translator.ts:427-431` |
| **`tools.web_search` explicitly enabled** | codex | ❌ | P2 | 🔍 | Codex web search relies on CLI defaults; Zeros never turns it on, so it can't be counted on. *Left:* enable via config override. | `generated/v2/ToolsV2.ts` |
| **Per-turn diff attribution (dead wiring)** | codex | 🟡 | P2 | 🔍 | `turn/diff/updated` is subscribed but has **no translator case** → dropped; there's no consolidated per-turn diff for Codex (individual file cards still show). *Left:* handle it or document as no-op. | `app-server-adapter.ts:929`, `app-server-translator.ts:200` |
| **MCP tool progress** | codex | ❌ | P2 | 🔍 | Long-running MCP tools show start/success/fail but no incremental progress. *Left:* handle `item/mcpToolCall/progress`. | `app-server-translator.ts` |
| **Cursor delta channel (streaming keystone)** | cursor | 🟡 | P1 | 🔍 | Cursor text/tools/thinking **do** stream (whole messages) — but there's no smooth token-by-token text, live shell output, or token-usage, because the bun→Node host forwards only whole `SDKMessage`s (no `run.delta` channel; `onStep/onDelta` never registered). *Left:* add a host `run.delta` event → adapter/translator consume `text-delta`/`shell-output-delta`/`turn-ended`. **Root blocker for the three below.** | `host/cursor-host.cjs:165-176`, `adapter.ts:709-758` |
| ↳ **Live shell/terminal output** | cursor | ❌ | P2 | 🔍 | Long Cursor shell commands show output only on completion. *(Needs the delta channel.)* | `translator.ts:270-376` |
| ↳ **Token-by-token text/thinking** | cursor | ❌ | P3 | 🔍 | Cursor streams in message-sized chunks, not a smooth typewriter. *(Needs the delta channel.)* | `translator.ts:236-268` |
| ↳ **Token usage / analytics** | cursor | ❌ | P2 | ⚙️ | Cursor turns report zero tokens and are invisible in cost analytics. *(Needs the delta channel; then map `turn-ended.usage` → `PromptResponse.usage`.)* | `adapter.ts:773-775` |
| **Live in-turn token usage** | claude | ❌ | P2 | 🔍 | The token/cost counter only updates at turn end, not live. *Left:* consume `SDKThinkingTokensMessage`/stream usage for incremental `usage_update`. | `claude/translator.ts:664` |
| **Cheap wins from fields already arriving (Cursor)** | cursor | ❌ | P3 | 🎨 | `SDKToolUseMessage.truncated` and `SDKThinkingMessage.thinking_duration_ms` arrive on messages the translator already reads but are ignored — no "output truncated" badge, no thinking duration. *Left:* read the fields (no delta channel needed). | `translator.ts:236-247` |

> ✅ **Done here:** Codex typed Read/Grep/List cards from `commandActions`; failing-bash error text (both agents, tested); Codex reasoning + plan + MCP-tool-call streaming (tested); Cursor subagent transcript reader + `CursorTaskCard`.

### 3.10 MCP — mostly done; remaining niceties

MCP is **shipped end-to-end** (§2.3): registration, dedupe, per-session resolution, the stdio\|http union, a Keychain-backed secret path, an OAuth 2.1 gateway, and a full Settings → MCP management panel. Remaining:

| Task | Agent | St | P | UI | User-facing meaning & what's left | Key files |
| --- | --- | :--: | :-- | :--: | --- | --- |
| OAuth/`auth` block for **Cursor** MCP servers | cursor | 🟡 | P2 | ⚙️ | Basic stdio + header-auth HTTP/SSE register; **OAuth-secured** MCP servers don't (no `auth{CLIENT_ID,…}`, no explicit http-vs-sse, no stdio `cwd`). *Left:* forward the OAuth block + distinguish sse. | `cursor-sdk/adapter.ts:935-950` |
| MCP runtime status/control (Claude) | claude | ❌ | P3 | 🎨 | MCP servers are configured but there's no live health/status/reconnect UI (`query.mcpServerStatus()` never called). | `sdk.d.ts` |
| Custom subagents defined by Zeros | claude, cursor | 🟡 | P3 | 🔍 | File-based `.claude/agents` / `.cursor/agents` load implicitly via `settingSources`, but Zeros never sets `Options.agents`/`AgentOptions.agents` or advertises the roster via `supportedAgents()`. | `claude-sdk/adapter.ts:1227`, `cursor-sdk/adapter.ts:924` |

### 3.11 Rate-limits & usage telemetry

| Task | Agent | St | P | UI | User-facing meaning & what's left | Key files |
| --- | --- | :--: | :-- | :--: | --- | --- |
| **Rate-limit fan-out + soft gating** | all | 🟡 | P2 | 🎨 | Codex captures `account/rateLimits/updated` but never fans it out ("No bridge fan-out yet"); Claude captures **nothing**; Cursor's 429 hard-fails. There's no "you're rate-limited / usage remaining" surface anywhere. *Left:* bridge event + a usage/rate-limit pill; Claude-side capture; a Cursor 429 branch. | `app-server-adapter.ts:885-890`, `cursor-sdk/adapter.ts:1047-1057` |
| **Cursor 429 → soft retry** | cursor | ❌ | P1 | 🔍 | A Cursor rate-limit shows a hard "Agent error" toast, not "try again shortly." `isRetryable` is dropped at the host boundary. *Left:* forward `isRetryable`; add a 429/`RateLimitError` branch. | `host/cursor-host.cjs:144-154`, `adapter.ts:1047-1057` |
| **Codex native thread-id resume** | codex | 🟡 | P1 | 🔍 | Reopening a *just-created* Codex chat by its live UUID can start a **blank** thread (loses memory); resume from the History browser works (uses the real disk id). *Left:* surface the codex thread id as the canonical/persisted sessionId. | `app-server-adapter.ts:262/533/603` |

---

## 4. Agent-chat UI surface inventory (status re-verified)

Master catalog from the UI doc, with each surface's current state. **St** = exists ✅ / removed ➖ / open ❌ / partial 🟡.

### (a) Messages, text & thinking

| Surface | St | Notes (user-centric) | File |
| --- | :--: | --- | --- |
| Agent / user / system bubbles, resume + summary dividers | ✅ | Markdown via `marked`+DOMPurify. Only the **trailing** agent text is the bright answer; earlier narration is "in-between" working content. | `text-message.tsx` |
| **Thinking / reasoning block** | 🟡➖ | **Regression:** `ThinkingBlock` (shimmer, ticking `LiveDuration`, redacted badge, Cmd+Shift+T toggle) is now **dead code** — the registry routes `role:'thought'` through the plain `EventRow`, so reasoning shows as a plain expandable "Thinking" row with **no shimmer/timer and no redacted-thinking badge**. | `thinking-block.tsx` (orphan), `registry.ts:49` |
| Agent-reply copy | 🟡 | Whole-turn copy + fenced code-block copy exist; **per-message hover-copy on the agent bubble is missing** (the doc's "agent reply has none" is now half-true). | `turn-footer.tsx:263`, `markdown-code-block.tsx:35` |

### (b) Tool rows & the working group

| Surface | St | Notes | File |
| --- | :--: | --- | --- |
| `EventRow` (inline row per tool/thought) | ✅ | Icon + `fg1` name (≤60ch) + `fg2` target; status by tint only. | `event-row.tsx` |
| `EventStripe` working group (live-expanded → settled chip) | ✅ | Live = fully expanded reasoning feed, no header; settled = one chip `N tool calls, M messages, K agents` + deduped icons **after** the text; semantic `fg1/fg2` (no opacity wash); 3-bucket counts. Tested (`turn-partition`, `event-summary`). | `event-stripe.tsx`, `tool-summary.ts` |
| **Running affordance on `EventRow`** | ❌ | ✦P1 — a 40s Bash and a 40ms one look identical; only a faint icon tint changes. No spinner/timer. | `event-row.tsx:65/72` |

### (c) Specialized cards

| Surface | St | Notes | File |
| --- | :--: | --- | --- |
| `EditCard` diff | ✅ | Now `@pierre/diffs` `<PatchDiff>` (same engine as Changes tab) — syntax highlight, word-level intra-line, virtualization. `+N −M` counts; hidden when 0/0. | `tool-edit.tsx` |
| ~~EditHistory (+N more)~~ / ~~DiffView/Hunk/DiffLine~~ / ~~hover-preview~~ | ➖ | All **removed**. | — |
| `ExitPlanModeCard` (Claude) | ✅ | Plan markdown + mode-pick approve / "Stay in Plan mode". *(Stuck-pending fallback still open — §3.7.)* | `tool-exit-plan-mode.tsx` |
| `QuestionCard` (Claude) | ✅ | Choice/multi/text/yes-no form + "Sent:" echo. *(Answer flows as a next-turn prompt, and the echo/fallback issues below.)* | `question-card.tsx` |
| `SubagentCard` (Claude) | ✅ | Auto-expands while running, folds on settle; Prompt block + markdown result; children stream via `EventStripe`. Header is hand-rolled (✦P2). | `tool-subagent.tsx` |
| `CursorTaskCard` (Cursor) | ✅ | Raw Task Input/Output JSON + live child tools (from the on-disk transcript). | `tool-cursor-task.tsx` |
| Design-tool receipts | ✅ | Low/high-risk prompts w/ before→after diff for the 4 Zeros design MCP tools. | `design-tools.ts` |

### (d) Permission & interaction

| Surface | St | Notes | File |
| --- | :--: | --- | --- |
| Inline permission cluster + option buttons | ✅ | Renders inline under the matching tool row (Claude/Codex). | `inline-permission.tsx` |
| `PermissionBar` global fallback | ✅ | For unanchored/auth/design-tool requests; risk default **medium** here. | `agent-chat.tsx` |
| `AutoDecisionChip` (auto-allowed/blocked + Revoke) | ✅ | Only management surface for sticky policies (chat-scoped; no global settings page). | `auto-decision-chip.tsx` |
| Cursor permission round-trip | ➖ | None (see §3.2). | — |
| **Generic risk defaults to `high`** | ❌ | ✦P1 — every routine Bash/Edit/exec prompt renders alarm-red, desensitizing users. Default to `medium`. | `inline-permission.tsx:79` |
| **Button order / variant distinction** | ❌ | ✦P2 — Cancel renders first (Block ends up nearest the cursor); "Allow once" and "Always allow" share a hue. | `inline-permission.tsx:95-148` |
| **Resolved-state echo** | ❌ | ✦P2 — the cluster vanishes on click with no "Allowed/Blocked" confirmation (unlike QuestionCard). | `inline-permission.tsx` |
| QuestionCard fallback shell + echo persistence | ❌ | ✦P2 — unparseable → a divergent bare `<Card>`; the "Sent:" echo is local `useState` (lost on remount → stale unanswered form). | `question-card.tsx:73-90/71` |
| `InteractionPrompt` accessibility | ❌ | ✦P2 — `role='dialog'` with only `aria-label`; no focus trap / default focus / Enter-to-allow. | `interaction-prompt.tsx:56-65` |

### (e) Errors & fallback

| Surface | St | Notes | File |
| --- | :--: | --- | --- |
| `UnknownMessage` drift fallback | ✅ | Collapsed JSON card for unrecognized events. | `unknown-message.tsx` |
| Codex error / advisory bubbles | ✅ | `⚠ Codex error` / `ℹ Warning/Deprecation`. *(willRetry guard still open — §3.9.)* | `app-server-translator.ts:490` |
| Cursor / Claude failure routing | ✅ | Sign-in chip · silent rebuild+retry · transport-closed. | adapters |
| ~~`ErrorCard`~~ | ➖ | Removed; terminal failures now surface as **toast + disabled composer**. Two stale comments still name it. | `agent-chat.tsx:2051` |

### (f) Chat shell & turn structure

| Surface | St | Notes | File |
| --- | :--: | --- | --- |
| TurnContainer / prompt header / queued bubbles / TurnEventList / ActivityShimmer | ✅ | Turn framing, editable queued sends (FIFO), tail working shimmer. | `turn-container.tsx`, `turn-event-list.tsx` |
| Send/Stop, jump pills, empty state, load-older, top mask | ✅ | (Jump-pill hover is a no-op + no unread count — ✦P3.) | `agent-chat.tsx`, `jump-pills.tsx` |
| Composer task dock (live Plan) | ✅ | Collapsed "Task N of M" strip above the composer. | `agent-chat.tsx:2432` |
| Embedded-terminal banner (Claude `/mcp` `/login` `/config`) | ✅ | Inline PTY sharing `~/.claude`. | `embedded-terminal-command.tsx` |
| **Warming / reconnecting chip** | ❌ | ✦P1 — the states exist but **no chip renders**, and `canSend` stays true during warming/reconnecting, so a user can fire into a not-yet-live session. | `agent-chat.tsx:2161`, `:1642` |

### (g) Composer & the removed usage pill

| Surface | St | Notes | File |
| --- | :--: | --- | --- |
| Composer card + drag overlay, editor, pickers (@ / / #), image lightbox, project-context chip | ✅ | (Drag-overlay radius off-grid — ✦P3.) | `agent-chat.tsx`, `composer-editor/` |
| Toolbar pills — Model / Fast / Effort / Plan | ✅ | Permission mode moved into the `+` menu (doc-3 "Permissions pill" is stale). Fast/Effort gated per agent (hidden for Cursor). | `agent-chat.tsx:862-951` |
| Added-directories chips (Claude `/add-dir`) | ✅ | Removable Folder chips; live grant/revoke (tested engine-side). | `added-directories.tsx` |
| **Usage / context pill (token + cost)** | ➖ | **Removed for ALL agents** — the data is captured (`AgentUsage`: Claude real cost, Codex tokens-only, Cursor blind) but **rendered nowhere**. doc-3's "Claude shows real cost" is stale. Rebuild degrading per agent. | `agent-chat.tsx:2620`, `use-agent-session.tsx:64-90` |

---

## 5. Design-polish findings (open vs resolved)

| Finding | Sev | St | What's left | File |
| --- | :--: | :--: | --- | --- |
| Running affordance on `EventRow` | High | ❌ | Spinner/pulse or ticking duration on the run tone. | `event-row.tsx` |
| Status semantic tokens (`--success/--warning/--info/--destructive`) | High | ✅ | **Resolved** — curated oklch values shipped; only the stale top-of-file "TODO placeholders" comment needs scrubbing. | `zeros-tokens.css:283-287` (stale legend `:65-67`) |
| Inline permission risk defaults to `high` | High | ❌ | Default generic → `medium`. | `inline-permission.tsx:79` |
| Warming/reconnecting indicator + `canSend` gating | High | ❌ | Add the chip; gate `canSend` while `status!=='ready'`. | `agent-chat.tsx:2161/1642` |
| EditCard diff scaling / virtualization | High | ✅ | **Resolved** via `<PatchDiff>`. | `tool-edit.tsx` |
| Permission button order / variant hue | Med | ❌ | Affirmative rightmost; de-emphasize "Always"; fix stale comment. | `inline-permission.tsx:95-148` |
| Cluster resolved-state echo | Med | ❌ | Inline "Allowed/Blocked" + optimistic disable. | `inline-permission.tsx` |
| SubagentCard hand-rolled header | Med | ❌ | Route through `ToolHeader`/EventRow (elapsed timer intentionally omitted → possibly WONTFIX). | `tool-subagent.tsx:104-133` |
| Cross-card status language | Med | 🟡 | EditCard status pill removed (now EventRow tint); delete dead `tool-status.ts`; align EventRow vs ExitPlanMode `ToolHeader`. | `tool-status.ts` (dead) |
| QuestionCard fallback shell + echo persistence | Med | ❌ | Route fallback through `InteractionPrompt`; derive answered-state from durable data. | `question-card.tsx` |
| `InteractionPrompt` a11y | Med | ❌ | Focus mgmt + Enter/Esc + proper roles. | `interaction-prompt.tsx` |
| Agent-reply message hover-copy | Med | 🟡 | Turn/code copy done; add per-bubble hover-copy. | `text-message.tsx` |
| ThinkingBlock over-persistence | Low | ➖ | **Moot** — the component isn't mounted (but that itself is the regression in §4a/§6). | — |
| Jump-pill hover / unread | Low | ❌ | Real hover delta + unread badge. | `jump-pills.tsx:70/97` |
| Globe icon collision (fetch vs web_search) | Low | ❌ | Distinct icon for fetch. | `event-meta.ts:209-229` |
| EditCard mixed type sizes | Low | ❌ | Align fallback pre to `text-xs`. | `tool-edit.tsx:105-118` |
| Composer overlay radius / plan-frame tint | Low | ❌ | Match `rounded-xl`; verify frame tint. | `agent-chat.tsx:2459/2480` |
| EventRow icon jiggle / `aria-expanded` | Low | 🟡 | Jiggle mitigated (uniform size-3); set `aria-expanded={false}` consistently. | `event-row.tsx:114` |
| EventStripe lost duration / dual formatters | Low | ❌ | Surface one aggregate duration or delete the computation; unify formatter. | `event-stripe.tsx`, `tool-summary.ts` |

---

## 6. Dead code, stale comments & known bugs to clean up

- **`ThinkingBlock` orphaned (regression).** Routed nowhere; the shimmer, ticking duration, **redacted-thinking badge**, and Cmd+Shift+T toggle are not rendered. `THINKING_TOGGLE_EVENT` dispatches to zero listeners. Decide: delete it, or re-wire it (the redacted badge is a genuine UX regression). `thinking-block.tsx`, `registry.ts:49`.
- **Claude image-drop bug (§3.9).** Tool-result image blocks are flattened to text and silently lost. `claude/translator.ts:705-714`.
- **Codex `turn/diff/updated` dead wiring.** Subscribed but no translator case → dropped. `app-server-adapter.ts:929`.
- **Codex `question` ToolKind declared but never emitted** — confirms the ask-tool path is incomplete end-to-end. `app-server-translator.ts:46`.
- **`translator.codexThreadId` getter is test-only** — the native id it captures is effectively dead for resume. `app-server-translator.ts:101`.
- **`tool-status.ts` (`mapToolStatus`) dead** — imported nowhere after EditCard moved to EventRow.
- **Stale comments:** `ErrorCard` references (`agent-chat.tsx:2051`, PermissionBar header ~2685); `zeros-tokens.css` top legend still calls finalized tokens "placeholders"; Cursor `settingSources` comment claims it mirrors Claude's `['user','project','local']` but the literal is `['user','project','team','mdm','plugins']`.
- **Dead `'max_tokens'` stop-reason branch** in `claude/translator.ts:305` — never assigned because `result.stop_reason` is never read.

---

## 7. Conductor-parity scorecard

The parity doc's 12 axes, re-scored against current code. **Most reliability axes are now closed;** the remaining open work is concentrated in Codex elicitation/reconnect, Cursor streaming/rate-limits, Claude bypass/hooks, and a handful of UI surfaces.

| Axis | Then | Now | Remaining |
| --- | --- | :--: | --- |
| Resume / session persistence | fragile | ✅ mostly | Codex live-UUID resume (§3.11); orphaned turn rows (§3.1) |
| Transport / process lifecycle | ❌ | ✅ mostly | Codex mid-turn reconnect + per-session exit (§3.1); Cursor host-crash class + backoff |
| Permissions / approvals | 🟡 | ✅ mostly | Claude bypass **P0** (persistence ✅ done, `ff550e58`); Codex inline anchoring + fileChange diff + tests; Cursor gating UI |
| Cancellation / interruption | unverified | ✅ | steering (`turn/steer`) optional (§3.4) |
| Context / compaction | ❌ | 🟡 | Codex `/compact` + compaction accounting; Claude compaction banner/`getContextUsage` |
| Checkpoints / rollback | ❌ | ⏭️ skipped | Covered by the NATIVE per-turn checkpoint system ("Reset to this point", all agents); per-agent SDK rollbacks deliberately not wired (§3.5, 2026-07-13) |
| Models / version coupling | 🟡 | ✅ mostly | `fallbackModel` + budget caps absent; Cursor effort control |
| Plan mode state machine | 🟡 | ✅ mostly | stuck-pending fallback + rapid-toggle/ordering tests |
| Auth / login / providers | 🟡 | ✅ mostly | `SessionEnd`/auth-status hook; Bedrock/Vertex; refresh-once guard |
| Tool-content visibility | 🟡 | ✅ mostly | Claude image results (bug); Codex output APPEND + willRetry bubble; Cursor delta channel |
| Mid-session settings restart | 🟡 | ✅ (tested) | — |
| Cross-agent concurrency | 🟡 | ✅ | — |
| **MCP (not a parity axis but a big workstream)** | ❌ | ✅ | Cursor OAuth MCP; runtime status UI |
| **Rate-limit surfacing** | 🟡 | 🟡 | fan-out + soft gating for all; Cursor 429 |
| **Usage/cost pill** | shipped (Claude) | ➖ removed | rebuild (degrading per agent) |

---

## 8. Test-coverage snapshot

**Well covered (green in this environment; 294 adapter/shared tests across 19 files):** `claude_code` preset invariant; Claude Deny-keeps-turn; Claude mid-session live settings + resume-preserving restart; `/add-dir` carriage; Claude model discovery (single-flight, ultracode tier, retry) + model-family resolver; Codex session-expired regex parity (99 fixtures); Codex turn/stop-reason mapping; Codex `commandActions` typed cards; Codex MCP overrides; Cursor loadSession self-heal + model-gating bound + cwd carriage + classification + host protocol; config-isolation guard; `turn-partition` + `event-summary` pure functions; Codex live app-server smoke.

**Untested / thin (highest-value backfill):**

- **Codex approval round-trip** (`mapResponseToCodexDecision`, "unapproved exec never runs", decline-keeps-thread) — the highest-severity safety class, **zero coverage**. [⚙️]
- Plan-mode: approve+`setMode` ordering, no-stuck-after-rapid-toggle, approval message ordering. [🔍]
- Cursor: `local:{force:true}` send assertion; explicit `plan`-mode carriage; 429 classification (once implemented). [⚙️]
- Codex: runtime turn-completion race buffer + `willRetry` guard; per-turn diff attribution. [⚙️]
- No `fallbackModel` / budget-cap code exists to test.

---

## 9. Test plan — how to trigger every surface

**Setup:** dev build (`ZEROS_DEV=1`), tail the engine log for `[claude-sdk] turn options …` / `[codex] turn …` / `[cursor-sdk] …`; bind a project folder; authenticate all three agents (Cursor via `CURSOR_API_KEY`).

**Messages & thinking**
- Agent text: ask Claude to read a file mid-reply → text/tool/text in **separate** bubbles; Cursor keeps text in **one** bubble; Codex splits per `agentMessage`.
- **Thinking regression check:** set effort High and ask a multi-step question → confirm reasoning renders as a plain expandable "Thinking" row (**expect no shimmer/timer**); force `redacted_thinking` on Claude → **expect no redacted badge** (documents the regression).
- Resume divider: restart the engine, prompt an old chat → dotted resume boundary.

**Tool rows & the working group**
- Read / Bash (incl. non-zero exit + a command with no exit code) / Grep / web_search vs fetch (**same Globe**).
- Working group live→settled: ask for interleaved reasoning+tools → live expanded feed (names `fg1`, command `fg2`, no "N tools" chip) → on finish, one `N tool calls, M messages, K agents` chip + icons; click to re-expand.
- **Running affordance (negative):** confirm a long Bash shows **no** spinner/timer on its row (open ✦P1).

**Specialized cards**
- EditCard: edit a file (Claude Edit/Write, Codex multi-file/rename, Cursor `diffString`) → `<PatchDiff>` + `+N −M`; each edit is its own row (no merge).
- ExitPlanModeCard (Claude): approve-with-mode / "Stay in Plan mode"; try the pending-null race + double-click (open ✦P2).
- SubagentCard (Claude) auto-expands while running; CursorTaskCard shows raw Input/Output + live children; Codex has no subagent tool.
- Codex item kinds: image view / generate / `Compacting context` (think-style).

**Permission & interaction**
- Claude/Codex ask mode → inline Allow/Block (confirm **generic prompts get the red ring** — open ✦P1); Deny a Claude Bash → turn continues.
- Always-allow → AutoDecisionChip + Revoke.
- **Cursor full-access (negative):** any shell/edit → **no card ever**.
- **Codex elicitation (negative):** trigger `request_user_input` / an eliciting MCP server → **no card**, turn hangs to timeout (open P1).
- **Bypass (P0 negative):** select Claude Full Access, edit a file → today it **still prompts** (the bug); after the fix, no card + no error.

**Errors, shell & lifecycle**
- Auth: sign out each agent → Claude/Cursor Sign-in chip, Codex `⚠` + dot flips.
- **Cursor host crash:** kill `cursor-host` mid-turn → today a hard toast (should become silent retry).
- **Cursor 429 / Codex silent retry / TLS proxy:** confirm soft vs hard handling.
- **Warming/reconnecting (negative):** cold-open / kill the subprocess → **blank pane, Send stays "ready"** (open ✦P1).
- Stop mid-turn → composer re-enables, no toast, queued sends dropped.

**Composer**
- Cycle each agent's modes (no timeline banner; pill reverts on error). Effort/Fast **hidden for Cursor**. `/add-dir` chips (Claude). Embedded terminal via `/mcp`/`/login` (Claude). Slash picker floor→full after first turn. Drag-drop image (all three).
- **Usage pill (negative):** confirm **no** token/cost readout anywhere for any agent today (removed).

---

## 10. Recommended sequencing (updated for what's already done)

Ordered by user-impact-per-effort; the big former blockers (MCP, `settingSources`, lifecycle resilience, diffs) are **already shipped**, so the list is shorter than the source docs'.

1. ✅ **Done (§3.2)** — **Claude Full-Access P0**: `allowDangerouslySkipPermissions` for bypass (scoped to bypass only, rebuilt on live switch-in), with regression tests. Runtime-verified — prompts stop **and** AskUserQuestion still surfaces via `onUserDialog`.
2. **Codex elicitation, as one unit** — flip `experimentalApi=true` at `initialize` **and** wire `item/tool/requestUserInput` → the shared question card (S+M). Gate is useless without the handler.
3. **Codex reconnect + per-session exit** (L) — kill the dead-end chat and the cross-chat "reconnecting" blast radius together.
4. ✅ **Done (§3.2)** — **Codex safety test backfill**: 32 approval decision-mapping tests, incl. the "unapproved never runs" invariant (Decline/Cancel/timeout/no-handler never grant).
5. ✅ **Done (§3.2)** — **Codex approval UX**: inline anchoring keys on the codex `item.id` at both ends (renderer matches `nativeToolCallId`), and the fileChange card now shows the file path / N-file count. (Per-file diff body descoped.)
6. **UI High-severity trio** (S each) — running affordance on `EventRow`; default generic permission risk to `medium`; warming/reconnecting chip + `canSend` gating.
7. **Rebuild the usage/rate-limit pill** (M) — degrade per agent (Claude real cost, Codex tokens, Cursor blind); fold in Codex rate-limit fan-out + Cursor 429 soft-retry.
8. **Cursor streaming keystone** (M) — the host `run.delta` channel first, then token usage / live shell output / text-thinking deltas ride on it; plus Cursor effort control (M) and host-crash → transport-closed (S).
9. **Claude quick wins** (S/M) — image-result rendering (bug), distinct stop-reasons. *(The §3.2 pair — path-aware permission copy and "Allow always" → `.claude` settings with a scope chooser — are ✅ shipped.)*
10. **Codex streaming/UX polish** (S each) — exec output APPEND, `willRetry` bubble guard, `thread/status/changed` unlock, `/compact` routing, reasoning summary-part keying.
11. ⏭️ **Skipped (§3.5, 2026-07-13)** — **Turn-revert, cross-agent**: the native per-turn checkpoints + "Reset to this point" footer already provide this for every agent; Claude `rewindFiles` / Codex `thread/rollback` deliberately not wired.
12. **Cleanup pass** (S) — delete/re-wire `ThinkingBlock` (decide the redacted-badge regression), delete `tool-status.ts`, scrub the stale `ErrorCard`/token-legend/settingSources comments.
13. **Hooks & advanced** (M+) — Claude `Options.hooks` umbrella (SessionEnd→auth, PreCompact→banner, Notification→toast, UserPromptSubmit→title); `fallbackModel` + budget caps; MCP runtime status UI; Codex `turn/steer`; Cursor OAuth MCP.
14. **Strategic** — Cursor cloud/background agents (out of the current local-only scope; harvest `RunResult.git` PR-url first if ever pursued).

---

## Appendix A — Canonical event & wire vocabulary (audited)

> Merged from the former `agent-events-and-coverage.md` Part A and **re-audited 2026-07-01** against the real definitions. **Source of truth in code:** `packages/core/src/agent-events.ts` (the old pointer `src/zeros/bridge/agent-events.ts` is now just a `export * from "@zeros/core/agent-events"` shim so existing engine/renderer/web/mobile import sites resolve). Every adapter normalizes its native protocol onto these shapes; the renderer folds them into the chat UI **without branching on agent id**. New in this pass: an **Emitted vs dormant** reality check on every variant (a shape existing in the type union does **not** mean any adapter produces it).

### A.1 Identifiers

`SessionId` (Zeros UUID per chat) · `ToolCallId` (adapter-minted, unique per session) · `SessionModeId` (e.g. `"plan"`, `"default"`, `"acceptEdits"`) · `SessionModelId` (e.g. `"claude-sonnet-5"`, `"composer-2"`). All `string`.

### A.2 Content blocks (5 variants)

| `type` | Required fields | Emitted status |
| --- | --- | --- |
| `text` | `text` | ✅ all agents, both directions (the workhorse). |
| `image` | `data` (base64), `mimeType` (+ `uri?`) | 🟡 **input-only** — used to send images *to* the agent (`claude-sdk/adapter.ts:1304`, `codex/app-server-adapter.ts:994`); no translator emits an image as an *output* block (this is the Claude tool-result **image-drop bug** in §3.9). |
| `audio` | `data`, `mimeType` | ➖ **reserved/unused** — no adapter emits or consumes it. |
| `resource_link` | `uri`, `name` | 🟡 **input-only** — a `@<path>` mention is decoded to `@uri` text on the prompt side; not emitted as an output block. |
| `resource` (`EmbeddedResourceContent`) | `resource: TextResourceContents \| BlobResourceContents` | ➖ **declared-unused** — type only; no producer/consumer. |

All variants accept optional `annotations` (`audience`, `lastModified`, `priority`) — adapters leave these empty.

### A.3 Tool taxonomy — `ToolKind` is now a **16-value** enum (was documented as 14)

Adapters set `kind` on every tool call so the renderer picks a card without title-matching. **Corrections vs the old doc:** `list` and `task` were added (→ 16); `question` is **Claude-only** (Codex declares a local `'question'` kind but never emits it; Cursor delegates via `task`); `move` is **declared-but-never-produced**; `delete` is **Cursor-only**; `think` is **Codex-only** (`contextCompaction`); `fetch` is Claude+Cursor (not Codex); `switch_mode` is Claude-only.

| `kind` | Use | Produced by (today) |
| --- | --- | --- |
| `read` | file reads | Claude, Codex (`commandActions`), Cursor |
| `edit` | file edits (carries diff) | Claude (`Edit`/`Write`), Codex (`apply_patch`), Cursor |
| `delete` | file deletion | **Cursor only** |
| `move` | rename/move | ➖ **never produced** (type only) |
| `search` | grep/glob | Claude, Codex (`commandActions`), Cursor |
| `list` | dir listing (**new**) | Codex (`commandActions listFiles`), Cursor (`ls`), Claude (`LS`) |
| `web_search` | web search | Claude, Codex, Cursor |
| `execute` | shell | Claude (`Bash`), Codex, Cursor |
| `think` | reasoning/compaction surface | **Codex only** (`contextCompaction`) |
| `fetch` | HTTP fetch | Claude (`WebFetch`), Cursor |
| `switch_mode` | mode transition as a tool | **Claude only** (`ExitPlanMode`) |
| `subagent` | Claude-style threaded subagent | Claude (`Task`/`Agent`), Cursor (nested step) |
| `task` | Cursor raw-task card (**new**) | **Cursor only** (top-level subagent delegation → `CursorTaskCard`) |
| `mcp` | MCP-provided tool | Claude, Codex, Cursor |
| `question` | interactive question | **Claude only** (`AskUserQuestion`) |
| `other` | catch-all | all (fallback) |

`ToolCallStatus`: `pending → in_progress → completed \| failed`.

**A.3.1 `ToolCall`** (fires on `tool_call`, full shape): `toolCallId`, `title`, `kind?`, `status?`, `content?` (A.3.3), `locations?`, `rawInput?`, `rawOutput?`, `mergeKey?`, `parentToolId?`, **`at?`** (epoch-ms, set by transcript **replay** so durations reflect the original run; live turns omit it and the reducer stamps `Date.now()` — this field is new vs the old doc). Optional fields are `T | null | undefined` — the wire carries `null` for cleared values.

**A.3.2 `ToolCallUpdate`** (fires on `tool_call_update`): same fields, all optional; streams a tool's start→progress→completion without re-sending the whole shape.

**A.3.3 `ToolCallContent` (3 shapes):** `content` (a `ContentBlock` in the card) · `diff` (`path`, `oldText?`, `newText`) · `terminal` (`terminalId`).

**A.3.4 `mergeKey` — collapse REMOVED (2026-06-20).** Canonical value `edit:<absolute-path>`. All three adapters **still emit it** (`claude/translator.ts:583`, `codex/app-server-translator.ts:305`, `cursor-sdk/translator.ts:358`), but the renderer **no longer collapses** merged cards into "+N more changes" — each edit renders as its own standalone row (`agent-chat.tsx:299-304`). The field is carried passively but nothing consumes it. *(The code comment in `agent-events.ts:145-149` still describes the old collapse behavior — stale.)*

**A.3.5 `parentToolId`** — routes a tool call or message chunk into the nested transcript of the parent `subagent`/`task` card (Claude `Task`, Cursor `task`). Live and working.

### A.4 Plan / todo

`PlanEntry = { content; status: pending|in_progress|completed; priority: high|medium|low }`. `plan` events carry the **complete** `entries` array (replace-semantics; every emitter sends the full snapshot). The reducer also persists via `persistChatPlan(chatId, entries)`.

### A.5 Session-level state

- **`SessionMode`** `{id,name,description?}` → `SessionModeState {currentModeId, availableModes}` (from `NewSessionResponse.modes`; mutated by `current_mode_update`).
- **`ModelInfo`** `{modelId,name,description?}` → `SessionModelState {currentModelId, availableModels}`.
- **`AdvertisedModel`** *(new vs old doc)* `{value, label, badge?, effortLevels?, supportsFast?}` — advertised under `InitializeResponse._meta.models` to **overlay** per-model capabilities (effort ladder + Fast) onto the curated `catalogs/models-v1.json`; it does not replace the catalog. This is the hook the Cursor-effort work (§3.6) would populate.
- **`AvailableCommand`** `{name, description, input?:{hint}, kind?: "command"|"skill"}` *(the `kind` field is new — drives the composer picker's All / Commands / Skills tabs + the "skill" badge; absent ⇒ treated as a command)*.
- **`AvailableSubagent`** `{name, description, tools?, model?}` — see A.6 (the picker that consumes it is **dormant**).
- **`UsageCost`** `{inputCostUsd?, outputCostUsd?, totalCostUsd?}`; **`UsageStats`** `{size, used, cost?}`.

### A.6 Session updates — `SessionUpdate` (12 variants) + **emitted-vs-dormant**

The union count (12) is accurate. What changed is the *reality* of each — several are declared-and-consumed but **never produced**:

| # | `sessionUpdate` | Payload | Emitted status (2026-07-01) |
| --- | --- | --- | --- |
| 1 | `user_message_chunk` | `content; messageId?` | 🟡 **engine-only** — produced by the engine's persistence/replay layer (`index.ts:1997/2031`), **never by a live adapter** (Claude explicitly never emits it). |
| 2 | `agent_message_chunk` | `content; messageId?; parentToolId?` | ✅ Claude, Codex, Cursor. Same `messageId` coalesces; `parentToolId` → subagent card. |
| 3 | `agent_thought_chunk` | `content; messageId?; redacted?; parentToolId?` | ✅ Claude, Codex, Cursor. **Regression:** `redacted:true` is still emitted (Claude `redacted_thinking`), but the renderer routes thoughts through `EventRow` (not the dead `ThinkingBlock`), so the **redacted-stub badge no longer renders** (see §4a/§6). |
| 4 | `tool_call` | `& ToolCall` | ✅ all. |
| 5 | `tool_call_update` | `& ToolCallUpdate` | ✅ all. |
| 6 | `plan` | `entries: PlanEntry[]` | ✅ all (replace-semantics). |
| 7 | `available_commands_update` | `availableCommands[]` | ✅ **Claude + Codex only** — **not Cursor** (Cursor shows only the built-in floor). |
| 8 | `available_subagents_update` | `availableSubagents[]` | ➖ **DORMANT — never emitted by any adapter** (the store consumes it at `sessions-store.ts:534`, but no producer exists; the shared `discoverSubagents` path is dormant). *This corrects the old B.5 claim that it fires for Claude.* Note: subagent **rendering** (`SubagentCard`/`CursorTaskCard`) is unrelated and does work. |
| 9 | `current_mode_update` | `currentModeId` | ✅ Claude + Codex (state patch; no banner). |
| 10 | `mode_switch` | `source; axis; from?; to; reason?; at?` | ➖ **DORMANT as a wire update** — no adapter emits it; the timeline "Switched to Plan mode" banner is **not produced** (it exists only as a reducer/message kind routed through `EventRow`). |
| 11 | `usage_update` | `size; used; cost?` | ✅ **Claude + Codex only** (not Cursor) — but the **ContextPill/usage surface was removed** for all agents, so the data is captured (`sessions-store.ts:489`) and **rendered nowhere** (§4g). |
| 12 | `session_info_update` | `title?; updatedAt?` | ➖ **DORMANT** — never emitted; no adapter sets an agent-derived chat title through it (sidebar titles are Zeros-derived). |

### A.7 Top-level envelope

`SessionNotification = { sessionId; update: SessionUpdate }`, wrapped in `AGENT_SESSION_UPDATE` bridge messages (`src/zeros/bridge/messages.ts`).

### A.8 Permission flow

- **`PermissionOptionKind` (4):** `allow_once` · `allow_always` · `reject_once` · `reject_always`.
- **`PermissionOption`** `{optionId, name, kind}`.
- **`RequestPermissionRequest`** `{sessionId, toolCall: ToolCall, options: PermissionOption[]}` → `AGENT_PERMISSION_REQUEST`.
- **`RequestPermissionResponse`** `{outcome: {outcome:"cancelled"} | {outcome:"selected", optionId}}` → `AGENT_PERMISSION_RESPONSE` (read as `response.outcome.outcome`). Claude via `canUseTool`; Codex via `requestApproval`; **Cursor emits none** (§3.2).

### A.9 Stop reasons (5)

`end_turn` · `max_tokens` · `max_turn_requests` · `refusal` · `cancelled`. **Reality check:** the vocabulary is accurate, but `max_tokens` is currently a **dead branch** — no adapter assigns it (Claude never reads `result.stop_reason`; see §3.6). Codex maps `interrupted → cancelled` and `contextWindowExceeded → max_turn_requests`.

### A.10 Session lifecycle responses

- **`NewSessionResponse`** `{sessionId, modes?, models?}`.
- **`LoadSessionResponse`** `{modes?, models?, `**`resumedFresh?`**`}` *(the `resumedFresh` flag is new — engine-internal; set when the adapter could NOT resume a prior transcript and started a fresh thread/agent (Codex stale rollout, Cursor "agent not found", Claude no persisted id), so the gateway re-arms the one-shot first-turn `<system_instruction>`; the renderer ignores it).*
- **`ListSessionsResponse`** `{sessions: SessionInfo[], nextCursor?}`; `SessionInfo {sessionId, cwd, title?, updatedAt?, additionalDirectories?}`.
- **`PromptResponse`** `{stopReason, usage?: TurnUsage, userMessageId?}`. **`TurnUsage`** `{inputTokens?, outputTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens?, totalCostUsd?}` — populated by Claude (with cost) and Codex (tokens only); Cursor returns no usage (§3.9).

### A.11 Initialize handshake

`InitializeResponse {protocolVersion, agentCapabilities?, authMethods?, agentInfo?, _meta?}`. `agentCapabilities {loadSession?, promptCapabilities?{audio?, embeddedContext?, image?}, auth?{terminal?}}`. **`_meta`** is the extensibility hatch — recognized keys: `models: AdvertisedModel[]`, `modelEnvVar` (env var the chosen model is written to, e.g. `ANTHROPIC_MODEL`), `modelsDynamic: true` (adapter fills `models` async after a runtime boots; the gateway re-polls `initialize`). **`AuthMethod` (3):** `env_var` (`vars: AuthEnvVar[]` → Providers env editor) · `terminal` (Login-in-Terminal) · `agent` (agent-driven OAuth, rare).

### A.12 Adapter authoring rules (events side)

1. Always set `kind` on tool calls (title-matching is fallback only).
2. Coalesce streaming text by `messageId`.
3. Emit `mergeKey` (`edit:<absolute-path>`) for repeated edits — **but note the renderer no longer collapses on it** (A.3.4); emit it for forward-compat, don't rely on collapse.
4. Set `parentToolId` for subagent-routed events (chunks and tool calls).
5. Emit `usage_update` at turn end (engine-side accounting stays fresh even though the pill is currently hidden).
6. Plan emitters send full snapshots (replace-semantics).
7. Discovery is opt-in via `adapters/shared/discovery.ts` — `discoverCommands` is wired for Codex (Claude discovers via the SDK); `discoverSubagents` (the picker producer) is **dormant**.

`packages/core/src/agent-events.ts` is the only canonical home for these types — import the typed alias; never redeclare a shape in adapter code.

---

## Appendix B — Shipped-state reference (roster · transports · files · history)

> Merged from the former `agent-events-and-coverage.md` Part B, re-verified 2026-07-01. The **capability matrix** lives in §2.1 and the **per-agent baseline** in §2.2 — not duplicated here. This appendix carries the roster, version floors, file inventory, removed-agent history, and the maintenance contract.

### B.1 Roster (3 agents)

Source: `src/engine/agents/registry.ts` `AGENT_MANIFEST` (exactly 3 entries). Adding an agent = one manifest entry + one adapter module + a row here.

| id | name | runtime | `minCliVersion` | auth probe |
| --- | --- | --- | --- | --- |
| `claude` | Claude Code | `@anthropic-ai/claude-agent-sdk` `query()` (bundled, pinned CLI) | `1.0.0` (global CLI, for sign-in only) | keychain `Claude Code-credentials` → `.credentials.json` expiry → dotfiles |
| `codex` | Codex | `codex app-server` (JSON-RPC/stdio); `codex exec --ephemeral` for one-shots | **`0.131.0`** (app-server floor) | `codex login status` |
| `cursor` | Cursor Agent | `@cursor/sdk` (`bundledRuntime`) in a Node host (`cursor-host.cjs`) under bun | — (ships with the app) | `CURSOR_API_KEY` presence in the encrypted store |

**Auth posture (load-bearing):** Zeros never stores/transmits/logs vendor tokens. Probes check existence/status only — `file-with-expiry` reads *only* an expiry timestamp and discards the parsed object; `secret-account` checks key-presence without decrypting (`src/engine/agents/probes.ts`).

### B.2 Transports (today)

- **Claude** — persistent `query()` (streaming-input); `SDKMessage` stream normalized by `ClaudeStreamTranslator` (`adapters/claude/translator.ts`, reused by `claude-sdk/`); **in-loop `canUseTool` permissions (no hook server)**. The bundled pinned CLI executes; the global `claude` is only for Terminal sign-in.
- **Codex** — long-lived JSON-RPC 2.0 over stdio (`bootCodexAppServerRuntime`); **`requestApproval` permissions** on the same channel; `codex exec --ephemeral` retained in `one-shot.ts` for isolated text-gen (PR titles, commit messages), not the session path.
- **Cursor** — local `Agent.create`/`send` + `run.stream()` normalized by the cursor-sdk translator; runs in a Node subprocess host because bun's `node:http2` can't reach Cursor's backend (`ZEROS_CURSOR_IN_PROCESS=1` forces in-process on a Node engine). **No CLI/ACP fallback.**

Codex shares the stdio JSON-RPC fabric (`adapters/shared/{stdio-process, jsonrpc, login-shell-path}`). There is **no** stream-json shared adapter and **no** hook server.

### B.3 Files inventory (`src/engine/agents/`, re-verified)

```
gateway.ts · registry.ts · types.ts · probes.ts · session-paths.ts · task-tools.ts
claude-binary.ts · install-commands.ts · mcp-registry.ts · mcp-scan.ts     (+ the MCP gateway under gateway/)
adapters/
  shared/{stdio-process.ts, jsonrpc.ts, login-shell-path.ts, constants.ts, discovery.ts}
  claude-sdk/  adapter.ts input-queue.ts index.ts        (@anthropic-ai/claude-agent-sdk query())
  claude/      translator.ts index.ts                    (ClaudeStreamTranslator: SDKMessage→event, reused by claude-sdk/)
  codex/       app-server.ts app-server-adapter.ts app-server-translator.ts one-shot.ts
               binary-resolver.ts history.ts generated/* (ts-rs protocol types) index.ts
  cursor-sdk/  adapter.ts translator.ts subagent-transcript.ts index.ts host/{cursor-host.cjs,host-client.ts}
```

*(New since the old B.6.3: `claude-binary.ts`, `install-commands.ts`, `mcp-registry.ts`, `mcp-scan.ts`, the `gateway/` MCP OAuth server, and `cursor-sdk/{subagent-transcript.ts, host/}`.)* No `acp/`, `base.ts`, `spec.ts`, `stream-json-adapter.ts`, `hook-server/`, `gemini/`, `copilot/`, `droid/`, `opencode/`, `antigravity/`, or `cursor/` (CLI) — **all removed** (verified absent).

### B.4 Removed agents & infra (history)

Preserved so old references resolve. **None are in the live build** (2026-06-16 cut to three): **Droid** (`factory-droid`; per-turn stream-json + `--auto` modes) · **OpenCode** (`opencode serve` + `@opencode-ai/sdk` HTTP/SSE) · **Antigravity** (`agy -p`) · **Gemini** (`gemini --acp`, removed 2026-05-30) · **Copilot**. Removed with them: the **ACP fabric** (`adapters/acp/`), the **stream-json shared adapter** (`base.ts`/`spec.ts`/`stream-json-adapter.ts`), and the **hook server** (`hook-server/`). Permissions are now in-loop (`canUseTool`, Claude) / `requestApproval` (Codex).

### B.5 Maintaining this document

Update this file in the same change that touches agent behavior:

- **Event vocabulary** (`packages/core/src/agent-events.ts`) → update **Appendix A** (and the counts in A.2/A.3/A.6/A.8/A.9). Keep the **emitted-vs-dormant** column honest — mark a variant dormant when no adapter produces it, rather than implying it fires.
- **New / removed agent** (`registry.ts` + an adapter module) → update **App. B.1 roster**, **B.2 transports**, **B.3 files**, the **§2.1 matrix**, and note it in the relevant §3 theme.
- **Capability change** (an adapter gains a mode / MCP / resume / discovery, etc.) → flip the **§2.1 matrix** cell + the **§2.2/§2.3** note, and move the item out of §3 (open) into §2 (done).
- **A gap ships** → change its **§3 row** from ❌/🟡 to ✅ and (if it was tagged 🎨) confirm the surface exists in **§4**.

---

*Consolidated 2026-07-01 from the four superseded docs, re-verified against the codebase (per-adapter, engine/MCP/auth, UI, tests, and the `packages/core` event vocabulary + emit-vs-dormant reality check). This file is now the single source of truth for agent capabilities, Conductor parity, the chat UI, and the wire vocabulary.*
