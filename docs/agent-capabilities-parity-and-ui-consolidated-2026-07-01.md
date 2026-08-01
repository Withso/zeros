# Zeros Agents — Open tasks (Claude Code · Codex · Cursor)

**Updated 2026-07-31.** Checked tasks are implemented; unchecked tasks remain open. Each task says what the user gets, in plain language. Re-verified against the repository's pinned agent platforms on 2026-07-31 (Claude Agent SDK 0.3.220 · Codex 0.146.0 · Cursor SDK 1.0.26).

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

*One chat can now fan out into many helper agents — a few, or hundreds in an ultracode workflow. Today Zeros shows one plain row per helper, with no model name, no live fleet, and no workflow view.*

- [ ] **Show each subagent's model (and effort) on its card** — "Explore · Sonnet 5" instead of just "Explore"; if it switched models mid-run, show what it ended on. `Claude · P1 · 🎨`
- [ ] **Handle background subagents (they're the default now)** — a helper card appears instantly as "launched", keeps living after the turn ends, and fills in its result when the finish notice arrives later. `Claude · P1 · 🎨`
- [ ] **A live strip of running helpers for the turn** — while several subagents run in parallel, show a compact list (name · model · status · tokens) instead of scattered rows. `Claude+Codex · P1 · 🎨`
- [ ] **Say which helper is asking for permission** — when a background subagent needs approval, the permission card must name that agent, and declining must only decline that agent's request. `Claude · P1 · 🎨`
- [ ] **Show helper progress heartbeats** — long-running subagents report elapsed time, last tool used, and an occasional one-line summary; tick these on the card. `Claude · P2 · 🔍`
- [ ] **A workflow approval card** — before an ultracode workflow launches, show its name, phases, and a token-cost caution with Once / Always / Deny. `Claude · P1 · 🎨`
- [ ] **A live workflow progress view** — phases as groups ("Find", "Verify", …) with per-phase agent counts, token totals, and elapsed time; drill into any agent to see its prompt, recent tools, and result; pause/stop controls; a "large workflow" warning for big runs. `Claude · P1 · 🎨`
- [ ] **A persistent workflow status line under the composer** — "Workflow running · 12 agents · 340k tokens" while a workflow runs in the background. `Claude · P1 · 🎨`
- [ ] **Render the narrator lines a workflow logs** — short progress messages ("16 results in — verifiers running") appear as quiet status text, not as answers. `Claude · P2 · 🔍`
- [ ] **Show Codex's agent fan-out properly** — Codex spawns helpers too now: render its spawn/wait/close calls as one card with each helper's status, model, and effort, updating live. `Codex · P1 · 🎨`
- [ ] **React to Codex helper lifecycle beats** — "helper started / was interrupted" events currently vanish; show them on the fan-out card. `Codex · P2 · 🔍`
- [ ] **Open a Codex helper's own transcript** — each Codex helper is a real thread; let the user click into it read-only. `Codex · P2 · 🎨`
- [ ] **Make Codex's "Ultra" effort real** — the effort picker already shows Ultra, but it silently runs as Extra-High; Codex now accepts the real ultra tier (proactive multi-agent), so wire it through. `Codex · P2 · 🔍`
- [ ] **Show Cursor's nested helper activity** — Cursor now streams what a helper is doing inside a task; render those nested rows live instead of raw JSON. `Cursor · P2 · 🎨`
- [ ] **Show when a Cursor task went to the background and why** — "backgrounded (agent chose / you asked / queued)" with a link to its transcript. `Cursor · P3 · 🎨`
- [ ] **Let users define their own helpers** — both Claude and Cursor accept custom subagent rosters from the app; add a simple roster (name, purpose, model) and show it in a picker. `Claude+Cursor · P3 · 🎨`

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
