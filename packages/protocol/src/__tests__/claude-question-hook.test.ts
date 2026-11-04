import { expect, it } from "vitest";
import { claudeQuestionHookOutput } from "../agent-questions";
import type { QuestionResponse } from "../agent-events";

const input = { questions: [{ question: "Route?", options: [{ label: "A" }, { label: "B" }], multiSelect: false }],
  metadata: { fixture: true }, answers: { "Route?": "Untrusted native answer" } };
const answered = (answers: unknown): QuestionResponse => ({ outcome: { outcome: "answered", answers } }) as QuestionResponse;

it("echoes original input with only validated human labels and free text", () => {
  expect(claudeQuestionHookOutput(input, answered([{ questionId: "q0", selectedOptionIds: ["o1"], freeText: "because" }])))
    .toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
      updatedInput: { ...input, answers: { "Route?": "B, because" } } } });
  expect(input.answers).toEqual({ "Route?": "Untrusted native answer" });
});

it.each([
  [],
  [{ questionId: "unknown", selectedOptionIds: ["o0"] }],
  [{ questionId: "q0", selectedOptionIds: ["o99"] }],
  [{ questionId: "q0", selectedOptionIds: ["o0", "o1"] }],
  [{ questionId: "q0", selectedOptionIds: ["o0", "o0"] }],
  [{ questionId: "q0", selectedOptionIds: [] }],
  [{ questionId: "q0", selectedOptionIds: [], freeText: 42 }],
  [{ questionId: "q0", selectedOptionIds: "o0" }],
  [{ questionId: "q0", selectedOptionIds: ["o0"] }, { questionId: "q0", selectedOptionIds: ["o1"] }],
  [null],
  null,
].map(answers => ({ answers })))("denies malformed or incomplete answers: %j", ({ answers }) => {
  const result = claudeQuestionHookOutput(input, answered(answers));
  expect(result.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(result.hookSpecificOutput).not.toHaveProperty("updatedInput");
});

it.each([undefined, { outcome: { outcome: "dismissed" } }, { outcome: { outcome: "declined" } }])("denies an absent or declined result: %j", response => {
  expect(claudeQuestionHookOutput(input, response as QuestionResponse | undefined))
    .toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
});

it("supports multi-select and Other without accepting unanswered questions", () => {
  expect(claudeQuestionHookOutput({ ...input, questions: [{ ...input.questions[0], multiSelect: true }] },
    answered([{ questionId: "q0", selectedOptionIds: ["o0", "o1"] }]))).toMatchObject({ hookSpecificOutput: {
      permissionDecision: "allow", updatedInput: { answers: { "Route?": "A, B" } } } });
  expect(claudeQuestionHookOutput(input, answered([{ questionId: "q0", selectedOptionIds: [], freeText: "C" }])))
    .toMatchObject({ hookSpecificOutput: { permissionDecision: "allow", updatedInput: { answers: { "Route?": "C" } } } });
  expect(claudeQuestionHookOutput({ questions: [] }, answered([]))).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
});

it("preserves literal question keys", () => {
  const question = { question: "__proto__", options: [{ label: "A" }] };
  const result = claudeQuestionHookOutput({ questions: [question] }, answered([{ questionId: "q0", selectedOptionIds: ["o0"] }]));
  expect(JSON.stringify(result)).toContain('"answers":{"__proto__":"A"}');
});

it("refuses ambiguous duplicate prompts", () => {
  expect(claudeQuestionHookOutput({ questions: [input.questions[0], input.questions[0]] }, answered([
    { questionId: "q0", selectedOptionIds: ["o0"] }, { questionId: "q1", selectedOptionIds: ["o1"] },
  ]))).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
});
