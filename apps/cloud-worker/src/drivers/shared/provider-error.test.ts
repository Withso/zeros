import { expect, it } from "vitest";
import { normalizeProviderError } from "./provider-error";
import { codexModelUnavailableMessage } from "@zeros/protocol/model-rejection";

it.each(["The model `gpt-6.1-terra` was not found.", "Request rejected for model `gpt-6.1-terra`."])("classifies Codex 0.165 modelNotFound with the same model recovery as Local: %s", message => {
  const native = normalizeProviderError("codex", {
    message, codexErrorInfo: "modelNotFound",
  });
  expect(native).toMatchObject({ category: "model-unavailable", code: "modelNotFound" });
  expect(codexModelUnavailableMessage(native.message)).toBe("Your Codex connection can't use GPT-6.1 Terra. Pick another model.");
});

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
