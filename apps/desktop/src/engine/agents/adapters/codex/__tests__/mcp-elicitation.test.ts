import { describe, expect, it, vi } from "vitest";

import type { QuestionResponse } from "../../../types";
import type { CodexUserInputRequest } from "../app-server";
import {
  mapCodexQuestionAnswer,
  mapCodexQuestionToCanonical,
} from "../app-server-adapter";
import {
  deliveredQuestionOutcome,
  mcpElicitationAuditInput,
} from "../../shared/mcp-elicitation";

function request(params: Record<string, unknown>): CodexUserInputRequest {
  return {
    questionId: "question-1",
    rpcRequestId: "rpc-9",
    method: "mcpServer/elicitation/request",
    params,
  };
}

function answered(
  answers: Array<{
    questionId: string;
    selectedOptionIds?: string[];
    freeText?: string;
  }>,
): QuestionResponse {
  return {
    outcome: {
      outcome: "answered",
      answers: answers.map((answer) => ({
        questionId: answer.questionId,
        selectedOptionIds: answer.selectedOptionIds ?? [],
        ...(answer.freeText !== undefined ? { freeText: answer.freeText } : {}),
      })),
    },
  };
}

describe("Codex MCP elicitation mapping", () => {
  it("maps every standard MCP primitive form shape into answerable questions", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const native = request({
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "deploy",
      mode: "form",
      message: "Configure the deployment",
      requestedSchema: {
        type: "object",
        properties: {
          email: {
            type: "string",
            title: "Notification email",
            description: "Where completion notices should be sent.",
            format: "email",
          },
          region: {
            type: "string",
            title: "Region",
            oneOf: [
              { const: "iad", title: "Virginia" },
              { const: "fra", title: "Frankfurt" },
            ],
          },
          features: {
            type: "array",
            title: "Features",
            items: { type: "string", enum: ["logs", "metrics"] },
          },
          replicas: {
            type: "integer",
            title: "Replicas",
            minimum: 1,
            maximum: 20,
          },
          public: { type: "boolean", title: "Public endpoint" },
        },
        required: ["email", "region", "replicas", "public"],
      },
      _meta: null,
    });

    const canonical = mapCodexQuestionToCanonical("session-1", native);

    expect(canonical).toMatchObject({
      sessionId: "session-1",
      questionId: "question-1",
      nativeRequestId: "rpc-9",
      toolCallId: "mcp-elicitation:rpc-9",
      source: "native_rpc",
      blocking: true,
      allowDecline: true,
      questions: [
        {
          id: "email",
          prompt: expect.stringContaining("Configure the deployment"),
          header: "deploy",
          multiSelect: false,
          options: [],
          allowOther: true,
        },
        {
          id: "region",
          multiSelect: false,
          options: [
            { id: "value:0", label: "Virginia", description: "iad" },
            { id: "value:1", label: "Frankfurt", description: "fra" },
          ],
          allowOther: false,
        },
        {
          id: "features",
          multiSelect: true,
          options: [
            { id: "value:0", label: "logs" },
            { id: "value:1", label: "metrics" },
            { id: "__zeros_empty_array__", label: "None" },
            {
              id: "__zeros_omit__",
              label: "Skip (optional)",
            },
          ],
          allowOther: false,
        },
        {
          id: "replicas",
          multiSelect: false,
          options: [],
          allowOther: true,
        },
        {
          id: "public",
          multiSelect: false,
          options: [
            { id: "boolean:true", label: "Yes" },
            { id: "boolean:false", label: "No" },
          ],
          allowOther: false,
        },
      ],
    });
    expect(canonical.expiresAt).toBeGreaterThan(1_000);

    vi.restoreAllMocks();
  });

  it("reconstructs typed MCP content and omits skipped optional fields", () => {
    const native = request({
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "deploy",
      mode: "form",
      message: "Configure the deployment",
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
          region: {
            type: "string",
            oneOf: [
              { const: "iad", title: "Virginia" },
              { const: "fra", title: "Frankfurt" },
            ],
          },
          features: {
            type: "array",
            items: { type: "string", enum: ["logs", "metrics"] },
          },
          replicas: { type: "integer", minimum: 1, maximum: 20 },
          public: { type: "boolean" },
        },
        required: ["email", "region", "replicas", "public"],
      },
      _meta: null,
    });
    const canonical = mapCodexQuestionToCanonical("session-1", native);

    expect(
      mapCodexQuestionAnswer(
        native,
        canonical,
        answered([
          { questionId: "email", freeText: "person@example.com" },
          { questionId: "region", selectedOptionIds: ["value:1"] },
          {
            questionId: "features",
            selectedOptionIds: ["__zeros_omit__"],
          },
          { questionId: "replicas", freeText: "3" },
          { questionId: "public", selectedOptionIds: ["boolean:false"] },
        ]),
      ),
    ).toEqual({
      response: {
        action: "accept",
        content: {
          email: "person@example.com",
          region: "fra",
          replicas: 3,
          public: false,
        },
        _meta: null,
      },
    });
  });

  it("preserves Codex MCP tool approval persistence choices in response metadata", () => {
    const native = request({
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "codex_apps",
      mode: "form",
      message: "Allow Calendar to create an event?",
      requestedSchema: { type: "object", properties: {} },
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        persist: ["session", "always"],
        connector_name: "Calendar",
        tool_title: "Create event",
        tool_description: "Creates an event in the selected calendar.",
        tool_params_display: [
          { name: "calendar_id", display_name: "Calendar", value: "Work" },
        ],
      },
    });
    const canonical = mapCodexQuestionToCanonical("session-1", native);

    expect(canonical.questions).toEqual([
      expect.objectContaining({
        id: "__zeros_confirm__",
        prompt: expect.stringMatching(
          /Calendar[\s\S]*Create event[\s\S]*Calendar: Work/,
        ),
        options: [
          { id: "accept", label: "Allow" },
          {
            id: "accept_session",
            label: "Allow for this session",
            description: "Remember this choice for this Codex session.",
          },
          {
            id: "accept_always",
            label: "Always allow",
            description: "Remember this choice for future tool calls.",
          },
        ],
      }),
    ]);
    expect(
      mapCodexQuestionAnswer(
        native,
        canonical,
        answered([
          {
            questionId: "__zeros_confirm__",
            selectedOptionIds: ["accept_session"],
          },
        ]),
      ),
    ).toEqual({
      response: {
        action: "accept",
        content: null,
        _meta: { persist: "session" },
      },
    });
    expect(
      mapCodexQuestionAnswer(
        native,
        canonical,
        answered([
          {
            questionId: "__zeros_confirm__",
            selectedOptionIds: ["accept_always", "forged-choice"],
          },
        ]),
      ),
    ).toEqual({
      response: { action: "cancel", content: null, _meta: null },
    });

    const rawParamsOnly = request({
      serverName: "docs",
      mode: "form",
      message: "Allow the docs search?",
      requestedSchema: { type: "object", properties: {} },
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        tool_params: { zeta: "last", alpha: "first" },
      },
    });
    expect(
      mapCodexQuestionToCanonical("session-1", rawParamsOnly).questions[0]
        .prompt,
    ).toMatch(/alpha: first[\s\S]*zeta: last/);
  });

  it("cancels instead of sending invalid typed content to the MCP server", () => {
    const native = request({
      threadId: "thread-1",
      turnId: null,
      serverName: "deploy",
      mode: "form",
      message: "Configure the deployment",
      requestedSchema: {
        type: "object",
        properties: {
          replicas: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["replicas"],
      },
      _meta: null,
    });
    const canonical = mapCodexQuestionToCanonical("session-1", native);

    expect(
      mapCodexQuestionAnswer(
        native,
        canonical,
        answered([{ questionId: "replicas", freeText: "three" }]),
      ),
    ).toEqual({
      response: { action: "cancel", content: null, _meta: null },
    });
  });

  it("preserves an explicit decline separately from dismiss/cancel", () => {
    const native = request({
      serverName: "deploy",
      mode: "form",
      message: "Configure the deployment",
      requestedSchema: {
        type: "object",
        properties: { region: { type: "string" } },
        required: ["region"],
      },
      _meta: null,
    });
    const canonical = mapCodexQuestionToCanonical("session-1", native);

    expect(
      mapCodexQuestionAnswer(native, canonical, {
        outcome: { outcome: "declined" },
      }),
    ).toEqual({
      response: { action: "decline", content: null, _meta: null },
    });
  });

  it("preserves an explicitly empty required multi-select", () => {
    const native = request({
      serverName: "deploy",
      mode: "form",
      message: "Choose features",
      requestedSchema: {
        type: "object",
        properties: {
          features: {
            type: "array",
            minItems: 0,
            items: { type: "string", enum: ["logs", "metrics"] },
          },
        },
        required: ["features"],
      },
      _meta: null,
    });
    const canonical = mapCodexQuestionToCanonical("session-1", native);

    expect(canonical.questions[0].options).toContainEqual({
      id: "__zeros_empty_array__",
      label: "None",
      exclusive: true,
    });
    expect(
      mapCodexQuestionAnswer(
        native,
        canonical,
        answered([
          {
            questionId: "features",
            selectedOptionIds: ["__zeros_empty_array__"],
          },
        ]),
      ),
    ).toEqual({
      response: {
        action: "accept",
        content: { features: [] },
        _meta: null,
      },
    });
    expect(
      mapCodexQuestionAnswer(
        native,
        canonical,
        answered([
          {
            questionId: "features",
            selectedOptionIds: ["__zeros_empty_array__", "value:0"],
          },
        ]),
      ),
    ).toEqual({
      response: { action: "cancel", content: null, _meta: null },
    });
  });

  it("fails closed on forged choices and invalid attempted optional values", () => {
    const native = request({
      serverName: "deploy",
      mode: "form",
      message: "Optional settings",
      requestedSchema: {
        type: "object",
        properties: {
          features: {
            type: "array",
            items: { type: "string", enum: ["logs", "metrics"] },
          },
          email: { type: "string", format: "email" },
        },
      },
    });
    const canonical = mapCodexQuestionToCanonical("session-1", native);

    expect(
      mapCodexQuestionAnswer(
        native,
        canonical,
        answered([
          {
            questionId: "features",
            selectedOptionIds: ["value:0", "forged-choice"],
          },
        ]),
      ),
    ).toEqual({
      response: { action: "cancel", content: null, _meta: null },
    });
    expect(
      mapCodexQuestionAnswer(
        native,
        canonical,
        answered([{ questionId: "email", freeText: "not-an-email" }]),
      ),
    ).toEqual({
      response: { action: "cancel", content: null, _meta: null },
    });
  });

  it("preserves meaningful string whitespace and allows schema-valid empty strings", () => {
    const native = request({
      serverName: "notes",
      mode: "form",
      message: "Add labels",
      requestedSchema: {
        type: "object",
        properties: {
          padded: { type: "string", default: "  keep me  " },
          empty: { type: "string", minLength: 0 },
        },
        required: ["padded", "empty"],
      },
    });
    const canonical = mapCodexQuestionToCanonical("session-1", native);

    expect(canonical.questions).toMatchObject([
      {
        id: "padded",
        defaultFreeText: "  keep me  ",
        preserveFreeText: true,
      },
      {
        id: "empty",
        allowEmptyFreeText: true,
        preserveFreeText: true,
      },
    ]);
    // Only the field that DECLARED minLength: 0 counts a blank box as filled.
    expect(canonical.questions[0].allowEmptyFreeText).toBeUndefined();
    expect(
      mapCodexQuestionAnswer(
        native,
        canonical,
        answered([
          { questionId: "padded", freeText: "  keep me  " },
          { questionId: "empty", freeText: "" },
        ]),
      ),
    ).toEqual({
      response: {
        action: "accept",
        content: { padded: "  keep me  ", empty: "" },
        _meta: null,
      },
    });
  });

  it("requires real input for text fields the schema never called optional", () => {
    const native = request({
      serverName: "support",
      mode: "form",
      message: "Open a ticket",
      requestedSchema: {
        type: "object",
        properties: {
          // No minLength at all — the common case. A blank box is NOT an answer.
          subject: { type: "string", title: "Subject" },
          // Declares minLength: 0, but "" can never satisfy the format, so
          // accepting a blank would only produce a silent cancel on submit.
          contact: { type: "string", format: "email", minLength: 0 },
          // Same, via pattern.
          ticket: { type: "string", pattern: "^T[0-9]{4}$", minLength: 0 },
        },
        required: ["subject", "contact", "ticket"],
      },
    });
    const canonical = mapCodexQuestionToCanonical("session-1", native);

    for (const question of canonical.questions) {
      expect(question.allowOther).toBe(true);
      expect(question.allowEmptyFreeText).toBeUndefined();
    }
  });

  it("renders forms carrying the annotation keys schema generators emit", () => {
    const native = request({
      serverName: "notes",
      mode: "form",
      message: "Add a note",
      requestedSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        title: "AddNote",
        description: "Arguments for add_note",
        // zod/pydantic emit this on every generated object schema. It cannot
        // affect the answer — only declared properties are ever sent.
        additionalProperties: false,
        properties: { body: { type: "string", title: "Body" } },
        required: ["body"],
      },
    });
    const canonical = mapCodexQuestionToCanonical("session-1", native);

    expect(canonical.questions.map((question) => question.id)).toEqual(["body"]);
    expect(
      mapCodexQuestionAnswer(
        native,
        canonical,
        answered([{ questionId: "body", freeText: "ship it" }]),
      ),
    ).toEqual({
      response: { action: "accept", content: { body: "ship it" }, _meta: null },
    });
  });

  it("receipts a fail-closed submit as skipped rather than answered", () => {
    const submitted = answered([{ questionId: "email", freeText: "nope" }])
      .outcome;

    // A submit the server never received must not be recorded as an exchange.
    expect(
      deliveredQuestionOutcome(submitted, {
        action: "cancel",
        content: null,
        _meta: null,
      }),
    ).toEqual({ outcome: "dismissed" });
    // An explicit refusal keeps its own meaning.
    expect(
      deliveredQuestionOutcome(submitted, {
        action: "decline",
        content: null,
        _meta: null,
      }),
    ).toEqual({ outcome: "declined" });
    // A delivered answer is untouched (identity, so the caller can compare).
    expect(
      deliveredQuestionOutcome(submitted, {
        action: "accept",
        content: {},
        _meta: null,
      }),
    ).toBe(submitted);
    // A dismissal was already honest.
    const dismissed = { outcome: "dismissed" } as const;
    expect(
      deliveredQuestionOutcome(dismissed, {
        action: "cancel",
        content: null,
        _meta: null,
      }),
    ).toBe(dismissed);
  });

  it("fails closed for unknown modes and impossible calendar dates", () => {
    const unknown = request({
      serverName: "custom",
      mode: "future-mode",
      message: "Unsupported",
      requestedSchema: {
        type: "object",
        properties: { value: { type: "string" } },
      },
      _meta: null,
    });
    const unknownCanonical = mapCodexQuestionToCanonical("session-1", unknown);
    expect(unknownCanonical.questions[0].id).toBe("__zeros_unsupported__");

    const dated = request({
      serverName: "calendar",
      mode: "form",
      message: "Choose a date",
      requestedSchema: {
        type: "object",
        properties: { day: { type: "string", format: "date" } },
        required: ["day"],
      },
      _meta: null,
    });
    const datedCanonical = mapCodexQuestionToCanonical("session-1", dated);
    expect(
      mapCodexQuestionAnswer(
        dated,
        datedCanonical,
        answered([{ questionId: "day", freeText: "2026-02-31" }]),
      ),
    ).toEqual({
      response: { action: "cancel", content: null, _meta: null },
    });

    const datedTime = request({
      serverName: "calendar",
      mode: "form",
      message: "Choose a timestamp",
      requestedSchema: {
        type: "object",
        properties: {
          at: { type: "string", format: "date-time" },
        },
        required: ["at"],
      },
    });
    const datedTimeCanonical = mapCodexQuestionToCanonical(
      "session-1",
      datedTime,
    );
    expect(
      mapCodexQuestionAnswer(
        datedTime,
        datedTimeCanonical,
        answered([{ questionId: "at", freeText: "2026-02-31T12:00:00Z" }]),
      ),
    ).toEqual({
      response: { action: "cancel", content: null, _meta: null },
    });
  });

  it("pre-populates valid MCP defaults for every primitive form control", () => {
    const native = request({
      serverName: "defaults",
      mode: "form",
      message: "Review these defaults",
      requestedSchema: {
        type: "object",
        properties: {
          email: {
            type: "string",
            format: "email",
            default: "person@example.com",
          },
          replicas: {
            type: "integer",
            minimum: 1,
            default: 3,
          },
          public: { type: "boolean", default: false },
          region: {
            type: "string",
            enum: ["iad", "fra"],
            default: "fra",
          },
          features: {
            type: "array",
            items: { type: "string", enum: ["logs", "metrics"] },
            default: ["metrics"],
          },
        },
        required: ["email", "replicas", "public", "region", "features"],
      },
    });

    const canonical = mapCodexQuestionToCanonical("session-1", native);

    expect(canonical.questions).toMatchObject([
      { id: "email", defaultFreeText: "person@example.com" },
      { id: "replicas", defaultFreeText: "3" },
      { id: "public", defaultOptionIds: ["boolean:false"] },
      { id: "region", defaultOptionIds: ["value:1"] },
      { id: "features", defaultOptionIds: ["value:1"] },
    ]);
  });

  it("validates safe JSON Schema patterns and rejects unsafe regex forms", () => {
    const patterned = request({
      serverName: "profiles",
      mode: "form",
      message: "Choose a handle",
      requestedSchema: {
        type: "object",
        properties: {
          handle: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]+$" },
        },
        required: ["handle"],
      },
    });
    const canonical = mapCodexQuestionToCanonical("session-1", patterned);
    expect(canonical.questions[0].id).toBe("handle");
    expect(
      mapCodexQuestionAnswer(
        patterned,
        canonical,
        answered([{ questionId: "handle", freeText: "valid-handle" }]),
      ),
    ).toMatchObject({ response: { action: "accept" } });
    expect(
      mapCodexQuestionAnswer(
        patterned,
        canonical,
        answered([{ questionId: "handle", freeText: "not valid!" }]),
      ),
    ).toEqual({
      response: { action: "cancel", content: null, _meta: null },
    });

    const unsafe = request({
      serverName: "profiles",
      mode: "form",
      message: "Unsafe regex",
      requestedSchema: {
        type: "object",
        properties: {
          handle: { type: "string", pattern: "^(a|aa)+$" },
        },
        required: ["handle"],
      },
    });
    expect(
      mapCodexQuestionToCanonical("session-1", unsafe).questions[0].id,
    ).toBe("__zeros_unsupported__");

    const ambiguousRepetition = request({
      serverName: "profiles",
      mode: "form",
      message: "Ambiguous regex",
      requestedSchema: {
        type: "object",
        properties: {
          handle: { type: "string", pattern: "^a*a*a*a*b$" },
        },
        required: ["handle"],
      },
    });
    expect(
      mapCodexQuestionToCanonical("session-1", ambiguousRepetition).questions[0]
        .id,
    ).toBe("__zeros_unsupported__");
  });

  it("maps URL confirmation without opening it before explicit acceptance", () => {
    const native = request({
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "github",
      mode: "url",
      message: "Authorize the GitHub MCP server",
      url: "https://github.com/login/oauth/authorize?client_id=123",
      elicitationId: "oauth-1",
      _meta: null,
    });
    const canonical = mapCodexQuestionToCanonical("session-1", native);

    expect(canonical).toMatchObject({
      nativeRequestId: "oauth-1",
      toolCallId: "mcp-elicitation:oauth-1",
      questions: [
        {
          id: "url-action",
          prompt: expect.stringMatching(/github[\s\S]*authorize/i),
          options: [
            {
              id: "open",
              label: "Open github.com",
              description:
                "https://github.com/login/oauth/authorize?client_id=123",
            },
          ],
        },
      ],
    });
    expect(
      mapCodexQuestionAnswer(
        native,
        canonical,
        answered([{ questionId: "url-action", selectedOptionIds: ["open"] }]),
      ),
    ).toEqual({
      response: { action: "accept", content: null, _meta: null },
      openUrl: "https://github.com/login/oauth/authorize?client_id=123",
    });
    expect(
      mapCodexQuestionAnswer(
        native,
        canonical,
        answered([
          {
            questionId: "url-action",
            selectedOptionIds: ["open", "forged-choice"],
          },
        ]),
      ),
    ).toEqual({
      response: { action: "cancel", content: null, _meta: null },
    });
  });

  it("highlights the URL host and warns before a suspicious navigation", () => {
    const native = request({
      serverName: "accounts",
      mode: "url",
      message: "Continue to sign in",
      url: "http://user@xn--pple-43d.com/authorize",
      elicitationId: "oauth-suspicious",
    });

    const canonical = mapCodexQuestionToCanonical("session-1", native);

    expect(canonical.questions[0]).toMatchObject({
      prompt: expect.stringMatching(/warning[\s\S]*(punycode|encoded)/i),
      options: [
        {
          id: "open",
          label: "Open xn--pple-43d.com",
          description: "http://user@xn--pple-43d.com/authorize",
        },
      ],
    });
    expect(canonical.questions[0].prompt).toMatch(/unencrypted HTTP/i);
    expect(canonical.questions[0].prompt).toMatch(/embedded username/i);
  });

  it("keeps OAuth query secrets and form defaults out of durable tool audit input", () => {
    const urlAudit = mcpElicitationAuditInput({
      serverName: "github",
      mode: "url",
      message: "Sign in",
      url: "https://github.com/login/oauth?state=secret-state&code=secret-code",
    });
    expect(urlAudit).toMatchObject({
      serverName: "github",
      mode: "url",
      destination: "https://github.com",
    });
    expect(JSON.stringify(urlAudit)).not.toMatch(/secret-state|secret-code/);

    const formAudit = mcpElicitationAuditInput({
      serverName: "profile",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: {
          token: { type: "string", default: "secret-default" },
        },
      },
    });
    expect(formAudit).toMatchObject({ fields: ["token"] });
    expect(JSON.stringify(formAudit)).not.toContain("secret-default");
  });

  it("renders a safe cancellation fallback for unsupported extended forms", () => {
    const native = request({
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "custom",
      mode: "openai/form",
      message: "Fill the custom form",
      // openai/form is opaque JSON. A non-object root is outside the subset
      // Zeros can faithfully validate and must never be accepted as `{}`.
      requestedSchema: { type: "array", items: { type: "string" } },
      _meta: null,
    });
    const canonical = mapCodexQuestionToCanonical("session-1", native);

    expect(canonical.questions).toEqual([
      {
        id: "__zeros_unsupported__",
        prompt: expect.stringMatching(/unsupported/i),
        header: "custom",
        multiSelect: false,
        options: [{ id: "cancel", label: "Cancel request" }],
        allowOther: false,
      },
    ]);
    expect(
      mapCodexQuestionAnswer(
        native,
        canonical,
        answered([
          {
            questionId: "__zeros_unsupported__",
            selectedOptionIds: ["cancel"],
          },
        ]),
      ),
    ).toEqual({
      response: { action: "cancel", content: null, _meta: null },
    });
  });

  it("fails closed on unimplemented constraints and oversized provider-authored forms", () => {
    const unsupportedConstraint = request({
      serverName: "custom",
      mode: "openai/form",
      message: "Choose an even number",
      requestedSchema: {
        type: "object",
        properties: {
          count: { type: "integer", multipleOf: 2 },
        },
        required: ["count"],
      },
    });
    expect(
      mapCodexQuestionToCanonical("session-1", unsupportedConstraint)
        .questions[0].id,
    ).toBe("__zeros_unsupported__");

    const tooManyFields = request({
      serverName: "custom",
      mode: "form",
      message: "Oversized form",
      requestedSchema: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [
            `field_${index}`,
            { type: "boolean" },
          ]),
        ),
      },
    });
    expect(
      mapCodexQuestionToCanonical("session-1", tooManyFields).questions[0].id,
    ).toBe("__zeros_unsupported__");

    const tooManyOptions = request({
      serverName: "custom",
      mode: "form",
      message: "Oversized choice list",
      requestedSchema: {
        type: "object",
        properties: {
          choice: {
            type: "string",
            enum: Array.from({ length: 101 }, (_, index) => `choice-${index}`),
          },
        },
      },
    });
    expect(
      mapCodexQuestionToCanonical("session-1", tooManyOptions).questions[0].id,
    ).toBe("__zeros_unsupported__");
  });

  it("does not lose required prototype-named fields or accept duplicate answers", () => {
    const properties = Object.fromEntries([
      ["__proto__", { type: "string" }],
      ["constructor", { type: "boolean" }],
    ]);
    const native = request({
      serverName: "custom",
      mode: "form",
      message: "Prototype-shaped keys",
      requestedSchema: {
        type: "object",
        properties,
        required: ["__proto__", "constructor"],
      },
    });
    const canonical = mapCodexQuestionToCanonical("session-1", native);
    expect(canonical.questions.map((question) => question.id)).toEqual([
      "__proto__",
      "constructor",
    ]);

    const mapped = mapCodexQuestionAnswer(
      native,
      canonical,
      answered([
        { questionId: "__proto__", freeText: "safe" },
        {
          questionId: "constructor",
          selectedOptionIds: ["boolean:true"],
        },
      ]),
    );
    expect(mapped).toMatchObject({
      response: {
        action: "accept",
        content: { __proto__: "safe", constructor: true },
      },
    });
    expect(
      Object.prototype.hasOwnProperty.call(
        (mapped as { response: { content: Record<string, unknown> } }).response
          .content,
        "__proto__",
      ),
    ).toBe(true);

    expect(
      mapCodexQuestionAnswer(
        native,
        canonical,
        answered([
          { questionId: "__proto__", freeText: "first" },
          { questionId: "__proto__", freeText: "forged replacement" },
          {
            questionId: "constructor",
            selectedOptionIds: ["boolean:true"],
          },
        ]),
      ),
    ).toEqual({
      response: { action: "cancel", content: null, _meta: null },
    });
  });

  it("rejects oversized URLs and bounds provider copy in audit records", () => {
    const longText = "x".repeat(20_000);
    const native = request({
      serverName: "accounts",
      mode: "url",
      message: "Continue to sign in",
      url: `https://example.com/authorize?state=${longText}`,
      elicitationId: "oauth-oversized",
    });
    const canonical = mapCodexQuestionToCanonical("session-1", native);
    expect(canonical.questions[0].options).toEqual([]);
    expect(
      mapCodexQuestionAnswer(
        native,
        canonical,
        answered([{ questionId: "url-action", selectedOptionIds: ["open"] }]),
      ),
    ).toEqual({
      response: { action: "cancel", content: null, _meta: null },
    });

    const audit = mcpElicitationAuditInput({
      serverName: longText,
      displayName: longText,
      mode: "form",
      message: longText,
      title: longText,
      description: longText,
      requestedSchema: { type: "object", properties: {} },
    });
    expect(JSON.stringify(audit).length).toBeLessThan(25_000);
  });

  it("does not falsely accept Codex's separate app-installation workflow", () => {
    const native = request({
      serverName: "codex_apps",
      mode: "form",
      message: "Install Calendar to continue",
      requestedSchema: { type: "object", properties: {} },
      _meta: {
        codex_approval_kind: "tool_suggestion",
        persist: "always",
        tool_type: "connector",
        suggest_type: "install",
        tool_id: "calendar",
        tool_name: "Calendar",
        install_url: "https://example.com/install/calendar",
      },
    });
    const canonical = mapCodexQuestionToCanonical("session-1", native);

    expect(canonical.questions).toEqual([
      expect.objectContaining({
        id: "__zeros_unsupported__",
        prompt: expect.stringMatching(/installation flow[\s\S]*cancel/i),
      }),
    ]);
    expect(
      mapCodexQuestionAnswer(
        native,
        canonical,
        answered([
          {
            questionId: "__zeros_unsupported__",
            selectedOptionIds: ["cancel"],
          },
        ]),
      ),
    ).toEqual({
      response: { action: "cancel", content: null, _meta: null },
    });
  });
});
