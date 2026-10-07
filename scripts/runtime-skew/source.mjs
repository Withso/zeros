import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build, version as esbuildVersion } from "esbuild";

export const root = fileURLToPath(new URL("../../", import.meta.url));
const execute = promisify(execFile);
const entry = `
export * as commands from "@zeros/protocol/cloud-commands";
export * as actions from "@zeros/protocol/cloud-actions";
export * as events from "@zeros/protocol/cloud-events";
export * as version from "@zeros/protocol/version";
export * as schemas from "@zeros/protocol/schemas";
export { CloudAgentConnection } from "./apps/desktop/src/renderer/platform/bridge/cloud-agent-connection";
export * as pty from "./apps/desktop/src/renderer/platform/bridge/pty-bridge";
export * as wire from "./apps/desktop/src/renderer/platform/bridge/cloud-runtime-wire";
export { CloudCommandRuntime } from "./apps/desktop/src/engine/cloud-command-runtime";
export { CloudEventRuntime } from "./apps/desktop/src/engine/cloud-event-runtime";
export { CloudActionRuntime } from "./apps/desktop/src/engine/cloud-action-runtime";
export * as commandTransport from "./apps/desktop/src/engine/cloud-command-client";
export * as eventTransport from "./apps/desktop/src/engine/cloud-event-client";
export * as registration from "./apps/desktop/src/engine/cloud-runtime-registration";
`;
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function git(args) {
  try {
    return (
      await execute("git", ["--no-lazy-fetch", ...args], {
        cwd: root,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout;
  } catch {
    // Never echo source, git stderr, or inherited environment in diagnostics.
    throw new Error(
      "runtime_skew_source_unavailable: fetch the pinned Git history before running the gate",
    );
  }
}

/** Compile only contract/client/pump modules. Git objects, never current aliases,
 * supply every relative and @zeros/protocol import for a frozen cohort. */
export async function loadContractSource(pin = null) {
  if (pin) {
    if (
      !/^[a-f0-9]{40}$/.test(pin.sourceCommit) ||
      !/^[a-f0-9]{40}$/.test(pin.sourceTree)
    )
      throw new Error("runtime_skew_pin_invalid");
    if (
      (await git(["rev-parse", `${pin.sourceCommit}^{tree}`])).trim() !==
      pin.sourceTree
    )
      throw new Error("runtime_skew_pin_digest_mismatch");
  }
  const cache = path.join(root, ".context/runtime-skew");
  await mkdir(cache, { recursive: true });
  const key = digest(
    [
      entry,
      pin?.sourceCommit ?? "current",
      esbuildVersion,
      await readFile(path.join(root, "pnpm-lock.yaml")),
    ].join("\0"),
  );
  const artifact = path.join(
    cache,
    `${pin?.sourceCommit ?? "current"}-${key}.mjs`,
  );
  if (pin) {
    try {
      await readFile(artifact);
      return import(pathToFileURL(artifact).href);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const sources = new Map();
  const readSource = async (file) => {
    if (!sources.has(file))
      sources.set(
        file,
        pin
          ? git(["show", `${pin.sourceCommit}:${file}`])
          : readFile(path.join(root, file), "utf8"),
      );
    return sources.get(file);
  };
  const result = await build({
    stdin: {
      contents: entry,
      resolveDir: root,
      sourcefile: "skew-entry.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
    plugins: [
      {
        name: "pinned-cloud-contracts",
        setup(builder) {
          builder.onResolve(
            { filter: /^(?:\.|@zeros\/protocol)/ },
            async (args) => {
              if (
                args.namespace !== "pinned-source" &&
                !args.importer.endsWith("skew-entry.ts")
              )
                return;
              const base = args.path.startsWith("@zeros/protocol/")
                ? `packages/protocol/src/${args.path.slice("@zeros/protocol/".length)}`
                : path.posix.normalize(
                    path.posix.join(
                      args.namespace === "pinned-source"
                        ? path.posix.dirname(args.importer)
                        : ".",
                      args.path,
                    ),
                  );
              if (base.startsWith("../") || path.isAbsolute(base))
                throw new Error("runtime_skew_source_path_invalid");
              const candidates = /\.(?:ts|mts|mjs|js)$/.test(base)
                ? [base.replace(/\.js$/, ".ts"), base]
                : [`${base}.ts`, `${base}.mjs`, `${base}/index.ts`];
              for (const file of [...new Set(candidates)]) {
                try {
                  await readSource(file);
                  return { path: file, namespace: "pinned-source" };
                } catch {
                  /* A missing candidate is not permission to use current code. */
                }
              }
              throw new Error(`runtime_skew_source_unavailable: ${base}`);
            },
          );
          builder.onLoad(
            { filter: /.*/, namespace: "pinned-source" },
            async (args) => ({
              contents: await readSource(args.path),
              loader: args.path.endsWith(".mjs") ? "js" : "ts",
              resolveDir: root,
            }),
          );
        },
      },
    ],
  });
  const temporary = `${artifact}.${process.pid}.tmp`;
  await writeFile(temporary, result.outputFiles[0].contents);
  await rename(temporary, artifact);
  // Current source is rebuilt and re-imported on each invocation, including
  // tests which mutate contracts. Immutable cohorts are cached by commit.
  return import(
    `${pathToFileURL(artifact).href}${pin ? "" : `?run=${Date.now()}`}`
  );
}
