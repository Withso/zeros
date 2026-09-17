# Claude SDK event coverage

Audited against installed `@anthropic-ai/claude-agent-sdk` **0.3.274** and its
bundled CLI **2.1.274**. The installed `sdk.d.ts` and wrapper are the contract;
online documentation can describe a different version.

The public `SDKMessage` union has 39 member aliases and 42 distinct type/subtype
keys: the two user aliases share a discriminator and the result alias has five
variants. **Handled** means that the meaningful supported portion is consumed,
not that every optional field has a product surface. Limitations are explicit
below. Intentionally ignored events have no transcript or lifecycle effects;
unsupported events belong to features Zeros does not invoke.

`claude/__tests__/sdk-event-coverage.test.ts` checks the installed union aliases,
type-checks an exhaustive discriminator map, checks this table, and verifies
that ignored/unsupported events do not emit content or finish/wake work. Review
the table and native fixtures whenever the pinned SDK changes.

## Public message inventory

| Native event | Disposition | Consumer and supported behavior / limitation |
| --- | --- | --- |
| `assistant` | handled | Translator/transcript state: text, Thinking, tool invocations, parent ownership, partial/completed block reconciliation, errors, supersedes, native context usage and steering receipts. A completed block is not a completed turn. |
| `user` | handled | Translator: correlate tool results, rich content and artifacts by native tool ID and parent; user echoes do not create duplicate user prompts. Includes `SDKUserMessageReplay`; replayed results retain one durable row. |
| `result/success` | handled | Translator and adapter: final answer, terminal reason, authoritative error details even on `is_error`, cumulative usage deltas and exact-once send settlement. |
| `result/error_during_execution` | handled | Native errors and codes feed existing failure/recovery classification; never infer success from EOF or subtype alone. |
| `result/error_max_turns` | handled | Existing terminal reason and turn settlement; preserve provider explanation and usage. |
| `result/error_max_budget_usd` | handled | Legacy/native budget termination remains readable even though Zeros no longer configures a spend cap. |
| `result/error_max_structured_output_retries` | handled | Structured-output exhaustion settles the turn with its native failure and usage. |
| `system/init` | handled | Adapter: native binding, commands/skills/plugins, capabilities and permission mode. Translator: current model and usage conversation identity. Ordinary init does not reset process-owned background work. |
| `stream_event` | handled | Translator/transcript state: native message/block deltas, tool arguments, Thinking and final-answer boundaries; root client UUIDs acknowledge consumed steering. |
| `system/compact_boundary` | handled | Existing compaction row settles only on confirmation; retain native trigger/pre-token metadata. Native UUID replay does not duplicate the row. History-preservation metadata is not a request to delete Zeros history. |
| `system/status` | handled | Compaction start/success/failure, requesting/compacting liveness and confirmed live permission-mode changes. A status clears neither user work nor the result requirement. Stop/replay guards precede state changes. |
| `system/api_retry` | handled | Existing transient error notice once per retry burst. Root model progress ends the burst; child/tool heartbeats and usage telemetry do not. |
| `system/control_request_progress` | unsupported | Side-question control requests are not invoked by this adapter. Their progress must not drive the main turn's loader, retries or completion. |
| `system/model_refusal_fallback` | handled | Apply native retractions and local/session scope; existing inbetween fallback messages and confirmed session model selection. See the shared presentation contract. |
| `system/model_refusal_no_fallback` | handled | Bounded native explanation as an inbetween message; no invented model switch or terminal result. |
| `system/local_command_output` | handled | Existing assistant-style output for native local commands. Not a fabricated tool call. |
| `system/hook_started` | intentionally ignored | Native hook execution stays runtime-owned; ordinary turn/task activity already has an indicator. No new hook tool or raw command/log disclosure. |
| `system/hook_progress` | intentionally ignored | Routine hook stdout/stderr is diagnostic data, not assistant reasoning or user-facing progress. Failures have a separate response event. |
| `system/hook_response` | handled | Error outcomes produce a bounded inbetween explanation keyed by hook identity. Success/cancellation stay quiet. This event alone never determines the whole turn's outcome. |
| `system/plugin_install` | handled | One installation progress message and a separate explanation for each failed plugin. Overall completion does not erase plugin failures; per-plugin success metadata stays quiet. |
| `tool_progress` | handled | Native subagent retry feedback stays inside the exact owning Agent group. Missing identity defers publication. Ordinary elapsed-time/heartbeat metadata does not create rows, complete tools, reset parent retries or wake an idle parent. |
| `auth_status` | handled | Generic authentication progress/failure commentary using existing provider settings. Raw output/error material stays private. Only existing authoritative error handling changes provider health; progress does not prove authentication success. |
| `system/task_notification` | handled | Native task settlement, summary/output and resource links; child outcomes and ambient/skip-transcript policy are preserved. |
| `system/task_started` | handled | Track task and Agent identity, ownership, description, background/ambient membership and workflow lifecycle. |
| `system/task_updated` | handled | Running/paused/terminal state and metadata; late edges cannot reopen terminal work. |
| `system/task_progress` | handled | Existing task/group progress and bounded native workflow compatibility fields. Progress is not a new invocation or completion. |
| `system/background_tasks_changed` | handled | Replace authoritative membership. Keep process retention separate from visible waiting; ambient watchers do not count toward user activity. |
| `system/thinking_tokens` | handled | Valid root estimates prove activity before prose arrives; a correlated client UUID acknowledges consumed steering. Estimates are not billed tokens or visible Thinking content. |
| `system/session_state_changed` | handled | Existing running/requires-action/idle indicators and idle retention. Deduplicate native UUIDs before adapter side effects; a replay cannot reactivate settled work. |
| `system/worker_shutting_down` | intentionally ignored | This local query integration does not own the remote bridge's worker lifecycle. The SDK warns that these records can be historical. Query EOF/error is authoritative here; replay must not stop a live local query. |
| `system/commands_changed` | handled | Refresh and replace available commands/skills under existing query/revision guards. |
| `system/notification` | handled | Plain bounded inbetween message; a native key updates the same notice within its turn. Provider colors and timeout requests do not control app styling or erase durable feedback. |
| `system/files_persisted` | handled | Failure produces a generic session-file persistence explanation. Successful cloud file IDs, private filenames and diagnostics are not displayed or treated as local artifacts. |
| `tool_use_summary` | intentionally ignored | Optional summary duplicates the existing native tool feed. It cannot settle or replace those tools. |
| `system/memory_recall` | intentionally ignored | Internal personal/team/organization memory hydration, including private contents, is not transcript narration. No memory-inspection feature is implied. |
| `rate_limit_event` | handled | Deduplicated limit/extra-usage/recovery advisory. Preserve included-usage versus extra-usage availability; never fail or authenticate a turn from this status alone. |
| `system/elicitation_complete` | handled | Plain external-request completion feedback keyed by server/request identity. Does not answer an approval or settle a pending question automatically. |
| `system/permission_denied` | handled | Preserve native explanation beside the exact owning tool/child feed. Unknown or ambiguous native tool ownership stays deferred. Native tool results still own tool success/failure. |
| `prompt_suggestion` | unsupported | Optional predicted follow-up suggestions are not enabled and have no product surface; never auto-submit them. |
| `system/mirror_error` | handled | Generic synchronization explanation without exposing private mirror paths/keys. Does not falsely mark an ordinary file tool failed. |
| `system/informational` | handled | Plain bounded content as an inbetween message, tool-scoped where identified. `prevent_continuation` explains runtime behavior but is not itself a terminal result. |
| `conversation_reset` | handled | Existing idempotent accounting reset at `/clear`. **Limitation:** the SDK's fresh-transcript/title remount is unsupported; this handler does not erase saved chat history or invent a new chat. Native session binding still follows init. |

## Other native surfaces

- Raw API stream events are nested inside `stream_event`: message start/stop,
  content-block start/delta/stop and message delta. Text, tool input and native
  Thinking flow through `ClaudeTranscriptState`; signature/redaction metadata
  is not rendered as reasoning text. Authoritative completed blocks reconcile
  streamed blocks by native identities. Unknown content retains the existing
  bounded supported-content policy; no invented output is inferred.
- `TerminalReason` is handled by the existing result mapper, including
  completion, cancellation, deferred/background work, hook stops, limits,
  setup/model/API errors and structured-output exhaustion. The installed SDK
  has no new unmapped reason in this audit.
- Explicit error subtypes and nonempty native errors take precedence over a
  conflicting is_error:false or completion reason. Budget, turn and blocking
  limits retain their distinct endings. A result without positive completion
  evidence fails through existing recovery; malformed subtype values cannot
  throw during classification. A subsequent confirmed success clears earlier
  terminal errors, while Stop/disposal still take precedence in the adapter.
- `command_lifecycle` is an existing native compatibility extension outside the
  public `SDKMessage` union. Steering joins `command_uuid` and consumption
  states, not the frame UUID. Result/assistant/stream/thinking UUID echoes also
  reconcile delivery. Stop still reconciles the interrupt receipt.
- `SDKActiveGoalMessage` (`active_goal`) appears in the wrapper's native stdout
  union, outside `SDKMessage`. Native goal control is unsupported here; it does
  not create a task, prompt, or completion.
- Control requests/responses/cancellations and keep-alives are consumed by the
  public wrapper. Keep-alive is transport health, not user activity. Do not
  bypass the wrapper or forward raw control payloads into the transcript.
- `canUseTool`, `onUserDialog` and `onElicitation` already use existing blocking
  approval/question controls and cancellation lifetimes. Elicitation completion
  notifications do not substitute for those callback receipts.
- Native hooks remain SDK-owned. Zeros registers passive `Stop` and
  `UserPromptSubmit` callbacks for scheduled wakeups and activity, with query
  identity guards. Other configured hooks can still run in the CLI; their
  started/progress/response notifications follow the table. The adapter does
  not register extra hooks merely to claim event coverage.
  The other installed hook names are intentionally unregistered by Zeros:
  `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`,
  `Notification`, `UserPromptExpansion`, `SessionStart`, `SessionEnd`,
  `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`,
  `PreModelSwitch`, `PostModelSwitch`, `PermissionRequest`, `PermissionDenied`,
  `Setup`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `Elicitation`,
  `ElicitationResult`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`,
  `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `DirectoryAdded` and
  `MessageDisplay`. This classification does not disable user-configured hooks.
- Init/context/result usage fields keep their existing scope. Thinking
  estimates, retry counts and task telemetry must never be added to billed
  token totals. Context gauges retain the last confirmed exact-query snapshot.

## Feedback and lifecycle invariants

New feedback uses existing `agent_message_chunk` commentary and parent-binding
updates. Stable local message IDs permit keyed replacement; native UUIDs suppress
replay across results/query replacement. Text is capped at 8,000 characters,
active keyed notices at 256, deferred tool notices at 64 and replay IDs at 4,000.
Unknown ownership cannot borrow a sibling row. Stop/disposal clears deferred
feedback and prevents late publication. Ordinary turn results retain separately
owned background work.

Routine feedback is not model progress. Only accepted native activity wakes an
autonomous parent, and replay filtering precedes adapter lifecycle/mode updates.
Requesting/compacting retains the process but does not end an API retry burst;
that requires actual root model output, native thinking progress or a result.
Live permission-mode changes update the existing composer state without applying
the creation-time Auto downgrade. Reconciliation checks query identity and a
mode revision after asynchronous control calls so stale replies cannot overwrite
a newer confirmed selection.

Compaction requires positive success evidence: `compact_result: success` or a
native boundary. A result, Stop, EOF or query replacement without confirmation
settles its existing row as **Compaction incomplete**. No new UI component,
protocol field or persisted schema is introduced.

Regression entry points are `claude/__tests__/sdk-event-feedback.test.ts`,
`sdk-event-coverage.test.ts`, existing translator/transcript/replacement/usage
suites and `claude-sdk/__tests__/adapter.test.ts`. They cover replay, root/child
isolation, delayed ownership, Stop, advisory versus terminal semantics, private
auth/diagnostic data, bounded payloads, compaction evidence, pre-output liveness,
steering acknowledgment, mode changes and delayed reconciliation. These are
native-contract simulations, not a claim that every cloud-only event was
reproduced against a live account.

The pinned wrapper natively forwards the
`default_to_no` / `suppress_always_allow_rule` control fields as
`defaultToNo` / `suppressAlwaysAllowRule` to
`canUseTool`. Either hint selects the existing once-only Yes/No card, disables
local policy replay and requires an explicit decision. This does not change
the SDKMessage inventory. The former 0.3.266 backport is removed.
`sdk-approval-hints.test.ts` exercises
the installed public wrapper with an offline stream-json process, rather than
only invoking a mocked callback. See the shared explicit-permission contract.

References: [SDK streaming flow](https://code.claude.com/docs/en/agent-sdk/streaming-output),
[SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks), the installed package's
`sdk.d.ts` and `sdk.mjs`, and [agent tool presentation](agent-tool-presentation.md).

The installed error contract handles
`verification_required` and `cloud_credential_error`.
The API's `error.details.error_code` can also identify
verification beneath a generic `permission_error`. Native codes outrank
incidental login/model wording and underlying HTTP 401 or transport causes.
Assistant error explanations and result diagnostics are retained together;
identical details are not repeated. Parent synthetic errors use the existing
failure card, while child errors remain scoped to their Agent group.

Both categories require explicit user retry, preserving the conversation and
selected model. They do not invalidate Claude OAuth health or offer a fresh
chat as a credential remedy. The optional persisted notice `failureKind`
retains recovery semantics for autonomous results without claiming turn
ownership. Older notices remain readable, and older clients can ignore this
additive metadata. Regression coverage includes startup, stream/result errors,
background failures, retry after recovery, links, persistence and child scope.

The **0.3.274** integration also handles uncorrelated background
batch receipts, `startup_failure_reason`, and `canUseTool.mcpServer` identity.
The public event union retains the same 39 aliases and 42 discriminators.
An SDK throw following a reported startup result does not duplicate that
diagnostic as a background disconnect; subsequent activity owns new failures.
Empty background acknowledgements retain activity and pending user/compaction
ownership while cumulative usage advances exactly once. Explicit user UUIDs,
including folded sends, still establish result ownership. Local commands that
make no model calls remain valid completions.

`CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1` asks supporting runtimes to emit known
startup errors before exit. Native reasons distinguish gateway sign-in from
organization policy, managed settings, proxy, temporary-directory, cwd, shell,
worktree and runtime setup failures. Unknown reasons retain their explanation;
EOF handling remains necessary for failures before structured output starts.
Native browser permissions require query-owned enablement and compatible MCP
provenance; an SDK-host server is not the CLI's native Chrome integration.

`systemPrompt.snapshot: false` preserves the existing fresh host-append behavior
on newer runtimes when resuming changed workspace/custom instructions, including
removal of an append. The native preset and model-dependent default tools remain
SDK-owned. Older wrappers ignore this optional property and already render fresh
prompts. Regression entry points include the Claude adapter, translator, usage,
and shared provider-error suites.
