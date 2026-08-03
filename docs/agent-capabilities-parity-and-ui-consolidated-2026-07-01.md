# Zeros Agents — Open tasks (Claude Code · Codex · Cursor)

**Updated 2026-08-03.** Checked tasks are implemented; unchecked tasks remain open. Each task says what the user gets, in plain language. Re-verified against the repository's pinned agent platforms on 2026-08-03 (Claude Agent SDK 0.3.220 · Codex 0.146.0 · Cursor SDK 1.0.26).

**Tags:** `Claude` / `Codex` / `Cursor` / `All` = which agent · **P1** do first · **P2** next · **P3** later · 🎨 = new/changed screen · 🔍 = wiring, confirm on screen · ⚙️ = invisible plumbing.

**Design file:** `styles/Artifacts/Designs/design-open-tasks-consolidated-2026-07-30.html` (one catalog for every task here that touches the UI — replaces design-3.8 and design-3.9).

---

## 1. Background tasks & waiting states

*Background work is now session-owned server state: Claude and Codex publish bounded, replace-style snapshots into one shared card, and completed work becomes a durable transcript record. Refreshes retain the last confirmed exact-session snapshot instead of blanking the UI.*

- [x] **Show every background task as a labeled chip in the chat** — Claude's native task membership and lifecycle events now drive one "Background Task" card above the composer, with the task name, live elapsed time, and Stop. `Claude · P1 · 🎨`
- [x] **Show a "Waiting for N background tasks" line with a live timer** — the line appears only when Claude reports the parent session idle while active work remains; it sits directly above the composer and uses the standard spinner. `Claude · P1 · 🎨`
- [x] **Show "Waiting for task until …" for watch-and-wait tasks** — Monitor/watch tasks use the same shared card, preserving their provider description, elapsed time, and task-scoped Stop action. `Claude · P1 · 🎨`
- [x] **Announce when a background task finishes** — one "Task Started" tool record settles in place as an expandable "Background Task" record with status, summary/error, command, duration, and output-file details when available; duplicate notifications do not create duplicate rows. `Claude · P1 · 🎨`
- [x] **A Background tasks list for the whole chat** — the docked, collapsible card lists the complete bounded active set for that chat (shells, subagents, watchers, and workflows), with elapsed time and Stop per row. `Claude · P1 · 🎨`
- [x] **Handle commands that move themselves to the background** — Claude's `is_backgrounded` transition and authoritative membership snapshot now move slow commands/MCP work into the same card without presenting the timeout as a failure or adding separate "moved" chrome. `Claude · P2 · 🎨`
- [x] **Show "next check at …" when the agent schedules its own wake-up** — one-shot `ScheduleWakeup` entries are read from the passive Stop hook, shown as "Next check at HH:MM · reason", cleared when they fire, and cancellable with Stop. Recurring entries are explicitly filtered out with task 008. `Claude · P2 · 🎨`
- [ ] **Show scheduled/recurring jobs the agent creates** — list them, and label messages they trigger as "scheduled run", never as something the user typed. **Skipped for now (2026-07-31)** — research first: where schedules run (a scheduler inside Zeros fires only while the app is open; laptop-closed runs need cloud routines, see §12) and how this relates to Claude's hosted Routines. Design and execute later. `Claude · P2 · 🎨`
- [x] **List Codex's background terminals** — the experimental app-server list is read for the exact thread with opaque-cursor pagination, refreshed from lifecycle invalidations, rendered in the same card, and stopped with the terminal-specific terminate endpoint. CPU/memory and provider-specific Kill chrome are intentionally omitted per the consolidated design. `Codex · P2 · 🎨`
- [x] **Never present a background notification as human input** — live Claude `user` envelopes remain tool-result transport only; prompt echoes, subagent turns, scheduled wakes, and task notifications cannot become human-authored chat bubbles. `Claude · P1 · ⚙️`

Implementation anchors: shared contracts and bridge validation live in `packages/core/src/agent-events.ts`, `packages/core/src/messages.ts`, and `packages/core/src/schemas.ts`; provider lifecycle wiring is in `src/engine/agents/adapters/claude/translator.ts`, `src/engine/agents/adapters/claude-sdk/adapter.ts`, and `src/engine/agents/adapters/codex/background-terminals.ts`; the keyed renderer state and UI are in `src/zeros/agent/sessions-store.ts`, `src/zeros/agent/background-tasks-card.tsx`, and `src/zeros/agent/renderers/background-task-record.tsx`. Exact-session isolation, stale-refresh races, authoritative empty snapshots, process-exit cleanup, edge/level reordering (including a missed start edge), duplicate completion, per-wake-up reason isolation, opaque pagination, task-scoped termination, and message-attribution regressions have automated coverage.

## 2. Subagents & multi-agent workflows

*The 2026-08-03 pass deliberately reuses Zeros' current permission, composer, and tool-call components without visual overrides. It adds one compact workflow hover detail, not a second background-card or helper-card system. Seven items are implemented and verified below; nine items are skipped for now.*

- [ ] **Show each subagent's model (and effort) on its card** — **Skipped for now (2026-08-03).** Do not design or implement a dedicated model/effort treatment in this pass. `Claude · P1 · 🎨`
- [ ] **Handle background subagents (they're the default now)** — **Skipped for now (2026-08-03).** Background-helper lifecycle UI will be handled in a separate iteration. `Claude · P1 · 🎨`
- [ ] **A live strip of running helpers for the turn** — **Skipped for now (2026-08-03).** Do not add a helper strip or fleet card. `Claude+Codex · P1 · 🎨`
- [x] **Route helper approvals through the existing permission card** — **Implemented and verified (2026-08-03).** Claude now forwards provider-authored request copy (for example “Allow network access”) into the current `PermissionCard`; its `--bg*`/`--fg*` tokens, typography, spacing, borders, action rows, focus behavior, and shortcuts remain the shipping UI. Concurrent helper gates queue in arrival order, dedupe replayed native request IDs, and advance safely after response, abort, timeout, or session teardown without adding helper chrome. `Claude · P1 · 🎨`
- [x] **Show helper progress as an ordinary Bash tool call** — **Implemented and verified (2026-08-03).** Helper-owned Bash activity retains its parent correlation and renders through the current expandable Bash tool-call component, including its existing icon, typography, spacing, collapse behavior, streaming output, and settled state. No heartbeat row, card, or shimmer was added. `Claude · P2 · 🔍`
- [x] **Use the existing permission card for workflow approval** — **Implemented and verified (2026-08-03).** Claude's native `permission_workflow` dialog now routes through the current `PermissionCard` without restyling it. Only its title (“Workflow approval”), compact existing-style phase pills (for example Find · 8 agents, Verify · 4 agents, Synthesize · 1 agent — each pill carries its own unit, since a pill is read on its own), and Run once / Always allow in this chat / Deny row copy vary. Parsing is literal-only and never executes the workflow script; cancel, abort, timeout, replay, and concurrent approval paths fail closed. No “large workflow”, estimated-token, cost, or scale banner exists. `Claude · P1 · 🎨`
- [x] **Show live workflow progress from a tool-call-style hover target** — **Implemented and verified (2026-08-03).** The workflow icon + “Workflow running” sits directly above the existing agent shimmer and timer in the live visual tail, using the current tool-call row styling. Hover or keyboard focus reveals one compact `--bg1` detail popover with a title-only header, Pause text control, and standard icon-only Stop action. Each phase shows only its name, a fixed-density 32-segment 8px track, and 8/8, 3/4, or Queued—never tokens or cost; pending cells use `--bg4`, progressed cells use `--fg2`, and completed tracks turn green. Counts dedupe cumulative start/progress/done events per helper, duplicate snapshots retain stable references, and late progress cannot reopen a terminal workflow. The row speaks only for work in flight: a run that settles mid-turn leaves the tail immediately instead of holding a “Workflow running” label and a live Stop until the turn ends, and the label itself is derived from status (running / paused). It does NOT inherit the shimmer's parked-on-the-user suppression — a helper's permission gate or blocking question silences the “agent is working” cue while the workflow's progress and Stop stay reachable, which is precisely when the user needs them. Stop is wired to the SDK's task-scoped `stopTask`; Pause is visibly reserved but disabled because the pinned public Agent SDK exposes no scoped pause method (the implementation does not depend on a private CLI protocol). `Claude · P1 · 🎨`
- [ ] **A persistent workflow status card under the composer** — **Skipped for now (2026-08-03).** Do not add a workflow card, dock, banner, agent count, token count, or cost readout. While the workflow keeps the agent working, retain the existing agent-loading shimmer in the workspace top bar and chat tab. `Claude · P1 · 🎨`
- [x] **Render workflow narrator lines as standard tool calls** — **Implemented and verified (2026-08-03).** Claude workflow log entries emit one deduplicated, completed “Workflow update” through the current tool-call component—normal icon, label, typography, spacing, expand/collapse behavior, and expanded output body. Repeated cumulative log prefixes do not duplicate transcript rows; no narrator-only card, colors, or loading shimmer were added. `Claude · P2 · 🔍`
- [ ] **Show Codex's agent fan-out properly** — **Skipped for now (2026-08-03).** Codex fan-out UI will be designed separately. `Codex · P1 · 🎨`
- [ ] **React to Codex helper lifecycle beats** — **Skipped for now (2026-08-03).** Handle this with the later Codex subagent pass. `Codex · P2 · 🔍`
- [ ] **Open a Codex helper's own transcript** — **Skipped for now (2026-08-03).** No helper-transcript navigation is designed in this pass. `Codex · P2 · 🎨`
- [x] **Keep Codex Ultra synchronized with the composer effort picker** — **Implemented and verified (2026-08-03).** The existing Ultra picker value maps to Codex's native `ultra` effort, and an exact-parent-thread `thread/settings/updated` notification maps `ultra` back to the owning chat's existing effort pill. Helper/collaboration thread drift, unknown effort values, and duplicate updates are ignored; no picker restyle, “True Ultra” card, or warning surface was added. Adopting a provider-reported tier is treated as already-applied: the live session's env stamp advances with it (effort only, so a genuinely unapplied model/Fast/add-dir change still reconciles) and the new env is pushed into the running session, so the next send neither respawns the session cold nor re-sends the old tier. Zeros-only tiers that Codex has no variant for (`max`) clamp down to its highest supported tier rather than failing the turn. `Codex · P2 · 🔍`
- [x] **Stream Cursor's nested activity inside the existing Task working group** — **Implemented and verified (2026-08-03).** Task remains the parent expandable tool call with its existing Input and Output sections. Cursor's already-live transcript polling emits nested Read/Bash/etc. operations through the same standard tool-call renderer, and the Task opens automatically when its first live child arrives while preserving an explicit user collapse/expand choice. No nested visual fork or separate activity card was added. `Cursor · P2 · 🎨`
- [ ] **Show when a Cursor task went to the background and why** — **Skipped for now (2026-08-03).** Do not add a Cursor-specific background card or background-reason banner. `Cursor · P3 · 🎨`
- [ ] **Let users define their own helpers** — **Skipped for now (2026-08-03).** Do not design or implement a helper roster, helper editor, automatic-selection UI, or composer picker in this pass; revisit it as a separate custom-subagent project. `Claude+Cursor · P3 · 🎨`

Implementation anchors: shared workflow, effort, permission-copy, and permission-settled wire contracts are in `packages/core/src/agent-events.ts`, `packages/core/src/messages.ts`, and `packages/core/src/schemas.ts`; Claude approval/progress translation is in `src/engine/agents/adapters/claude-sdk/adapter.ts` and `src/engine/agents/adapters/claude/translator.ts`; exact-session state and the reused permission/tool-call surfaces are in `src/zeros/agent/sessions-store.ts`, `src/zeros/agent/permission-card.tsx`, `src/zeros/agent/workflow-activity.tsx`, and `src/zeros/agent/turn-event-list.tsx`; Codex effort synchronization and Cursor Task disclosure are in `src/engine/agents/adapters/codex/app-server-adapter.ts` and `src/zeros/agent/renderers/tool-cursor-task.tsx`. Automated coverage includes exact-session isolation, concurrent/replayed/aborted approvals, request-and-settle ordering in one render frame, out-of-order workflow lifecycle edges, cumulative-agent and narration deduplication, fixed progress projection, stable replacement snapshots, parent-thread-only Ultra updates, and sticky Cursor Task disclosure.

## 3. Seeing everything the agent does (tool output & streaming)

*If the agent saw it, the user should see it — while it happens, not after.*

- [ ] **Show images the agent's tools return** — a screenshot from a browser tool renders as a picture; today it's silently dropped. `Claude · P1 · 🎨`
- [ ] **Long command output grows instead of flickering** — while a Codex command streams, the log appends line by line; today only the latest fragment shows until the end. `Codex · P1 · 🔍`
- [ ] **Live streaming for Cursor** — one wiring change (the delta channel) unlocks smooth word-by-word text, live shell output, and per-turn token counts for Cursor chats. `Cursor · P1 · 🔍`
- [ ] **↳ Live shell output for Cursor commands** — see the log while it runs, not on completion. `Cursor · P2 · 🔍`
- [ ] **↳ Word-by-word text and thinking for Cursor** — replies type out smoothly instead of arriving in blocks. `Cursor · P3 · 🔍`
- [ ] **↳ Cursor turns report real token usage** — Cursor chats stop being invisible in the cost readout. `Cursor · P2 · ⚙️`
- [ ] **A stuck Codex error unlocks the chat** — a system error mid-turn should end the turn with a clear "turn failed" instead of leaving the composer locked for up to 10 minutes. `Codex · P2 · 🔍`
- [ ] **Codex thoughts stay separate** — three distinct reasoning summaries render as three rows, not one merged blob. `Codex · P2 · 🔍`
- [ ] **Turn Codex web search on explicitly** — so search is always available, not dependent on CLI defaults. `Codex · P2 · ⚙️`
- [ ] **Show progress for long MCP tools** — a percentage / "62 of 180" and a slim bar while a long tool runs. `Codex · P2 · 🎨`
- [ ] **Show richer web-search results** — Codex now sends the query action and structured results; render them instead of a bare "Web search" row. `Codex · P3 · 🎨`
- [ ] **Style Codex interim commentary differently from the final answer** — Codex labels messages as commentary vs final; keep in-between narration quiet and only the real answer bright. `Codex · P2 · 🔍`
- [ ] **"Output truncated" badge + thinking timer for Cursor** — both fields already arrive and are ignored. `Cursor · P3 · 🎨`
- [ ] **Render Cursor's new image and screen-recording tools** — today they show as a bare generic row; give them proper cards (image preview, recording link). `Cursor · P3 · 🎨`
- [ ] **A real thinking treatment** — thinking rows get a shimmer while live, a duration when done, stay open while streaming, and show a "redacted" badge when the model hides its reasoning. `All · P2 · 🎨`
- [ ] **A running tool looks alive** — a spinner or ticking timer on any tool row that's still working; today a 40-second command looks identical to a finished one. `All · P1 · 🎨`

## 4. Questions, approvals & safety

- [ ] **Render MCP form/link requests instead of failing silently** — when an MCP server needs a form filled or a link opened mid-turn, show it on the question card (masked secrets, explicit continue), and treat a timeout as declined. `Codex · P2 · 🎨`
- [ ] **Answer unknown dialog requests safely** — Claude can ask the app to show new dialog kinds; anything unrecognized must be answered "cancelled" so the turn never hangs. `Claude · P1 · ⚙️`
- [ ] **Approvals leave a record** — after clicking Allow/Block, an "Allowed" / "Blocked" note stays on the row; today the card just vanishes. `All · P2 · 🎨`
- [ ] **Make "Yes once" and "Don't ask again" look different** — the sticky options should be visually distinct from the one-time Yes. `All · P2 · 🎨`
- [ ] **Keyboard & focus polish on blocking cards** — permission and question cards get proper focus handling (auto-focus, trap, Enter/Esc) for keyboard users. `All · P2 · 🎨`
- [ ] **Support Codex's richer approval asks** — network-access requests and "always allow this pattern" amendments arrive with the approval; show what's actually being granted. `Codex · P2 · 🎨`
- [ ] **Show Codex auto-review verdicts** — when a reviewer subagent approves/denies instead of the user, leave an audit row saying so. `Codex · P2 · 🎨`
- [ ] **Real per-tool approvals for Cursor via hooks** — Cursor still has no built-in prompt, but Zeros can install its own hook that asks the user before risky tools run; today Cursor tools run with no ask at all. `Cursor · P2 · 🎨`
- [ ] **Show the sandbox state** — a small badge when commands run sandboxed, and a clear prompt when the agent asks to reach a new network host. `Claude · P2 · 🎨`
- [ ] **Show hook activity** — when configured hooks run (start/progress/result, warnings that stop the turn), show quiet rows instead of nothing. `Claude · P3 · 🎨`

## 5. Usage, cost & limits

- [ ] **A live cost/token ticker while the turn runs** — watch tokens climb next to the working shimmer; today the bill appears only after the turn ends. `Claude · P2 · 🎨`
- [ ] **Show plan limits and reset times** — a usage surface (in the context gauge popover) with how much of the 5-hour/weekly limit is used, when it resets, and overage state; warn near the cap. `Claude · P2 · 🎨`
- [ ] **Surface Codex rate limits** — the data already arrives and is stored; show it (and credits/plan info) instead of dropping it. `Codex · P2 · 🎨`
- [ ] **Rate-limited Cursor says "try again shortly"** — a 429 becomes a soft retry notice, not a hard "Agent error". `Cursor · P1 · 🔍`
- [ ] **Live thinking-token estimate** — Claude streams how much thinking the model is doing; show it as a small pill. `Claude · P3 · 🎨`
- [ ] **Show fast-mode cooldown honestly** — when fast mode is on/off/cooling down, the pill reflects it and says why it's unavailable. `Claude · P2 · 🔍`

## 6. Models & effort

- [ ] **Add Cursor's Auto model (Router)** — the option that lets Cursor pick the best model per request; the rest of the catalog (Opus 5, GPT-5.6 family, Composer 2.5, Grok 4.5) is already current. `Cursor · P3 · 🎨`
- [ ] **Tell the user when the model was switched for safety** — Codex can reroute a turn to a different model; show an inline "model switched" note with the reason. `Codex · P2 · 🎨`
- [ ] **Codex personality setting** — friendly / pragmatic / none, where the model supports it. `Codex · P3 · 🎨`
- [ ] **Generic model options from Cursor's catalog** — Cursor models advertise their own knobs (effort variants); build the picker from that data instead of hard-coding. `Cursor · P2 · 🔍`

## 7. Sign-in & providers

- [ ] **Notice a sign-out the moment it happens** — the connected dot grays instantly, a "signed out" row lands in the chat, and a sign-in banner docks above the composer; your pending message sends once you're back. Today nothing happens until the next message fails. `Claude · P2 · 🎨`
- [ ] **One-click Bedrock / Vertex hosting** — a "Route Claude via" choice (Anthropic · custom gateway · Amazon Bedrock · Google Vertex) with region/credential fields; no more hand-editing config. `Claude · P2 · 🎨`
- [ ] **Refresh-once guard + idle-session reap on re-auth** — invisible plumbing so a token refresh never double-fires and stale sessions are cleaned up after signing back in. `All · P2 · ⚙️`

## 8. Sessions & reliability

- [ ] **Reopening a brand-new Codex chat never loses memory** — persist Codex's real thread id as the chat's id so an immediate reopen resumes with full context instead of a blank thread. `Codex · P1 · 🔍`
- [ ] **Keep listening after the answer ends** — Claude can send a suggested next prompt *after* the result; keep reading so it isn't lost, and show it as a tappable suggestion chip. `Claude · P2 · 🎨`
- [ ] **Mark keyboard input as human** — stamp real user messages as human-origin so trust-gated features (like the ultracode keyword) work; forwarded/scheduled content must not count as human. `Claude · P1 · ⚙️`
- [ ] **Show "needs your input" on the chat** — the session now reports idle / running / waiting-for-you; badge the chat tab so a waiting question is never missed. `Claude+Cursor · P2 · 🎨`
- [ ] **Map the new end-of-turn reasons** — turns can now end for new reasons (structured-output retries exhausted, deferred tools, background requested); show a named pill instead of a generic error. `Claude · P2 · 🔍`
- [ ] **Show partial answers as partial** — a reply cut off by Stop is now flagged by the agent; mark it "stopped early" instead of presenting it as complete. `Claude · P3 · 🔍`
- [ ] **Branch a conversation** — "fork from here" creates a copy of the chat (both Claude and Codex support it natively) so the user can explore two directions. `Claude+Codex · P3 · 🎨`
- [ ] **Codex session niceties** — named sessions, pinning, and search across thread history now exist in the protocol; adopt them in the sessions browser. `Codex · P3 · 🎨`

## 9. New agent powers to adopt

- [ ] **Show memory recalls** — when Claude pulls from its memory folder, show a small "recalled from memory" card with what it used. `Claude · P2 · 🎨`
- [ ] **Skill runs & skill proposals** — show a chip when a skill runs in the background, refresh the slash-command list live, and render the "agent proposes a new skill" review card. `Claude · P2 · 🎨`
- [ ] **Structured outputs** — when a chat is asked for schema-shaped output, render the final JSON nicely and explain a retry-exhausted failure. `Claude · P3 · 🎨`
- [ ] **Codex goals** — a standing objective with its own budget; show a goal banner with status (active / paused / budget-limited) and progress. `Codex · P3 · 🎨`
- [ ] **Codex review mode** — "review my changes" runs Codex's built-in reviewer; show entered/exited-review states and the findings list. `Codex · P2 · 🎨`
- [ ] **Cursor to-dos** — Cursor agents maintain a checklist; render it in the plan dock like Claude's plan. `Cursor · P2 · 🎨`
- [ ] **App-provided tools** — Cursor (customTools) and Codex (dynamicTools) let Zeros hand the agent app-side tools; use it for things like "ask the user" or "open this file in the app". `Codex+Cursor · P3 · ⚙️`
- [ ] **Import setup from other tools** — Codex can detect and migrate Claude Code / Cursor configuration; offer it during onboarding. `Codex · P3 · 🎨`
- [ ] **MCP server health** — a live status (connected / failed / reconnect) per MCP server in Settings; both Claude and Codex expose it now. `Claude+Codex · P3 · 🎨`
- [ ] **Cursor MCP parity** — pass OAuth-secured servers, explicit SSE, and working-directory options through to Cursor. `Cursor · P2 · ⚙️`

## 10. Chat polish

- [ ] **Copy one message** — a hover copy button on each agent reply (turn-level and code-block copy already exist). `All · P2 · 🎨`
- [ ] **Expand-all control** — a shortcut (and an "always expanded" preference) to open every collapsed tool row in a turn. `All · P2 · 🎨`
- [ ] **Different icons for web search vs fetch** — both are a globe today. `All · P3 · 🎨`
- [ ] **Jump pill niceties** — unread count and hover preview on the jump-to-latest pills. `All · P3 · 🎨`
- [ ] **Warming indicator** — a subtle "starting agent…" state when a chat is warming up, so first-message feedback is instant. `All · P2 · 🎨`
- [ ] **Queued messages say why they wait** — "waiting for the current reply to finish" on queued sends. `All · P3 · 🎨`
- [ ] **Show a turn's total work time on the collapsed chip** — the "N tool calls, M messages" chip gains its duration. `All · P3 · 🎨`
- [ ] **Unify the subagent card header** — route SubagentCard/CursorTaskCard through the standard row component so status/hover/keyboard behavior match every other tool row. `All · P3 · 🎨`
- [ ] **Math rendering** — LaTeX in replies renders as math, not raw markup. `All · P3 · 🎨`

## 11. Housekeeping (invisible, keeps the code honest)

- [ ] **Decide the dead Codex subscriptions** — per-turn diff, plan-update, and reasoning-part events are subscribed but dropped; wire them or remove them. `Codex · P2 · ⚙️`
- [ ] **Delete the dead status-mapper file and stale comments** — `tool-status.ts` has no importers; two comments still reference deleted permission surfaces. `— · P3 · ⚙️`
- [ ] **Remove or use the dead Codex thread-id getter** — it captures the native id that the resume fix (§8) actually needs. `Codex · P3 · ⚙️`
- [ ] **Retire the unused "thinking message" type or emit it** — it exists in the vocabulary but nothing produces or renders it (ties to the thinking treatment). `— · P3 · ⚙️`

## 12. Bigger bets (need scoping first)

- [ ] **Cloud / remote agents** — run a chat's agent in the cloud and keep working after closing the laptop (Cursor cloud agents + artifacts; Claude remote isolation; Codex environments). `All`
- [ ] **A cross-chat activity view** — one place listing every running chat, background task, and workflow across workspaces, with "needs input" flags. `All`
- [ ] **Same prompt, N models** — launch one prompt across several models/agents side-by-side and pick the best result. `All`
- [ ] **Voice conversations** — Codex now supports realtime voice sessions. `Codex`
