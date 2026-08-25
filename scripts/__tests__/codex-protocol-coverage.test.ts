import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs has no type declarations; it exports pure helpers.
import {
  extractCodexMethods,
  validateCodexProtocolCoverage,
} from "../codex-protocol-coverage.mjs";

function manifest() {
  return {
    schemaVersion: 1,
    codexProtocolVersion: "0.146.0",
    clientRequests: {
      handled: ["client/handled"],
      "generated-only": ["client/generated"],
    },
    serverRequests: {
      handled: ["request/handled"],
      "provider-conditional": ["request/conditional"],
    },
    serverNotifications: {
      canonical: ["notification/canonical"],
      forwarded: ["notification/forwarded"],
    },
  };
}

describe("Codex protocol coverage", () => {
  it("extracts method discriminants from generated TypeScript", () => {
    const source = [
      'export type Message = { "method": "alpha", params: A }',
      '  | { "method": "beta/gamma", params: B };',
    ].join("\n");

    expect(extractCodexMethods(source, "fixture.ts")).toEqual([
      "alpha",
      "beta/gamma",
    ]);
  });

  it("accepts an exact, version-matched classification", () => {
    expect(
      validateCodexProtocolCoverage({
        manifest: manifest(),
        pinnedVersion: "0.146.0",
        clientRequests: ["client/handled", "client/generated"],
        serverRequests: ["request/handled", "request/conditional"],
        serverNotifications: [
          "notification/canonical",
          "notification/forwarded",
        ],
      }),
    ).toEqual({
      clientRequests: { "generated-only": 1, handled: 1 },
      serverRequests: { handled: 1, "provider-conditional": 1 },
      serverNotifications: { canonical: 1, forwarded: 1 },
      total: 6,
    });
  });

  it("fails when generated bindings add an unclassified method", () => {
    expect(() =>
      validateCodexProtocolCoverage({
        manifest: manifest(),
        pinnedVersion: "0.146.0",
        clientRequests: ["client/handled", "client/generated", "client/new"],
        serverRequests: ["request/handled", "request/conditional"],
        serverNotifications: [
          "notification/canonical",
          "notification/forwarded",
        ],
      }),
    ).toThrow(/unclassified client request.*client\/new/i);
  });

  it("fails when a classification is stale or duplicated", () => {
    const invalid = manifest();
    invalid.serverRequests.handled.push("request/stale");
    invalid.serverRequests["provider-conditional"].push("request/handled");

    expect(() =>
      validateCodexProtocolCoverage({
        manifest: invalid,
        pinnedVersion: "0.146.0",
        clientRequests: ["client/handled", "client/generated"],
        serverRequests: ["request/handled", "request/conditional"],
        serverNotifications: [
          "notification/canonical",
          "notification/forwarded",
        ],
      }),
    ).toThrow(
      /stale server request.*request\/stale.*duplicate.*request\/handled/is,
    );
  });

  it("rejects unknown classification states", () => {
    const invalid = manifest() as ReturnType<typeof manifest> & {
      clientRequests: Record<string, string[]>;
    };
    invalid.clientRequests.unreviewed = [];

    expect(() =>
      validateCodexProtocolCoverage({
        manifest: invalid,
        pinnedVersion: "0.146.0",
        clientRequests: ["client/handled", "client/generated"],
        serverRequests: ["request/handled", "request/conditional"],
        serverNotifications: [
          "notification/canonical",
          "notification/forwarded",
        ],
      }),
    ).toThrow(/unknown client request classification.*unreviewed/i);
  });

  it("fails when the manifest targets a different protocol pin", () => {
    expect(() =>
      validateCodexProtocolCoverage({
        manifest: manifest(),
        pinnedVersion: "0.147.0",
        clientRequests: ["client/handled", "client/generated"],
        serverRequests: ["request/handled", "request/conditional"],
        serverNotifications: [
          "notification/canonical",
          "notification/forwarded",
        ],
      }),
    ).toThrow(/coverage version.*0\.146\.0.*pin.*0\.147\.0/i);
  });

  it("classifies adapter-owned client requests as handled", () => {
    const repositoryRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const coverage = JSON.parse(
      readFileSync(
        resolve(
          repositoryRoot,
          "apps/desktop/src/engine/agents/adapters/codex/protocol-coverage.json",
        ),
        "utf8",
      ),
    ) as {
      clientRequests: {
        handled: string[];
        "generated-only": string[];
      };
    };
    const adapterOwnedRequests = [
      "account/rateLimits/read",
      "account/read",
      "model/list",
      "skills/list",
      "thread/backgroundTerminals/list",
      "thread/backgroundTerminals/terminate",
      "thread/compact/start",
      "thread/list",
      "turn/steer",
    ];

    expect(coverage.clientRequests.handled).toEqual(
      expect.arrayContaining(adapterOwnedRequests),
    );
    expect(coverage.clientRequests["generated-only"]).not.toEqual(
      expect.arrayContaining(adapterOwnedRequests),
    );
  });
});
