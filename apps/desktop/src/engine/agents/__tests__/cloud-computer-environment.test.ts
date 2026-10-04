import { describe, expect, it } from "vitest";
import {
  cloudComputerExecutionHistory,
  cloudComputerProcessEnvironment,
} from "../cloud-computer-environment";
import { CloudCustomizationRedactor } from "../cloud-customization-redaction";

describe("execution-scoped computer environment", () => {
  it("merges ordinary values after defaults while native authentication and locations stay managed", () => {
    const base = {
      APP_MODE: "default",
      CURSOR_API_KEY: "native-material",
      HOME: "/private",
      XDG_CONFIG_HOME: "/private/config",
    };
    const values = {
      APP_MODE: "org-value",
      DATABASE_URL: "synthetic-database-value",
      CURSOR_API_KEY: "org-key",
      XDG_CONFIG_HOME: "/tmp",
    };
    expect(cloudComputerProcessEnvironment(base, values, "agent")).toEqual({
      ...base,
      APP_MODE: "org-value",
      DATABASE_URL: values.DATABASE_URL,
    });
    expect(
      cloudComputerProcessEnvironment(base, values, "terminal").CURSOR_API_KEY,
    ).toBe("org-key");
    expect(base.APP_MODE).toBe("default");
    for (const name of [
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "OPENAI_BASE_URL",
      "ZEROS_CLOUD_ENGINE_RUNTIME_B64",
      "GIT_CONFIG_COUNT",
    ])
      expect(() =>
        cloudComputerProcessEnvironment(
          base,
          { [name]: "private-sentinel" },
          "agent",
        ),
      ).toThrow(/^Cloud environment is invalid$/);
  });
  it("adds env-only literals to the existing actor-bound redaction history", () => {
    const history = {
      owner: "a".repeat(64),
      currentKeyVersion: 1,
      keys: { 1: "b".repeat(43) },
    };
    const admitted = cloudComputerExecutionHistory({
      customization: null,
      environment: {
        version: 1,
        revision: "c".repeat(64),
        values: { ORG_KEY: "synthetic-org-value" },
        history,
      },
    })!;
    expect(admitted).toEqual({
      authority: history,
      secrets: ["synthetic-org-value"],
    });
    const redactor = new CloudCustomizationRedactor(admitted.secrets);
    expect(
      redactor.stream("stdout", "synthetic-org-") +
        redactor.stream("stdout", "value") +
        redactor.finish("stdout"),
    ).toBe("[redacted]");
    expect(
      (redactor.error(new Error("failed: synthetic-org-value")) as Error)
        .message,
    ).toBe("failed: [redacted]");
  });
});
