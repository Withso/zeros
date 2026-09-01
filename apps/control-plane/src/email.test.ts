import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EmailDeliveryError,
  sendEmail,
  sendEmailStrict,
  type EmailConfig,
} from "./email.js";

const config: EmailConfig = {
  apiKey: "re_alpha_product_notifications",
  from: "Zeros <notifications@updates.zeros.build>",
};

afterEach(() => vi.restoreAllMocks());

describe("Resend delivery contract", () => {
  it("uses a deterministic idempotency key and the pinned Resend endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(String(_url)).toBe("https://api.resend.com/emails");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer re_alpha_product_notifications",
      );
      expect(new Headers(init?.headers).get("user-agent")).toBe(
        "zeros-control-plane/0.1",
      );
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(
        "zeros-security:notification-id",
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        from: "Zeros <notifications@updates.zeros.build>",
        to: ["person@example.com"],
        subject: "Subject",
        html: "<p>Body</p>",
      });
      return Response.json({ id: "4c1c8f10-39c6-4d85-a214-f94958d1779b" });
    });

    await expect(
      sendEmailStrict(config, "person@example.com", "Subject", "<p>Body</p>", {
        idempotencyKey: "zeros-security:notification-id",
        fetch: fetchMock as typeof fetch,
      }),
    ).resolves.toEqual({
      provider: "resend",
      messageId: "4c1c8f10-39c6-4d85-a214-f94958d1779b",
    });
  });

  it("classifies provider and configuration failures for durable retry", async () => {
    await expect(
      sendEmailStrict(
        { apiKey: null, from: null },
        "person@example.com",
        "Subject",
        "<p>Body</p>",
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<EmailDeliveryError>>({
        code: "email_not_configured",
        retryable: true,
      }),
    );

    const unavailable = vi.fn(async () => new Response("down", { status: 503 }));
    await expect(
      sendEmailStrict(config, "person@example.com", "Subject", "<p>Body</p>", {
        fetch: unavailable as typeof fetch,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<EmailDeliveryError>>({
        code: "resend_503",
        retryable: true,
      }),
    );

    const rejected = vi.fn(async () =>
      Response.json({ name: "validation_error" }, { status: 400 }),
    );
    await expect(
      sendEmailStrict(config, "person@example.com", "Subject", "<p>Body</p>", {
        fetch: rejected as typeof fetch,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<EmailDeliveryError>>({
        code: "resend_400_validation_error",
        retryable: false,
      }),
    );
  });

  it("retries only concurrent idempotency conflicts and rejects changed payloads", async () => {
    // Resend's raw HTTP error schema uses `name` for its documented error
    // classification (the SDK exposes the same property on ErrorResponse).
    const conflict = (name: string) =>
      vi.fn(async () => Response.json({ name }, { status: 409 }));

    await expect(
      sendEmailStrict(config, "person@example.com", "Subject", "<p>Body</p>", {
        idempotencyKey: "zeros-security:notification-id",
        fetch: conflict("concurrent_idempotent_requests") as typeof fetch,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<EmailDeliveryError>>({
        code: "resend_409_concurrent_idempotent_requests",
        retryable: true,
      }),
    );

    await expect(
      sendEmailStrict(config, "person@example.com", "Subject", "<p>Changed</p>", {
        idempotencyKey: "zeros-security:notification-id",
        fetch: conflict("invalid_idempotent_request") as typeof fetch,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<EmailDeliveryError>>({
        code: "resend_409_invalid_idempotent_request",
        retryable: false,
      }),
    );
  });

  it("retries a malformed success response under the same idempotency key", async () => {
    await expect(
      sendEmailStrict(config, "person@example.com", "Subject", "<p>Body</p>", {
        idempotencyKey: "zeros-security:notification-id",
        fetch: vi.fn(async () => Response.json({})) as typeof fetch,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<EmailDeliveryError>>({
        code: "resend_response_invalid",
        retryable: true,
      }),
    );
  });

  it("retains best-effort invitation behavior", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      sendEmail(config, "person@example.com", "Subject", "<p>Body</p>", {
        fetch: vi.fn(async () => new Response("down", { status: 503 })) as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });

  it("does not put a recipient address in the unconfigured fallback log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await sendEmail(
      { apiKey: null, from: null },
      "private-recipient@example.com",
      "Subject",
      "<p>Body</p>",
    );

    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).not.toContain(
      "private-recipient@example.com",
    );
  });
});
