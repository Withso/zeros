export function guardianDeniedEvent(rawOutput: unknown): unknown | null {
  const output = record(rawOutput);
  const review = record(output.review);
  const event = record(output.event);
  const eventReview = record(event.review);
  if (
    review.status !== "denied" ||
    eventReview.status !== "denied" ||
    typeof event.threadId !== "string" ||
    typeof event.reviewId !== "string" ||
    !record(event.action).type
  ) {
    return null;
  }
  return output.event;
}

export function guardianReviewRationale(rawOutput: unknown): string {
  const rationale = record(record(rawOutput).review).rationale;
  return typeof rationale === "string" && rationale.trim()
    ? rationale.trim()
    : "Codex Guardian denied this action.";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
