import { describe, expect, it } from "vitest";
import {
  CLOUD_RUNTIME_RELAY_ENVIRONMENT,
  CLOUD_RUNTIME_RELAY_MAX_MESSAGE_BYTES,
  DEFAULT_CLOUD_RUNTIME_RELAY_LIMITS,
  cloudRuntimeRelayLimits,
  cloudRuntimeRelayOutboundBytes,
  loadCloudRuntimeRelayLimits,
} from "./runtime-bridge-limits.js";

const MiB = 1024 * 1024;

describe("cloud runtime relay limits", () => {
  it("reserves queue metadata for empty and tiny frames without lowering the message ceiling", () => {
    expect(cloudRuntimeRelayOutboundBytes(0)).toBe(512);
    expect(cloudRuntimeRelayOutboundBytes(1)).toBe(512);
    expect(cloudRuntimeRelayOutboundBytes(64 * MiB)).toBe(64 * MiB);
  });

  it("keeps the documented envelope when nothing is configured", () => {
    expect(DEFAULT_CLOUD_RUNTIME_RELAY_LIMITS).toEqual({
      maxConnections: 64,
      maxConnectionsPerWorkspace: 10,
      maxReadOnlyConnectionsPerWorkspace: 10,
      outboundBudgetBytes: 128 * MiB,
      inboundBudgetBytes: 256 * MiB,
    });
    expect(DEFAULT_CLOUD_RUNTIME_RELAY_LIMITS.inboundBudgetBytes).toBe(
      4 * CLOUD_RUNTIME_RELAY_MAX_MESSAGE_BYTES,
    );
    expect(CLOUD_RUNTIME_RELAY_MAX_MESSAGE_BYTES).toBe(64 * MiB);
    expect(loadCloudRuntimeRelayLimits({})).toEqual(
      DEFAULT_CLOUD_RUNTIME_RELAY_LIMITS,
    );
    expect(cloudRuntimeRelayLimits({})).toEqual(
      DEFAULT_CLOUD_RUNTIME_RELAY_LIMITS,
    );
  });

  it("loads each limit from its environment variable", () => {
    expect(CLOUD_RUNTIME_RELAY_ENVIRONMENT).toEqual({
      maxConnections: "CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS",
      maxConnectionsPerWorkspace:
        "CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS_PER_WORKSPACE",
      maxReadOnlyConnectionsPerWorkspace:
        "CLOUD_WORKSPACE_BRIDGE_MAX_READ_ONLY_CONNECTIONS_PER_WORKSPACE",
      outboundBudgetMiB: "CLOUD_WORKSPACE_BRIDGE_OUTBOUND_BUDGET_MIB",
      inboundBudgetMiB: "CLOUD_WORKSPACE_BRIDGE_INBOUND_BUDGET_MIB",
    });
    expect(
      loadCloudRuntimeRelayLimits({
        CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS: "64",
        CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS_PER_WORKSPACE: "6",
        CLOUD_WORKSPACE_BRIDGE_MAX_READ_ONLY_CONNECTIONS_PER_WORKSPACE: "16",
        CLOUD_WORKSPACE_BRIDGE_OUTBOUND_BUDGET_MIB: "256",
        CLOUD_WORKSPACE_BRIDGE_INBOUND_BUDGET_MIB: "384",
      }),
    ).toEqual({
      maxConnections: 64,
      maxConnectionsPerWorkspace: 6,
      maxReadOnlyConnectionsPerWorkspace: 16,
      outboundBudgetBytes: 256 * MiB,
      inboundBudgetBytes: 384 * MiB,
    });
    // A blank Railway variable means "unset", never zero.
    expect(
      loadCloudRuntimeRelayLimits({
        CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS: " ",
        CLOUD_WORKSPACE_BRIDGE_OUTBOUND_BUDGET_MIB: "",
      }),
    ).toEqual(DEFAULT_CLOUD_RUNTIME_RELAY_LIMITS);
  });

  it("accepts the inclusive boundaries and nothing outside them", () => {
    const load = (name: string, value: string) =>
      loadCloudRuntimeRelayLimits({
        // Keep the per-workspace ceiling legal while probing the instance one.
        CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS_PER_WORKSPACE: "1",
        CLOUD_WORKSPACE_BRIDGE_MAX_READ_ONLY_CONNECTIONS_PER_WORKSPACE: "1",
        [name]: value,
      });
    expect(
      load("CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS", "1").maxConnections,
    ).toBe(1);
    expect(
      load("CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS", "1024").maxConnections,
    ).toBe(1024);
    expect(
      load("CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS_PER_WORKSPACE", "1")
        .maxConnectionsPerWorkspace,
    ).toBe(1);
    expect(
      loadCloudRuntimeRelayLimits({
        CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS: "64",
        CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS_PER_WORKSPACE: "64",
      }).maxConnectionsPerWorkspace,
    ).toBe(64);
    for (const name of [
      "CLOUD_WORKSPACE_BRIDGE_OUTBOUND_BUDGET_MIB",
      "CLOUD_WORKSPACE_BRIDGE_INBOUND_BUDGET_MIB",
    ]) {
      expect(Object.values(load(name, "64"))).toContain(64 * MiB);
      expect(Object.values(load(name, "16384"))).toContain(16_384 * MiB);
    }
    for (const [name, values] of [
      ["CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS", ["0", "1025"]],
      ["CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS_PER_WORKSPACE", ["0", "65"]],
      [
        "CLOUD_WORKSPACE_BRIDGE_MAX_READ_ONLY_CONNECTIONS_PER_WORKSPACE",
        ["0", "65"],
      ],
      ["CLOUD_WORKSPACE_BRIDGE_OUTBOUND_BUDGET_MIB", ["63", "16385"]],
      ["CLOUD_WORKSPACE_BRIDGE_INBOUND_BUDGET_MIB", ["63", "16385"]],
    ] as const) {
      for (const value of values)
        expect(() =>
          loadCloudRuntimeRelayLimits({
            CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS: "1024",
            [name]: value,
          }),
        ).toThrow(new RegExp(`${name} must be an integer from`));
    }
  });

  it("rejects values that are not plain decimal integers", () => {
    for (const value of [
      "8.5",
      "1e3",
      "-8",
      "+8",
      "08",
      "0x10",
      "8 MiB",
      "Infinity",
      "８",
    ]) {
      expect(() =>
        loadCloudRuntimeRelayLimits({
          CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS: value,
        }),
      ).toThrow(
        /Invalid cloud workspace bridge environment: CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS/,
      );
    }
  });

  it("refuses a per-workspace ceiling above the instance ceiling", () => {
    expect(() =>
      loadCloudRuntimeRelayLimits({
        CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS: "4",
        CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS_PER_WORKSPACE: "5",
      }),
    ).toThrow(
      /CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS_PER_WORKSPACE must not exceed CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS/,
    );
    // Lowering the instance ceiling alone keeps the per-workspace default legal.
    expect(
      loadCloudRuntimeRelayLimits({
        CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS: "2",
      }),
    ).toMatchObject({
      maxConnections: 2,
      maxConnectionsPerWorkspace: 2,
      maxReadOnlyConnectionsPerWorkspace: 2,
    });
    expect(() =>
      loadCloudRuntimeRelayLimits({
        CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS: "4",
        CLOUD_WORKSPACE_BRIDGE_MAX_READ_ONLY_CONNECTIONS_PER_WORKSPACE: "5",
      }),
    ).toThrow(
      /CLOUD_WORKSPACE_BRIDGE_MAX_READ_ONLY_CONNECTIONS_PER_WORKSPACE must not exceed CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS/,
    );
  });

  it("validates constructor limits with the same bounds", () => {
    expect(
      cloudRuntimeRelayLimits({
        maxConnections: 200,
        maxConnectionsPerWorkspace: 8,
        outboundBudgetBytes: 512 * MiB,
        inboundBudgetBytes: 2048 * MiB,
      }),
    ).toEqual({
      maxConnections: 200,
      maxConnectionsPerWorkspace: 8,
      maxReadOnlyConnectionsPerWorkspace: 10,
      outboundBudgetBytes: 512 * MiB,
      inboundBudgetBytes: 2048 * MiB,
    });
    for (const limits of [
      { maxConnections: 0 },
      { maxConnections: 1025 },
      { maxConnections: 8.5 },
      { maxConnectionsPerWorkspace: 65 },
      { maxReadOnlyConnectionsPerWorkspace: 65 },
      { maxConnections: 3, maxReadOnlyConnectionsPerWorkspace: 4 },
      { maxConnections: 3, maxConnectionsPerWorkspace: 4 },
      { outboundBudgetBytes: 64 * MiB - 1 },
      { inboundBudgetBytes: 16_384 * MiB + 1 },
      { inboundBudgetBytes: Number.NaN },
    ])
      expect(
        () => cloudRuntimeRelayLimits(limits),
        JSON.stringify(limits),
      ).toThrow("invalid relay bound");
  });
});
