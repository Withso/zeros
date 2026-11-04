import type { QuestionAnswer, QuestionRequest, QuestionResponse, QuestionSpec } from "./agent-events";

/** AskUserQuestionInput / dialog payload → the canonical QuestionRequest. */
export function buildClaudeQuestionRequest(
  sessionId: string,
  questionId: string,
  toolUseID: string | undefined,
  input: Record<string, unknown>,
  expiresAt: number,
): QuestionRequest {
  const rawQuestions = Array.isArray(input?.questions)
    ? (input.questions as Array<Record<string, unknown>>)
    : [];
  const questions: QuestionSpec[] = rawQuestions.map((q, qi) => ({
    id: `q${qi}`,
    prompt: typeof q?.question === "string" ? q.question : "",
    header: typeof q?.header === "string" ? q.header : undefined,
    multiSelect:
      typeof q?.multiSelect === "boolean" ? q.multiSelect : undefined,
    options: (Array.isArray(q?.options)
      ? (q.options as Array<Record<string, unknown>>)
      : []
    ).map((o, oi) => ({
      id: `o${oi}`,
      label: typeof o?.label === "string" ? o.label : String(o?.label ?? ""),
      description:
        typeof o?.description === "string" ? o.description : undefined,
      preview: typeof o?.preview === "string" ? o.preview : undefined,
    })),
    // Claude auto-provides an "Other" free-text option (per the tool schema).
    allowOther: true,
  }));
  return {
    sessionId: sessionId as never,
    questionId,
    nativeRequestId: toolUseID ?? questionId,
    toolCallId: toolUseID,
    source: "native_dialog",
    blocking: true,
    expiresAt,
    questions,
  };
}

/** Map a canonical answer for `q${i}` back to the original option labels. */
function claudeAnswerLabels(
  rawQuestion: Record<string, unknown> | undefined,
  answer: QuestionAnswer | undefined,
): string[] {
  const options = Array.isArray(rawQuestion?.options)
    ? (rawQuestion!.options as Array<Record<string, unknown>>)
    : [];
  const labels = (answer?.selectedOptionIds ?? []).map((id) => {
    const oi = Number(String(id).replace(/^o/, ""));
    const label = options[oi]?.label;
    return typeof label === "string" ? label : String(id);
  });
  if (answer?.freeText) labels.push(answer.freeText);
  return labels;
}

/** Reconstruct the SDK's AskUserQuestionOutput (echo questions + keyed answers)
 *  for the onUserDialog `{completed, result}` path. */
export function buildAskUserQuestionOutput(
  input: Record<string, unknown>,
  answers: QuestionAnswer[],
): Record<string, unknown> {
  const rawQuestions = Array.isArray(input?.questions)
    ? (input.questions as Array<Record<string, unknown>>)
    : [];
  const answerMap = Object.fromEntries(rawQuestions.map((q, qi) => {
    const a = answers.find((x) => x.questionId === `q${qi}`);
    return [typeof q?.question === "string" ? q.question : `q${qi}`, claudeAnswerLabels(q, a).join(", ")];
  }));
  return { questions: rawQuestions, answers: answerMap };
}

/** A headless question may run only with the human's complete, validated answers. */
export function claudeQuestionHookOutput(
  input: Record<string, unknown>,
  response?: QuestionResponse,
): { hookSpecificOutput: { hookEventName: "PreToolUse" } & (
  { permissionDecision: "allow"; updatedInput: Record<string, unknown> } |
  { permissionDecision: "deny"; permissionDecisionReason: string }
) } {
  const denied = { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const,
    permissionDecisionReason: "The question was not answered." } };
  const questions = input.questions;
  if (!Array.isArray(questions) || !questions.length || response?.outcome?.outcome !== "answered") return denied;
  if (!questions.every(q => q && typeof q === "object" && typeof q.question === "string" && q.question.length > 0)) return denied;
  if (new Set(questions.map(q => q.question)).size !== questions.length) return denied;
  const answers = response.outcome.answers;
  if (!Array.isArray(answers) || answers.length !== questions.length || new Set(answers.map(a => a?.questionId)).size !== questions.length) return denied;
  if (!answers.every(answer => {
    if (!answer || !Array.isArray(answer.selectedOptionIds)) return false;
    const index = questions.findIndex((_, i) => answer.questionId === `q${i}`), question = questions[index];
    if (!question || (answer.freeText !== undefined && typeof answer.freeText !== "string")) return false;
    const selected = answer.selectedOptionIds;
    const options: Array<Record<string, unknown> | null> = Array.isArray(question.options) ? question.options : [];
    return (question.multiSelect === true || selected.length <= 1) && new Set(selected).size === selected.length &&
      selected.every(id => options.some((option, i) => id === `o${i}` && typeof option?.label === "string")) &&
      (selected.length > 0 || !!answer.freeText);
  })) return denied;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
    updatedInput: { ...input, answers: buildAskUserQuestionOutput(input, answers).answers } } };
}

/** Human-readable answer string for the canUseTool deny-message (B) path. */
export function formatAnswerForClaude(
  input: Record<string, unknown>,
  answers: QuestionAnswer[],
): string {
  const rawQuestions = Array.isArray(input?.questions)
    ? (input.questions as Array<Record<string, unknown>>)
    : [];
  const lines = rawQuestions.map((q, qi) => {
    const a = answers.find((x) => x.questionId === `q${qi}`);
    const prompt =
      typeof q?.question === "string" ? q.question : `Question ${qi + 1}`;
    const value = claudeAnswerLabels(q, a).join(", ") || "(no selection)";
    return `- ${prompt} → ${value}`;
  });
  return `The user answered your question(s):\n${lines.join("\n")}`;
}

/** Convert a Codex ToolRequestUserInputParams into the canonical QuestionRequest.
 *  Codex specifics: option `id` == `label` (the answer is a label array, so the
 *  labels ARE the ids); Codex currently has no generated multiSelect field, so
 *  option questions default to single-select unless a future boolean appears;
 *  `options: null` → a pure free-text question; `isOther`/`isSecret` map to the
 *  free-text row + masking. */
export function mapCodexUserInputToQuestion(
  sessionId: string,
  questionId: string,
  rpcRequestId: string,
  params: Record<string, unknown>,
  expiresAt: number,
): QuestionRequest {
  const rawQuestions = Array.isArray(params?.questions)
    ? (params.questions as Array<Record<string, unknown>>)
    : [];
  const itemId = typeof params?.itemId === "string" ? params.itemId : undefined;
  const questions: QuestionSpec[] = rawQuestions.map((q, qi) => {
    const options = Array.isArray(q?.options)
      ? (q.options as Array<Record<string, unknown>>).map((o) => {
          const label =
            typeof o?.label === "string" ? o.label : String(o?.label ?? "");
          return {
            id: label, // MUST equal label — the Codex answer is a label array
            label,
            description:
              typeof o?.description === "string" ? o.description : undefined,
          };
        })
      : [];
    return {
      id: typeof q?.id === "string" ? q.id : `q${qi}`,
      prompt: typeof q?.question === "string" ? q.question : "",
      header: typeof q?.header === "string" ? q.header : undefined,
      multiSelect: typeof q?.multiSelect === "boolean" ? q.multiSelect : false,
      options,
      // isOther adds the free-text row ALONGSIDE options; a null/absent
      // options list IS a pure free-text ask, so it must get the row too —
      // otherwise the card renders no input at all and can never be
      // submitted (only dismissed).
      allowOther: q?.isOther === true || options.length === 0,
      secret: q?.isSecret === true,
    };
  });
  return {
    sessionId: sessionId as never,
    questionId,
    nativeRequestId: itemId ?? rpcRequestId,
    toolCallId: itemId,
    source: "native_rpc",
    blocking: true,
    expiresAt,
    questions,
  };
}

/** Canonical QuestionResponse → Codex ToolRequestUserInputResponse
 *  ({ answers: { [questionId]: { answers: string[] } } }). Since option id ==
 *  label, selectedOptionIds ARE the labels; free-text is appended last. On
 *  dismiss/decline we send empty arrays for every question id because Codex
 *  has no cancel variant. (Only MCP cards expose decline as a distinct action.) */
export function mapNativeQuestionAnswerToCodex(
  request: QuestionRequest,
  response: QuestionResponse,
): { answers: Record<string, { answers: string[] }> } {
  const answers: Record<string, { answers: string[] }> = {};
  if (response.outcome.outcome !== "answered") {
    for (const q of request.questions) answers[q.id] = { answers: [] };
    return { answers };
  }
  const byId = new Map<string, QuestionAnswer>();
  for (const a of response.outcome.answers) byId.set(a.questionId, a);
  for (const q of request.questions) {
    const a = byId.get(q.id);
    const vals = [...(a?.selectedOptionIds ?? [])];
    if (a?.freeText) vals.push(a.freeText);
    answers[q.id] = { answers: vals };
  }
  return { answers };
}
