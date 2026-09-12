import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  filterCloudWorkspaceSettingsByAllowedPaths,
  normalizeCloudWorkspaceSettingsDocument,
  resolveCloudWorkspaceSettingsLayers,
  sealCloudWorkspaceSecretBinding,
} from "./settings.js";

describe("cloud workspace settings resolution", () => {
  it("merges weak-to-strong layers and records exact leaf provenance", () => {
    const resolved = resolveCloudWorkspaceSettingsLayers([
      {
        source: "built-in defaults",
        document: {
          values: {
            git: { baseBranch: "main", fetchDepth: 10 },
            runtime: { node: "22" },
          },
        },
      },
      {
        source: "organization cloud",
        document: {
          values: { git: { fetchDepth: 50 }, runtime: { node: "24" } },
        },
      },
      {
        source: "repository cloud",
        document: { values: { git: { baseBranch: "release/2026.08" } } },
      },
      {
        source: "managed policy",
        document: { values: { network: { publicPorts: false } } },
      },
    ]);

    expect(resolved.snapshot).toEqual({
      schemaVersion: 1,
      values: {
        git: { baseBranch: "release/2026.08", fetchDepth: 50 },
        runtime: { node: "24" },
        network: { publicPorts: false },
      },
    });
    expect(resolved.provenance).toMatchObject({
      "/values/git/baseBranch": "repository cloud",
      "/values/git/fetchDepth": "organization cloud",
      "/values/runtime/node": "organization cloud",
      "/values/network/publicPorts": "managed policy",
    });
  });

  it("merges secret references by environment name without accepting values", () => {
    const resolved = resolveCloudWorkspaceSettingsLayers([
      {
        source: "organization cloud",
        document: {
          values: {},
          secretRefs: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "DATABASE_URL",
            },
          ],
        },
      },
      {
        source: "repository cloud",
        document: {
          values: {},
          secretRefs: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              name: "DATABASE_URL",
            },
            {
              id: "33333333-3333-4333-8333-333333333333",
              name: "SENTRY_DSN",
            },
          ],
        },
      },
    ]);

    expect(resolved.snapshot.secretRefs).toEqual([
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "DATABASE_URL",
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "SENTRY_DSN",
      },
    ]);
    expect(resolved.provenance["/secretRefs/DATABASE_URL"]).toBe(
      "repository cloud",
    );
  });

  it.each([
    ["prototype key", JSON.parse('{"values":{"__proto__":{"polluted":true}}}')],
    ["non-finite number", { values: { timeout: Number.NaN } }],
    ["inline secret", { values: {}, secrets: { DATABASE_URL: "plaintext" } }],
    [
      "malformed reference",
      { values: {}, secretRefs: [{ id: "not-a-uuid", name: "TOKEN" }] },
    ],
  ])("rejects a %s", (_name, document) => {
    expect(() =>
      resolveCloudWorkspaceSettingsLayers([
        { source: "untrusted settings", document },
      ]),
    ).toThrow("invalid");
  });

  it("is deterministic regardless of object insertion order", () => {
    const first = resolveCloudWorkspaceSettingsLayers([
      { source: "repository", document: { values: { b: 2, a: 1 } } },
    ]);
    const second = resolveCloudWorkspaceSettingsLayers([
      { source: "repository", document: { values: { a: 1, b: 2 } } },
    ]);
    expect(first.canonicalJson).toBe(second.canonicalJson);
    expect(first.sha256).toBe(second.sha256);
  });

  it("normalizes a persisted layer without leaking the execution wrapper", () => {
    const normalized = normalizeCloudWorkspaceSettingsDocument({
      setupCommands: [{ timeoutSeconds: 30, command: "pnpm install" }],
      values: { runtime: { node: "24" }, a: true },
    });

    expect(normalized.document).toEqual({
      values: { a: true, runtime: { node: "24" } },
      setupCommands: [{ command: "pnpm install", timeoutSeconds: 30 }],
    });
    expect(normalized.canonicalJson).not.toContain("schemaVersion");
    expect(normalized.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("inherits only explicitly consented values and never secrets or commands", () => {
    expect(
      filterCloudWorkspaceSettingsByAllowedPaths(
        {
          values: {
            environment: { node: "24", region: "eu" },
            editor: { fontSize: 14 },
          },
          secretRefs: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "DATABASE_URL",
            },
          ],
          setupCommands: [{ command: "unsafe-to-inherit", timeoutSeconds: 30 }],
        },
        ["/values/environment/node"],
      ),
    ).toEqual({ values: { environment: { node: "24" } } });
  });

  it("rejects protected process environment names before materialization", () => {
    expect(() =>
      resolveCloudWorkspaceSettingsLayers([
        {
          source: "repository",
          document: {
            values: {},
            secretRefs: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                name: "NODE_OPTIONS",
              },
            ],
          },
        },
      ]),
    ).toThrow("invalid");
  });

  it("binds encrypted secret versions to org, id, version, and name", () => {
    const key = randomBytes(32).toString("base64url");
    const binding = {
      bindingId: "11111111-1111-4111-8111-111111111111",
      organizationId: "22222222-2222-4222-8222-222222222222",
      version: 1,
      name: "DATABASE_URL",
    };
    const sealed = sealCloudWorkspaceSecretBinding(
      "postgresql://private.example/db",
      binding,
      key,
    );
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.authTag).toHaveLength(16);
    expect(sealed.valueVerifier).toHaveLength(32);
    expect(sealed.valueVerifier).not.toEqual(
      createHash("sha256")
        .update("postgresql://private.example/db", "utf8")
        .digest(),
    );
    expect(
      sealCloudWorkspaceSecretBinding(
        "postgresql://private.example/db",
        { ...binding, bindingId: "33333333-3333-4333-8333-333333333333" },
        key,
      ).valueVerifier,
    ).not.toEqual(sealed.valueVerifier);
    expect(
      sealCloudWorkspaceSecretBinding(
        "postgresql://private.example/db",
        binding,
        key,
      ).valueVerifier,
    ).toEqual(sealed.valueVerifier);
    expect(sealed.ciphertext.toString("utf8")).not.toContain("private.example");
    expect(() =>
      sealCloudWorkspaceSecretBinding(
        "postgresql://private.example/db",
        { ...binding, name: "NODE_OPTIONS" },
        key,
      ),
    ).toThrow("invalid");
  });
});
