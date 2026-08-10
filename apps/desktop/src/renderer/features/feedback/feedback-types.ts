export const FEEDBACK_TYPE_OPTIONS = [
  { value: "bug", label: "Bug or Issue" },
  { value: "feedback", label: "Feedback" },
  { value: "feature", label: "Feature Request" },
] as const;

export type FeedbackType = (typeof FEEDBACK_TYPE_OPTIONS)[number]["value"];

export const DEFAULT_FEEDBACK_TYPE: FeedbackType = "bug";
