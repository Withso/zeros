import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { decideScope, loadPolicy } from "../ci/scope.mjs";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const workflows = [
  "ci",
  "preflight",
  "cloud-runtime-bundle-build",
  "cloud-runner-qualification",
  "release-alpha",
  "release-beta",
  "release",
] as const;

describe("VM execution and neutral packaging contracts", () => {
  it.each([
    ["scripts/preview-browser-smoke.ts", "cloud-runtime"],
    ["scripts/stage-ripgrep.mjs", "packaging"],
  ])("keeps the audited selector floor for %s", (file, lane) => {
    const decision = decideScope({
      policy: loadPolicy(path.join(root, "scripts/ci/scope-rules.json")),
      changes: [{ path: file, status: "M" }],
      labels: [],
    });
    expect(decision.full).toBe(false);
    expect(decision.lanes[lane!]).toBe(true);
  });

  it.each(workflows)(
    "%s retains its lanes without per-agent sandbox qualification",
    (name) => {
      const source = read(`.github/workflows/${name}.yml`);
      expect(source).not.toMatch(
        /pnpm (?:check:zsr|zsr:qualify|build:zsr-supervisor)/,
      );
      expect(source).not.toContain(
        "./.github/actions/contained-execution-runtime",
      );
      expect(source).not.toContain("ZEROS_REQUIRE_CONTAINMENT_RUNTIME");
    },
  );

  it.each(["ci", "preflight"])(
    "%s preserves required aggregates and native source-sync checks",
    (name) => {
      const workflow = load(read(`.github/workflows/${name}.yml`)) as {
        jobs: Record<string, { steps?: { run?: string }[] }>;
      };
      for (const job of [
        "test",
        "source-sync",
        "control-plane",
        "ui-smoke",
        "secret-scan",
      ]) {
        expect(workflow.jobs).toHaveProperty(job);
      }
      const steps = workflow.jobs["source-sync-workload"]!.steps!.map(
        (step) => step.run ?? "",
      ).join("\n");
      for (const command of [
        "pnpm smoke:engine",
        "pnpm agents:smoke:offline",
        "pnpm check:runtime-pins",
      ]) {
        expect(steps).toContain(command);
      }
    },
  );

  it("keeps offline artifact closure tools and command-scoped Ubuntu restoration", () => {
    expect(
      existsSync(
        path.join(root, ".github/actions/runtime-closure-tools/action.yml"),
      ),
    ).toBe(true);
    const action = read(".github/actions/runtime-closure-tools/action.yml");
    expect(action).toContain("bubblewrap util-linux");
    expect(action).toContain("command -v setpriv");
    expect(action).toContain("scripts/ci/with-userns.sh");
    expect(action).not.toMatch(/sandbox-runtime|apply.seccomp|socat/);
    const wrapper = read("scripts/ci/with-userns.sh");
    expect(
      statSync(path.join(root, "scripts/ci/with-userns.sh")).mode & 0o777,
    ).toBe(0o755);
    expect(wrapper).toContain("trap restore EXIT");
    expect(wrapper).toContain('sudo sysctl -q -w "$KEY=$restriction"');
    expect(wrapper).toContain("apparmor_parser --replace --skip-cache");
    expect(wrapper).toContain('"$@"');
  });

  it("uses the real closure tools for Linux bundle construction and retains preview browser checks", () => {
    const bundle = read(".github/workflows/cloud-runtime-bundle-build.yml");
    expect(bundle).toContain("./.github/actions/runtime-closure-tools");
    expect(bundle).toContain(
      "bash scripts/ci/with-userns.sh pnpm cloud:runtime-bundle:build",
    );
    expect(bundle).toContain("--source-commit");
    const runner = read(".github/workflows/cloud-runner-qualification.yml");
    expect(runner).toContain("pnpm agents:smoke:offline");
    expect(runner).toContain("pnpm check:preview-browser");
  });

  it("packages the original Host supervisor and neutral pinned ripgrep, keeping provider assets", () => {
    const pkg = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["build:ripgrep"]).toBe("node scripts/stage-ripgrep.mjs");
    for (const entry of ["electron:build", "electron:dev:prep"]) {
      expect(pkg.scripts[entry]).toContain("pnpm build:ripgrep");
      expect(pkg.scripts[entry]).not.toContain("build:zsr-supervisor");
    }
    expect(Object.keys(pkg.scripts).filter((key) => /zsr/.test(key))).toEqual(
      [],
    );
    const config = load(read("electron-builder.yml")) as {
      extraResources: { from: string; to: string }[];
    };
    expect(config.extraResources).toContainEqual({
      from: "binaries/rg",
      to: "rg",
    });
    expect(config.extraResources).toContainEqual({
      from: "apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs",
      to: "host-process-supervisor.mjs",
    });
    expect(config.extraResources.some(({ from }) => /zsr-/.test(from))).toBe(
      false,
    );
    expect(config.extraResources.some(({ to }) => to === "claude")).toBe(true);
    expect(config.extraResources.some(({ to }) => /codex/.test(to))).toBe(true);
  });

  it("moves preview smoke to the neutral gateway while preserving capability URL compatibility", () => {
    expect(
      existsSync(path.join(root, "scripts/preview-browser-smoke.ts")),
    ).toBe(true);
    const source = read("scripts/preview-browser-smoke.ts");
    expect(source).toContain('containment/preview-gateway"');
    expect(source).toContain("PreviewGateway.open");
    expect(source).toContain('searchParams.has("__zsr_cap")');
    expect(source).toContain("status !== 403");
  });
});
