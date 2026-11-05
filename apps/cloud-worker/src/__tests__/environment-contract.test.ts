import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as shared from "@zeros/protocol/cloud-v2-relay";
import * as control from "../../../control-plane/src/cloud/environment-contract";
import { CloudV2ControlFrameSchema as cpConfig } from "../../../control-plane/src/cloud/contract";
import { CloudV2ControlFrameSchema as oldConfig } from "../../../control-plane/src/cloud/__fixtures__/worker-contract-before-environment";
import { config } from "./worker-fixtures";

const canary = 'synthetic-app-canary-"quoted"\nsecond-line';
const material = { variables: { APP_DATABASE: canary, EMPTY: "" }, files: [{ path: "private-env/.env.local", content: `APP_VALUE=${canary}\n` }] };
const environment = { ...material, versionId: "44444444-4444-4444-8444-444444444444", repositoryId: "123" };

it("negotiates an optional environment without weakening old strict configuration readers", () => {
  expect(oldConfig.parse(config)).toEqual(config);
  expect(shared.CloudV2ControlFrameSchema.parse(config)).toEqual(config);
  expect(cpConfig.parse(config)).toEqual(config);
  const frame = { ...config, environment };
  expect(oldConfig.safeParse(frame).success).toBe(false);
  expect(shared.CloudV2ControlFrameSchema.parse(frame)).toEqual(cpConfig.parse(frame));
});

it("keeps only names, sizes and revisions in public metadata", () => {
  for (const contract of [shared, control]) {
    const metadata = contract.cloudEnvironmentMetadata("123", 2, environment.versionId, "2026-11-04T00:00:00Z", material);
    expect(metadata.variables).toEqual([{ name: "APP_DATABASE", bytes: Buffer.byteLength(canary) }, { name: "EMPTY", bytes: 0 }]);
    expect(JSON.stringify(metadata)).not.toContain("synthetic-app-canary");
    expect(contract.CloudEnvironmentMetadataSchema.safeParse({ ...metadata, values: material.variables }).success).toBe(false);
    expect(contract.CloudEnvironmentMaterialSchema.parse(material)).toEqual(material);
  }
});

it.each(["PATH", "HOME", "SHELL", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "http_proxy", "HTTPS_PROXY", "GIT_ASKPASS", "GH_TOKEN",
  "GH_ZEROS_SOCKET", "CLOUD_V2_WORKER_TOKEN", "ZEROS_CLOUD_PROXY_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_BASE_URL",
  "CURSOR_API_KEY", "CODEX_HOME", "XDG_CONFIG_HOME", "LD_PRELOAD", "constructor", "__proto__"])("refuses reserved %s instead of shadowing it", name => {
  for (const contract of [shared, control]) {
    const result = contract.CloudEnvironmentMaterialSchema.safeParse({ ...material, variables: { [name]: canary } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("cloud_environment_reserved");
      expect(JSON.stringify(result.error.issues)).not.toContain("synthetic-app-canary");
    }
  }
});

it.each([
  [{ ...material, variables: { "APP_VALUE\n": canary } }, "cloud_environment_invalid"],
  [{ ...material, variables: { ["A".repeat(129)]: canary } }, "cloud_environment_invalid"],
  [{ ...material, variables: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`APP_${i}`, canary])) }, "cloud_environment_variable_limit"],
  [{ ...material, variables: { APP_VALUE: "é".repeat(8193) } }, "cloud_environment_value_limit"],
  [{ ...material, files: Array.from({ length: 17 }, (_, i) => ({ path: `.env.${i}`, content: "" })) }, "cloud_environment_file_limit"],
  [{ ...material, files: [{ path: ".env", content: "é".repeat(32769) }] }, "cloud_environment_file_limit"],
  [{ variables: {}, files: Array.from({ length: 4 }, (_, i) => ({ path: `.env.${i}`, content: "x".repeat(64 * 1024) })) }, "cloud_environment_total_limit"],
])("reports a closed typed bound for invalid environment data", (input, code) => {
  for (const contract of [shared, control]) {
    const result = contract.CloudEnvironmentMaterialSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(code);
  }
});

it.each(["../.env", "/.env", ".env.local\n", "a\\.env", ".git/.env", ".zeros/.env", ".context/.env", "private/../../.env", "a/./.env", "config.json"])("refuses unsafe or lookalike file path %s", path => {
  for (const contract of [shared, control]) expect(contract.CloudEnvironmentMaterialSchema.safeParse({ ...material, files: [{ path, content: canary }] }).success).toBe(false);
});

it("accepts atomic partial patches and refuses ambiguous or malformed patches without reflecting a value", () => {
  for (const contract of [shared, control]) {
    for (const patch of [{ expectedRevision: 0, variables: { APP: canary } }, { expectedRevision: 2, variables: { APP: null }, files: [{ path: ".env", content: null }] },
      { expectedRevision: 3, clear: true }]) expect(contract.CloudEnvironmentPatchSchema.parse(patch)).toEqual(patch);
    for (const patch of [{ expectedRevision: -1 }, { expectedRevision: 0, clear: true, variables: {} }, { expectedRevision: 1, userId: "foreign" },
      { expectedRevision: 0, variables: { APP: { secret: canary } } }, { expectedRevision: 1, files: [{ path: ".env", content: canary }, { path: ".env", content: null }] }]) {
      const result = contract.CloudEnvironmentPatchSchema.safeParse(patch);
      expect(result.success).toBe(false);
      if (!result.success) expect(JSON.stringify(result.error.issues)).not.toContain("synthetic-app-canary");
    }
  }
});

it("keeps Local name policy byte-identical to the standalone mirror", () => {
  const sharedNames = readFileSync(new URL("../../../../packages/protocol/src/env-names.ts", import.meta.url), "utf8");
  const cpNames = readFileSync(new URL("../../../control-plane/src/cloud/environment-names.ts", import.meta.url), "utf8");
  expect(cpNames.slice(cpNames.indexOf("\n") + 1)).toBe(sharedNames);
});

it("bounds reports and prevents failure payloads from carrying names or values", () => {
  for (const contract of [shared, control]) {
    const ready = { versionId: environment.versionId, sequence: 1, state: "ready" };
    expect(contract.CloudEnvironmentReportSchema.parse(ready)).toEqual(ready);
    for (const patch of [{ state: "failed" }, { errorCode: "cloud_environment_path_conflict" }, { sequence: 0 }, { path: ".env" }, { message: canary }])
      expect(contract.CloudEnvironmentReportSchema.safeParse({ ...ready, ...patch }).success).toBe(false);
  }
});
