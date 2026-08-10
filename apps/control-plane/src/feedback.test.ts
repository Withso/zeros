import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import type { AuthedUser } from "./auth.js";
import { HttpError } from "./authz.js";
import type { FeedbackBackendConfig } from "./config.js";
import { createFeedbackRoutes } from "./feedback.js";

const sender: AuthedUser = {
  id: "00000000-0000-0000-0000-000000000001",
  providerSub: "auth0|000000000000000000000001",
  email: "real-sender@example.test",
  displayName: "Real Sender",
  avatarUrl: null,
  staffRole: null,
};

const config: FeedbackBackendConfig = {
  intercom: {
    token: "test-intercom-token-000000",
    region: "us",
    adminId: null,
    tagIds: {},
    appId: "test-app",
  },
  linear: {
    apiKey: "test-linear-api-key-000000",
    teamId: "00000000-0000-0000-0000-000000000002",
    labelIds: {},
  },
  posthogProjectUrl: "https://us.posthog.com/project/123",
};

interface FetchCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown> | string | null;
}

const calls: FetchCall[] = [];
let contactExists = false;
let intercomFails = false;
let linearIssueFails = false;
let uploadFails = false;
let unsafeUploadUrl = false;

function parseBody(init?: RequestInit): FetchCall["body"] {
  const raw = init?.body;
  if (typeof raw !== "string") return raw ? "[binary]" : null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw;
  }
}

beforeEach(() => {
  calls.length = 0;
  contactExists = false;
  intercomFails = false;
  linearIssueFails = false;
  uploadFails = false;
  unsafeUploadUrl = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const parsedUrl = new URL(url);
      calls.push({ url, init: init ?? {}, body: parseBody(init) });

      if (
        parsedUrl.origin === "https://api.intercom.io" ||
        parsedUrl.origin === "https://api.eu.intercom.io" ||
        parsedUrl.origin === "https://api.au.intercom.io"
      ) {
        if (intercomFails) {
          return new Response('{"error":"private-upstream-detail"}', {
            status: 500,
          });
        }
        if (parsedUrl.pathname.startsWith("/contacts/find_by_external_id/")) {
          return contactExists
            ? Response.json({ id: "contact-1" })
            : Response.json({ error: "not found" }, { status: 404 });
        }
        if (parsedUrl.pathname === "/contacts") {
          contactExists = true;
          return Response.json({ id: "contact-1" });
        }
        if (parsedUrl.pathname === "/conversations") {
          return Response.json({ id: "convo-9" });
        }
        return Response.json({ ok: true });
      }

      if (url === "https://api.linear.app/graphql") {
        const body = parseBody(init) as { query?: string };
        if (body.query?.includes("fileUpload")) {
          if (uploadFails) {
            return Response.json({ errors: [{ message: "no upload" }] });
          }
          const uploadUrl = unsafeUploadUrl
            ? "https://attacker.example/upload"
            : "https://uploads.linear.app/put-here";
          return Response.json({
            data: {
              fileUpload: {
                success: true,
                uploadFile: {
                  uploadUrl,
                  assetUrl: "https://uploads.linear.app/asset-42.jsonl",
                  headers: [{ key: "x-linear", value: "1" }],
                },
              },
            },
          });
        }
        if (body.query?.includes("issueCreate")) {
          if (linearIssueFails) {
            return Response.json({
              errors: [{ message: "private-linear-detail" }],
            });
          }
          return Response.json({
            data: {
              issueCreate: {
                success: true,
                issue: {
                  identifier: "ISSUE-1",
                  url: "https://linear.app/test/issue/ISSUE-1",
                },
              },
            },
          });
        }
      }

      if (url === "https://uploads.linear.app/put-here") {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unmocked fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function feedbackApp(
  feedbackConfig: FeedbackBackendConfig | null = config,
): Hono {
  const app = new Hono();
  app.use("/v1/*", async (c, next) => {
    c.set("user", sender);
    await next();
  });
  app.route("/", createFeedbackRoutes(feedbackConfig));
  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.status,
      );
    }
    return c.json({ error: { code: "internal" } }, 500);
  });
  return app;
}

async function post(
  body: Record<string, unknown>,
  feedbackConfig: FeedbackBackendConfig | null = config,
): Promise<Response> {
  return feedbackApp(feedbackConfig).request("/v1/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("feedback route", () => {
  it.each([
    "https://api.intercom.io.attacker.example/contacts",
    "https://attacker.example/api.intercom.io/contacts",
  ])("does not classify a lookalike host as Intercom: %s", async (url) => {
    await expect(fetch(url)).rejects.toThrow(`unmocked fetch: ${url}`);
  });

  it("returns a clear 503 when no destination is configured", async () => {
    const response = await post({ message: "hello" }, null);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "feedback_not_configured",
        message: "Feedback is not configured in this environment",
      },
    });
  });

  it("rejects identity fields instead of trusting or silently ignoring them", async () => {
    const response = await post({
      message: "hello",
      email: "victim@example.test",
      name: "Not The Sender",
    });
    expect(response.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it("creates an Intercom conversation and Linear issue with full logs attached", async () => {
    const logs = `${"old line\n".repeat(2_000)}NEWEST LINE`;
    const response = await post({
      type: "bug",
      message: "Diff view scrolls to top",
      app_version: "0.5.0",
      logs,
      posthog_distinct_id: "ph-abc",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      conversation: "convo-9",
      linear_issue: "ISSUE-1",
      type: "bug",
    });
    const contact = calls.find((call) => call.url.endsWith("/contacts"))!
      .body as Record<string, unknown>;
    expect(contact).toMatchObject({
      role: "user",
      external_id: sender.providerSub,
      email: sender.email,
      name: sender.displayName,
    });

    const conversation = calls.find((call) =>
      call.url.endsWith("/conversations"),
    )!.body as { body: string };
    const inlineLogs = /<pre>([\s\S]*)<\/pre>/.exec(conversation.body)?.[1];
    expect(conversation.body).toContain("[Bug or Issue]");
    expect(conversation.body).toContain("NEWEST LINE");
    expect(inlineLogs?.length).toBeLessThanOrEqual(6_000);

    const upload = calls.find((call) => call.url.endsWith("/put-here"));
    expect(upload?.init.method).toBe("PUT");
    const issueCall = calls.find((call) =>
      (call.body as { query?: string })?.query?.includes("issueCreate"),
    )!;
    const issueInput = (
      issueCall.body as {
        variables: { input: { title: string; description: string } };
      }
    ).variables.input;
    expect(issueInput.title).toContain(
      "[Bug or Issue] Diff view scrolls to top",
    );
    expect(issueInput.description).toContain("asset-42.jsonl");
    expect(issueInput.description).toContain(
      "**Email:** real-sender@example.test",
    );
    expect(issueInput.description).toContain(
      "https://us.posthog.com/project/123/persons?distinct_id=ph-abc",
    );
  });

  it("reuses an existing Intercom contact on later submissions", async () => {
    contactExists = true;
    const response = await post({ message: "hello again" });
    expect(response.status).toBe(200);
    expect(calls.filter((call) => call.url.endsWith("/contacts"))).toHaveLength(
      0,
    );
  });

  it("composes every upstream call with one total delivery deadline", async () => {
    const delivery = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((milliseconds) =>
        milliseconds === 40_000
          ? delivery.signal
          : new AbortController().signal,
      );

    const response = await post({ message: "keep the request bounded" });

    expect(response.status).toBe(200);
    expect(timeout).toHaveBeenCalledWith(40_000);
    const signals = calls
      .map((call) => call.init.signal)
      .filter((signal): signal is AbortSignal => signal instanceof AbortSignal);
    expect(signals.length).toBeGreaterThan(1);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    delivery.abort();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("still succeeds through Linear when Intercom is down", async () => {
    intercomFails = true;
    const response = await post({ message: "help", logs: "line" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      conversation: null,
      linear_issue: "ISSUE-1",
    });
  });

  it("falls back to an inline tail if a Linear upload fails", async () => {
    uploadFails = true;
    const response = await post({ message: "help", logs: "tail-me" });
    expect(response.status).toBe(200);
    const issueCall = calls.find((call) =>
      (call.body as { query?: string })?.query?.includes("issueCreate"),
    )!;
    const description = (
      issueCall.body as {
        variables: { input: { description: string } };
      }
    ).variables.input.description;
    expect(description).toContain("tail-me");
    expect(description).toContain("```");
  });

  it("does not PUT logs to an upload host outside Linear", async () => {
    unsafeUploadUrl = true;
    const response = await post({ message: "help", logs: "tail-me" });
    expect(response.status).toBe(200);
    expect(calls.some((call) => call.url.includes("attacker.example"))).toBe(
      false,
    );
  });

  it("returns a generic 502 only when every configured destination fails", async () => {
    intercomFails = true;
    linearIssueFails = true;
    const response = await post({ message: "help" });
    expect(response.status).toBe(502);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("feedback_delivery_failed");
    expect(body).not.toContain("private-upstream-detail");
    expect(body).not.toContain("private-linear-detail");
  });

  it("supports Intercom-only and Linear-only environments", async () => {
    const intercomOnly = await post(
      { message: "intercom" },
      { ...config, linear: null },
    );
    expect(intercomOnly.status).toBe(200);
    expect(await intercomOnly.json()).toMatchObject({
      conversation: "convo-9",
      linear_issue: null,
    });

    calls.length = 0;
    const linearOnly = await post(
      { message: "linear" },
      { ...config, intercom: null },
    );
    expect(linearOnly.status).toBe(200);
    expect(await linearOnly.json()).toMatchObject({
      conversation: null,
      linear_issue: "ISSUE-1",
    });
  });

  it.each([
    { type: "bug", label: "Bug or Issue" },
    { type: "feedback", label: "Feedback" },
    { type: "feature", label: "Feature Request" },
  ] as const)(
    "maps the canonical $label type to matching Intercom and Linear metadata",
    async ({ type, label }) => {
      const mappedConfig: FeedbackBackendConfig = {
        ...config,
        intercom: {
          ...config.intercom!,
          adminId: "admin-1",
          tagIds: { [type]: `intercom-${type}` },
        },
        linear: {
          ...config.linear!,
          labelIds: { [type]: `linear-${type}` },
        },
      };

      const response = await post(
        { type, message: `${type} message` },
        mappedConfig,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ type });

      const conversation = calls.find((call) =>
        call.url.endsWith("/conversations"),
      )!.body as { body: string };
      expect(conversation.body).toContain(`[${label}]`);

      const tag = calls.find((call) => call.url.endsWith("/tags"))!.body as {
        id: string;
        admin_id: string;
      };
      expect(tag).toEqual({
        id: `intercom-${type}`,
        admin_id: "admin-1",
      });

      const issueCall = calls.find((call) =>
        (call.body as { query?: string })?.query?.includes("issueCreate"),
      )!;
      const issueInput = (
        issueCall.body as {
          variables: { input: { title: string; labelIds: string[] } };
        }
      ).variables.input;
      expect(issueInput.title).toContain(`[${label}]`);
      expect(issueInput.labelIds).toEqual([`linear-${type}`]);
    },
  );

  it("accepts the released issue value but normalizes it to Bug or Issue", async () => {
    const compatibilityConfig: FeedbackBackendConfig = {
      ...config,
      intercom: {
        ...config.intercom!,
        adminId: "admin-1",
        tagIds: { bug: "intercom-bug" },
      },
      linear: {
        ...config.linear!,
        labelIds: { bug: "linear-bug" },
      },
    };

    const response = await post(
      { type: "issue", message: "legacy desktop report" },
      compatibilityConfig,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ type: "bug" });

    const conversation = calls.find((call) =>
      call.url.endsWith("/conversations"),
    )!.body as { body: string };
    expect(conversation.body).toContain("[Bug or Issue]");

    const tag = calls.find((call) => call.url.endsWith("/tags"))!.body as {
      id: string;
    };
    expect(tag.id).toBe("intercom-bug");

    const issueCall = calls.find((call) =>
      (call.body as { query?: string })?.query?.includes("issueCreate"),
    )!;
    const issueInput = (
      issueCall.body as {
        variables: { input: { title: string; labelIds: string[] } };
      }
    ).variables.input;
    expect(issueInput.title).toContain("[Bug or Issue]");
    expect(issueInput.labelIds).toEqual(["linear-bug"]);
  });

  it("rejects feedback types outside the three-type contract", async () => {
    const response = await post({
      type: "support-request",
      message: "not a supported type",
    });
    expect(response.status).toBe(422);
    expect(calls).toHaveLength(0);
  });
});
