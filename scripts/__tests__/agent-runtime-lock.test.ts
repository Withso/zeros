import { dump } from "js-yaml";
import { describe, expect, it } from "vitest";
import { validateLockChange } from "../agent-runtime/patch.mjs";

const task = { provider: "cursor", from: "1.0.0", version: "1.1.0" };
function graph(version: string) {
  return {
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: true },
    importers: {
      ".": {
        dependencies: {
          "@cursor/sdk": { specifier: version, version },
          other: { specifier: "2.0.0", version: "2.0.0" },
        },
      },
    },
    packages: {
      [`@cursor/sdk@${version}`]: {
        resolution: { integrity: `fixture-${version}` },
      },
      "shared@1.0.0": { resolution: { integrity: "fixture-shared" } },
      "other@2.0.0": { resolution: { integrity: "fixture-other" } },
    },
    snapshots: {
      [`@cursor/sdk@${version}`]: { dependencies: { shared: "1.0.0" } },
      "shared@1.0.0": {},
      "other@2.0.0": {},
    },
  };
}

describe("runtime lockfile dependency ownership", () => {
  it("accepts only the selected version and its added/removed dependency closure", () => {
    const before = graph("1.0.0"),
      after = graph("1.1.0");
    expect(() =>
      validateLockChange(dump(before), dump(after), task),
    ).not.toThrow();
    after.snapshots["@cursor/sdk@1.1.0"].optionalDependencies = {
      "cursor-linux": "1.1.0",
    };
    after.snapshots["cursor-linux@1.1.0"] = {};
    after.packages["cursor-linux@1.1.0"] = {
      resolution: { integrity: "fixture-linux" },
    };
    expect(() =>
      validateLockChange(dump(before), dump(after), task),
    ).not.toThrow();
  });

  it.each([
    "unrelated-addition",
    "shared-integrity",
    "unrelated-removal",
    "settings",
    "workspace-importer",
  ])("rejects %s changes even when the selected pin is valid", (change) => {
    const before = graph("1.0.0"),
      after: any = graph("1.1.0");
    if (change === "unrelated-addition") after.packages["injected@1.0.0"] = {};
    if (change === "shared-integrity")
      after.packages["shared@1.0.0"].resolution.integrity = "rewritten";
    if (change === "unrelated-removal") delete after.snapshots["other@2.0.0"];
    if (change === "settings") after.settings.autoInstallPeers = false;
    if (change === "workspace-importer")
      after.importers["apps/control-plane"] = {
        dependencies: { "@openai/codex": { version: "99.0.0" } },
      };
    expect(() => validateLockChange(dump(before), dump(after), task)).toThrow();
  });
});
