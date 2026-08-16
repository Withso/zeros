#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(
  root,
  "apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs",
);
const output = path.join(root, "binaries/zsr-supervisor.mjs");
const bridgeEntry = path.join(
  root,
  "apps/desktop/src/engine/agents/containment/zsr-network-bridge.mjs",
);
const bridgeOutput = path.join(root, "binaries/zsr-network-bridge.mjs");
const containerWorkerEntry = path.join(
  root,
  "apps/desktop/src/engine/agents/containment/zsr-container-worker.mjs",
);
const containerWorkerOutput = path.join(
  root,
  "binaries/zsr-container-worker.mjs",
);
const orbStackHostEntry = path.join(
  root,
  "apps/desktop/src/engine/agents/containment/zsr-orbstack-container-host.mjs",
);
const orbStackHostOutput = path.join(
  root,
  "binaries/zsr-orbstack-container-host.mjs",
);
const orbStackCloudInitEntry = path.join(
  root,
  "apps/desktop/src/engine/agents/containment/zsr-orbstack-cloud-init.yaml",
);
const orbStackCloudInitOutput = path.join(
  root,
  "binaries/zsr-orbstack-cloud-init.yaml",
);
const macosProcessDomainEntry = path.join(
  root,
  "apps/desktop/src/engine/agents/containment/zsr-macos-process-domain.c",
);
const macosProcessDomainOutput = path.join(
  root,
  "binaries/zsr-macos-process-domain",
);
const macosPortBindEntry = path.join(
  root,
  "apps/desktop/src/engine/agents/containment/zsr-macos-port-bind.c",
);
const macosPortBindOutput = path.join(
  root,
  "binaries/zsr-macos-port-bind.dylib",
);

await mkdir(path.dirname(output), { recursive: true });
await build({
  entryPoints: [entry],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20.11",
  sourcemap: false,
  legalComments: "none",
  // Some transitive SRT dependencies retain guarded CommonJS `require()`
  // calls for Node built-ins. esbuild's ESM dynamic-require shim needs a real
  // module-scoped require in packaged builds (where no outer CJS wrapper
  // exists), otherwise the first crypto/net import fails at runtime.
  banner: {
    js: 'import { createRequire as __zsrCreateRequire } from "node:module"; const require = __zsrCreateRequire(import.meta.url);',
  },
});
await chmod(output, 0o755);
await copyFile(bridgeEntry, bridgeOutput);
await chmod(bridgeOutput, 0o755);
await copyFile(containerWorkerEntry, containerWorkerOutput);
await chmod(containerWorkerOutput, 0o755);
await copyFile(orbStackHostEntry, orbStackHostOutput);
await chmod(orbStackHostOutput, 0o755);
const cloudInitTemporaryOutput = `${orbStackCloudInitOutput}.tmp-${process.pid}`;
await rm(cloudInitTemporaryOutput, { force: true });
await copyFile(orbStackCloudInitEntry, cloudInitTemporaryOutput);
await chmod(cloudInitTemporaryOutput, 0o444);
await rename(cloudInitTemporaryOutput, orbStackCloudInitOutput);
if (process.platform === "darwin") {
  const architecture =
    process.arch === "arm64"
      ? "arm64"
      : process.arch === "x64"
        ? "x86_64"
        : null;
  if (!architecture) {
    throw new Error(`unsupported macOS helper architecture ${process.arch}`);
  }
  const temporaryOutput = `${macosProcessDomainOutput}.tmp-${process.pid}`;
  await rm(temporaryOutput, { force: true });
  const compiled = spawnSync(
    "/usr/bin/xcrun",
    [
      "--sdk",
      "macosx",
      "clang",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      "-mmacosx-version-min=11.0",
      "-arch",
      architecture,
      macosProcessDomainEntry,
      "-o",
      temporaryOutput,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (compiled.status !== 0) {
    await rm(temporaryOutput, { force: true });
    throw new Error(
      `could not compile macOS process-domain helper: ${(
        compiled.stderr || compiled.stdout
      ).trim()}`,
    );
  }
  await chmod(temporaryOutput, 0o555);
  await rename(temporaryOutput, macosProcessDomainOutput);
  const portBindTemporaryOutput = `${macosPortBindOutput}.tmp-${process.pid}`;
  await rm(portBindTemporaryOutput, { force: true });
  const portBindCompiled = spawnSync(
    "/usr/bin/xcrun",
    [
      "--sdk",
      "macosx",
      "clang",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      "-mmacosx-version-min=11.0",
      "-arch",
      architecture,
      "-dynamiclib",
      macosPortBindEntry,
      "-o",
      portBindTemporaryOutput,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (portBindCompiled.status !== 0) {
    await rm(portBindTemporaryOutput, { force: true });
    throw new Error(
      `could not compile macOS bind-port interposer: ${(
        portBindCompiled.stderr || portBindCompiled.stdout
      ).trim()}`,
    );
  }
  await chmod(portBindTemporaryOutput, 0o555);
  await rename(portBindTemporaryOutput, macosPortBindOutput);
}
console.log(
  `[build-zsr-supervisor] wrote ${output}, ${bridgeOutput}, ${containerWorkerOutput}, ${orbStackHostOutput}, ${orbStackCloudInitOutput}${
    process.platform === "darwin"
      ? `, ${macosProcessDomainOutput}, and ${macosPortBindOutput}`
      : ""
  }`,
);
