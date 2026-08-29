import type {
  QuestionAnswer,
  QuestionRequest,
  QuestionResponse,
  QuestionSpec,
} from "../../types";

export const MCP_OPTIONAL_OMIT_ID = "__zeros_omit__";
export const MCP_EMPTY_ARRAY_ID = "__zeros_empty_array__";
/** Bound parked callbacks per provider session. This is both UI backpressure
 * and the MCP client's recommended elicitation rate-limit defense. */
export const MAX_PENDING_MCP_ELICITATIONS = 8;
const MCP_CONFIRM_ID = "__zeros_confirm__";
const MCP_UNSUPPORTED_ID = "__zeros_unsupported__";
const CODEX_MCP_APPROVAL_KIND_KEY = "codex_approval_kind";
const CODEX_MCP_APPROVAL_KIND_TOOL_CALL = "mcp_tool_call";
const CODEX_MCP_APPROVAL_KIND_TOOL_SUGGESTION = "tool_suggestion";
const CODEX_MCP_APPROVAL_PERSIST_KEY = "persist";
const CODEX_MCP_APPROVAL_PERSIST_SESSION = "session";
const CODEX_MCP_APPROVAL_PERSIST_ALWAYS = "always";
const CODEX_MCP_APPROVAL_ACCEPT_ONCE_ID = "accept";
const CODEX_MCP_APPROVAL_ACCEPT_SESSION_ID = "accept_session";
const CODEX_MCP_APPROVAL_ACCEPT_ALWAYS_ID = "accept_always";
const MAX_SAFE_PATTERN_CHARS = 256;
const MAX_PATTERN_INPUT_CHARS = 4_096;
const MAX_MCP_FORM_FIELDS = 64;
const MAX_MCP_ENUM_OPTIONS = 100;
const MAX_MCP_SCHEMA_CHARS = 256_000;
const MAX_MCP_URL_CHARS = 16_384;
const MAX_MCP_FIELD_KEY_CHARS = 256;
const MAX_MCP_COPY_CHARS = 4_096;
const MAX_MCP_LABEL_CHARS = 1_024;
const MAX_MCP_MODE_CHARS = 64;
const MAX_APPROVAL_PARAM_ROWS = 3;
const MAX_APPROVAL_PARAM_CHARS = 120;

export interface McpElicitationRequestLike {
  serverName?: string;
  message?: string;
  mode?: "form" | "openai/form" | "url" | string;
  requestedSchema?: unknown;
  url?: string;
  elicitationId?: string;
  title?: string;
  displayName?: string;
  description?: string;
  [key: string]: unknown;
}

export interface McpElicitationResponseLike {
  action: "accept" | "decline" | "cancel";
  content: Record<string, unknown> | null;
  _meta?: Record<string, unknown> | null;
}

export interface McpElicitationAnswer {
  response: McpElicitationResponseLike;
  /** URL to open only after the user explicitly chose Continue. */
  openUrl?: string;
}

/** Minimal durable/debug representation of a provider-authored elicitation.
 * The interactive request still contains the full URL/schema so the user can
 * make an informed choice, but OAuth query parameters and schema defaults do
 * not belong in the persisted tool transcript. */
export function mcpElicitationAuditInput(
  request: McpElicitationRequestLike,
): Record<string, unknown> {
  const serverName = boundedNonEmpty(request.serverName, MAX_MCP_LABEL_CHARS);
  const displayName = boundedNonEmpty(request.displayName, MAX_MCP_LABEL_CHARS);
  const message = boundedNonEmpty(request.message, MAX_MCP_COPY_CHARS);
  const title = boundedNonEmpty(request.title, MAX_MCP_COPY_CHARS);
  const description = boundedNonEmpty(request.description, MAX_MCP_COPY_CHARS);
  const common = {
    ...(serverName ? { serverName } : {}),
    ...(displayName ? { displayName } : {}),
    ...(message ? { message } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    mode: boundedNonEmpty(request.mode, MAX_MCP_MODE_CHARS) ?? "form",
  };
  if (request.mode === "url") {
    const url = safeWebUrlObject(request.url);
    return {
      ...common,
      ...(url ? { destination: url.origin } : { destination: "invalid URL" }),
    };
  }
  const schema = asRecord(request.requestedSchema);
  const properties = asRecord(schema?.properties);
  return {
    ...common,
    ...(properties
      ? {
          fields: Object.keys(properties)
            .slice(0, MAX_MCP_FORM_FIELDS)
            .map((field) => truncateText(field, MAX_MCP_FIELD_KEY_CHARS)),
        }
      : {}),
  };
}

interface BuildMcpQuestionOptions {
  sessionId: string;
  questionId: string;
  nativeRequestId: string;
  toolCallId: string;
  request: McpElicitationRequestLike;
  expiresAt?: number;
}

/** Translate the standard MCP form/URL elicitation shapes onto the one shared
 * blocking-question UI. The mapper is provider-neutral: both Claude's
 * onElicitation callback and Codex app-server carry the same MCP contract. */
export function buildMcpElicitationQuestion(
  options: BuildMcpQuestionOptions,
): QuestionRequest {
  const { request } = options;
  const questions =
    request.mode === "url"
      ? [buildUrlQuestion(request)]
      : buildFormQuestions(request);
  return {
    sessionId: options.sessionId as never,
    questionId: options.questionId,
    nativeRequestId: options.nativeRequestId,
    toolCallId: options.toolCallId,
    source: "native_rpc",
    blocking: true,
    allowDecline: true,
    ...(typeof options.expiresAt === "number"
      ? { expiresAt: options.expiresAt }
      : {}),
    questions,
  };
}

/** Reconstruct typed MCP content from canonical answers. Invalid/missing
 * required values fail closed as `cancel`; we never send a knowingly malformed
 * number, enum, URL, or formatted string to the server. */
export function answerMcpElicitation(
  request: McpElicitationRequestLike,
  response: QuestionResponse,
): McpElicitationAnswer {
  if (response.outcome.outcome === "declined") return declined();
  if (response.outcome.outcome === "dismissed") return cancelled();
  const answerIds = response.outcome.answers.map((answer) => answer.questionId);
  if (new Set(answerIds).size !== answerIds.length) return cancelled();
  const answers = new Map(
    response.outcome.answers.map((answer) => [answer.questionId, answer]),
  );

  if (request.mode === "url") {
    const selected = answers.get("url-action")?.selectedOptionIds ?? [];
    if (selected.length === 1 && selected[0] === "decline") return declined();
    const url = safeWebUrl(request.url);
    if (selected.length !== 1 || selected[0] !== "open" || !url) {
      return cancelled();
    }
    return {
      response: { action: "accept", content: null, _meta: null },
      openUrl: url,
    };
  }

  // Codex also uses an empty elicitation form for its app/plugin installation
  // workflow. A native client keeps that request parked while the browser
  // install completes, then verifies the installation before accepting. The
  // shared one-shot question card cannot truthfully complete that two-stage
  // flow, so it must cancel rather than claim the app was installed.
  if (codexToolSuggestionMeta(request)) return cancelled();

  // `openai/form` deliberately carries opaque JSON. Advertising support is
  // allowed only when the client has a safe fallback for shapes it cannot
  // validate. Never reinterpret an unsupported root/field as an empty object.
  if (!canRenderMcpForm(request)) return cancelled();

  const schema = asRecord(request.requestedSchema);
  const properties = asRecord(schema?.properties) ?? {};
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );

  if (Object.keys(properties).length === 0) {
    const selected = answers.get(MCP_CONFIRM_ID)?.selectedOptionIds ?? [];
    const approvalMeta = codexMcpToolApprovalMeta(request);
    if (approvalMeta) {
      if (selected.length !== 1) return cancelled();
      const selectedId = selected[0];
      if (selectedId === CODEX_MCP_APPROVAL_ACCEPT_ONCE_ID) {
        return {
          response: { action: "accept", content: null, _meta: null },
        };
      }
      if (
        selectedId === CODEX_MCP_APPROVAL_ACCEPT_SESSION_ID &&
        codexMcpApprovalSupports(
          approvalMeta,
          CODEX_MCP_APPROVAL_PERSIST_SESSION,
        )
      ) {
        return {
          response: {
            action: "accept",
            content: null,
            _meta: {
              [CODEX_MCP_APPROVAL_PERSIST_KEY]:
                CODEX_MCP_APPROVAL_PERSIST_SESSION,
            },
          },
        };
      }
      if (
        selectedId === CODEX_MCP_APPROVAL_ACCEPT_ALWAYS_ID &&
        codexMcpApprovalSupports(
          approvalMeta,
          CODEX_MCP_APPROVAL_PERSIST_ALWAYS,
        )
      ) {
        return {
          response: {
            action: "accept",
            content: null,
            _meta: {
              [CODEX_MCP_APPROVAL_PERSIST_KEY]:
                CODEX_MCP_APPROVAL_PERSIST_ALWAYS,
            },
          },
        };
      }
      return cancelled();
    }
    if (selected.length === 1 && selected[0] === "decline") return declined();
    if (selected.length !== 1 || selected[0] !== "accept") return cancelled();
    return {
      response: { action: "accept", content: {}, _meta: null },
    };
  }

  const contentEntries: Array<[string, unknown]> = [];
  for (const [key, rawSchema] of Object.entries(properties)) {
    const property = asRecord(rawSchema);
    if (!property) return cancelled();
    const answer = answers.get(key);
    const selected = answer?.selectedOptionIds ?? [];
    if (selected.includes(MCP_OPTIONAL_OMIT_ID)) {
      // Skip is an exclusive optional-field action. A forged/mixed response
      // (Skip + a value, or Skip on a required field) is ambiguous and must
      // never be reinterpreted silently.
      if (
        required.has(key) ||
        selected.length !== 1 ||
        Boolean(answer?.freeText)
      ) {
        return cancelled();
      }
      continue;
    }
    const value = readPropertyAnswer(property, answer);
    if (!value.ok) {
      const attempted =
        Boolean(answer) &&
        (selected.length > 0 || answer?.freeText !== undefined);
      if (required.has(key) || attempted) return cancelled();
      continue;
    }
    contentEntries.push([key, value.value]);
  }

  return {
    // Object.fromEntries uses CreateDataProperty, so a legitimate JSON field
    // named `__proto__` remains an own data property instead of mutating the
    // response object's prototype.
    response: {
      action: "accept",
      content: Object.fromEntries(contentEntries),
      _meta: null,
    },
  };
}

/** Discriminate an MCP wire response from a provider's own answer payload —
 * only the former carries the fail-closed `cancel` this module can produce. */
export function isMcpElicitationResponse(
  value: unknown,
): value is McpElicitationResponseLike {
  const action = asRecord(value)?.action;
  return action === "accept" || action === "decline" || action === "cancel";
}

/** The outcome that was actually DELIVERED to the MCP server. Every
 * fail-closed path above (unparseable number, unmet `format`/`pattern`, forged
 * option id, duplicate/mixed selections) turns a submit into `cancel`, so the
 * server receives nothing at all. Stamping the transcript from the user's
 * `answered` intent would record values that were never sent — and read as a
 * completed exchange — so the durable record follows the wire instead. */
export function deliveredQuestionOutcome(
  outcome: QuestionResponse["outcome"],
  delivered: McpElicitationResponseLike,
): QuestionResponse["outcome"] {
  if (outcome.outcome !== "answered" || delivered.action === "accept") {
    return outcome;
  }
  return delivered.action === "decline"
    ? { outcome: "declined" }
    : { outcome: "dismissed" };
}

function buildUrlQuestion(request: McpElicitationRequestLike): QuestionSpec {
  const parsedUrl = safeWebUrlObject(request.url);
  const url = parsedUrl?.toString() ?? null;
  const requester = boundedRequesterName(request);
  const copy =
    boundedNonEmpty(request.message, MAX_MCP_COPY_CHARS) ??
    boundedNonEmpty(request.title, MAX_MCP_COPY_CHARS) ??
    "Open the authorization link?";
  const warnings: string[] = [];
  if (parsedUrl?.hostname.toLowerCase().includes("xn--")) {
    warnings.push(
      "the domain contains Punycode/encoded characters; verify it carefully",
    );
  }
  if (parsedUrl?.protocol === "http:") {
    warnings.push("the destination uses unencrypted HTTP");
  }
  if (parsedUrl && (parsedUrl.username || parsedUrl.password)) {
    warnings.push("the URL contains an embedded username or credential");
  }
  const consentCopy =
    warnings.length > 0 ? `${copy}\n\nWarning: ${warnings.join("; ")}.` : copy;
  return {
    id: "url-action",
    prompt: requester
      ? `${requester} is requesting access.\n\n${consentCopy}`
      : consentCopy,
    header: requester,
    multiSelect: false,
    options: [
      ...(url && parsedUrl
        ? [
            {
              id: "open",
              // Put the actual host in the visually prominent label to make
              // subdomain/userinfo spoofing harder to miss; retain the full
              // URL below it as the mandatory pre-consent detail.
              label: `Open ${parsedUrl.hostname}`,
              // MCP requires the FULL URL to be visible before consent. Never
              // prefetch it or collapse it to only the hostname.
              description: url,
              // The renderer performs this trusted UI action after consent.
              // Keeping it off the engine means cloud workspaces open the
              // browser on the user's device, and code processes never receive
              // Apple Events / xdg-open authority.
              externalAction: { kind: "open-url" as const, url },
            },
          ]
        : []),
    ],
    allowOther: false,
  };
}

function buildFormQuestions(
  request: McpElicitationRequestLike,
): QuestionSpec[] {
  if (codexToolSuggestionMeta(request)) {
    const requester = boundedRequesterName(request);
    return [
      {
        id: MCP_UNSUPPORTED_ID,
        prompt:
          `${requester ?? "Codex"} requested an app installation flow that ` +
          "Zeros cannot complete safely in this question card. Cancel the request to continue.",
        header: requester,
        multiSelect: false,
        options: [{ id: "cancel", label: "Cancel request" }],
        allowOther: false,
      },
    ];
  }
  if (!canRenderMcpForm(request)) {
    const requester = boundedRequesterName(request);
    return [
      {
        id: MCP_UNSUPPORTED_ID,
        prompt:
          `${requester ?? "This MCP server"} requested a form with unsupported fields. ` +
          "Cancel the request to continue safely.",
        header: requester,
        multiSelect: false,
        options: [{ id: "cancel", label: "Cancel request" }],
        allowOther: false,
      },
    ];
  }
  const schema = asRecord(request.requestedSchema);
  const properties = asRecord(schema?.properties) ?? {};
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  const entries = Object.entries(properties);
  if (entries.length === 0) {
    const requester = boundedRequesterName(request);
    const copy =
      nonEmpty(request.message) ??
      nonEmpty(request.title) ??
      "Continue with this MCP request?";
    const approvalMeta = codexMcpToolApprovalMeta(request);
    if (approvalMeta) {
      const approvalRequester =
        nonEmpty(approvalMeta.connector_name) ?? requester;
      const details = codexMcpToolApprovalDetails(approvalMeta);
      const browserOriginApproval =
        nonEmpty(approvalMeta.tool_title) === "Access browser origin";
      const browserOrigin = browserOriginApproval
        ? codexMcpBrowserOrigin(approvalMeta)
        : null;
      return [
        {
          id: MCP_CONFIRM_ID,
          prompt: [
            approvalRequester
              ? `${approvalRequester} is requesting permission.`
              : undefined,
            copy,
            ...details,
          ]
            .filter((value): value is string => Boolean(value))
            .join("\n\n"),
          header: approvalRequester,
          presentation: "one_click_approval",
          approvalPrompt: copy,
          approvalKind: browserOriginApproval ? "browser_origin" : "tool",
          ...(browserOrigin ? { approvalTarget: browserOrigin } : {}),
          multiSelect: false,
          options: [
            { id: CODEX_MCP_APPROVAL_ACCEPT_ONCE_ID, label: "Allow" },
            ...(codexMcpApprovalSupports(
              approvalMeta,
              CODEX_MCP_APPROVAL_PERSIST_SESSION,
            )
              ? [
                  {
                    id: CODEX_MCP_APPROVAL_ACCEPT_SESSION_ID,
                    label: "Allow for this session",
                    description: "Remember this choice for this Codex session.",
                  },
                ]
              : []),
            ...(codexMcpApprovalSupports(
              approvalMeta,
              CODEX_MCP_APPROVAL_PERSIST_ALWAYS,
            )
              ? [
                  {
                    id: CODEX_MCP_APPROVAL_ACCEPT_ALWAYS_ID,
                    label: "Always allow",
                    description: "Remember this choice for future tool calls.",
                  },
                ]
              : []),
          ],
          allowOther: false,
        },
      ];
    }
    return [
      {
        id: MCP_CONFIRM_ID,
        prompt: requester
          ? `${requester} is requesting access.\n\n${copy}`
          : copy,
        header: requester,
        multiSelect: false,
        options: [{ id: "accept", label: "Continue" }],
        allowOther: false,
      },
    ];
  }

  return entries.map(([key, rawSchema], index) => {
    const property = asRecord(rawSchema) ?? {};
    const title = nonEmpty(property.title) ?? humanizeKey(key);
    const description = nonEmpty(property.description);
    const fieldCopy = description ? `${title}\n${description}` : title;
    const message = nonEmpty(request.message);
    const fieldPrompt =
      index === 0 && message && message !== fieldCopy
        ? `${message}\n\n${fieldCopy}`
        : fieldCopy;
    const requester = boundedRequesterName(request);
    const prompt = requester
      ? `${requester} is requesting information.\n\n${fieldPrompt}`
      : fieldPrompt;
    const optional = !required.has(key);
    const options = propertyOptions(property);
    if (property.type === "array" && (numeric(property.minItems) ?? 0) === 0) {
      options.push({ id: MCP_EMPTY_ARRAY_ID, label: "None", exclusive: true });
    }
    if (optional) {
      options.push({
        id: MCP_OPTIONAL_OMIT_ID,
        label: "Skip (optional)",
        exclusive: true,
      });
    }
    const type = property.type;
    const isArray = type === "array";
    const freeText =
      options.length === (optional ? 1 : 0) &&
      (type === "string" || type === "number" || type === "integer" || !type);
    const defaults = propertyDefaults(property);
    return {
      id: key,
      prompt,
      header: requester,
      multiSelect: isArray,
      options,
      allowOther: freeText,
      ...(freeText && type === "string" && allowsEmptyString(property)
        ? { allowEmptyFreeText: true }
        : {}),
      ...(freeText && type === "string" ? { preserveFreeText: true } : {}),
      ...defaults,
    };
  });
}

/** True only when the server EXPLICITLY declared a zero-length string valid
 * and an empty value would survive `readPropertyAnswer`. Treating the mere
 * absence of `minLength` as permission would mark every plain required text
 * box as already answered — Submit lights up before the user types, and a
 * blank that then fails `format`/`pattern` makes the mapper cancel the whole
 * request while the transcript still reads as an answer. */
function allowsEmptyString(property: Record<string, unknown>): boolean {
  return (
    numeric(property.minLength) === 0 &&
    readPropertyAnswer(property, {
      questionId: "",
      selectedOptionIds: [],
      freeText: "",
    }).ok
  );
}

/** Codex 0.146 routes MCP tool approvals through an otherwise ordinary empty
 * form. Its private-to-Codex metadata is a capability hint, not form content:
 * sticky choices must be returned in response `_meta.persist`. */
function codexMcpToolApprovalMeta(
  request: McpElicitationRequestLike,
): Record<string, unknown> | null {
  const meta = asRecord(request._meta);
  return meta?.[CODEX_MCP_APPROVAL_KIND_KEY] ===
    CODEX_MCP_APPROVAL_KIND_TOOL_CALL
    ? meta
    : null;
}

function codexToolSuggestionMeta(
  request: McpElicitationRequestLike,
): Record<string, unknown> | null {
  const meta = asRecord(request._meta);
  return meta?.[CODEX_MCP_APPROVAL_KIND_KEY] ===
    CODEX_MCP_APPROVAL_KIND_TOOL_SUGGESTION
    ? meta
    : null;
}

function codexMcpApprovalSupports(
  meta: Record<string, unknown>,
  mode: "session" | "always",
): boolean {
  const persist = meta[CODEX_MCP_APPROVAL_PERSIST_KEY];
  return (
    persist === mode ||
    (Array.isArray(persist) && persist.some((value) => value === mode))
  );
}

function codexMcpToolApprovalDetails(meta: Record<string, unknown>): string[] {
  const toolTitle = nonEmpty(meta.tool_title);
  const toolDescription = nonEmpty(meta.tool_description);
  const details = [
    ...(toolTitle ? [`Tool: ${toolTitle}`] : []),
    ...(toolDescription ? [toolDescription] : []),
  ];
  const displayParams = Array.isArray(meta.tool_params_display)
    ? meta.tool_params_display.flatMap((raw) => {
        const param = asRecord(raw);
        if (!param) return [];
        const name = nonEmpty(param.display_name) ?? nonEmpty(param.name);
        if (!name || !("value" in param)) return [];
        const value = displayApprovalParam(param.value);
        return value ? [`${name}: ${value}`] : [];
      })
    : [];
  const rawParams = asRecord(meta.tool_params);
  const fallbackParams = rawParams
    ? Object.entries(rawParams)
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([name, value]) => {
          const rendered = displayApprovalParam(value);
          return rendered ? [`${name}: ${rendered}`] : [];
        })
    : [];
  const params = (
    displayParams.length > 0 ? displayParams : fallbackParams
  ).slice(0, MAX_APPROVAL_PARAM_ROWS);
  return params.length > 0 ? [...details, params.join("\n")] : details;
}

function codexMcpBrowserOrigin(meta: Record<string, unknown>): string | null {
  const display = Array.isArray(meta.tool_params_display)
    ? meta.tool_params_display
    : [];
  for (const raw of display) {
    const param = asRecord(raw);
    if (!param) continue;
    const name = (nonEmpty(param.name) ?? nonEmpty(param.display_name))
      ?.trim()
      .toLowerCase();
    if (name !== "origin" || !("value" in param)) continue;
    const value = safeWebUrlObject(param.value);
    if (value) return value.origin;
  }
  const rawOrigin = asRecord(meta.tool_params)?.origin;
  return safeWebUrlObject(rawOrigin)?.origin ?? null;
}

function displayApprovalParam(value: unknown): string | null {
  let rendered: string;
  if (typeof value === "string") rendered = value;
  else if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    rendered = String(value);
  } else {
    try {
      rendered = JSON.stringify(value);
    } catch {
      return null;
    }
  }
  const normalized = rendered.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= MAX_APPROVAL_PARAM_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_APPROVAL_PARAM_CHARS - 1)}…`;
}

/** True when Zeros can both render and validate every field in a form. The
 * standard MCP primitive schema is covered; opaque OpenAI extensions outside
 * that subset use the explicit cancellation fallback above. */
export function canRenderMcpForm(request: McpElicitationRequestLike): boolean {
  if (
    request.mode !== undefined &&
    request.mode !== "form" &&
    request.mode !== "openai/form"
  ) {
    return false;
  }
  const schema = asRecord(request.requestedSchema);
  if (!schema || schema.type !== "object") return false;
  if (
    // `additionalProperties`/`title`/`description` are what zod- and
    // pydantic-derived schemas routinely emit alongside the MCP subset. None
    // of them can invalidate what we send: the answer is built only from the
    // declared `properties`, so no undeclared key is ever produced and the
    // other two are pure annotations. Rejecting them would degrade a
    // perfectly renderable form to the "unsupported → cancel" card. Every
    // key that DOES constrain a value stays unlisted and still fails closed.
    !hasOnlyKeys(schema, [
      "$schema",
      "type",
      "properties",
      "required",
      "additionalProperties",
      "title",
      "description",
    ]) ||
    !jsonSizeWithin(schema, MAX_MCP_SCHEMA_CHARS) ||
    (schema.$schema !== undefined &&
      !boundedString(schema.$schema, MAX_MCP_COPY_CHARS)) ||
    !requestCopyWithinLimits(request)
  ) {
    return false;
  }
  const properties = asRecord(schema.properties);
  if (!properties) return false;
  const entries = Object.entries(properties);
  if (
    entries.length > MAX_MCP_FORM_FIELDS ||
    entries.some(([key]) => !key || [...key].length > MAX_MCP_FIELD_KEY_CHARS)
  ) {
    return false;
  }
  const required = schema.required;
  if (
    required !== undefined &&
    (!Array.isArray(required) ||
      required.length > MAX_MCP_FORM_FIELDS ||
      new Set(required).size !== required.length ||
      required.some(
        (value) =>
          typeof value !== "string" || !Object.hasOwn(properties, value),
      ))
  ) {
    return false;
  }
  return entries.every(([, value]) => {
    const property = asRecord(value);
    if (!property || !validPropertyCopy(property)) return false;
    switch (property.type) {
      case "boolean":
        return (
          hasOnlyKeys(property, ["type", "title", "description", "default"]) &&
          (property.default === undefined ||
            typeof property.default === "boolean")
        );
      case "number":
      case "integer":
        return (
          hasOnlyKeys(property, [
            "type",
            "title",
            "description",
            "minimum",
            "maximum",
            "default",
          ]) &&
          validNumericBounds(property, "minimum", "maximum") &&
          validNumericDefault(property)
        );
      case "string": {
        const usesEnum = property.enum !== undefined;
        const usesTitledEnum = property.oneOf !== undefined;
        if (usesEnum && usesTitledEnum) return false;
        if (
          !hasOnlyKeys(
            property,
            usesEnum
              ? ["type", "title", "description", "enum", "enumNames", "default"]
              : usesTitledEnum
                ? ["type", "title", "description", "oneOf", "default"]
                : [
                    "type",
                    "title",
                    "description",
                    "minLength",
                    "maxLength",
                    "format",
                    "pattern",
                    "default",
                  ],
          )
        ) {
          return false;
        }
        if (
          property.format !== undefined &&
          !["email", "uri", "date", "date-time"].includes(
            String(property.format),
          )
        ) {
          return false;
        }
        if (!validCountBounds(property, "minLength", "maxLength")) {
          return false;
        }
        if (
          property.pattern !== undefined &&
          compileSafeMcpPattern(property.pattern) === null
        ) {
          return false;
        }
        return (
          validEnumShape(property, "oneOf") && validStringDefault(property)
        );
      }
      case "array": {
        if (
          !hasOnlyKeys(property, [
            "type",
            "title",
            "description",
            "minItems",
            "maxItems",
            "items",
            "default",
          ])
        ) {
          return false;
        }
        if (!validCountBounds(property, "minItems", "maxItems")) {
          return false;
        }
        const items = asRecord(property.items);
        if (
          !items ||
          (items.type !== undefined && items.type !== "string") ||
          !hasOnlyKeys(
            items,
            items.anyOf !== undefined ? ["anyOf"] : ["type", "enum"],
          )
        ) {
          return false;
        }
        return (
          validEnumShape(items, "anyOf", true) && validArrayDefault(property)
        );
      }
      default:
        return false;
    }
  });
}

function requestCopyWithinLimits(request: McpElicitationRequestLike): boolean {
  return (
    optionalBoundedString(request.serverName, MAX_MCP_LABEL_CHARS) &&
    optionalBoundedString(request.displayName, MAX_MCP_LABEL_CHARS) &&
    optionalBoundedString(request.message, MAX_MCP_COPY_CHARS) &&
    optionalBoundedString(request.title, MAX_MCP_COPY_CHARS) &&
    optionalBoundedString(request.description, MAX_MCP_COPY_CHARS)
  );
}

function validPropertyCopy(property: Record<string, unknown>): boolean {
  return (
    optionalBoundedString(property.title, MAX_MCP_LABEL_CHARS) &&
    optionalBoundedString(property.description, MAX_MCP_COPY_CHARS)
  );
}

function validNumericDefault(property: Record<string, unknown>): boolean {
  if (property.default === undefined) return true;
  const value = numeric(property.default);
  if (value == null) return false;
  if (property.type === "integer" && !Number.isSafeInteger(value)) return false;
  const minimum = numeric(property.minimum);
  const maximum = numeric(property.maximum);
  return !(
    (minimum != null && value < minimum) ||
    (maximum != null && value > maximum)
  );
}

function validStringDefault(property: Record<string, unknown>): boolean {
  if (property.default === undefined) return true;
  if (!boundedString(property.default, MAX_PATTERN_INPUT_CHARS)) return false;
  const value = property.default;
  const choices = enumValues(property);
  if (choices.length > 0) return choices.includes(value);
  const minimum = numeric(property.minLength);
  const maximum = numeric(property.maxLength);
  const length = [...value].length;
  return !(
    (minimum != null && length < minimum) ||
    (maximum != null && length > maximum) ||
    !validStringFormat(value, property.format) ||
    !validStringPattern(value, property.pattern)
  );
}

function validArrayDefault(property: Record<string, unknown>): boolean {
  if (property.default === undefined) return true;
  if (!Array.isArray(property.default)) return false;
  const items = asRecord(property.items);
  if (!items) return false;
  const values = enumValues(items);
  const selected = property.default;
  const minimum = numeric(property.minItems);
  const maximum = numeric(property.maxItems);
  return (
    selected.length <= MAX_MCP_ENUM_OPTIONS &&
    new Set(selected).size === selected.length &&
    selected.every(
      (value) => typeof value === "string" && values.includes(value),
    ) &&
    (minimum == null || selected.length >= minimum) &&
    (maximum == null || selected.length <= maximum)
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function jsonSizeWithin(value: unknown, maximum: number): boolean {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" && encoded.length <= maximum;
  } catch {
    return false;
  }
}

function optionalBoundedString(value: unknown, maximum: number): boolean {
  return value === undefined || boundedString(value, maximum);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && [...value].length <= maximum;
}

function validCountBounds(
  schema: Record<string, unknown>,
  minimumKey: string,
  maximumKey: string,
): boolean {
  const values = [schema[minimumKey], schema[maximumKey]];
  if (
    values.some(
      (value) =>
        value !== undefined &&
        (typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 0 ||
          !Number.isSafeInteger(value)),
    )
  ) {
    return false;
  }
  return validNumericBounds(schema, minimumKey, maximumKey);
}

function validNumericBounds(
  schema: Record<string, unknown>,
  minimumKey: string,
  maximumKey: string,
): boolean {
  const minimum = schema[minimumKey];
  const maximum = schema[maximumKey];
  if (minimum !== undefined && numeric(minimum) == null) return false;
  if (maximum !== undefined && numeric(maximum) == null) return false;
  return !(
    typeof minimum === "number" &&
    typeof maximum === "number" &&
    minimum > maximum
  );
}

function validEnumShape(
  schema: Record<string, unknown>,
  titledKey: "oneOf" | "anyOf",
  required = false,
): boolean {
  const titled = schema[titledKey];
  const plain = schema.enum;
  if (titled !== undefined && plain !== undefined) return false;
  if (titled !== undefined) {
    return (
      Array.isArray(titled) &&
      titled.length > 0 &&
      titled.length <= MAX_MCP_ENUM_OPTIONS &&
      titled.every((value) => {
        const option = asRecord(value);
        return (
          Boolean(option) &&
          hasOnlyKeys(option!, ["const", "title"]) &&
          boundedString(option!.const, MAX_MCP_LABEL_CHARS) &&
          boundedString(option!.title, MAX_MCP_LABEL_CHARS)
        );
      })
    );
  }
  if (plain !== undefined) {
    const names = schema.enumNames;
    return (
      Array.isArray(plain) &&
      plain.length > 0 &&
      plain.length <= MAX_MCP_ENUM_OPTIONS &&
      plain.every((value) => boundedString(value, MAX_MCP_LABEL_CHARS)) &&
      (names === undefined ||
        (Array.isArray(names) &&
          names.length === plain.length &&
          names.every((value) => boundedString(value, MAX_MCP_LABEL_CHARS))))
    );
  }
  return !required;
}

function propertyOptions(property: Record<string, unknown>): Array<{
  id: string;
  label: string;
  description?: string;
  exclusive?: boolean;
}> {
  if (property.type === "boolean") {
    return [
      { id: "boolean:true", label: "Yes" },
      { id: "boolean:false", label: "No" },
    ];
  }

  if (property.type === "array") {
    const items = asRecord(property.items);
    if (!items) return [];
    const titled = Array.isArray(items.anyOf) ? items.anyOf : null;
    if (titled) return enumOptions(titled);
    const values = Array.isArray(items.enum) ? items.enum : [];
    return values.map((value, index) => ({
      id: `value:${index}`,
      label: String(value),
    }));
  }

  const titled = Array.isArray(property.oneOf) ? property.oneOf : null;
  if (titled) return enumOptions(titled);
  const values = Array.isArray(property.enum) ? property.enum : [];
  const names = Array.isArray(property.enumNames) ? property.enumNames : [];
  return values.map((value, index) => {
    const label =
      typeof names[index] === "string" ? names[index] : String(value);
    return {
      id: `value:${index}`,
      label,
      ...(label !== String(value) ? { description: String(value) } : {}),
    };
  });
}

function propertyDefaults(
  property: Record<string, unknown>,
): Pick<QuestionSpec, "defaultOptionIds" | "defaultFreeText"> {
  if (!("default" in property)) return {};
  const value = property.default;
  if (property.type === "boolean") {
    return typeof value === "boolean"
      ? { defaultOptionIds: [`boolean:${String(value)}`] }
      : {};
  }

  const choices = enumValues(property);
  if (choices.length > 0) {
    const index = choices.findIndex((choice) => choice === value);
    return index >= 0 ? { defaultOptionIds: [`value:${index}`] } : {};
  }

  if (property.type === "array") {
    if (!Array.isArray(value)) return {};
    const items = asRecord(property.items);
    if (!items) return {};
    const values = enumValues(items);
    const indexes = value.map((entry) => values.indexOf(entry));
    const minimum = numeric(property.minItems);
    const maximum = numeric(property.maxItems);
    if (
      indexes.some((index) => index < 0) ||
      new Set(indexes).size !== indexes.length ||
      (minimum != null && indexes.length < minimum) ||
      (maximum != null && indexes.length > maximum)
    ) {
      return {};
    }
    return {
      defaultOptionIds:
        indexes.length === 0
          ? [MCP_EMPTY_ARRAY_ID]
          : indexes.map((index) => `value:${index}`),
    };
  }

  if (
    (property.type === "string" && typeof value === "string") ||
    ((property.type === "number" || property.type === "integer") &&
      typeof value === "number")
  ) {
    const freeText = String(value);
    const validated = readPropertyAnswer(property, {
      questionId: "default",
      selectedOptionIds: [],
      freeText,
    });
    if (validated.ok && validated.value === value) {
      return { defaultFreeText: freeText };
    }
  }
  return {};
}

function enumOptions(
  entries: unknown[],
): Array<{ id: string; label: string; description?: string }> {
  return entries.flatMap((entry, index) => {
    const option = asRecord(entry);
    if (!option || typeof option.const !== "string") return [];
    const label = nonEmpty(option.title) ?? option.const;
    return [
      {
        id: `value:${index}`,
        label,
        ...(label !== option.const ? { description: option.const } : {}),
      },
    ];
  });
}

function readPropertyAnswer(
  property: Record<string, unknown>,
  answer: QuestionAnswer | undefined,
): { ok: true; value: unknown } | { ok: false } {
  const selected = (answer?.selectedOptionIds ?? []).filter(
    (id) => id !== MCP_OPTIONAL_OMIT_ID,
  );
  if (property.type === "boolean") {
    if (selected.length !== 1) return { ok: false };
    if (selected.includes("boolean:true")) return { ok: true, value: true };
    if (selected.includes("boolean:false")) return { ok: true, value: false };
    return { ok: false };
  }

  if (property.type === "array") {
    const items = asRecord(property.items);
    if (!items) return { ok: false };
    const values = enumValues(items);
    const explicitlyEmpty = selected.includes(MCP_EMPTY_ARRAY_ID);
    if (
      (explicitlyEmpty && selected.length !== 1) ||
      new Set(selected).size !== selected.length
    ) {
      return { ok: false };
    }
    const picked = selected.flatMap((id) => {
      const index = optionIndex(id);
      return index == null || values[index] === undefined
        ? []
        : [values[index]];
    });
    if (!explicitlyEmpty && picked.length !== selected.length) {
      return { ok: false };
    }
    const minimum = numeric(property.minItems);
    const maximum = numeric(property.maxItems);
    if (minimum != null && picked.length < minimum) return { ok: false };
    if (maximum != null && picked.length > maximum) return { ok: false };
    return picked.length > 0 || explicitlyEmpty
      ? { ok: true, value: picked }
      : { ok: false };
  }

  const choices = enumValues(property);
  if (choices.length > 0) {
    if (selected.length !== 1) return { ok: false };
    const index = optionIndex(selected[0]);
    return index != null && choices[index] !== undefined
      ? { ok: true, value: choices[index] }
      : { ok: false };
  }

  const rawText = answer?.freeText;
  if (typeof rawText !== "string" || selected.length > 0) {
    return { ok: false };
  }
  if (property.type === "number" || property.type === "integer") {
    const text = rawText.trim();
    if (!text) return { ok: false };
    const value = Number(text);
    if (!Number.isFinite(value)) return { ok: false };
    if (property.type === "integer" && !Number.isSafeInteger(value)) {
      return { ok: false };
    }
    const minimum = numeric(property.minimum);
    const maximum = numeric(property.maximum);
    if (minimum != null && value < minimum) return { ok: false };
    if (maximum != null && value > maximum) return { ok: false };
    return { ok: true, value };
  }

  const text = rawText;
  const minimum = numeric(property.minLength);
  const maximum = numeric(property.maxLength);
  const textLength = [...text].length;
  if (minimum != null && textLength < minimum) return { ok: false };
  if (maximum != null && textLength > maximum) return { ok: false };
  if (!validStringFormat(text, property.format)) return { ok: false };
  if (!validStringPattern(text, property.pattern)) return { ok: false };
  return { ok: true, value: text };
}

function enumValues(property: Record<string, unknown>): string[] {
  const titled = Array.isArray(property.oneOf)
    ? property.oneOf
    : Array.isArray(property.anyOf)
      ? property.anyOf
      : null;
  if (titled) {
    return titled.flatMap((entry) => {
      const option = asRecord(entry);
      return typeof option?.const === "string" ? [option.const] : [];
    });
  }
  return Array.isArray(property.enum)
    ? property.enum.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
}

function optionIndex(id: string | undefined): number | null {
  if (!id?.startsWith("value:")) return null;
  const value = Number(id.slice("value:".length));
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function validStringFormat(value: string, format: unknown): boolean {
  switch (format) {
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case "uri":
      try {
        return Boolean(new URL(value).protocol);
      } catch {
        return false;
      }
    case "date":
      return validCalendarDate(value);
    case "date-time":
      return validDateTime(value);
    default:
      return true;
  }
}

function validStringPattern(value: string, pattern: unknown): boolean {
  if (pattern === undefined) return true;
  if ([...value].length > MAX_PATTERN_INPUT_CHARS) return false;
  const regex = compileSafeMcpPattern(pattern);
  return regex ? regex.test(value) : false;
}

/** Compile the common, linear-time JSON Schema pattern subset used by form
 * fields. Server-authored regular expressions execute in the engine process,
 * so reject lookarounds/backreferences and quantified groups rather than
 * accepting a ReDoS-shaped pattern such as `(a|aa)+$`. The deliberately
 * conservative subset supports literals, character classes, anchors, fixed
 * repetition, and at most one variable-width repetition. */
function compileSafeMcpPattern(pattern: unknown): RegExp | null {
  if (
    typeof pattern !== "string" ||
    [...pattern].length > MAX_SAFE_PATTERN_CHARS
  ) {
    return null;
  }
  let escaped = false;
  let inClass = false;
  let variableQuantifiers = 0;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (escaped) {
      if (/[1-9k]/.test(char)) return null;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (char === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    // Alternation and groups are where compact patterns most easily hide
    // overlapping exponential paths. The supported subset deliberately keeps
    // a flat concatenation of literals/classes/anchors.
    if (char === "(" || char === ")" || char === "|") return null;
    if (char === "{") {
      const close = pattern.indexOf("}", index + 1);
      if (close < 0) return null;
      const bounds = pattern.slice(index + 1, close);
      const match = /^(\d+)(?:,(\d*))?$/.exec(bounds);
      if (!match) return null;
      const minimum = Number(match[1]);
      const maximum =
        match[2] === undefined
          ? minimum
          : match[2] === ""
            ? null
            : Number(match[2]);
      if (
        !Number.isSafeInteger(minimum) ||
        minimum > MAX_PATTERN_INPUT_CHARS ||
        (maximum !== null &&
          (!Number.isSafeInteger(maximum) ||
            maximum < minimum ||
            maximum > MAX_PATTERN_INPUT_CHARS))
      ) {
        return null;
      }
      if (maximum === null || maximum !== minimum) variableQuantifiers++;
      index = close;
    } else if (char === "*" || char === "+" || char === "?") {
      variableQuantifiers++;
    }
    // With no grouping/alternation, at most one variable-width atom keeps
    // matching linear in the bounded input length. Fixed `{n}` repetitions
    // remain safe and cover common date/id patterns.
    if (variableQuantifiers > 1) return null;
  }
  if (escaped || inClass) return null;
  try {
    return new RegExp(pattern, "u");
  } catch {
    return null;
  }
}

function validDateTime(value: string): boolean {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match || !validCalendarDate(match[1])) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  const offsetHour = match[5] === undefined ? 0 : Number(match[5]);
  const offsetMinute = match[6] === undefined ? 0 : Number(match[6]);
  return (
    hour <= 23 &&
    minute <= 59 &&
    // RFC 3339 reserves 60 for an announced leap second.
    second <= 60 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function validCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function safeWebUrl(value: unknown): string | null {
  return safeWebUrlObject(value)?.toString() ?? null;
}

function safeWebUrlObject(value: unknown): URL | null {
  if (!boundedString(value, MAX_MCP_URL_CHARS)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedNonEmpty(value: unknown, maximum: number): string | undefined {
  const text = nonEmpty(value);
  return text ? truncateText(text, maximum) : undefined;
}

function truncateText(value: string, maximum: number): string {
  const characters = [...value];
  if (characters.length <= maximum) return value;
  return `${characters.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

function boundedRequesterName(
  request: McpElicitationRequestLike,
): string | undefined {
  return (
    boundedNonEmpty(request.displayName, MAX_MCP_LABEL_CHARS) ??
    boundedNonEmpty(request.serverName, MAX_MCP_LABEL_CHARS)
  );
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function humanizeKey(value: string): string {
  const result = value.replace(/[_-]+/g, " ").trim();
  return result ? result[0].toUpperCase() + result.slice(1) : "Value";
}

function cancelled(): McpElicitationAnswer {
  return { response: { action: "cancel", content: null, _meta: null } };
}

function declined(): McpElicitationAnswer {
  return { response: { action: "decline", content: null, _meta: null } };
}
