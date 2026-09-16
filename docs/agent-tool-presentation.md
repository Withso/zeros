# Agent tool streaming and presentation

This is the shared transcript contract for Claude, Codex and Cursor. Provider
adapters own native semantics; the renderer owns consistent presentation. A
provider upgrade must preserve both. Stored native inputs, results, identities
and statuses remain available even when routine metadata is hidden in the UI.

## Identity and streaming

1. Scope reconciliation to the provider execution, native conversation, parent
   tool, native message, block and tool identity where the provider supplies
   them. Keep the resulting durable message ID stable through all updates.
2. Retain a provisional record when a native start arrives, but show a known
   command/file/search/delegation row only once it has a meaningful command,
   target or task name. Never flash `Running shell command` or `Agent Agent`.
   Completed arguments enrich that same row. Terminal errors and unresolved
   results remain inspectable even if the start/arguments never arrive.
3. Handle repeated starts, completed snapshots, reconnect replay, missing starts
   and late results without duplicating rows or returning a settled row to a
   running state. An explicit new child interaction may resume its existing
   group; old lifecycle events cannot settle that newer work. Missing completion
   evidence remains unresolved.
4. History hydration reconciles overlapping snapshots by durable row ID. Never
   merge tools because titles or arguments match, especially when both inputs
   are missing. Equal text can also belong to separate messages. Reuse an
   unchanged history array; prefer newer snapshots, and retain settled status
   over a start when timestamps tie.
5. Keep a user's expanded/collapsed choice through result and history updates.
   Do not key rows by title, output, status, array position, or a generated
   render-time UUID. Native action facets may use the owning call plus their
   native action position/path; these are not additional tool executions.
6. A text block ending, a tool input finishing, a tool finishing and a turn
   finishing are different boundaries. Do not infer one from another.
7. A confirmed answer remains output when a later reply continues the same
   send. Preserve work → answer → more work → another answer in source order.
   Never downgrade earlier confirmed reports to commentary or move later work
   above them. Native end-turn metadata belongs to its own message, including
   late frames that arrive while a newer message is streaming.

### Provider boundaries

| Provider | Authoritative identity and completion                                                                                                                                                                                      | Presentation consequence                                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | An SDK assistant frame can contain just one completed block. Several frames have the same API message ID; the frame UUID and API block position distinguish them. Tool results correlate by native tool-use ID and parent. | A completed text block cannot suppress later tools from that response. Partial starts and full blocks enrich one named row.                     |
| Codex    | Item IDs identify streamed items; completed items provide authoritative snapshots. Command actions describe operations within a command execution, whose result is aggregated.                                             | Use native file actions without splitting one result into invented per-file outputs. Preserve the original command for recovery and inspection. |
| Cursor   | Native call IDs correlate callback and stream delivery. Shell wrappers can report success while the inner command has a failing exit code. Child transcript tool results refer to native tool IDs.                         | Merge delivery for each call, retain error text, and never infer completion from a wrapper or a child tool-use record alone.                    |

The Claude frame behavior is documented in the
[SDK streaming message flow](https://code.claude.com/docs/en/agent-sdk/streaming-output#message-flow).
Codex documents command actions, aggregated results and authoritative completed
items in the [app-server item contract](https://learn.chatgpt.com/docs/app-server#items).
For Cursor upgrades, compare the installed SDK types with its
[TypeScript SDK reference](https://cursor.com/docs/sdk/typescript); the pinned
types and native-event regression fixtures define the integration's supported
delivery shapes.

## Response replacement and model fallback

- Claude `supersedes` and `model_refusal_fallback.retracted_message_uuids`
  identify native SDK frame UUIDs, including per-block assistant frames and
  tool-result frames. Apply the markers before replay suppression. Unknown and
  already withdrawn UUIDs are no-ops; text matching cannot establish ownership.
- Withdraw only the named assistant blocks. Withdrawing a tool result clears
  its result, failure and settled status while retaining the invocation for a
  corrected result. A late audit of the old result cannot clear the correction.
  Withdrawing an invocation also withdraws its owned descendants; later child
  output and late ownership binding cannot resurrect an orphaned transcript.
- Persist payload-free tombstones under the original durable row IDs. Keep
  result revisions so stale history cannot restore withdrawn output. Rendering,
  copy/export, database text and history hydration must agree. Do not erase user
  prompts or unrelated siblings. Identity ledgers stay bounded per execution.
- Fallbacks are plain assistant commentary in source order, never tool calls,
  cards, icons or disclosures. Claude local copy is `Model fallback used Opus 5`;
  session copy is `Model switched to Sonnet 5`. Codex safety copy is
  `Model fallback to Sol 5.6 because of a cybersecurity-related safety check`.
  Substitute the actual catalog model. Codex narration uses the concise
  name/version order; the existing picker retains its shared catalog label.
  Do not infer a safety reason from arbitrary provider prose.
- Claude's explicit `scope` wins: `local` affects one response and must not
  change the parent selection. Keep identified child notices inside that Agent
  group, using native request/parent ownership. Unknown scope is conservatively
  local; absent scope means session for older supported SDKs. An inferred
  overload fallback is response-local. An explicit notice for that same native
  request refines the existing narration in place.
- Only a confirmed main-session fallback changes the saved chat model, composer
  dropdown and subsequent native sends. Codex root `model/rerouted` supplies
  the target; child-thread reroutes never change the parent. Persist the choice
  in the engine even without a renderer. Apply the renderer's model control
  update immediately, before a queued prompt can drain, independently of
  transcript animation-frame batching. Retain other configuration and global
  defaults; reconcile effort/Fast against the selected model's capabilities.
- A newer manual choice wins over an older request's fallback, including
  A → B → A. Use local selection revisions rather than comparing renderer and
  remote-engine wall clocks. Repeated notices cannot change selection again. If a late Claude
  sticky fallback overwrites a prior live control, reassert the current choice
  before more input leaves the app. Stop/disposal must interrupt this wait,
  and control failure must not send a prompt using the wrong model.
- Legacy persisted `model_switch` tool records render as the same narration,
  but history never drives a live model change. Preserve the serialized kind
  for compatibility. Cursor currently exposes no equivalent authoritative
  fallback/replacement event in the supported contract; do not synthesize one
  from response text or change its selected model by guesswork.

Regression coverage includes assistant/tool-result replacement, repeated and
late audit receipts, overlapping blocks and parents, stale history, child
ownership, local/session scope, native next-send parameters, queued-send timing,
manual selection races, disconnected persistence and actual browser narration
plus dropdown behavior. Entry points include `claude/__tests__/message-replacement.test.ts`,
`shared/__tests__/fallback-model-selection.test.ts`, the Claude/Codex adapter
suites, `features/agent/__tests__/fallback-transcript.test.ts`,
`sessions-store-current-model.test.ts`, and `scripts/ui-smoke-model-fallback.mjs`.

## Collapsed rows

- Use a compact icon, stable operation name, and concise target. Standard names
  include **Bash**, **Read**, **Edit**, **Glob**, **Grep**, **List**, and **Fetch**.
  Native MCP/app and browser actions keep their established semantic names.
- Prefer a native command's meaningful `description` as its operation label;
  use **Bash** when absent. Preview the actual command with whitespace collapsed
  in the header. Preserve spacing and newlines in the expanded body. Do not
  invent Read/Grep operations from arbitrary shell syntax.
- Remove a literal shell launcher such as `/bin/zsh -lc` for display only. Do
  not execute or broadly rewrite shell syntax. Keep ambiguous wrappers, outer
  expansion, extra arguments, and malformed quoting intact.
- Read/Edit rows use the shared file tag. Every captured text read uses
  **Read N lines** (**Read 1 line** for one line). Labels and expanded source
  share extraction across canonical blocks and native Claude, Codex and Cursor
  result envelopes, including stored turns. Count all captured source blocks
  before preview clipping; exclude one trailing line terminator, and preserve
  genuine blank lines. Empty captured reads show **Read 0 lines**. Requested
  limits and whole-file metadata are not the number returned by a partial read.
  Missing results and images have no invented text count; an error message is
  not successfully read source. Keep failures and unresolved completion
  distinguishable from success.
- Native batches consisting entirely of reads can show individual file rows.
  These rows share one execution and one expandable combined result; explain
  that ownership in the detail card. When per-file boundaries are absent, label
  the captured output count **Read N lines total** on these shared rows. Never
  present that total as a per-file count or infer per-file success from aggregate
  output. Keep all facets visible if the command fails.
  Mixed/unknown operations or oversized action lists remain an execution row.
- Ordinary Glob calls show the pattern without an expansion affordance. Failed
  or unresolved Glob calls remain expandable so their explanation is reachable.
  Recognize legacy native Glob titles as well as current argument names.
- Unknown tools retain their provider name and readable payload. Omit the
  internal category `other` from the target. If old history lacks a tool name,
  keep its result visible; do not invent a name from the output.

## Expanded cards

- `ToolDetailSurface` owns the **320px maximum height**, border, background,
  keyboard focus and scrolling for the entire operation. Put meaningful input,
  output, empty-result explanations and failures inside that one surface.
- Hide the non-file command/query/description preview in an expanded header.
  Keep the operation name, file identity and confirmed edit counts. Accessible
  names stay stable when the visual preview disappears; use `aria-expanded`
  and connect ordinary disclosure buttons to their detail region.
- Do not render routine **Input**, **Output**, **Completed**, **Running**, exit
  code or duration labels in ordinary tool details. Show the command itself,
  followed by its result. Preserve actionable failure, cancellation, unresolved
  completion, truncation and missing-capture explanations.
- Native result envelopes are not source code. Unwrap known command and read
  results. Keep unknown readable payloads inspectable through the bounded,
  binary-safe fallback; do not display encoded image/audio bytes as JSON.
- Syntax-highlight source by its actual language. Command syntax may be
  highlighted; logs and search output stay plain and readable. Preserve source
  line numbers for partial reads. Media loading follows the active chat gate.
- A highlighted worker result must match the exact source, language and theme
  before it can render. During an update, show current source immediately and
  replace it with matching highlighted text when ready. Never paint previous
  source beside a new gutter or header.
- Agent groups and Thinking are exceptions to the card surface. Thinking opens
  as plain readable text with no duration chip. Its disclosure owns a single
  4px vertical inset; paragraphs use an 8px gap and normal line height. Ignore
  provider boundary blanks and extra paragraph blank lines for display, while
  preserving single line breaks, indentation and the original stored text.
  Preserve native duration and redaction metadata in history; never fabricate
  reasoning that a provider did not supply. Agent conversations follow the
  group contract below.
- Approval, question, safety-review and compaction controls retain meaningful
  decision context and actions. They are not generic command diagnostics.

## Agent groups and background activity

- Claude `Agent`/legacy `Task`, Codex `subAgentActivity`/legacy `spawnAgent`, and
  Cursor's stored `task` kind share the **Agent** presentation. Preserve the
  stored kind and native identity. Use the delegated description/name and the
  native resolved/requested model when supplied; never guess a missing model.
- Each group starts collapsed, including when children arrive later. Show the
  agent loader during child work and the agent icon after completion. Streaming,
  results, replay and history hydration cannot override the user's disclosure.
  On hover or keyboard focus, the disclosure chevron replaces that same icon
  slot. Align the expanded child rail with its center; do not add a second
  leading arrow or shift the label.
- An expanded group is an **unboxed nested feed with a left rail**, not a 320px
  container. Keep narration, Thinking, child tools and final output in their
  native order and parent scope. Child tools have their own 320px detail cards;
  the prompt is a separate disclosure. Child final output and parented error
  notices stay inside the group, including when ownership arrives late.
- Launch acknowledgement is not child completion or final output. Hide Claude's
  `async_launched` instructions, correlate task IDs with native tool IDs, and
  retain resolved model information. Task completion/failure owns the loader;
  late launch acknowledgements cannot overwrite that terminal result.
- Codex activity-item completion only confirms delivery. `kind` owns the child
  lifetime; correlate different activity IDs by child thread. Legacy collab
  snapshots use child `agentsStates`, not the spawn/wait wrapper's success.
  Cancellation and transport disposal release group loaders without inventing
  successful completion. Keep resumed groups stable across parent turns.
- Request Claude's native `forwardSubagentText`, `showThinkingSummaries`, and
  summarized thinking display where supported by the pinned SDK. Display is
  separate from reasoning effort/budget; do not force a model's thinking mode.
  Partial root output and complete
  child assistant blocks follow their respective native identities. Forwarded
  summaries are displayable provider output, not access to hidden reasoning.
- Cursor's local SDK writes child transcript checkpoints during execution.
  Poll under the exact native parent conversation and provider HOME, then
  reconcile narration, thoughts and tools by source/message/block/tool identity.
  A complete native task argument or result must provide the child ID, or its
  result must provide an exact transcript path. Partial/truncated argument IDs,
  equal prompts (including full matches), timestamps and a sole candidate do
  not establish ownership. Keep the existing Agent group/loader and defer its
  child details until that identity arrives; do not emit provisional rows that
  would need to be retracted from live or saved history. Once identified, stream
  captured narration before the parent's final wait. An ID-less completion
  callback cannot claim a pending task by matching its prompt/arguments; join
  it to native completion by child identity or keep it as a separate final
  fallback. Replays must not create additional groups or child rows.
  Native results settle tool status; missing results stay unresolved. Exact-path
  results supersede ID-based lookup, even when the path is not readable yet.
  Use conversationSteps only as a final fallback when no file checkpoint was
  captured, so a disappearing/late file cannot duplicate the child feed. Final
  flush closes child delivery, including late callbacks after Stop/EOF. This
  provides checkpoint progress; it does not promise per-token child callbacks.
- Codex collaboration `wait` is agent coordination, not Claude Background Task.
  Present a compact waiting row. Show actual child messages/statuses when
  supplied, with failed/unresolved waits inspectable; omit internal thread IDs
  and an empty JSON disclosure.
- Claude parent idleness is independent of an outstanding SDK send. With live
  children, a root assistant `end_turn` parks the parent display even if the
  SDK holds back its Result. Preserve **Waiting for 2 → 1 background task**
  through interim parent replies; child traffic does not restart the parent.
  The chat, workspace and transcript use the same activity projection. User
  Stop still cancels the outstanding send.
- Keep the request's original elapsed-time anchor during background work. A
  later parent reply extends the footer beyond the first settled send; use its
  last changed text time, excluding child/tool bookkeeping and identical replay.
  Older persisted text without `updatedAt` uses its existing creation time.
- Claude `system/init` is turn metadata, not process replacement. Only the
  adapter creating a new query resets process-owned tasks, wakeups, lifecycle
  joins and workflow narration. Resume can reuse the native session ID; it
  still creates a new process. Retain durable transcript identities and settle
  unfinished rows on retirement without claiming success.
- Keep native task ownership separate from visible activity. Ambient watchers
  (including legacy `skip_transcript` tasks) retain their process while alive,
  but do not activate the waiting count, workflow display or busy indicators.
  A valid `background_tasks_changed` frame replaces membership, including an
  empty set; metadata edges cannot resurrect a task absent from that snapshot.
  Older providers without membership snapshots retain the edge-based fallback.
  Apply the visible task cap after filtering ambient work. Bound retained IDs;
  when membership exceeds that budget, retain the process conservatively until
  a newer complete snapshot resolves the overflow.
- Parent results preserve running/paused workflows and their narrator dedupe.
  Only terminal workflows leave the foreground projection at a result boundary;
  terminal snapshots do not retain an otherwise-idle process. Query replacement,
  Stop and EOF release live activity. Retired iterators and lifecycle callbacks
  cannot overwrite replacement work or restart a stopped clock.

## Colors and readable errors

- Ordinary tool icons always use `--fg2`, including the newest running call.
  List uses the file-search icon. Current streamed narration uses `--fg1` at
  every nesting level; once the next visible activity arrives, it uses `--fg2`.
  Final output remains `--fg1` inside and outside Agent groups.
- Missing completion does not lower a tool row's opacity. Preserve its unknown
  status and explanation without dimming the row or its descendants.
- Failed tools use the circle-X icon and **Error** label. Their expanded body
  uses the red background/text tokens and retains the actual command and error.
  All text, command syntax and highlighted code inside a failure surface stay
  red, including asynchronous highlighter results. Collapsed command/file
  previews also use red foreground/background. Failed **Agent** groups retain
  the **Agent** label and agent icon in red; their disclosure geometry is unchanged.
  Existing approval/question controls keep their meaningful decision states.
- Keep actual Grep calls, including short patterns such as `id:`. Cursor's
  `workspaceResults` envelope is not the result text: display its native file
  matches, supplied line numbers/text/context, file lists or counts. Never
  invent omitted source lines. Label native semantic Search appropriately;
  retain unknown result shapes through the bounded fallback.

## Smooth assistant text

- Apply pacing only to the visible conversation's growing assistant narration
  or output, including child conversations. Persist native text immediately;
  presentation must not alter replay, copying/export, tool input, or results.
- Keep visual buffering short and bounded (160ms catch-up window), with a
  subtle fade at the advancing prose edge. Earlier lines stay opaque. Never
  animate tool output, Thinking, user text or mounted history. Preserve Unicode
  grapheme boundaries and sanitized markdown.
- Flush immediately for correction, truncation, Stop, next visible activity,
  hidden surfaces and reduced motion. Cancel frame loops/listeners on teardown;
  do not replay a hidden backlog when returning to a chat. Limit markdown work
  to about 30 updates per second and bypass pacing for oversized chunks/replies.
- The [smooth-streaming discussion](https://upstash.com/blog/smooth-streaming)
  motivates a presentation buffer independent from transport. Zeros' bounded
  buffer and edge mask are local implementations, without a new dependency.

## Edit diffs

- Reuse the shared Pierre diff theme and Changes row colors, hunk separators,
  gutters, syntax theme, and wrapping policy. Keep virtualizer geometry in sync
  with the shared painted separator height.
- The expanded card, including any path or failure notice, is capped at 320px.
  Embedded diffs do not add another vertical scroller or a larger height cap.
- Hover previews retain their collision-aware 450px width and 350px outer cap.
  Disable hover previews while the corresponding edit is expanded or inactive,
  without remounting its disclosure button or losing keyboard focus.
- Render the recorded patch and native hunk line numbers. Never replace a
  historical tool result with a read of today's file. Missing or failed edits
  must not look applied; proposed diffs remain explicitly unconfirmed.

## Verification when providers change

Keep native adapter regressions for separate blocks sharing a message ID,
partial-plus-complete delivery, completion-only delivery, repeated completion,
missing start, result-before-input, parent isolation, reconnect replay, failure
output and terminal status. Cover native callback/stream mixtures for Cursor
and authoritative item snapshots for Codex.

Keep renderer regressions for history identity and ordering, native command
actions, safe shell display, Glob behavior, empty reads, media, unknown results,
and failure visibility. Browser tests must exercise expanding during streaming,
settlement, reload, keyboard toggles, a long result, shared batched output,
320px edit/output geometry, Changes diff parity, hover suppression and stale
highlight rejection. Also cover collapsed Agent groups across all providers,
child thinking/final output, unboxed group geometry, dimming as new work arrives,
error/list icons, two-to-one background waiting and late footer duration. Use
synthetic data rather than private transcripts.
Also cover multiple visible reports in chronological order, native command
descriptions, fully red highlighted failures, undimmed unresolved rows, shared
disclosure geometry, live Cursor checkpoints and ambiguous ownership, and text
smoothing cancellation/correction/reduced-motion behavior.

Current entry points:

- `claude/__tests__/transcript-reconciliation.test.ts` and corresponding Cursor
  and Codex adapter suites under `engine/agents/adapters/`.
- `features/agent/__tests__/history-message-identity.test.ts`,
  `tool-presentation.test.ts`, `tool-details.test.ts`, and
  `diff-hover-preview.test.ts` in the renderer.
- `shared/theme/__tests__/diff-overflow.test.ts` in the renderer.
- `scripts/ui-smoke-tool-presentation.mjs` and
  `scripts/ui-smoke-subagent-presentation.mjs`, included in `pnpm test:ui-smoke`.

## Queue, steering, and Stop ownership

- Follow-ups belong to the chat's renderer queue until native delivery is
  confirmed. **Stop pauses dispatch and preserves pending messages, payloads,
  and order.** They remain editable/deletable. An admission-stage opening
  prompt is instead retained as the stopped turn; it must not silently retry.
- An explicit send resumes automatic dispatch. Given A running and B/C/D
  queued: Stop → Send now C → C runs in the same conversation → B → D.
  A new composer message also takes precedence and resumes the remaining FIFO.
  Editing, saving, tab navigation, late receipts, and old turn completion cannot
  release a Stop pause. Another Stop pauses the remaining messages again.
- Queue-held-for-edit and queue-paused-by-Stop are separate conditions. Releasing
  an edit hold must not release Stop. Preserve the existing card and controls;
  show `Paused` in its header rather than introducing a separate queue surface.
- Mid-turn Send now keeps the row in its original queue position while delivery
  is pending. Disable editing/deletion and repeated submission until the receipt
  arrives. `delivered` promotes that exact row into its accepting turn;
  `queued` proves it was not consumed and schedules the selected message next.
  If Stop occurred during delivery, retain its original FIFO position and pause.
  `interrupted` means consumption was uncertain: preserve the attempted message
  in its original turn, pause the queue, explain the uncertainty, and never
  automatically inject it again. Do not represent
  local buffering or a missing reply as successful delivery.
- Lost bridge replies retain the same steering attempt ID. `Retry delivery`
  retrieves the engine receipt, including after the original turn ended; it must
  not issue a second native instruction. The bounded receipt ledger retains all
  accepted IDs for the execution lifetime. At capacity new requests remain
  ordinary queued follow-ups. Capture the accepting turn before awaiting and
  ignore callbacks from a replaced queue or execution. Recheck the accepting
  turn after gateway admission as well as after provider input preparation.
  `attemptId` opts into structured outcomes; older clients receive AGENT_ERROR
  for non-delivery because they interpret any AGENT_STEERED as success.
- Claude's input UUID is the steering identity. `command_lifecycle.command_uuid`
  (not the lifecycle frame UUID), native started/completed states, and root
  `user_message_uuid(s)` establish consumption. Child events do not acknowledge
  root steering. A root result with no queued work starts a five-second grace
  for missing acknowledgements: late terminal lifecycle events may still confirm
  delivery; otherwise settle as uncertain, never resend automatically. Positive
  queued-work evidence keeps delivery pending. Clear the grace on receipt,
  replacement, or disposal. On Stop, discard unpulled local input first, then reconcile the
  interrupt receipt's `cancelled` and `still_queued` UUIDs. A generic lifecycle
  `cancelled` alone does not prove non-consumption.
- Claude SDK 0.3.266's public wrapper implements `interrupt({cancelQueued:true})`
  in JavaScript although the exported TypeScript signature omits the argument.
  Keep the compatibility cast isolated and require advertised
  `interrupt_cancel_queued_v1` plus a valid empty `still_queued` receipt to retain
  the live query. Otherwise retire it and lazily resume the same conversation on
  the next explicit send. Query replacement/disposal settles pending receipts;
  ordinary `system/init` metadata must not clear them or background work.
- Codex uses native `turn/steer` with the captured expected turn ID. Recheck the
  live session, turn, and Stop intent after preparing attachments and before
  dispatching. A delayed attachment conversion cannot steer a replacement turn.
- Cursor SDK 1.0.31 local runs expose `run.steer(text)`. Forward through the
  contained host and map `complete_delivered` to delivered and
  `revert_to_followup` to queued. Missing/finished runs and legacy unsupported
  binary blocks stay queued. Preserve all text blocks, including saved `.context`
  attachment references. Host disposal and uncertain transport failures settle
  pending requests without fabricating success. This is Zeros' shared queue;
  the SDK does not provide a separate queue-management UI.

Provider contract references: [Cursor steering](https://cursor.com/docs/sdk/typescript#steering-a-run-in-flight),
[Cursor SDK changelog](https://cursor.com/docs/sdk/changelog), and the pinned
Claude wrapper implementation/declarations in `@anthropic-ai/claude-agent-sdk`.
Regression coverage must include Stop with multiple follow-ups, selected sends,
new composer sends, edit holds, duplicate clicks, lost/late acknowledgements,
query replacement, host disposal, buffered input, and native cancellation receipts.

## Turn usage in the output footer

The timer is the only usage-card trigger. Show Input, Output, Cache read and
one Total cost with agent/start/end details. Keep unknown distinct from zero,
mark Claude estimates, and do not render per-model pricing or a separate cost
icon. See [agent-turn-usage.md](agent-turn-usage.md) for native query/run
baselines, late updates, analytics and retired Claude fallback/budget settings.

Protocol 18 combines these steering receipts, transcript replacement/fallback
events and turn-usage snapshots with protocol 17's native attachment sources.
The desktop and control-plane compatibility ranges advance together; optional
fields keep older transcript records and supported peers readable.
