import type {
  QuestionRequest,
  QuestionResponse,
} from "../../platform/bridge/agent-events";

const MAX_EXTERNAL_URL_CHARS = 16_384;
const MAX_EXTERNAL_ACTIONS = 4;

function safeWebUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_EXTERNAL_URL_CHARS
  ) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

/** Resolve renderer-owned actions from the exact options the user accepted.
 * Unknown/duplicate answers and non-web URLs fail closed. The bounded result
 * prevents a provider-authored multi-question prompt from becoming a browser
 * popup flood even after explicit form submission. */
export function externalUrlsForQuestionResponse(
  request: QuestionRequest,
  response: QuestionResponse,
): string[] {
  if (response.outcome.outcome !== "answered") return [];
  const questions = new Map(request.questions.map((item) => [item.id, item]));
  const seenQuestions = new Set<string>();
  const urls = new Set<string>();
  for (const answer of response.outcome.answers) {
    if (seenQuestions.has(answer.questionId)) return [];
    seenQuestions.add(answer.questionId);
    const question = questions.get(answer.questionId);
    if (!question) return [];
    for (const selectedId of answer.selectedOptionIds) {
      const option = question.options.find((item) => item.id === selectedId);
      if (!option) return [];
      const action = option.externalAction;
      if (!action) continue;
      if (action.kind !== "open-url") return [];
      const url = safeWebUrl(action.url);
      if (!url) return [];
      urls.add(url);
      if (urls.size > MAX_EXTERNAL_ACTIONS) return [];
    }
  }
  return [...urls];
}
