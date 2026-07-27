// Feedback bridge Worker — Intercom + Linear fan-out.
//
// Mocks global fetch and routes by URL: Intercom REST, Linear GraphQL, and
// the Linear asset-upload PUT. Locks the contract the app depends on:
//   • happy path creates an Intercom conversation AND a Linear issue, with
//     the FULL logs attached to Linear and only a readable tail inline in
//     Intercom
//   • Intercom and Linear are independent (one failing doesn't lose the other)
//   • both failing → 502
//
// AUTH is exercised for real: the suite mints RS256 tokens with a throwaway
// keypair and serves the matching JWKS off the mocked fetch, so signature,
// issuer, audience, expiry and the email_verified rule all run the production
// code path rather than a stub. The impersonation regression ("body.email is
// ignored") is the reason this file exists in its current shape.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import worker from "../worker";

const AUTH0_DOMAIN = "tenant.example.com";
const AUTH_AUDIENCE = "https://api.example.test";
const ISSUER = `https://${AUTH0_DOMAIN}/`;
const JWKS_URL = `https://${AUTH0_DOMAIN}/.well-known/jwks.json`;
const CLAIM_NS = "https://zeros.build/";

const SENDER_SUB = "auth0|000000000000000000000001";
const SENDER_EMAIL = "real-sender@example.test";

let privateKey: CryptoKey;
let publicJwk: JWK;
/** A second keypair that the JWKS does NOT publish — for the forged-token case. */
let attackerKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), alg: "RS256", kid: "test-key-1" };
  attackerKey = (await generateKeyPair("RS256", { extractable: true })).privateKey;
});

/** Mint an access token. Defaults are the valid case; override to break one
 *  thing at a time. */
async function mintToken(
  over: {
    sub?: string;
    email?: string | null;
    emailVerified?: boolean | null;
    name?: string;
    aud?: string;
    iss?: string;
    expiresIn?: string;
    key?: CryptoKey;
  } = {},
): Promise<string> {
  const claims: Record<string, unknown> = { [CLAIM_NS + "name"]: over.name ?? "Real Sender" };
  if (over.email !== null) claims[CLAIM_NS + "email"] = over.email ?? SENDER_EMAIL;
  if (over.emailVerified !== null) {
    claims[CLAIM_NS + "email_verified"] = over.emailVerified ?? true;
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setSubject(over.sub ?? SENDER_SUB)
    .setIssuer(over.iss ?? ISSUER)
    .setAudience(over.aud ?? AUTH_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(over.expiresIn ?? "5m")
    .sign(over.key ?? privateKey);
}

interface FetchCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown> | string | null;
}

const calls: FetchCall[] = [];
let intercomFails = false;
let linearIssueFails = false;
let uploadFails = false;

function parseBody(init?: RequestInit): FetchCall["body"] {
  const raw = init?.body;
  if (typeof raw !== "string") {
    return raw ? "[binary]" : null;
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw;
  }
}

beforeEach(() => {
  calls.length = 0;
  intercomFails = false;
  linearIssueFails = false;
  uploadFails = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {}, body: parseBody(init) });

      // The tenant's JWKS — served so jwtVerify resolves the signing key by kid
      // exactly as it would in production.
      if (url.startsWith(JWKS_URL)) {
        return Response.json({ keys: [publicJwk] });
      }

      if (url.includes("api.intercom.io")) {
        if (intercomFails) {
          return new Response(JSON.stringify({ errors: ["down"] }), { status: 500 });
        }
        if (url.endsWith("/contacts")) {
          return Response.json({ id: "contact-1" });
        }
        if (url.endsWith("/conversations")) {
          return Response.json({ id: "convo-9" });
        }
        return Response.json({ ok: true });
      }

      if (url.includes("api.linear.app")) {
        const body = parseBody(init) as { query?: string };
        if (body.query?.includes("fileUpload")) {
          if (uploadFails) {
            return Response.json({ errors: [{ message: "no upload" }] });
          }
          return Response.json({
            data: {
              fileUpload: {
                success: true,
                uploadFile: {
                  uploadUrl: "https://uploads.linear.app/put-here",
                  assetUrl: "https://uploads.linear.app/asset-42.jsonl",
                  headers: [{ key: "x-linear", value: "1" }],
                },
              },
            },
          });
        }
        if (body.query?.includes("issueCreate")) {
          if (linearIssueFails) {
            return Response.json({ errors: [{ message: "team not found" }] });
          }
          return Response.json({
            data: {
              issueCreate: {
                success: true,
                issue: { identifier: "ISSUE-1", url: "https://tracker.example/i/ISSUE-1" },
              },
            },
          });
        }
        return Response.json({ data: {} });
      }

      if (url.includes("uploads.linear.app/put-here")) {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unmocked fetch: ${url}`);
    }),
  );
});

// Obviously-fake placeholders: these must never resemble a real credential, or
// secret scanners will flag the file on every push.
const ENV = {
  AUTH0_DOMAIN,
  AUTH_AUDIENCE,
  INTERCOM_TOKEN: "test-intercom-token-000000",
  LINEAR_API_KEY: "test-linear-api-key-000000",
  LINEAR_TEAM_ID: "00000000-0000-0000-0000-000000000000",
};

/** A request carrying a valid token unless `token` overrides it. */
async function post(
  payload: Record<string, unknown>,
  token?: string | null,
): Promise<Request> {
  const bearer = token === undefined ? await mintToken() : token;
  return new Request("https://feedback.example", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(payload),
  });
}

describe("feedback worker — auth", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await worker.fetch(await post({ message: "hi" }, null), ENV);
    expect(res.status).toBe(401);
  });

  it("rejects a token signed by a key the JWKS does not publish", async () => {
    const forged = await mintToken({ key: attackerKey });
    const res = await worker.fetch(await post({ message: "hi" }, forged), ENV);
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const stale = await mintToken({ expiresIn: "-1m" });
    const res = await worker.fetch(await post({ message: "hi" }, stale), ENV);
    expect(res.status).toBe(401);
  });

  it("rejects a token minted for a different audience or issuer", async () => {
    for (const bad of [
      await mintToken({ aud: "https://someone-elses-api.test" }),
      await mintToken({ iss: "https://evil.example/" }),
    ]) {
      const res = await worker.fetch(await post({ message: "hi" }, bad), ENV);
      expect(res.status).toBe(401);
    }
  });

  it("rejects an unverified email, and fails CLOSED when the claim is absent", async () => {
    // An unverified address must never reach Intercom as a contact — it would
    // be an address the sender does not demonstrably control.
    const unverified = await mintToken({ emailVerified: false });
    expect((await worker.fetch(await post({ message: "hi" }, unverified), ENV)).status).toBe(401);
    // ABSENT is rejected too: a missing claim means a misconfigured connection,
    // not a trustworthy token.
    const absent = await mintToken({ emailVerified: null });
    expect((await worker.fetch(await post({ message: "hi" }, absent), ENV)).status).toBe(401);
  });

  it("rejects a token with no email claim at all", async () => {
    const noEmail = await mintToken({ email: null });
    const res = await worker.fetch(await post({ message: "hi" }, noEmail), ENV);
    expect(res.status).toBe(401);
  });

  it("rejects everything when the Worker itself is unconfigured", async () => {
    const res = await worker.fetch(await post({ message: "hi" }), {
      INTERCOM_TOKEN: "test-intercom-token-000000",
    } as never);
    expect(res.status).toBe(401);
  });

  it("IGNORES a sender address supplied in the body (impersonation regression)", async () => {
    // The whole reason the shared secret was retired. Anyone could once post
    // `email: "someone-else@..."` and the Worker would attach it to a real
    // Intercom contact. Identity now comes only from the verified token.
    const res = await worker.fetch(
      await post({
        message: "hi",
        email: "victim@example.test",
        name: "Not The Sender",
      }),
      ENV,
    );
    expect(res.status).toBe(200);
    const contact = calls.find((c) => c.url.endsWith("/contacts"))!
      .body as Record<string, unknown>;
    expect(contact.email).toBe(SENDER_EMAIL);
    expect(contact.email).not.toBe("victim@example.test");
    expect(contact.name).not.toBe("Not The Sender");
    // Always a real user pinned to the Auth0 subject, never an anonymous lead.
    expect(contact.role).toBe("user");
    expect(contact.external_id).toBe(SENDER_SUB);
    // And the address must not leak into the Linear issue either.
    const issueCall = calls.find(
      (c) => (c.body as { query?: string })?.query?.includes("issueCreate"),
    )!;
    const desc = (issueCall.body as {
      variables: { input: { description: string } };
    }).variables.input.description;
    expect(desc).not.toContain("victim@example.test");
  });
});

describe("feedback worker", () => {

  it("creates Intercom conversation + Linear issue with attached logs", async () => {
    const logs = `${"old line\n".repeat(2000)}NEWEST LINE`;
    const res = await worker.fetch(
      await post({
        type: "bug",
        message: "Diff view scrolls to top",
        app_version: "0.5.0",
        logs,
        posthog_distinct_id: "ph-abc",
      }),
      ENV,
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(out.conversation).toBe("convo-9");
    expect(out.linear_issue).toBe("ISSUE-1");

    // Intercom got only the readable TAIL (≤6000 chars), newest included.
    const convoCall = calls.find((c) => c.url.endsWith("/conversations"))!;
    const html = (convoCall.body as { body: string }).body;
    expect(html).toContain("NEWEST LINE");
    expect(html).toContain("[Bug]");
    const pre = /<pre>([\s\S]*)<\/pre>/.exec(html)![1];
    expect(pre.length).toBeLessThanOrEqual(6000);

    // Full logs were uploaded to Linear (PUT), and the issue references the
    // asset + carries metadata + the Intercom conversation id.
    const put = calls.find((c) => c.url.includes("put-here"))!;
    expect(put.init.method).toBe("PUT");
    const issueCall = calls.find(
      (c) => (c.body as { query?: string })?.query?.includes("issueCreate"),
    )!;
    const input = (issueCall.body as {
      variables: { input: { title: string; description: string; teamId: string } };
    }).variables.input;
    expect(input.teamId).toBe(ENV.LINEAR_TEAM_ID);
    expect(input.title).toContain("[Bug] Diff view scrolls to top");
    expect(input.description).toContain("asset-42.jsonl");
    expect(input.description).toContain("**App:** 0.5.0");
    expect(input.description).toContain("convo-9");
    expect(input.description).toContain("ph-abc");
  });

  it("still succeeds via Linear when Intercom is down", async () => {
    intercomFails = true;
    const res = await worker.fetch(await post({ message: "halp", logs: "l1" }), ENV);
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out.conversation).toBeNull();
    expect(out.linear_issue).toBe("ISSUE-1");
  });

  it("falls back to inline log tail when the Linear upload fails", async () => {
    uploadFails = true;
    const res = await worker.fetch(await post({ message: "m", logs: "tail-me" }), ENV);
    expect(res.status).toBe(200);
    const issueCall = calls.find(
      (c) => (c.body as { query?: string })?.query?.includes("issueCreate"),
    )!;
    const desc = (issueCall.body as {
      variables: { input: { description: string } };
    }).variables.input.description;
    expect(desc).toContain("tail-me");
    expect(desc).toContain("```");
  });

  it("returns 502 only when BOTH destinations fail", async () => {
    intercomFails = true;
    linearIssueFails = true;
    const res = await worker.fetch(await post({ message: "m" }), ENV);
    expect(res.status).toBe(502);
  });

  it("works Intercom-only when Linear is not configured (legacy setup)", async () => {
    const res = await worker.fetch(
      await post({ message: "m" }),
      {
        AUTH0_DOMAIN,
        AUTH_AUDIENCE,
        INTERCOM_TOKEN: "test-intercom-token-000000",
      },
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out.conversation).toBe("convo-9");
    expect(out.linear_issue).toBeNull();
  });
});
