#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { rgPath } from "@vscode/ripgrep";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(
  root,
  "apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs",
);
const output = path.join(root, "binaries/zsr-supervisor.mjs");
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
const gitDispatchEntry = path.join(
  root,
  "apps/desktop/src/engine/agents/containment/zsr-git-dispatch.c",
);
const gitDispatchOutput = path.join(root, "binaries/zsr-git-dispatch");
const ripgrepOutput = path.join(root, "binaries/zsr-rg");

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
await copyFile(containerWorkerEntry, containerWorkerOutput);
await chmod(containerWorkerOutput, 0o755);
await copyFile(orbStackHostEntry, orbStackHostOutput);
await chmod(orbStackHostOutput, 0o755);
const ripgrepTemporaryOutput = `${ripgrepOutput}.tmp-${process.pid}`;
await rm(ripgrepTemporaryOutput, { force: true });
await copyFile(rgPath, ripgrepTemporaryOutput);
await chmod(ripgrepTemporaryOutput, 0o555);
await rename(ripgrepTemporaryOutput, ripgrepOutput);
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
  // The narrow Git integration dispatcher is built with the same flags and
  // -Werror posture as every other helper that runs inside the fence.
  const gitDispatchTemporaryOutput = `${gitDispatchOutput}.tmp-${process.pid}`;
  await rm(gitDispatchTemporaryOutput, { force: true });
  const gitDispatchCompiled = spawnSync(
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
      gitDispatchEntry,
      "-o",
      gitDispatchTemporaryOutput,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (gitDispatchCompiled.status !== 0) {
    await rm(gitDispatchTemporaryOutput, { force: true });
    throw new Error(
      `could not compile Git integration dispatcher: ${(
        gitDispatchCompiled.stderr || gitDispatchCompiled.stdout
      ).trim()}`,
    );
  }
  await chmod(gitDispatchTemporaryOutput, 0o555);
  await rename(gitDispatchTemporaryOutput, gitDispatchOutput);
}
console.log(
  `[build-zsr-supervisor] wrote ${output}, ${containerWorkerOutput}, ${orbStackHostOutput}, ${orbStackCloudInitOutput}, ${ripgrepOutput}${
    process.platform === "darwin"
      ? `, ${macosProcessDomainOutput}, and ${gitDispatchOutput}`
      : ""
  }`,
);
