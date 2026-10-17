// ──────────────────────────────────────────────────────────
// Local orchestration — question and permission cards
// ──────────────────────────────────────────────────────────
//
// Agents that can see a chat may read its pending cards and answer them (D14).
// Cards are classified by meaning, not by the channel they arrived on:
//   permission     — a provider permission request (Allow / Deny);
//   approval       — a question that is really a permission (Codex sends MCP
//                    tool approvals as one-click question cards);
//   question       — an ordinary question with options or free text;
//   plan_approval  — Claude's ExitPlanMode review (approving also restores the
//                    remembered mode, as the UI does);
//   external       — a sign-in or URL the user must finish in the app.
// The approval guard (user decision): any visible agent may answer questions
// and deny anything; it may APPROVE a permission, approval or plan only when
// its own current mode is Auto or Full and at least the asking chat's level,
// counting the mode a plan approval would restore.
// ──────────────────────────────────────────────────────────

import type { QuestionRequest, RequestPermissionRequest } from "@zeros/protocol/agent-events";
import {
  LocalOrchestrationError,
  localModeRank,
  type LocalCard,
  type LocalCardKind,
  type LocalModeLevel,
} from "@zeros/protocol/local-orchestration";
import type { LocalPendingCardRecord } from "./types";

/** Mirrors renderer/features/agent/renderers/plan-body.ts isPlanReviewRequest. */
export function isPlanReview(request: RequestPermissionRequest): boolean {
  if ((request as { requiresExplicitApproval?: unknown }).requiresExplicitApproval === true) return false;
  const tc = request.toolCall as { title?: unknown; rawInput?: unknown } | undefined;
  if (!tc) return false;
  const plan = (tc.rawInput as { plan?: unknown } | null | undefined)?.plan;
  return (typeof tc.title === "string" && /exit.?plan.?mode/i.test(tc.title)) || (typeof plan === "string" && plan.trim().length > 0);
}

function questionKind(question: QuestionRequest): LocalCardKind {
  const specs = question.questions ?? [];
  if (specs.some((q) => q.options?.some((o) => o.externalAction?.kind === "open-url"))) return "external";
  if (specs.some((q) => q.presentation === "one_click_approval" || q.approvalKind)) return "approval";
  return "question";
}

export function cardKind(record: LocalPendingCardRecord): LocalCardKind {
  if (record.type === "permission" && record.permission) {
    return isPlanReview(record.permission) ? "plan_approval" : "permission";
  }
  return record.question ? questionKind(record.question) : "question";
}

function permissionEffect(kind: string): LocalCard["options"][number]["effect"] {
  if (kind === "allow_once") return "allow";
  if (kind === "allow_always" || kind === "allow_always_project") return "allow_always";
  return "deny";
}

/** Option labels that mean "decline" in one-click approval questions. */
const DENY_LABEL = /^(deny|decline|reject|no|cancel|don't allow|do not allow|block)\b/i;

export function projectCard(record: LocalPendingCardRecord, chatLink: string): LocalCard {
  const kind = cardKind(record);
  const cardId = `${record.type === "permission" ? "perm" : "q"}:${record.id}`;
  if (record.type === "permission" && record.permission) {
    const p = record.permission;
    const tc = p.toolCall as { title?: string; kind?: string; rawInput?: unknown; locations?: unknown } | undefined;
    return {
      cardId,
      kind,
      chatId: record.chatId ?? "",
      chatLink,
      title: p.title ?? tc?.title ?? "Permission request",
      detail: {
        tool: tc?.title ?? null,
        toolKind: tc?.kind ?? null,
        input: tc?.rawInput ?? null,
        locations: tc?.locations ?? null,
        ...(p.contextItems ? { context: p.contextItems } : {}),
      },
      options: p.options.map((o) => ({ id: o.optionId, label: o.name, effect: permissionEffect(o.kind) })),
      blocking: true,
      expiresAt: null,
      answerCommand: `zeros local card answer ${cardId} --option <id>`,
    };
  }
  const q = record.question!;
  const specs = q.questions ?? [];
  const first = specs[0];
  const approvalLike = kind === "approval";
  return {
    cardId,
    kind,
    chatId: record.chatId ?? "",
    chatLink,
    title: first?.header ?? first?.approvalPrompt ?? first?.prompt ?? "Question",
    detail: {
      questions: specs.map((s) => ({
        id: s.id,
        prompt: s.prompt,
        header: s.header ?? null,
        multiSelect: s.multiSelect ?? false,
        allowOther: s.allowOther,
        options: s.options.map((o) => ({ id: o.id, label: o.label, description: o.description ?? null })),
        ...(s.approvalPrompt ? { approvalPrompt: s.approvalPrompt } : {}),
      })),
      allowDecline: q.allowDecline ?? false,
    },
    options:
      specs.length === 1
        ? first!.options.map((o) => ({
            id: o.id,
            label: o.label,
            effect: approvalLike ? (DENY_LABEL.test(o.label) ? "deny" : /always|session|remember/i.test(o.label) ? "allow_always" : "allow") : "answer",
          }))
        : [],
    blocking: q.blocking,
    expiresAt: q.expiresAt ?? null,
    answerCommand:
      specs.length === 1 && first!.options.length > 0
        ? `zeros local card answer ${cardId} --option <id>`
        : `zeros local card answer ${cardId} --answers '[{"questionId":"…","selectedOptionIds":[…],"freeText":"…"}]'`,
  };
}

export function parseCardId(cardId: string): { type: "permission" | "question"; id: string } | null {
  const match = /^(perm|q):(.+)$/.exec(cardId);
  if (!match) return null;
  return { type: match[1] === "perm" ? "permission" : "question", id: match[2]! };
}

/** Throw unless the caller may give this answer. */
export function assertAnswerAllowed(input: {
  kind: LocalCardKind;
  approving: boolean;
  callerLevel: LocalModeLevel | null;
  targetLevel: LocalModeLevel | null;
  restoredLevel?: LocalModeLevel | null;
}): void {
  if (input.kind === "external") {
    throw new LocalOrchestrationError("UNAVAILABLE", "This card needs the user to finish a sign-in in the Zeros app.");
  }
  if (!input.approving) return;
  if (input.kind === "question") return;
  const caller = input.callerLevel;
  if (!caller || (caller !== "auto" && caller !== "full")) {
    throw new LocalOrchestrationError(
      "APPROVAL_GUARD",
      "Only an agent in Auto or Full mode can approve permissions. Deny it or ask the user to approve it in that chat.",
    );
  }
  const needed = [input.targetLevel, input.restoredLevel].filter((l): l is LocalModeLevel => l != null);
  for (const level of needed) {
    if (localModeRank(level) > localModeRank(caller)) {
      throw new LocalOrchestrationError(
        "APPROVAL_GUARD",
        `That chat runs at a higher permission level (${level}) than yours (${caller}). Ask the user to approve it.`,
      );
    }
  }
}
