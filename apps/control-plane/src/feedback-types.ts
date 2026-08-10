export const FEEDBACK_TYPES = ["bug", "feedback", "feature"] as const;

export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

// `issue` shipped in older desktop builds. Keep accepting it at the API edge,
// then immediately collapse it into the canonical combined bug category.
export const ACCEPTED_FEEDBACK_TYPES = [...FEEDBACK_TYPES, "issue"] as const;

export type AcceptedFeedbackType = (typeof ACCEPTED_FEEDBACK_TYPES)[number];

export const FEEDBACK_TYPE_LABELS: Readonly<Record<FeedbackType, string>> = {
  bug: "Bug or Issue",
  feedback: "Feedback",
  feature: "Feature Request",
};

export function normalizeFeedbackType(
  type: AcceptedFeedbackType,
): FeedbackType {
  return type === "issue" ? "bug" : type;
}
