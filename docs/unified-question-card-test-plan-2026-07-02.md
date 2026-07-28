# Unified Question Card — Complete Manual Test Plan

Covers every phase (0–6), every agent (Claude / Codex / Cursor), and every question-card
use case. Companion to `docs/unified-question-card-plan-2026-07-02.md`.

**Legend:** ✅ = expected pass · ⚠️ = known limitation / honest caveat · 🔬 = reveals the Phase-0 channel.

---

## 0. Setup & how to trigger a question (per agent)

Questions are **model-driven** — the agent decides to ask. Reliable nudges:

| Agent | Tool | Nudge prompt to trigger a card |
|---|---|---|
| **Claude** | `AskUserQuestion` | "Before you do anything, **use AskUserQuestion** to ask me which approach to take: A, B, or C." / "Ask me a **multi-select** question about which features to enable." / "Ask me **3 questions at once** about the design." |
| **Codex** | `item/tool/requestUserInput` (EXPERIMENTAL) | "Ask me for the details you need as **structured questions** before starting." Codex raises it when it genuinely needs input; may be harder to force. |
| **Cursor** | *(none — no host-answerable channel)* | Cursor will just ask **in prose** → expect **no card**, reply in the composer. |

Watch the agent **stderr log** (dev console / terminal) during Claude runs for:
```
[zeros] onUserDialog dialogKind=<X> hasQuestions=<true|false>
```

---

## 1. Quick smoke test (5 min — happy path)

1. Claude chat → "Use AskUserQuestion to ask me: use Zustand or Redux?"
2. ✅ A **card takes the composer slot**: header `💬 User input · ⧗ AWAITING RESPONSE`, the question, two option rows, a `0 Type something…` row, a submit arrow.
3. ✅ **No** greyed "queued" bubble, **no** Allow/Deny permission card, **no** duplicate inline card.
4. Click an option → row highlights → submit arrow enables → click it (or `Enter`).
5. ✅ **Turn resumes immediately** — Claude continues using your answer (not a fresh next turn).
6. ✅ Scroll up: transcript shows `User input requested` + an **`Answered: …`** line.

If all six hold, the core round-trip works. The rest is exhaustive coverage.

---

## 2. Phase-by-phase implementation verification

| Phase | What to verify | How |
|---|---|---|
| **0** Channel probe 🔬 | Which channel Claude uses | Trigger a Claude question; read the `onUserDialog dialogKind=…` log. **Log appears + `hasQuestions=true`** → channel **(A)**. **No log but the card still appears + resumes** → channel **(B)** (canUseTool deny-message). Either is a pass — just record which. |
| **1** Core model | (implicit) | No direct test — exercised by every case below. |
| **2** Claude blocking | Answer resolves the **same** turn | §1 step 5 — Claude keeps going in the same turn, no new user bubble. |
| **3** Store queue + ordering + eviction | one-by-one, no clobber, crash-evict | §4 (ordering) + §5 (crash). |
| **4** The card UI | all shapes + keyboard | §3 (every row). |
| **5** Codex blocking | requestUserInput round-trip | §6 Codex column. |
| **6** Cursor | inference-only, no card | §6 Cursor column. |

---

## 3. Card UI — every shape (drive with Claude nudges from §0)

| # | Shape | Trigger | ✅ Expected |
|---|---|---|---|
| 3.1 | **Single-select** + descriptions | "ask me A/B/C with explanations" | Numbered rows `1 2 3`; clicking one **highlights** it (only one at a time); descriptions render under labels. |
| 3.2 | **Multi-select** | "ask me a multi-select: which of X, Y, Z" | Rows show a **checkbox**; multiple toggle on/off. |
| 3.3 | **Free-text last row** | any Claude question | `0 Type something…` row present (Claude always offers Other); clicking it reveals + **focuses** a textarea. |
| 3.4 | **Free-text only** | Codex with `options:null` | A single free-text field, no option rows, submit enabled once typed. |
| 3.5 | **Multi-question carousel** | "ask me 3 questions at once" | Footer shows **`‹ ● ● ● ›`**; dots fill as each is answered; arrows + dot-clicks page; **submit enabled only when ALL answered**. |
| 3.6 | **Secret / masked** (Codex) | Codex `isSecret` question | Text field is **masked** (dots); placeholder notes hidden-from-logs. |
| 3.7 | **Header chip** | header present | Small chip left of the question text. |
| 3.8 | **Consistency** | any | Card is `bg1` + `border-border1` + `rounded-lg`, matches the `/` picker + reconnecting island. |

---

## 4. Interactions & keyboard

| # | Action | ✅ Expected |
|---|---|---|
| 4.1 | Click option (single) | Replaces selection. |
| 4.2 | Click options (multi) | Toggles each independently. |
| 4.3 | Number keys `1–9` | Select the Nth row of the **current** question. |
| 4.4 | Key `0` | Selects the free-text row + focuses it. |
| 4.5 | `Enter` (nothing focused) | Submits **if** all answered; else no-op. |
| 4.6 | `Esc` | Dismisses (see §5.1). |
| 4.7 | `←` / `→` | Pages the carousel (multi-question only). |
| 4.8 | **Digit while textarea focused** | The digit **types into the text**, does NOT select a row. |
| 4.9 | Submit gating | Arrow **disabled** until every question is answered (title explains why). |
| 4.10 | Empty free-text submit | With only free-text chosen and it's blank → submit stays disabled. |

---

## 5. Wiring & correctness (the core fix)

| # | Case | ✅ Expected |
|---|---|---|
| 5.1 | **Dismiss (X / Esc)** | Card closes; **agent proceeds with its default** (Claude: dialog cancelled / tool deny-with-guidance; Codex: empty answers). Honest — never "tool refused." |
| 5.2 | **No queueing** | Answering does **not** create a greyed "queued" bubble. This is the headline bug fixed. |
| 5.3 | **No triple-surface** | For a Claude question you see exactly **one** interactive card (composer slot) — not also a permission card and not an inline interactive tool card. |
| 5.4 | **Composer swap** | While a question is up, the composer input is **hidden**; after answering it **returns**. |
| 5.5 | **Durable record** | After answering, the transcript tool card reads `User input requested` + `Answered: <your pick>`. |
| 5.6 | **Answer reaches the agent** | The agent's continued output clearly reflects **your** choice (single, multi joined, or free-text). |
| 5.7 | **Multi-select delivery** | Picking 2+ options → the agent receives all of them (comma-joined for Claude; label array for Codex). |

---

## 6. Per-agent matrix (same card, different backends)

| Case | **Claude** | **Codex** | **Cursor** |
|---|---|---|---|
| Blocking? | ✅ (A `onUserDialog` or B `canUseTool`) | ✅ (RPC, same-turn) | ❌ inference-only |
| Card appears | ✅ | ✅ | ❌ — prose only, reply in composer |
| Single-select | ✅ | ✅ | n/a |
| Multi-select | ✅ (from SDK flag) | ✅ (**default multi** — Codex sends no flag) ⚠️ | n/a |
| Free-text / Other | ✅ (auto-Other) | ✅ (`isOther`) | n/a |
| Secret field | n/a | ✅ (`isSecret`, masked) | n/a |
| Multi-question carousel | ✅ (1–4) | ✅ | n/a |
| Dismiss behavior | cancelled → default | empty-arrays sentinel ⚠️ | remove, no send |
| Durable "Answered:" | ✅ | ✅ | n/a |

⚠️ **Codex multi-select default:** Codex gives no single/multi signal, so the card defaults to **multi** (your decision). A genuinely single-answer Codex question will still allow multiple — pick one and submit.
⚠️ **Codex dismiss:** the protocol has no cancel variant, so dismiss sends empty answers — Codex may read that as "answered nothing."

---

## 7. Concurrency & ordering

| # | Case | ✅ Expected |
|---|---|---|
| 7.1 | **Permission + question together** | The **permission** card shows first; after you answer it, the **question** card surfaces. One at a time. ⚠️ Precedence (permission-first), not strict arrival order — the full unified queue is a noted follow-up. |
| 7.2 | **Two questions in one turn** (rare) | They surface **one-by-one**; answering the first reveals the second. No clobber. |
| 7.3 | **Question while a follow-up is queued** | A pre-queued next-turn send stays queued until the question resolves + the turn ends. |

---

## 8. Edge cases & resilience

| # | Case | How to test | ✅ Expected |
|---|---|---|---|
| 8.1 | **Crash mid-question** (Codex) | With a Codex question open, `pkill -f "codex.*app-server"` (kill that chat's child) | The card **evicts** (no stuck card); chat shows reconnecting; next prompt rebuilds. |
| 8.2 | **Timeout** | Open a question, wait ~30 min without answering | Last 5 min: the card shows a `⏱ Skips in m:ss` countdown (amber under 1 min). At zero the card evicts, the transcript tool row stamps **SKIPPED**, and the agent proceeds with its default (engine `PERMISSION_RESPONSE_TIMEOUT_MS` / Codex `APPROVAL_TIMEOUT_MS`, both 30 min). |
| 8.3 | **App reload mid-question** ⚠️ | Reload the window while a question is open | The card is **gone** (pending question isn't persisted); the engine resolver times out. Known limitation — durable-pending is not in scope. |
| 8.4 | **Duplicate/replay** | (Hard to force manually) | Covered by the automated `nativeRequestId` dedup test — one card, never two. |
| 8.5 | **Cancel the turn** while a question is up | Stop button | Question releases; turn ends cleanly. |

---

## 9. Regression checks (must still work)

| # | Case | ✅ Expected |
|---|---|---|
| 9.1 | **Permission card** (e.g. Codex "run curl…", Claude edit) | Still shows Allow/Deny in the composer slot, resolves the turn. |
| 9.2 | **Plan review** (Claude ExitPlanMode) | Standalone card above a **live** composer; Approve/Copy work; composer stays usable. |
| 9.3 | **Normal prompts** (no question) | Compose + send as usual; no card. |
| 9.4 | **Reconnecting island / embedded terminal** | Still render 2px above the composer. |

---

## 10. Already covered by automated tests (skip manual)

These are deterministic and green in CI — no need to hand-test:
- **Store queue**: append (no clobber), `nativeRequestId` + `questionId` dedup, unknown-session ignore, streaming-crash eviction — `src/zeros/agent/__tests__/question-queue.test.ts`.
- **Durable record**: `stampQuestionAnswer` stamps / no-ops — same file.
- **Codex protocol shapes**: mappers match the generated `ToolRequestUserInput*` types (typecheck).
- **Engine interface**: gateway/adapter conformance — 479 engine tests.

Focus manual effort on §1–§9 (the visible round-trip + UX + resilience), especially the **Phase-0 channel probe (🔬 §2)** and the **no-queueing / no-triple-surface** guarantees (§5.2–5.3), since those can't be unit-tested.
