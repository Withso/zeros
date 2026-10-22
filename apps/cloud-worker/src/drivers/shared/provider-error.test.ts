import { expect, it } from "vitest";
import { normalizeProviderError } from "./provider-error";

it("recognizes the OpenAI project model-access wording while retaining other failure categories", () => {
  const message = "unexpected status 403 Forbidden: Project `proj_fixture` does not have access to model `gpt-6.1-sol`, url: https://proxy.example.test/v2/cloud/proxy/openai/responses, cf-ray: fixture-ray, request id: fixture-request";
  for (const value of [new Error(message), { status: 403, message }, {
    codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } }, message,
  }]) expect(normalizeProviderError("codex", value)).toMatchObject({ category: "model-unavailable", message });
  for (const [status, category] of [[401, "auth-required"], [429, "rate-limited"], [503, "transport-closed"]] as const)
    expect(normalizeProviderError("codex", { status, message }).category).toBe(category);
  expect(normalizeProviderError("codex", { status: 403, message: "Project access denied while requesting model gpt-6.1-sol." }).category).toBe("protocol-error");
  expect(normalizeProviderError("codex", { message: "Request refused.", advice: message }).category).toBe("protocol-error");
});
