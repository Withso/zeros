import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function configuration(channel: string, branch?: string) {
  const source = readFileSync(".railway/railway.ts", "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: { default?: (context: unknown) => unknown; partial?: string } = {};
  const sdk = { defineRailway: (program: unknown) => program, service: (name: string, config: unknown) => ({ name, config }),
    project: (name: string, config: object) => ({ name, ...config }) };
  runInNewContext(compiled, { exports, process: { env: { RELEASE_BRANCH: branch } }, require: (name: string) => {
    expect(name).toBe("railway/iac"); return sdk;
  } });
  return { partial: exports.partial, project: exports.default!({ projectName: "existing-project", environmentName: channel }) as {
    name: string; resources: Array<{ name: string; config: { rootDirectory: string; source: { repo: string; branch: string }; build: unknown; deploy: unknown } }>;
  } };
}

describe("Railway control-plane IaC authoring", () => {
  it.each(["alpha", "beta", "production"])("preserves the %s service's effective legacy settings without applying", channel => {
    const current = JSON.parse(readFileSync("apps/control-plane/railway.json", "utf8"));
    const result = configuration(channel, "release/0.1.20"), resource = result.project.resources[0];
    expect(result.partial).toBe("zeros-control-plane"); expect(result.project.name).toBe("existing-project");
    expect(result.project.resources).toHaveLength(1); expect(resource.name).toBe("zeros");
    expect(resource.config.rootDirectory).toBe("apps/control-plane");
    expect(resource.config.source).toEqual({ repo: "Withso/zeros", branch: channel === "alpha" ? "main" : "release/0.1.20" });
    expect(resource.config.build).toEqual({ ...current.build, watchPatterns: ["/apps/control-plane/**"] });
    expect(resource.config.deploy).toEqual(current.deploy);
    expect(resource.config).not.toHaveProperty("env"); expect(resource.config).not.toHaveProperty("variables");
  });
  it("rejects unreviewed environments and release-branch selections", () => {
    expect(() => configuration("dev")).toThrow(/existing alpha/);
    expect(() => configuration("beta")).toThrow(/RELEASE_BRANCH/);
    expect(() => configuration("production", "main")).toThrow(/RELEASE_BRANCH/);
  });
});
