import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EmailDeliveryError,
  sendEmail,
  sendEmailStrict,
  type EmailConfig,
} from "./email.js";

const config: EmailConfig = {
  token: "send-mail-token",
  from: { address: "hello@zeros.build", name: "Zeros" },
};

afterEach(() => vi.restoreAllMocks());

describe("ZeptoMail delivery contract", () => {
  it("uses a deterministic client reference and disables security-email tracking", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Zoho-enczapikey send-mail-token",
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        client_reference: "zeros-security:notification-id",
        track_clicks: false,
        track_opens: false,
      });
      return Response.json({ message: "success" });
    });

    await expect(
      sendEmailStrict(config, "person@example.com", "Subject", "<p>Body</p>", {
        clientReference: "zeros-security:notification-id",
        fetch: fetchMock as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });

  it("classifies provider and configuration failures for durable retry", async () => {
    await expect(
      sendEmailStrict(
        { token: null, from: null },
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
        code: "zeptomail_503",
        retryable: true,
      }),
    );

    const rejected = vi.fn(async () => new Response("bad", { status: 400 }));
    await expect(
      sendEmailStrict(config, "person@example.com", "Subject", "<p>Body</p>", {
        fetch: rejected as typeof fetch,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<EmailDeliveryError>>({
        code: "zeptomail_400",
        retryable: false,
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
});
