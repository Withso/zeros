import { describe, expect, it } from "vitest";
import { mcpResourceHeaders } from "../resource-headers";

describe("MCP resource credentials", () => {
  it("substitutes only this entry's configured variables, including empty values", () => {
    expect(mcpResourceHeaders({ env: { TOKEN: "${zeros.secret}", EMPTY: "" }, headers: { Authorization: "${zeros.secret}", "X-Empty": "${EMPTY}" } },
      { env: { TOKEN: "private" }, headers: { Authorization: "Bearer ${env:TOKEN}" } })).toEqual({ Authorization: "Bearer private", "X-Empty": "" });
  });
  it("never revives a cleared draft credential and rejects missing variables", () => {
    expect(() => mcpResourceHeaders({ headers: { Authorization: "${zeros.secret}" } }, { headers: { Authorization: "old" } }, { headers: { authorization: null } })).toThrow(/missing/);
    expect(() => mcpResourceHeaders({ headers: { Authorization: "${PATH}" } })).toThrow(/undefined/);
  });
  it("checks injection after substitution and preserves unrelated saved fields", () => {
    const saved = { env: { TOKEN: "bad\r\nInjected: true" }, headers: { "X-Account": "one" } };
    expect(() => mcpResourceHeaders({ env: { TOKEN: "${zeros.secret}" }, headers: { "X-Key": "${TOKEN}" } }, saved)).toThrow(/Invalid/);
    expect(saved.headers).toEqual({ "X-Account": "one" });
  });
});
