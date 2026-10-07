import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { rgPath } from "@vscode/ripgrep";
import { buildSync } from "esbuild";
import { expect, it } from "vitest";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudEngineViewArguments } from "../cloud-workspace-validation/sandbox/cloud-engine-view.mjs";

// Explicit opt-in: this is a local investigation fixture, not a deployment gate.
const available =
  process.env.ZEROS_LOCAL_NATIVE_STARTUP_PROBE === "1" &&
  process.platform === "linux" &&
  [
    "/usr/bin/bwrap",
    "/usr/bin/setpriv",
    "/usr/bin/unshare",
    "/usr/bin/cc",
    "/conductor/bin/claude",
    "/conductor/bin/codex",
  ].every(existsSync) &&
  spawnSync("sudo", ["-n", "/usr/bin/true"], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: "ignore",
  }).status === 0;
it.skipIf(!available)(
  "probes real v4 native startup (requires opt-in, Linux sudo and Conductor CLIs; no credentials or prompts)",
  () => {
    const tree = cloudRuntimeFixture({ mapAbsoluteLinks: false });
    let privileged = false;
    try {
      const runtime = createCloudRuntimeResolver({
        filesystem: tree.filesystem,
      }).resolve();
      const view =
        "/run/zeros/view/runtime-32345678-1234-4234-8234-123456789abc";
      const supervisor = `${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs`;
      const bundled = buildSync({
        entryPoints: [
          "apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs",
        ],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node20.11",
        write: false,
        banner: {
          js: 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);',
        },
      });
      tree.write(supervisor, bundled.outputFiles[0].text);
      const probe = buildSync({
        entryPoints: ["scripts/__tests__/cloud-native-startup-probe.ts"],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node20.11",
        write: false,
      });
      tree.write(
        `${runtime.workerRoot}/dist-engine/cli.js`,
        probe.outputFiles[0].text,
      );
      tree.write(`${runtime.workerRoot}/package.json`, {});
      for (const file of [runtime.node, runtime.engineNamespace])
        unlinkSync(tree.physical(file));
      copyFileSync(process.execPath, tree.physical(runtime.node));
      chmodSync(tree.physical(runtime.node), 0o555);
      copyFileSync(rgPath, tree.physical(`${runtime.binRoot}/rg`));
      chmodSync(tree.physical(`${runtime.binRoot}/rg`), 0o555);
      for (const provider of ["claude", "codex"]) {
        copyFileSync(
          realpathSync(`/conductor/bin/${provider}`),
          tree.physical(`${runtime.binRoot}/${provider}`),
        );
        chmodSync(tree.physical(`${runtime.binRoot}/${provider}`), 0o555);
      }
      execFileSync(
        "cc",
        [
          "-std=c11",
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          "scripts/cloud-workspace-validation/sandbox/cloud-engine-namespace.c",
          "-o",
          tree.physical(runtime.engineNamespace),
        ],
        { stdio: "pipe" },
      );
      chmodSync(tree.physical(runtime.engineNamespace), 0o500);
      for (const directory of [
        "/srv/zeros/files/workspace/.git",
        "/srv/zeros/state",
        "/srv/zeros/home/agent",
        "/srv/zeros/home/capture",
        "/run/zeros/engine",
        "/run/zeros/view/settings",
        `${view}/facade/sessions`,
        `${view}/etc`,
      ])
        tree.mkdir(directory);
      for (const name of ["policy.json", "registries.conf"])
        tree.write(`/etc/containers/${name}`, "{}");
      tree.write(`${view}/etc/cloud-worker.json`, {
        ...tree.marker,
        toolchain: {
          node: runtime.node,
          supervisor,
          bwrap: "/usr/bin/bwrap",
          setpriv: "/usr/bin/setpriv",
        },
      });
      tree.write(`${view}/active-runtime.json`, tree.descriptor);
      for (const [name, target] of Object.entries({
        current: `../zeros-infra/${tree.descriptor.runtimeId}`,
        bin: "current/bin",
        worker: "current/worker",
        "manifest.json": "current/manifest.json",
        logs: "/srv/zeros/log",
        state: "/srv/zeros/state",
      }))
        tree.link(`${view}/facade/${name}`, target);
      const args = cloudEngineViewArguments("serve", 4, runtime, view);
      for (let i = 0; i < args.length; i++)
        if (["--bind", "--ro-bind"].includes(args[i])) {
          const source = args[i + 1];
          if (
            source.startsWith("/srv/zeros") ||
            source.startsWith("/run/zeros") ||
            source.startsWith("/etc/containers") ||
            source === runtime.root
          )
            args[i + 1] = tree.physical(source);
        }
      privileged = true;
      execFileSync("sudo", [
        "-n",
        "/usr/bin/chown",
        "-hR",
        "0:0",
        tree.directory,
      ]);
      for (const [directory, uid] of [
        ["/srv/zeros/state", 10003],
        ["/run/zeros/engine", 10003],
        ["/srv/zeros/home/agent", 10001],
        ["/srv/zeros/home/capture", 10002],
        ["/srv/zeros/files/workspace", 10001],
      ] as const) {
        execFileSync("sudo", [
          "-n",
          "/usr/bin/chown",
          "-hR",
          `${uid}:${uid}`,
          tree.physical(directory),
        ]);
        execFileSync("sudo", [
          "-n",
          "/usr/bin/chmod",
          "0700",
          tree.physical(directory),
        ]);
      }
      // A fresh proc avoids inherited CI masks. A fresh empty network namespace
      // ensures neither binary can authenticate or contact a provider.
      const result = spawnSync(
        "sudo",
        [
          "-n",
          "/usr/bin/unshare",
          "--mount",
          "--pid",
          "--net",
          "--fork",
          "--mount-proc",
          "--",
          "/usr/bin/bwrap",
          ...args,
        ],
        {
          env: { PATH: "/usr/bin:/bin" },
          encoding: "utf8",
          timeout: 35000,
          maxBuffer: 16384,
        },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const records = JSON.parse(result.stdout) as Record<string, unknown>[];
      // Credential-free synthetic results only, saved for LEAD/W3 to inspect.
      mkdirSync(".context/overhaul/reports", { recursive: true });
      writeFileSync(
        ".context/overhaul/reports/W5-phase4-probe.json",
        `${JSON.stringify(records, null, 2)}\n`,
      );
      expect(records[0]).toMatchObject({
        phase: "engine",
        uid: 0,
        runtimeProfile: "v4",
      });
      expect(
        records.filter(
          (record) =>
            record.phase === "claude:prepare" ||
            record.phase === "codex:prepare",
        ),
      ).toEqual([
        { phase: "claude:prepare", result: "passed" },
        { phase: "codex:prepare", result: "passed" },
      ]);
      expect(records.filter((record) => record.failure !== undefined)).toEqual([
        {
          phase: "claude-unwritable-home:prepare-canary",
          failure: "cloud_containment_canary_failed",
        },
      ]);
      for (const provider of ["claude", "codex"]) {
        expect(
          records.find(
            (record) => record.phase === `${provider}:prepare-canary`,
          ),
        ).toMatchObject({
          code: 0,
          output: "zeros-native-provider-v1",
          diagnostics: "",
        });
        expect(
          JSON.parse(
            String(
              records.find((record) => record.phase === `${provider}:identity`)
                ?.output,
            ),
          ),
        ).toMatchObject({
          uid: 10001,
          gid: 10001,
          home: "/srv/zeros/home/agent",
          capEff: "0000000000000000",
          noNewPrivs: "1",
        });
        expect(
          records.find((record) => record.phase === `${provider}:version`),
        ).toMatchObject({ code: 0, diagnostics: "" });
        expect(
          records.find((record) => record.phase === `${provider}:initialize`),
        ).toMatchObject({ result: "passed" });
      }
      expect(
        records.find(
          (record) =>
            record.phase === "claude-unwritable-home:prepare-canary" &&
            record.code !== undefined,
        ),
      ).toMatchObject({ code: 1, output: "" });
      expect(
        String(
          records.find(
            (record) =>
              record.phase === "claude-unwritable-home:prepare-canary" &&
              record.code !== undefined,
          )?.diagnostics,
        ),
      ).toContain("EACCES");
    } finally {
      if (privileged)
        execFileSync("sudo", [
          "-n",
          "/usr/bin/chown",
          "-hR",
          `${process.getuid!()}:${process.getgid!()}`,
          tree.directory,
        ]);
      tree.dispose();
    }
  },
  45000,
);
