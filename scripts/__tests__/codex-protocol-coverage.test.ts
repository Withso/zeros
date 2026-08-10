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
      "client/handled": {
        state: "supported",
        owner: "runtime",
      },
    },
    serverRequests: {
      "request/handled": {
        state: "supported",
        owner: "runtime",
      },
      "request/planned": {
        state: "planned",
        owner: "runtime",
        reason: "The interaction UI is not implemented yet.",
      },
    },
    serverNotifications: {
      "notification/handled": {
        state: "supported",
        owner: "translator",
      },
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
        clientRequests: ["client/handled"],
        serverRequests: ["request/handled", "request/planned"],
        serverNotifications: ["notification/handled"],
      }),
    ).toEqual({
      serverRequests: { planned: 1, supported: 1 },
      serverNotifications: { supported: 1 },
      clientRequests: { supported: 1 },
      total: 4,
    });
  });

  it("fails when generated bindings add an unclassified method", () => {
    expect(() =>
      validateCodexProtocolCoverage({
        manifest: manifest(),
        pinnedVersion: "0.146.0",
        clientRequests: ["client/handled"],
        serverRequests: ["request/handled", "request/planned", "request/new"],
        serverNotifications: ["notification/handled"],
      }),
    ).toThrow(/unclassified server request.*request\/new/i);
  });

  it("fails when the manifest retains a method absent from the bindings", () => {
    expect(() =>
      validateCodexProtocolCoverage({
        manifest: manifest(),
        pinnedVersion: "0.146.0",
        clientRequests: ["client/handled"],
        serverRequests: ["request/handled"],
        serverNotifications: ["notification/handled"],
      }),
    ).toThrow(/stale server request.*request\/planned/i);
  });

  it("requires a reason for every non-supported classification", () => {
    const invalid = manifest();
    delete (invalid.serverRequests["request/planned"] as { reason?: string })
      .reason;

    expect(() =>
      validateCodexProtocolCoverage({
        manifest: invalid,
        pinnedVersion: "0.146.0",
        clientRequests: ["client/handled"],
        serverRequests: ["request/handled", "request/planned"],
        serverNotifications: ["notification/handled"],
      }),
    ).toThrow(/request\/planned.*reason/i);
  });

  it("fails when the classification targets a different protocol pin", () => {
    expect(() =>
      validateCodexProtocolCoverage({
        manifest: manifest(),
        pinnedVersion: "0.147.0",
        clientRequests: ["client/handled"],
        serverRequests: ["request/handled", "request/planned"],
        serverNotifications: ["notification/handled"],
      }),
    ).toThrow(/coverage version.*0\.146\.0.*pin.*0\.147\.0/i);
  });

  it("fails when a generated client request is not classified", () => {
    expect(() =>
      validateCodexProtocolCoverage({
        manifest: manifest(),
        pinnedVersion: "0.146.0",
        clientRequests: ["client/handled", "client/new"],
        serverRequests: ["request/handled", "request/planned"],
        serverNotifications: ["notification/handled"],
      }),
    ).toThrow(/unclassified client request.*client\/new/i);
  });
});
