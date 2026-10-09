import { describe, expect, it } from "vitest";
import { harnessFailureSite } from "../cloud-workspace-validation/cloud-agent-e2e/failure-site";

const site = "/private/repository/scripts/cloud-workspace-validation/cloud-agent-e2e/renderer-turn.ts:91:15";
function error(stack: unknown, name: unknown = "Error") {
  return Object.assign(new Error("Bearer private-prose"), { stack, name });
}

describe("closed harness failure site", () => {
  it("keeps fixed source identities and numeric locations without text, paths or argv", () => {
    const result = harnessFailureSite(error(`Error: Bearer private-prose\n    at requestEnvelope (${site})\n    at /private/repository/apps/desktop/src/renderer/platform/bridge/cloud-agent-connection.ts:349:24`));
    expect(result).toEqual({ errorClass: "Error", sites: [
      { file: "renderer-turn", line: 91, column: 15 },
      { file: "cloud-agent-connection", line: 349, column: 24 },
    ] });
    expect(JSON.stringify(result)).not.toMatch(/private|Bearer|requestEnvelope|repository/);
  });
  it("does not accept a source-looking phrase in prose or an unknown source", () => {
    expect(harnessFailureSite(error(`Error: ${site}\n    at /secret/unknown.ts:7:1`)))
      .toEqual({ errorClass: "Error", sites: [] });
  });
  it.each([null, "private", { name: "Error", stack: `    at ${site}` }])("ignores a non-Error value", value => {
    expect(harnessFailureSite(value)).toBeUndefined();
  });
  it("never coerces or retains an enum object and samples a throwing stack silently", () => {
    const value = error({ toString() { throw new Error("private"); } }, { toString() { return "Error"; } });
    expect(harnessFailureSite(value)).toEqual({ errorClass: "other", sites: [] });
    Object.defineProperty(value, "stack", { get() { throw new Error("private"); } });
    expect(harnessFailureSite(value)).toEqual({ errorClass: "other", sites: [] });
  });
  it("bounds stack size, numeric locations and retained rows", () => {
    expect(harnessFailureSite(error("x".repeat(16_385)))).toEqual({ errorClass: "Error", sites: [] });
    expect(harnessFailureSite(error(`    at ${site.replace(":91:15", ":99999999:15")}`)))
      .toEqual({ errorClass: "Error", sites: [] });
    expect(harnessFailureSite(error(Array.from({ length: 20 }, () => `    at ${site}`).join("\n")))?.sites).toHaveLength(4);
  });
  it("does not trust throwing or coercible name properties", () => {
    const value = error(`    at ${site}`, "TypeError");
    Object.defineProperty(value, "name", { get() { throw new Error("private"); } });
    expect(harnessFailureSite(value)).toEqual({ errorClass: "other", sites: [{ file: "renderer-turn", line: 91, column: 15 }] });
  });
});
