<!-- Generated 2026-07-02 by an ultracode audit+plan workflow (7 audits -> synthesis -> 3 adversarial critiques -> finalize). -->

# Implementation Plan — Unified "User input" Question Card + Blocking Answer Delivery

## 0. Design summary, guiding principle, and the mandatory mechanism probe

Today there are **two** disconnected question models and **zero** blocking answer channels. A Claude `AskUserQuestion` produces *three* competing artifacts on screen: (a) an inline `QuestionCard` tool render (already wired at `registry.ts:92` under `toolByKind.question`, driven by `tool.rawInput`), (b) a generic Allow/Deny `PermissionCard` in the composer slot (because `canUseTool` fires), and (c) a greyed "queued" bubble when the user answers mid-stream. The permission flow, by contrast, is a *correct* block-and-resume round-trip. **The plan makes the question a first-class blocking interaction, collapses everything into ONE interactive surface plus ONE durable record, and serializes permission + question interactions through ONE ordered queue.**

Guiding principle: **do not invent new machinery where the permission flow already has it** — but do not assume the Claude answer channel is the permission channel. The store/queue/bridge half genuinely mirrors permissions; the Claude *answer delivery* does **not**, and the critiques are correct that the original `updatedInput.answers` mechanism is architecturally wrong.

### 0.1 What the installed SDK actually says (re-verified against `@anthropic-ai/claude-agent-sdk@0.3.170`)

The three audits agree and the code confirms every point:

- `AskUserQuestionInput` (`sdk-tools.d.ts:608`) has **only** `questions` (1–4 questions, each 2–4 options; option = `{label, description, preview?}`, `description` **required**; per-question `multiSelect: boolean`). It has **no `answers` field.**
- `PermissionResult` `allow` (`sdk.d.ts:2069`) carries `updatedInput?: Record<string, unknown>` — fed to the tool as its **INPUT before execution**. There is **no** `updatedOutput`. Stuffing `answers` here writes a field the input schema ignores; the CLI then **executes** the tool and collects the answer via its own channel.
- The answer (`answers: {[questionText]: string}` comma-joined for multi, plus optional `response`, `annotations`, and a full `questions[]` echo) lives on `AskUserQuestionOutput` (`sdk-tools.d.ts:2798`) — the tool **OUTPUT**, never assignable to `updatedInput`.
- The real blocking-dialog channel is `onUserDialog` + `supportedDialogKinds` (`sdk.d.ts:1279, 1521, 1543, 6357–6382`) returning `UserDialogResult` = `{behavior:'completed', result}` or `{behavior:'cancelled'}`. **Absence of the declared kind fails closed** (`sdk.d.ts:3222`): the flow degrades to no-dialog behavior — which is exactly why questions degrade to next-turn today (the engine wires neither, confirmed at `adapter.ts:1212` options block: `canUseTool` present, `onUserDialog`/`supportedDialogKinds` absent).
- **Critical unknown:** the only *documented* `dialogKind` is `'refusal_fallback_prompt'` (`sdk.d.ts:1525, 3222`). Whether `AskUserQuestion` even flows through `onUserDialog`, and under which `dialogKind`/payload/result shape, is **version-dependent and opaque** (`sdk.d.ts:6357–6363`). It is unproven that Zeros can intercept it at all in the SDK path.
- `canUseTool` is **skipped entirely in `bypass` mode** (`adapter.ts:184`, and PRIVILEGED set `adapter.ts:188` = `{bypass, accept-edits, auto}` — note only `bypass` skips the gate; accept-edits/auto still call it for non-auto-approved tools). `onUserDialog`, by contrast, is a control channel **independent of `permissionMode`**.

### 0.2 Phase 0 — the mechanism probe (NEW, BLOCKING, runs before any plan code)

Because the answer channel is the load-bearing correctness claim, Phase 0 is a throwaway runtime spike, not a manual test baked into a later phase:

1. In `claude-sdk/adapter.ts`, temporarily log every `toolName` entering `canUseTool` during an `AskUserQuestion` turn — confirm whether `AskUserQuestion` reaches the gate at all, and in which modes (`default` vs `accept-edits` vs `bypass`).
2. Temporarily wire `onUserDialog` with a **wildcard-ish** `supportedDialogKinds` (declare the observed kind; unknown kinds must still be answered `{behavior:'cancelled'}`). Log the actual `dialogKind`, `payload` shape, and `toolUseID` for an `AskUserQuestion` ask.
3. Return `{behavior:'completed', result: <AskUserQuestionOutput-shaped>}` and confirm the model receives the answer **without a second dialog** and **without re-asking for Other**.
4. Record the outcome in three buckets and pick the mechanism from observed behavior:
   - **(A) `onUserDialog` fires for AskUserQuestion** → this is the primary channel; lock `QuestionResponse` → `{behavior:'completed', result: AskUserQuestionOutput}`, dismiss → `{behavior:'cancelled'}`, timeout → `{behavior:'cancelled'}`.
   - **(B) `onUserDialog` does NOT fire, but `canUseTool` does** → interception must happen at `canUseTool`. Since `updatedInput` cannot deliver the answer, the only honest options are: **deny the tool** with a message that steers the model, then deliver the structured answer as the *next-turn* prompt (non-blocking, honestly labeled) — OR keep the tool card read-only and treat Claude as non-blocking. **The capability matrix must then downgrade Claude to non-blocking.** No pretending.
   - **(C) Neither fires (native terminal dialog)** → Zeros cannot intercept in the SDK path; Claude is inference-only like Cursor. Matrix downgraded accordingly.

**The `QuestionRequest`/`QuestionResponse` shapes and the entire capability matrix are LOCKED on the Phase-0 result.** The sections below are written for outcome (A), which is the target, and flag every place where (B)/(C) changes the design. Phase 1 does not start until Phase 0 returns.

> Note on the original plan's Risk #1 "ship `updatedInput` first": **withdrawn.** The cited "GROUND TRUTH `sdk-tools.d.ts:2798-2975`" was the OUTPUT type, misread as writable via `updatedInput`. Corrected above.

---

## 1. Unified DATA MODEL

*(Shapes below are the outcome-(A) lock. If Phase 0 returns (B)/(C), `QuestionResponse.outcome` gains no new fields, but the adapter reshapers in §2.3 and the matrix in §2.1 change.)*

### 1.1 The canonical in-flight request (engine → renderer)

Add to `packages/core/src/agent-events.ts` (next to `RequestPermissionRequest` at `agent-events.ts:440-456`):

```
QuestionRequest {
  sessionId: SessionId
  questionId: string            // adapter-minted uuid, the UI resolver key
  nativeRequestId: string       // vendor correlation id for replay dedup (see §3.1):
                                //   Claude → SDK control request_id; Codex → JSON-RPC RequestId; else questionId
  toolCallId?: string           // native tool_use id / Codex itemId — co-locate/dedupe with the timeline tool card
  source: "native_dialog" | "native_rpc" | "inferred_from_text"
  blocking: boolean             // true = a resolver is parked on the engine; false = next-turn fallback
  questions: QuestionSpec[]      // 1..N — drives the carousel
}

QuestionSpec {
  id: string                    // per-question id (Codex has real ids; Claude synth = `q${index}`)
  prompt: string
  header?: string
  multiSelect?: boolean         // OPTIONAL and per-vendor-derived: Claude sets it from the SDK boolean;
                                //   Codex has NO such flag (see §1.4) so it is undefined → card falls back per §4.2
  options: QuestionOption[]      // may be empty ONLY for Codex (options:null) → pure free-text; never empty for Claude
  allowOther: boolean           // render the "0  Type something…" free-text last row
  secret?: boolean              // Codex isSecret → masked input
}

QuestionOption {
  id: string                    // Claude: synth `o${i}`; Codex: MUST equal label (see §1.4/§2.3)
  label: string
  description?: string          // Claude: required by SDK but modeled optional here; Codex: required
  preview?: string
}
```

Answer payload (renderer → engine), wire body of `AGENT_QUESTION_RESPONSE`:

```
QuestionResponse {
  outcome:
    | { outcome: "answered"; answers: QuestionAnswer[] }
    | { outcome: "dismissed" }
}
QuestionAnswer {
  questionId: string            // matches QuestionSpec.id
  selectedOptionIds: string[]   // chosen option ids (multi → many; single → one)
  freeText?: string             // "Other"/free-text value, if any
}
```

Rationale for structured `selectedOptionIds` + `freeText` over a flattened string: the current flatten at `question-card.tsx:156-169` (`v.join(", ")`) is lossy — commas in labels collide (audit [low], `question-card.tsx:161`). The card **always emits `QuestionAnswer[]`** and is mechanism-agnostic; each adapter's resolver reshapes it into the vendor result (§2.3). **The card never knows about vendor answer shapes.**

### 1.2 The durable transcript message — and its explicit producer (this is NEW machinery, not a permission mirror)

`AgentQuestionMessage`/`AgentQuestionField` exist at `agent-messages.ts:206-234`, are in the union (`:296`), but are **dead** (never constructed anywhere in `src/` — verified). The permission flow has **no durable-message analog** (`pendingPermission` is transient), so "mirror permissions verbatim" gives **no template** for this. We call it out as net-new:

Additions to `AgentQuestionField`:
- add `id: string` (per-question id);
- add `allowOther?: boolean`, `secret?: boolean`;
- option shape already `{id,label,description?,preview?}` — no change;
- move `answer` from message-level (`:218`) to **per-field** `answer?: { selectedOptionIds: string[]; freeText?: string }`;
- add `questionId: string` and `nativeRequestId: string` on the message.

**Producer (specified, since there is no precedent):**
- On `QuestionRequest` arrival, `applyBridgeQuestionRequest` (§2.2f) **both** enqueues the pending interaction **and** constructs+appends an `AgentQuestionMessage` (unanswered) to `session.messages`.
- On answer, `respondToQuestion` (§2.2g) **both** sends `AGENT_QUESTION_RESPONSE`, dequeues, **and** patches the matching `AgentQuestionMessage`'s per-field `answer` (matched by `questionId`) to the read-only answered state.
- This fixes the `useState`-`submitted` remount bug (`question-card.tsx:71`, audit [medium]) at the store level; a Phase-4 test asserts a reload after answering shows read-only answered state, not a fresh form.

### 1.3 Wire path and the triple-surface reconciliation

There is no `question` `SessionUpdate` variant and no `applyUpdate` case for it (audit GAP 1); we do **not** add one. The question rides the **bridge request event** (§2), and the durable message is produced by the same handler (§1.2).

**Reconciling the (up to) three surfaces** — this is the core "ONE surface" promise and must be explicit:
- **Interactive surface (exactly one producer):** the composer-slot card driven by `QuestionRequest`/`pendingInteractions[0]` (§4.4). Blocking questions render here; inferred ones may render inline.
- **Durable record (exactly one producer):** the `AgentQuestionMessage`, rendered read-only via `byKind.question` after answering.
- **The existing `toolByKind.question` tool render (`registry.ts:92`) must be SUPPRESSED for AskUserQuestion**, or the composer card and an inline interactive tool card both appear. Decision: in `translator.ts:797`, **stop mapping `AskUserQuestion` → `toolKind:"question"`** for the interactive render; instead emit a read-only "asked" stub tool card (or suppress entirely and rely solely on the durable `AgentQuestionMessage`). We pick: **suppress the `toolKind:"question"` interactive mapping; the durable `AgentQuestionMessage` is the only in-timeline artifact.** `registry.ts:92` `toolByKind.question` is then removed (or repointed to the read-only stub); `registry.ts:100` `byKind.question` is wired to the read-only card. This kills the triple-surface bug the critiques flagged.

### 1.4 Per-translator mapping into `QuestionRequest`

**Claude** (`claude-sdk/adapter.ts`; timeline mapping suppressed per §1.3):
- Source of truth is the **Phase-0-selected channel** (`onUserDialog` if (A); `canUseTool`-deny-then-next-turn if (B); inference if (C)), **not** the translator.
- Input verified (`sdk-tools.d.ts:608`): `questions[].{question, header, options:[{label, description, preview?}], multiSelect}`. Map: `prompt←question`, `header←header`, `options[i]←{id:\`o${i}\`, label, description, preview}`, `multiSelect←multiSelect`, **`allowOther←true` always** (native auto-Other, `sdk-tools.d.ts:627`), `id←\`q${i}\``, `nativeRequestId←` the SDK control `request_id` (from the `onUserDialog` request frame, or the `canUseTool` `toolUseID`).
- **Schema bounds:** Claude questions always have ≥2 options (`@minItems 2`, `sdk-tools.d.ts:629`) and 1–4 questions — so the card's "empty-options → pure free-text" branch is **Codex-only dead code for Claude** (documented, §4/EC-20).

**Codex** (`app-server.ts` wires only 3 approval methods at `456-458`; `item/tool/requestUserInput` is in `ServerRequest.ts:19` but **unhandled**; verified `ToolRequestUserInputParams.json`):
- Add `wireRequest("item/tool/requestUserInput")` next to `wireApproval` (`app-server.ts:422-458`). Params `{threadId, turnId, itemId, questions:[{id, header, question, isOther, isSecret, options:[{label, description}]|null}]}`.
- Map: `id←question.id` (real ids), `prompt←question`, `header←header`, `options[i]←{id: label, label, description}` — **`id` MUST equal `label`** because the Codex answer is a `string[]` of labels (see §2.3); no synthetic ids. `options:null → []` (pure free-text). `allowOther←isOther`, `secret←isSecret`, `multiSelect←undefined` (Codex has **no** multiSelect flag — schema confirmed), `nativeRequestId←` the JSON-RPC `RequestId`, `toolCallId←itemId`.
- Fully blocking (`blocking:true`, `source:"native_rpc"`) via the JSON-RPC deferred-Promise pattern used by `wireApproval`.
- **Second unhandled channel:** `mcpServer/elicitation/request` (`ServerRequest.ts:19`) is a distinct Codex question-like blocking RPC. **Out of scope for this plan** but explicitly noted: until wired, Codex MCP elicitations still hang/auto-cancel. Tracked as follow-up, not silently ignored (addresses audit missed-edge-case).

**Cursor** (`translator.ts:228-231` `case "request"` explicitly ignored; SDK has no host-answerable question RPC — verified):
- No blocking channel. `source:"inferred_from_text"`, `blocking:false`, `nativeRequestId←questionId`. Inference-only if/when an inferred surface exists.

---

## 2. WIRING / PROTOCOL

### 2.1 Honest per-vendor capability matrix (LOCKED on Phase 0; target = outcome A)

| Vendor | Blocking channel | Mechanism | Answer shape returned to vendor | Fallback (clearly marked NON-BLOCKING) |
|---|---|---|---|---|
| **Claude — outcome (A)** | **YES (same-turn)** | `onUserDialog` for the observed `AskUserQuestion` `dialogKind`, declared in `supportedDialogKinds`; resolve `{behavior:'completed', result}` (`sdk.d.ts:1279,1521,6377`). **Independent of `permissionMode`, so works in `bypass` too.** | `AskUserQuestionOutput`: `{questions:[…full echo…], answers:{[questionText]:comma-joined}, response?, annotations?}` (`sdk-tools.d.ts:2798`). Keyed by **question text**. Reshaper must reconstruct the full `questions[]` echo, not just `answers`. | Dismiss/timeout → `{behavior:'cancelled'}` (CLI applies dialog default). |
| **Claude — outcome (B)** *(if `onUserDialog` doesn't fire)* | **NO — NON-BLOCKING** | `canUseTool` special-case denies the tool with a steering message; structured answer delivered as **next-turn prompt** (`updatedInput` cannot carry output — verified). Does **not** work in `bypass` (gate skipped, `adapter.ts:184`). | Next-turn prompt built from `QuestionAnswer[]`. | Card copy honestly says "sent as your next prompt." |
| **Claude — outcome (C)** *(native terminal dialog)* | **NO** | Not interceptable in SDK path. | — | Inference-only, like Cursor. |
| **Codex** | **YES (same-turn)** | JSON-RPC `item/tool/requestUserInput` deferred Promise (twin of `wireApproval`, `app-server.ts:422-458`) | `ToolRequestUserInputResponse`: `{answers:{[questionId]:{answers: string[]}}}` — id-keyed, **label-valued arrays** (verified). | Dismiss → see §4.3 (no native cancel variant — sentinel behavior defined there). |
| **Cursor** | **NO — NON-BLOCKING** | none — no host-answerable question RPC in `@cursor/sdk` (verified) | — | next-turn prompt via `session.send`; card copy says "sent as your next prompt." |

**The card is capability-driven off `QuestionRequest.blocking`/`source`.** Blocking → submit resolves the parked resolver. Non-blocking → submit does the honest `sendPrompt`. No pretending, and **the matrix is honest about `bypass` mode** for outcome (B).

### 2.2 The block-and-resume round-trip

The store/queue/bridge half genuinely mirrors permissions; the Claude **answer settle values differ** (see §2.2c). Reference the working permission path:
- resolver map `state.pendingPermissions` + `respondToPermission` (`adapter.ts:918-929, 990-995`);
- gateway fan-out `answerPermission` (`gateway.ts:988-998`);
- bridge pair `AGENT_PERMISSION_REQUEST` (`messages.ts:514-519`) / `_RESPONSE` (`messages.ts:384-388`);
- store slot + writer `pendingPermission` (`sessions-store.ts:146`), `applyBridgePermissionRequest` (`:567-578`);
- provider responder `respondToPermission` (`sessions-provider.tsx:1594-1609`).

**New symmetric pieces:**

**(a) Core bridge messages** — `packages/core/src/messages.ts`:
- `AgentQuestionRequestMessage { type:"AGENT_QUESTION_REQUEST"; agentId; questionId; request: QuestionRequest; chatId? }`
- `AgentQuestionResponseMessage { type:"AGENT_QUESTION_RESPONSE"; questionId; response: QuestionResponse }`
- Register both in the bridge message union.

**(b) Engine gateway** — `gateway.ts`: `answerQuestion(questionId, response)` fanning out to `adapter.respondToQuestion(...)` (verbatim copy of `answerPermission`, `:988-998`); add `onQuestionRequest` to `AgentGatewayEvents` (mirror `onPermissionRequest`, `types.ts:85-102`) and `respondToQuestion` to `AgentAdapter` (mirror `respondToPermission`, `types.ts:214-218`).

**(c) Claude adapter** — `claude-sdk/adapter.ts` — **mechanism-dependent (Phase 0):**
- **Outcome (A):** add `onUserDialog` + `supportedDialogKinds:[<observed AskUserQuestion kind>]` to the options block (`adapter.ts:1212+`, currently missing both). In `onUserDialog`: if `dialogKind` matches AskUserQuestion, build `QuestionRequest` from `request.payload`, mint `questionId`, carry `nativeRequestId = request` control id, store resolver in `state.pendingDialogs`, `ctx.emit.onQuestionRequest(...)`; on resolve return `{behavior:'completed', result: buildAskUserQuestionOutput(canonicalAnswers, payload)}`. **Unrecognized kinds → `{behavior:'cancelled'}`** (required, `sdk.d.ts:6361`).
  - `buildAskUserQuestionOutput`: reconstruct the full `AskUserQuestionOutput` — echo `questions[]` (with `multiSelect` + options), build `answers[questionText] = selectedLabels.join(", ")` (map synth `o${i}` back to the **label** via the original payload; guard label collisions by index, not by label string), set `response`/`annotations` from `freeText` where applicable.
  - **Lifecycle safeguards re-derived for the dialog channel (NOT copied from permission deny/allow):** timeout → resolve `{behavior:'cancelled'}` (not `deny`); `options.signal` abort → `{behavior:'cancelled'}`; release on `cancel()`/`teardown()` — hook `pendingDialogs` into the same abort paths as `pendingPermissions` (`adapter.ts:795-811, 1078-1082`); dismiss → `{behavior:'cancelled'}`.
- **Outcome (B):** the special-case lives in `canUseTool` (`adapter.ts:935`), denies with a steering message, and the answer is delivered next-turn. **Does not fire in `bypass`** — matrix already reflects this.
- `respondToQuestion({questionId, response})`: fires `pendingDialogs` (twin of `respondToPermission` `:918-929`, but resolving the dialog result type).
- **Concurrent/subagent questions:** `canUseTool`/dialog resolvers are keyed independently (`adapter.ts:931-934`), so a subagent + main-agent question can both be parked with live timers while the UI serializes them one-by-one. **Mitigation:** timers are per-request and start on emit; a question queued behind another could time out (`{behavior:'cancelled'}`) before the user reaches it. We **reset/extend the engine timeout when an interaction reaches the queue head** (§3.5), so only the head is "on the clock."

**(d) Codex adapter** — `app-server-adapter.ts` + `app-server.ts`: `handleUserInputRequest` twin of `handleApprovalRequest` (`app-server-adapter.ts:995-1010`); `respondToQuestion` twin of `respondToPermission` (`app-server-adapter.ts:518-538`) sending the JSON-RPC `ToolRequestUserInputResponse`. Uses `APPROVAL_TIMEOUT_MS` (`app-server.ts:438`), **not** Claude's `PERMISSION_RESPONSE_TIMEOUT_MS` — the two clocks differ (§3.5).

**(e) Cursor adapter** — `respondToQuestion` no-op stub (like `respondToPermission`, `adapter.ts:841-846`); fallback only.

**(f) Store** — `sessions-store.ts`:
- generalize the single `pendingPermission` slot into an ordered queue (§3), **while preserving plan-review derivation** (§3.6);
- add `applyBridgeQuestionRequest` (twin of `applyBridgePermissionRequest`, `:567-578`) that enqueues **and constructs the durable `AgentQuestionMessage`** (§1.2);
- eviction: `truncateMessagesFromInMemory` (`:395-415`) **and** a reworked `applyBridgeAgentExit` (§3.3) **and** the Codex rebuild/resend recovery path (§3.4).

**(g) Provider** — `sessions-provider.tsx`:
- `respondToQuestion(chatId, response)` (twin of `respondToPermission`, `:1594-1609`): reads the front interaction's `questionId`, sends `AGENT_QUESTION_RESPONSE`, dequeues, **and patches the durable `AgentQuestionMessage` per-field answer** (§1.2). **The structured→string flatten for the inferred/non-blocking path lives HERE**, not in the card: `respondToQuestion` branches on `blocking`; for non-blocking it does the label lookup from the `QuestionRequest` it already holds and calls `sendPrompt` (§2.3). The card stays mechanism-agnostic.
- unified interaction buffer folding questions into `permBuffer` (§3.2), **with a kind discriminant** so the auto-policy loop (which reads `p.request.toolCall`, `sessions-provider.tsx:343`) runs for permissions only (§3.2).

**(h) RendererContext seam** — `renderers/types.ts`:
- change `respondToQuestion` from `(text:string)=>void` (`types.ts:68`) to `(response: QuestionResponse)=>void`.
- its `agent-chat.tsx:327-334` impl calls provider `respondToQuestion(chatId, response)` (blocking) or lets the provider do the `sendPrompt` (non-blocking) — the card never calls `sendPrompt` directly.
- delete stale doc `types.ts:62-68`; fix stale `interaction-prompt.tsx:1-21` header if retained.

### 2.3 Answer reshaping summary
- **Claude (A):** canonical `QuestionAnswer[]` → full `AskUserQuestionOutput` `{questions:[echo], answers:{[questionText]:comma-joined labels}, response?, annotations?}`. Synth `o${i}` → label via index into original payload.
- **Claude (B/C):** canonical → human string → next-turn `sendPrompt` (non-blocking).
- **Codex:** canonical → `{answers:{[questionId]:{answers:[selectedLabels..., freeText?]}}}`. **Option `id`==`label` end-to-end** so no synthetic-id round-trip guessing. **Ambiguity note:** the `string[]` cannot distinguish a selected label from typed free-text; we place free-text **last** and, when `isOther`, the card records it separately so the reshaper appends it as the final array element (the vendor's own format conflates them — this is a schema limitation, documented, not a Zeros bug). If two options share a label, selection is ambiguous by the vendor's design; we surface the label as-is.
- **Cursor/inferred:** canonical → human string (the old `question-card.tsx:156-169` formatter, retained ONLY in the provider for this path) → `sendPrompt`.

---

## 3. INTERACTION QUEUE / ORDERING

### 3.1 One ordered queue replaces the single slot
Today `pendingPermission` is a **single** slot (`sessions-store.ts:146`); a second request **clobbers** the first (`patchSession` overwrite, `:571`) and its engine resolver parks until timeout (audit Q1/Q2/Q3). Questions have no slot. Replace with:

```
pendingInteractions: Interaction[]   // FIFO on the session slot
Interaction =
  | { kind:"permission"; agentId; permissionId; nativeRequestId; request: RequestPermissionRequest }
  | { kind:"question";   agentId; questionId;   nativeRequestId; request: QuestionRequest }
```

- **Only the head (`pendingInteractions[0]`) renders** as the interactive surface (plan-review excepted — §3.6).
- Enqueue by **appending** (never overwrite). **Dedup on `nativeRequestId`, NOT the adapter-minted uuid.** Rationale (verified): on reconnect the SDK re-arms in-flight dialogs via `pending_user_dialog_requests` / `pending_permission_requests` on the initialize response and warns "the same request_id also arriving as a live or replayed control_request frame — render it once" (`sdk.d.ts:302-318`). The adapter re-enters its handler and mints a **new** `questionId` for the **same** underlying request_id, so uuid-keyed dedup misses the replay → two cards → possibly two answers. Deduping on `nativeRequestId` (SDK control request_id / Codex RequestId / itemId) honors the SDK's "render once" contract. **This also fixes the existing permission path**, which has the same latent replay bug.
- Dequeue on answer: `respondToPermission`/`respondToQuestion` shift the head **only if its id matches** the responded id (guards double-send; mirrors `sessions-provider.tsx:1600`).

### 3.2 Unified buffer + flush with a kind discriminant
Fold question bridge events into the existing per-frame `permBuffer` rAF coalescer (`sessions-provider.tsx:296-300, 311-393`) as a single interaction buffer, **tagging each entry with `kind`.** Within a flush, **append all** buffered interactions in arrival order (today the loop lets the LAST permission win the slot, `:335-383`; that bug disappears once we append). **The auto-response policy loop (`findMatchingPolicy` on `p.request.toolCall`, `:343-345`) runs for `kind:"permission"` entries only** — question entries have no `toolCall` and would crash on `undefined.kind/.title`; they skip straight to enqueue. (Addresses the critique's hot-path crash.)

### 3.3 Correct session targeting + reconnect eviction that actually fires
- Every bridge request carries `sessionId` and optional `chatId` (`messages.ts:505-511`); `applyBridge*` resolves via `sessionToChatId` with the `chatId` fallback (`sessions-store.ts:568-570`). Questions reuse this exactly — no cross-session clobber.
- **The `activelyDriven` guard problem (verified `sessions-store.ts:630-636`):** `applyBridgeAgentExit` early-returns **without clearing** when `terminal` OR `activelyDriven` (`sessionId && status ∈ {streaming, warming}`). A mid-question crash is by definition `streaming` → the current handler skips it → the stale card would persist. **Fix:** move `pendingInteractions` eviction to run **for all matching chats BEFORE the terminal/activelyDriven early-return** — a dead session's pending card is evicted regardless of streaming status, even while the slot's `sessionId`/`status` are otherwise preserved for prompt-retry. (This is the one place we deliberately diverge from the existing preserve-for-retry logic, because a pending *card* must not outlive the request that spawned it.)
- **Codex-specific:** the reconnect path this branch targets is a per-session streaming crash recovered by `sendPrompt`'s rebuild+resend. On rebuild the new turn re-emits `requestUserInput` with a **new** RequestId, so the old card's answer would be dropped. Add pending-interaction eviction **on the Codex rebuild/resend recovery path** too (where `sendPrompt` recovers from transport-closed), not only in `applyBridgeAgentExit`. Combined with §3.1 `nativeRequestId` dedup, the re-emitted question surfaces as one fresh card.
- Engine-side resolvers release via the adapter `cancel()`/`teardown()` abort paths (`adapter.ts:795-811, 1078-1082`); `pendingDialogs` hooks the same. Net: mid-question crash → UI evicts the stale card, engine resolver fails closed (`cancelled` for Claude dialog; RPC resolver gone for Codex), no dangling parked turn, no answer sent into a dead session.

### 3.4 Response only while head + live
A response is sent only while the interaction is at the head AND its session is live; the provider re-checks `getStore().sessions[chatId]` head id before sending (mirror `sessions-provider.tsx:1599-1600`). A stale response for an already-dequeued/evicted id is a no-op.

### 3.5 Timeout ownership and the two-clock problem
- Vendors auto-resolve on **different clocks**: Claude `PERMISSION_RESPONSE_TIMEOUT_MS` (10 min, `constants.ts:27`) vs Codex `APPROVAL_TIMEOUT_MS` (`app-server.ts:438`). A single "AWAITING RESPONSE" pill hiding two clocks can silently time out a queued-behind interaction on the engine while the UI still shows it head-pending.
- **Mitigation:** (1) introduce `QUESTION_RESPONSE_TIMEOUT_MS` distinct from the permission constant (open value in §7, but distinct so questions don't inherit a tool-approval clock); (2) **the engine timer is (re)armed when the interaction becomes the queue head**, not when it is first emitted — so only the visible head is on the clock; queued-behind interactions do not tick down. For the `onUserDialog` channel there is also the **CLI's own park deadline** (`sdk.d.ts:1518-1519`): the two timers race; whichever fires first settles, the other resolves a now-dead id (handled by the head-match no-op in §3.4). We set the engine timeout comfortably below the CLI park to keep the engine authoritative.

### 3.6 Plan-review coexistence (the under-scoped coupling, now explicit)
`planReview` is **derived from `pendingPermission`** and read in ~10 sites (verified `agent-chat.tsx`): derive at `:1572-1579`, `approvePlan` `:1584`, `denyPlanReview` `:1600`, `composerStreaming` `:1614`, `permissionCardActive` `:1620`, `handleSend` `:1657/:1663`, memo dep `:1186`, gates `:1920/:1941/:1957`, render `:2414-2431`. Migrating the slot to `pendingInteractions[]` without touching these regresses plan review the moment Phase 3 lands.

**Explicit sub-task (Phase 3):**
- Re-derive `planReview` from **the head interaction** where `kind==="permission" && isPlan` (a plan review is just a permission-kind interaction at the head).
- Rewrite `approvePlan`/`denyPlanReview`/`composerStreaming`/`permissionCardActive`/`handleSend` and all `pendingPermission` reads to read `pendingInteractions[0]`.
- **Compose the three composer behaviors** in one queue, documented:
  - **plan-review** (permission-kind, isPlan) → composer stays **LIVE** (`composerStreaming`/`permissionCardActive` exception at `:1614/:1620`);
  - **permission** (non-plan) → composer **replaced** by card;
  - **question** (head) → composer **replaced** by card.
  The "keeps composer live" exception must survive the merge as an `isPlan` check on the head, not a separate slot.
- **Correction to prior §3.4 wording:** the original plan said a plan review can sit "behind" the head interaction — **wrong.** A plan review **is** the head interaction (kind permission, isPlan). It cannot coexist as a separate surface with a head permission/question; they serialize like everything else. Removed.

### 3.7 Keyboard ownership (corrected)
Global-window keydown handlers exist in `permission-card.tsx:155-164`, `plan-review-card.tsx:66`, and the new question card. The prior "only head renders ⇒ one binding, automatic" claim was **false** because plan review used to be treated as outside the queue. Now that plan-review is the head interaction (§3.6), there is genuinely **one active surface at the head**. Still, to be safe against transitional double-mounts, **every keyboard-owning card guards with an explicit "am I the foreground/head surface" check** before binding capture-phase listeners — do not rely on render-count alone. One head ⇒ one binding.

---

## 4. THE CARD COMPONENT

**One** component, `question-card.tsx` (absorbing `QuestionCard`/`QuestionForm`/`QuestionInput`), driven by `QuestionRequest`, **always emitting `QuestionAnswer[]`** (mechanism-agnostic). **Delete the unparseable `<Card>` fallback** (`question-card.tsx:73-90`) and v0 `Card` import (`:37-44`) — with a real request there is always structure; a Codex parse-empty (`options:null`) degrades to a single free-text field in the SAME card, never a different primitive. (For Claude the empty-options branch is dead code, §1.4.)

### 4.1 Chrome / tokens
Adopt the slash-picker gold standard (`slash-command-picker.tsx:125`): `rounded-lg border border-border1 bg-bg1` (drop `bg-bg3`; drop `rounded-xl`+`shadow`). `PermissionCard` and this card are queue-siblings → identical chrome. Retune or inline `interaction-prompt.tsx:61` (`bg-bg3`) — it now has one consumer since `inline-permission.tsx` was deleted.

### 4.2 Layout (matches the approved screenshot)
- **Header row ABOVE the card:** `User input` label (left) + `AWAITING RESPONSE` pill (`border-border1` outline).
- **Card body:** question text; `X` dismiss top-right.
- **Option ROWS**, numbered `1, 2, 3…`:
  - **`multiSelect === true`** (Claude only, from the SDK boolean): checkbox rows, multiple toggle (keep checkbox semantics `question-card.tsx:255-292`, restyled).
  - **`multiSelect === false`** (Claude single): highlighted-row selection (`bg-bg1-hover`), not a radio (replaces `:296-327`).
  - **`multiSelect === undefined`** (Codex — no flag exists): **default to single-select**, because the vendor gives no cardinality signal. Documented limitation: a genuinely multi-answer Codex question is capped to one unless we later learn otherwise. *(Alternative considered: always-multi for Codex since the answer is `string[]`; rejected as default because it mis-renders the common single-answer case, but revisitable — see §7.)*
  - `description`/`preview` render under the label.
- **Free-text LAST row `0  Type something…`** whenever `allowOther`. Selecting it reveals & **focuses** a text input (masked if `secret`).
- **Bottom-LEFT carousel `< ● ● ● >`** — one dot per question; shown only when `questions.length > 1`.
- **Bottom-RIGHT submit (arrow) button.**

### 4.3 States & interactions
- **single-select:** click/number-key highlights; submit → `{selectedOptionIds:[id]}`.
- **multi-select:** toggle; submit → all selected ids.
- **free-text:** selecting "0" focuses input; typed → `freeText`. Empty free-text with no option ⇒ submit disabled + inline hint (fixes silent dead-button, `question-card.tsx:150-154`).
- **free-text "Other" on multi-select or multi-question:** `QuestionAnswer` supports `selectedOptionIds[]` + `freeText` together. **Claude output-schema limitation:** `AskUserQuestionOutput.response` is a **single** top-level string (`sdk-tools.d.ts:2961`) that cannot say *which* question the Other belongs to in a multi-question call. When multiple questions each have free-text, we fold per-question free-text into that question's `answers[questionText]` entry (append to the comma-joined labels) and reserve top-level `response` for a single-question ask — documented lossiness inherent to the vendor schema (EC-19).
- **carousel:** per-question answer map keyed by `question.id`; arrows/dots page; submit enabled only when **all** questions answered. One submit → one resolver → one `QuestionAnswer[]`.
- **dismiss (X):** sends `{outcome:"dismissed"}`. Agent effect: **Claude (A)** → `{behavior:"cancelled"}` (CLI applies dialog default — **UX copy says "the agent proceeds with its default," NOT "tool refused"**); **Claude (B)** → tool deny with steering message; **Codex** → see below; **inferred** → removes card, no prompt.
  - **Codex dismiss (no native cancel variant — verified schema):** `ToolRequestUserInputResponse` requires `{answers:{[id]:{answers:string[]}}}` with no cancel. We send **empty arrays for every question id** as the dismiss sentinel and document that Codex may interpret this as "answered nothing" rather than a true cancel — the schema offers nothing better. (Addresses audit missed-edge-case; honest about the limitation.)
- **submit:** disabled until valid; on submit the provider resolves the head interaction AND patches the durable `AgentQuestionMessage` per-field `answer` (§1.2) → remount shows read-only answered, not a blank form.
- **keyboard (scoped, focus-aware):** `1..9`/`0` pick rows (0 = free-text) **for the currently-visible carousel page only**; `↑/↓` move highlight on the active page; `←/→` page carousel; `Enter` submit (when valid); `Esc` dismiss. **When a free-text input has focus, digit keys go to the text field — only `Enter`/`Esc` stay global** (fixes the digit-vs-textarea fight, audit). Card owns focus on mount; only the head/foreground card binds (§3.7).

### 4.4 Composer gating
A head **question** interaction gates the composer like `pendingPermission` does. Extend `permissionCardActive` (`agent-chat.tsx:1620`) / `canSend` (`:1622-1626`) to treat a head question as composer-blocking (user can't fire a competing next-turn prompt). Blocking questions render in the **composer slot** (like `PermissionCard`, `:2416-2464`) — this also fixes EventStripe-collapse hiding the form (audit [high], `event-stripe.tsx:99-101`). **Inferred (non-blocking) questions** stay inline (no turn to block).
- **Precedence at the head:** plan-review (composer live) > permission (composer replaced) > question (composer replaced), all serialized by the queue (§3.6). The durable `AgentQuestionMessage` in the timeline and the composer-slot card are two renders of the same ask; on submit the composer card dismisses and the timeline message flips to read-only answered (§1.2).
- **Pre-existing queued next-turn send vs a parked question turn:** if the user queued an unrelated follow-up (greyed bubble, `sessions-provider.tsx:811-857`) *before* the question arrived, that send flushes on turn *completion* — but the turn is now parked on the question, not complete. **Defined behavior:** the queued send stays queued (turn not complete) and flushes only after the question resolves and the turn actually ends; composer gating prevents *new* queued sends while a question is at the head. (Addresses audit missed-edge-case.)

### 4.5 Deletions
- delete unparseable `<Card>` fallback (`question-card.tsx:73-90`) + unused `Card*` imports (`:37-44`).
- delete "replies are sent as your next prompt" body copy (`:107`) — replaced by header pill; only the inferred/non-blocking path shows a "sent as your next prompt" note.
- delete the lossy string flatten (`:156-169`) from the card; **move a copy to the provider** for the inferred path only (§2.2g).
- remove the `toolByKind.question` interactive mapping (`registry.ts:92`) and repoint to read-only (§1.3); wire `byKind.question` (`registry.ts:100`) to the read-only card.
- remove/repoint stale `interaction-prompt.tsx:1-21` header and `types.ts:62-68` doc.

---

## 5. EDGE CASES

| # | Edge case (audit ref) | Designed behavior |
|---|---|---|
| 1 | Mid-stream answer queued as greyed bubble (`sessions-provider.tsx:811-856`) | For blocking vendors: gone — resolver settles the SAME turn, no `sendPrompt`. |
| 2 | Idle answer starts a fresh turn (`:890-905`) | Gone for blocking; only inferred/non-blocking uses next-turn. |
| 3 | Queued answer dropped on failed/reconnecting turn (`:1527-1537`) | N/A for blocking. On crash the card is evicted (§3.3), resolver fails closed. |
| 4 | Triple surface (tool card + PermissionCard + QuestionCard) | `toolByKind.question` interactive mapping removed (§1.3); `canUseTool`/dialog special-case raises a **question**, not a permission; durable `AgentQuestionMessage` is the only timeline artifact. ONE interactive surface. |
| 5 | Question hidden in collapsed EventStripe (`event-stripe.tsx:99-101`) | Blocking question renders in composer slot; never collapsed. |
| 6 | Dismiss/X semantics | Claude (A) → `cancelled` (agent uses default, honest copy); Claude (B) → deny+steer; Codex → empty-array sentinel (documented); inferred → remove. |
| 7 | Timeout, no answer | Head-only engine timer (§3.5): Claude (A) → `cancelled`; Codex → RPC clock; distinct `QUESTION_RESPONSE_TIMEOUT_MS`; card evicted. |
| 8 | Crash/reconnect mid-question | Eviction runs BEFORE the `activelyDriven` early-return (§3.3) + on the Codex rebuild path; resolver released via `cancel()`/`teardown()`. Fires for the streaming case. |
| 9 | Empty submit | Submit disabled + inline hint. |
| 10 | Concurrent permission + question | ONE queue, one-by-one, arrival order; append not overwrite (`sessions-store.ts:571` clobber gone). |
| 11 | Multiple questions in one call | One `questions[]` → carousel, one submit → one resolver. |
| 12 | Duplicate/replayed request (SDK re-arm, `sdk.d.ts:302-318`) | Dedup on **`nativeRequestId`** (SDK request_id / Codex RequestId), not the minted uuid; already-dequeued response is a no-op. |
| 13 | Answered form reappears after remount (`question-card.tsx:71`) | Durable per-field `answer` on `AgentQuestionMessage`, written by provider on submit (§1.2); Phase-4 reload test. |
| 14 | Keyboard multi-binding | Only head/foreground card binds, with an explicit foreground guard (§3.7); plan-review is now the head, not a separate surface. |
| 15 | Multi-select label contains comma | Card keeps ids/labels structured; Claude joins for the text payload; Codex keeps arrays — no ambiguity in the structured path. |
| 16 | Free-text "Other" | `allowOther` row `0`; Claude auto-Other, Codex `isOther`. |
| 17 | Secret input (Codex `isSecret`) | Masked field via `secret?`; value never logged. Includes the **null-options + isSecret** combo → lone masked textarea with valid submit. |
| 18 | Cursor question (no channel) | Inference-only, non-blocking, honest copy, inline. |
| 19 | Multi-question + per-question Other in Claude output | `response` is a single string (`sdk-tools.d.ts:2961`); per-question free-text folded into that question's `answers[]` entry; documented lossiness (§4.3). |
| 20 | Claude schema bounds (1–4 q, 2–4 opts) | Empty-options branch is Codex-only dead code for Claude (§1.4); no 0-option Claude question. |
| 21 | Bypass mode Claude | Outcome (A) `onUserDialog` works in bypass; outcome (B) `canUseTool` does NOT — matrix (§2.1) reflects this honestly. |
| 22 | Concurrent subagent + main question timers | Engine timer armed only at queue head (§3.5); queued-behind requests don't tick down. |
| 23 | `supportedDialogKinds` first-attached-client-wins, multi-client (`sdk.d.ts:1537-1541,3222`) | Single-owner assumption stated: the engine is the dialog renderer; on multi-client/remote sessions another client may own it and the engine's answer could settle it out from under them — documented limitation, out of scope to arbitrate ownership here. |
| 24 | Codex `mcpServer/elicitation/request` (`ServerRequest.ts:19`) | Second unhandled blocking channel; **explicitly out of scope**, tracked as follow-up so Codex MCP elicitations aren't silently assumed handled. |
| 25 | Pre-queued next-turn send vs parked question turn | Queued send stays queued until the turn truly ends after the question resolves (§4.4). |
| 26 | Codex `string[]` can't separate label vs free-text | Free-text placed last; documented vendor-schema conflation, not a Zeros bug (§2.3). |

---

## 6. PHASED ROLLOUT

Ordered by risk; each phase independently shippable and Mac-testable. **Phase 0 gates everything.**

**Phase 0 — Claude mechanism probe (BLOCKING; throwaway code).**
- Files (temporary): `claude-sdk/adapter.ts` — log `canUseTool` toolNames per mode; wire `onUserDialog`+`supportedDialogKinds`, log `dialogKind`/`payload`/`toolUseID`, return `{behavior:'completed',result}` and observe.
- Exit criteria: classify outcome (A)/(B)/(C); confirm no second dialog / no Other re-ask; observe behavior in `default` and `bypass`. **Lock `QuestionRequest`/`QuestionResponse` and the capability matrix on the result.** No further phase starts until this returns.

**Phase 1 — Data model + core types (no behavior change).**
- Files: `agent-events.ts` (`QuestionRequest/Spec/Option/Response/Answer`, incl. `nativeRequestId`), `messages.ts` (`AGENT_QUESTION_REQUEST/RESPONSE` + union, `nativeRequestId` on the permission request too for §3.1), `agent-messages.ts:206-234` (per-field `id/answer/allowOther/secret`, message `questionId`/`nativeRequestId`).
- Test: `pnpm -w typecheck` + package tests green.

**Phase 2 — Engine plumbing + Claude blocking (mechanism from Phase 0).**
- Files: `gateway.ts` (`answerQuestion`+`onQuestionRequest`), `engine/agents/types.ts`, `claude-sdk/adapter.ts` (`pendingDialogs`; **outcome-A:** `onUserDialog`+`supportedDialogKinds`, `buildAskUserQuestionOutput` with full echo; **outcome-B:** `canUseTool` deny+next-turn; dialog-correct timeout/abort/cancel/teardown safeguards; head-armed timer).
- Test: extend `codex/__tests__/app-server-adapter-reconnect.test.ts` pattern with a Claude question resolve/dismiss(cancelled)/timeout/abort/replay-dedup unit test.
- Manual (Mac): ask Claude a question; confirm the request emits with `questionId`+`nativeRequestId`; a scripted resolver returns the answer same-turn (temporary CLI-driven answer before UI); verify in `default` and `bypass`.

**Phase 3 — Store queue + bridge + provider + plan-review migration.**
- Files: `sessions-store.ts` (`pendingInteractions` queue, `applyBridgeQuestionRequest` incl. durable-message construction, eviction in `truncateMessagesFromInMemory` + reworked `applyBridgeAgentExit` before the early-return + Codex rebuild path, `nativeRequestId` dedup), `sessions-provider.tsx` (`respondToQuestion` incl. durable patch + inferred flatten, unified kind-tagged buffer), `bridge/ws-client.ts` + `bridge/agent-events.ts` (route new messages), **`agent-chat.tsx` plan-review migration** (re-derive `planReview` + all ~10 `pendingPermission` reads off `pendingInteractions[0]`).
- Test: extend `sessions-store-agent-exit.test.ts` for pending-interaction eviction on streaming crash; new queue-ordering test (perm+question head order, dequeue-on-match, no clobber, `nativeRequestId` dedup); a **plan-review-regression** test (plan review still shows, composer stays live).
- Manual: back-to-back permission + question surface one-by-one in order; plan review still works with composer live; kill agent mid-question → card evicts.

**Phase 4 — The ONE card (UI), Claude end-to-end.**
- Files: rewrite `question-card.tsx` (delete fallback, new layout/states/scoped-focus-aware keyboard/carousel, always emit `QuestionAnswer[]`), retune `interaction-prompt.tsx`, `registry.ts` (remove `toolByKind.question` interactive mapping, wire `byKind.question` read-only), `translator.ts:797` (suppress AskUserQuestion tool-kind interactive mapping), `agent-chat.tsx` (reroute `respondToQuestion`, composer gating/precedence), `types.ts` (seam + doc).
- Test: render tests for single/multi/free-text/carousel/dismiss + a **reload-after-answer shows read-only** test + a **digit-key-with-focused-textarea** test.
- Manual (Mac): full Claude loop — single, multi, free-text/Other, 2-question carousel; same-turn resume (no greyed bubble, no second permission card, no inline tool card); X dismiss (agent uses default); keyboard.

**Phase 5 — Codex blocking (`item/tool/requestUserInput`).**
- Files: `app-server.ts` (`wireRequest`), `app-server-adapter.ts` (`handleUserInputRequest`, `respondToQuestion` with `APPROVAL_TIMEOUT_MS`), `app-server-translator.ts` (map params → `QuestionRequest`; option `id`==`label`; `multiSelect` undefined → single default; null-options; isSecret; `nativeRequestId`=RequestId; `toolCallId`=itemId).
- Test: extend `app-server-adapter-reconnect.test.ts` with a requestUserInput round-trip + rebuild-path eviction + label-keyed answer reshape.
- Manual (Mac): drive Codex to `requestUserInput`; same card renders; id-keyed label-valued `{answers}` resolves the RPC same-turn; secret masked; dismiss sentinel behaves.

**Phase 6 — Cursor inferred fallback + cleanup.**
- Files: `cursor-sdk/adapter.ts` (`respondToQuestion` no-op), inferred-path copy in provider, delete stale comments, remove dead code.
- Manual: Cursor questions render inference-only, honest "next prompt" copy, non-blocking.

---

## 7. RISKS & OPEN QUESTIONS

1. **Claude answer channel (RESOLVED IN DIRECTION, PINNED BY PHASE 0).** The original `updatedInput.answers` mechanism is **wrong** — `updatedInput` is tool INPUT (`sdk.d.ts:2069`), `answers` is OUTPUT (`sdk-tools.d.ts:2798`), and the real channel is `onUserDialog`/`supportedDialogKinds` (`sdk.d.ts:1279,1543,6377`). **`onUserDialog` is now the PRIMARY investigation, not a follow-up.** Residual risk: it is unproven that `AskUserQuestion` flows through `onUserDialog` at all — the only documented `dialogKind` is `'refusal_fallback_prompt'` (`sdk.d.ts:1525,3222`). Phase 0 classifies (A)/(B)/(C) and the matrix downgrades Claude to non-blocking honestly if needed.
2. **Bypass mode.** Outcome (B)'s `canUseTool` special-case does **not** fire in `bypass` (`adapter.ts:184`), so Claude blocking is mode-dependent under (B). Outcome (A)'s `onUserDialog` is mode-independent. Matrix (§2.1) states this; **needs no further decision if Phase 0 = (A).**
3. **Codex `multiSelect`.** No flag exists (schema verified). Default single-select; documented limitation. **Open:** confirm from Codex docs/runtime whether >1 selection is ever valid; if array-native multi is common, flip the Codex default to multi with min-1 validation (§4.2 alternative).
4. **`supportedDialogKinds` ownership on multi-client sessions.** First-attached-client-wins, persisted across restarts (`sdk.d.ts:1537-1541`); the engine answering could settle a dialog another client owns (`sdk.d.ts:1516-1517`). We assume single-owner (engine). **Open:** arbitration is out of scope; revisit if remote/multi-client sessions ship.
5. **Timeout values + two-clock race.** Distinct `QUESTION_RESPONSE_TIMEOUT_MS` (value TBD), armed at queue head (§3.5), set below the CLI park deadline so the engine stays authoritative. **Open:** the exact value for a human answering a question vs approving a tool.
6. **Composer-slot vs inline for blocking questions.** Plan uses composer-slot (matches PermissionCard, avoids EventStripe collapse) with plan-review > permission > question precedence (§4.4). **Open (user preference):** if inline is preferred, force-expand EventStripe on a pending question (`event-stripe.tsx:70-77` twin) and gate the composer separately.
7. **Codex `mcpServer/elicitation/request`** (`ServerRequest.ts:19`) — a second question-like blocking channel, **out of scope**, tracked as follow-up so Codex MCP elicitations are not silently assumed handled.
8. **Durable-message machinery is net-new** (no permission precedent). Producer/patcher fully specified (§1.2), but flagged as the one place the plan does **not** simply mirror permissions.

---

**Key files this plan touches (all absolute):**
- `/home/vercel-sandbox/workspace/packages/core/src/agent-events.ts` — `QuestionRequest/Response` + `nativeRequestId`
- `/home/vercel-sandbox/workspace/packages/core/src/messages.ts` — bridge pair + `nativeRequestId` on permission request
- `/home/vercel-sandbox/workspace/packages/core/src/agent-messages.ts` — adopt/extend `AgentQuestionMessage` (per-field `answer`, `questionId`, `nativeRequestId`)
- `/home/vercel-sandbox/workspace/src/engine/agents/gateway.ts` — `answerQuestion`/`onQuestionRequest`
- `/home/vercel-sandbox/workspace/src/engine/agents/types.ts` — interface additions
- `/home/vercel-sandbox/workspace/src/engine/agents/adapters/claude-sdk/adapter.ts` — Phase-0 probe; `pendingDialogs`; `onUserDialog`+`supportedDialogKinds` (A) or `canUseTool` deny (B); `buildAskUserQuestionOutput`; head-armed timer
- `/home/vercel-sandbox/workspace/src/engine/agents/adapters/claude/translator.ts` — suppress AskUserQuestion interactive tool-kind mapping (`~:797`)
- `/home/vercel-sandbox/workspace/src/engine/agents/adapters/codex/app-server.ts` + `app-server-adapter.ts` + `app-server-translator.ts` — `requestUserInput` (label-keyed answers, single-select default)
- `/home/vercel-sandbox/workspace/src/engine/agents/adapters/cursor-sdk/adapter.ts` — no-op stub
- `/home/vercel-sandbox/workspace/src/zeros/agent/sessions-store.ts` — `pendingInteractions` queue, `nativeRequestId` dedup, eviction before early-return, durable-message producer
- `/home/vercel-sandbox/workspace/src/zeros/agent/sessions-provider.tsx` — `respondToQuestion` (durable patch + inferred flatten), kind-tagged unified buffer
- `/home/vercel-sandbox/workspace/src/zeros/agent/renderers/question-card.tsx` — the ONE card; delete fallback; scoped focus-aware keyboard
- `/home/vercel-sandbox/workspace/src/zeros/agent/renderers/interaction-prompt.tsx` — retune/stale-comment
- `/home/vercel-sandbox/workspace/src/zeros/agent/renderers/registry.ts` — remove `toolByKind.question` interactive mapping; wire `byKind.question` read-only
- `/home/vercel-sandbox/workspace/src/zeros/agent/renderers/types.ts` — `respondToQuestion` seam
- `/home/vercel-sandbox/workspace/src/zeros/agent/agent-chat.tsx` — plan-review migration off `pendingPermission`, composer gating/precedence, reroute