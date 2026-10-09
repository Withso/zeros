import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build, version as esbuildVersion } from "esbuild";
import ts from "typescript";

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
export { CloudTransport } from "./apps/desktop/src/engine/transport/cloud";
export * as engineReplies from "runtime-skew:engine-replies";
export * as failureDisplay from "runtime-skew:failure-display";
export * as controlCommands from "runtime-skew:control-commands";
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
      await readFile(fileURLToPath(import.meta.url)),
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
    // Keep CommonJS Node dependencies outside the ESM source bundle. The
    // current pump imports the qualified local queue guard, but this legacy
    // gate never constructs a queue or opens a SQLite database. Bundling its
    // package rewrites builtin requires into an unsupported ESM shim.
    external: ["ws", "better-sqlite3"],
    logLevel: "silent",
    plugins: [
      {
        name: "pinned-cloud-contracts",
        setup(builder) {
          // Source-capture the real portable handler bodies without importing
          // the engine constructor, database or native bindings. Missing or
          // renamed handlers fail closed; no current-source substitution.
          builder.onResolve({ filter: /^runtime-skew:/ }, args => ({
            path: args.path, namespace: "skew-derived",
          }));
          builder.onLoad({ filter: /.*/, namespace: "skew-derived" }, async args => {
            if (args.path === "runtime-skew:control-commands") {
              const file = "apps/control-plane/src/cloud-workspaces/commands.ts";
              const source = ts.createSourceFile(file, await readSource(file), ts.ScriptTarget.Latest, true);
              const variables = source.statements.filter(ts.isVariableStatement);
              const request = variables.find(node => node.declarationList.declarations.some(declaration =>
                declaration.name.getText(source) === "CloudCommandRequestSchema"));
              const declarations = new Map();
              for (const node of variables.filter(node => node.end <= request?.end))
                for (const declaration of node.declarationList.declarations)
                  if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, node);
              const selected = new Set();
              const capture = name => {
                const node = declarations.get(name);
                if (!node) throw new Error("runtime_skew_source_unavailable");
                if (selected.has(node)) return;
                selected.add(node);
                const visit = child => {
                  if (ts.isIdentifier(child) && declarations.has(child.text)) capture(child.text);
                  ts.forEachChild(child, visit);
                };
                for (const declaration of node.declarationList.declarations)
                  if (declaration.initializer) visit(declaration.initializer);
              };
              for (const name of ["CloudCommandRequestSchema", "CloudCommandSettleSchema", "CloudNativeResultSchema"]) capture(name);
              // The standalone CP schema uses Zod 3. Capture its actual schema
              // dependency closure in source order. Negotiated boot/mirror
              // declarations have separate dependencies and are not part of
              // this legacy contract slice. Every selected declaration still
              // comes from the exact current or frozen source cohort.
              return { loader: "ts", resolveDir: path.join(root, "apps/control-plane"), contents: `
                import { z } from "zod";
                ${variables.filter(node => selected.has(node)).map(node => node.getText(source)).join("\n")}
              ` };
            }
            const engine = args.path === "runtime-skew:engine-replies";
            if (!engine && args.path !== "runtime-skew:failure-display")
              throw new Error("runtime_skew_source_path_invalid");
            const file = engine ? "apps/desktop/src/engine/zeros-engine.ts"
              : "apps/desktop/src/renderer/features/agent/cloud-admission-failure.ts";
            const source = ts.createSourceFile(file, await readSource(file), ts.ScriptTarget.Latest, true);
            const declarations = engine
              ? source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ZerosEngine")?.members
              : source.statements;
            const names = engine ? ["handleCloudCommandOperation", "handleLegacyCloudAction"]
              : ["cloudAdmissionFailureCode", "classifyCloudAdmissionFailure"];
            const bodies = names.map(name => {
              const node = declarations?.find(node => node.name?.getText(source) === name);
              if (!node || !(engine ? ts.isMethodDeclaration(node) : ts.isFunctionDeclaration(node)))
                throw new Error("runtime_skew_source_unavailable");
              return node.getText(source);
            });
            let advertised = 0;
            if (engine) {
              const visit = node => {
                if (ts.isPropertyAssignment(node) && node.name.getText(source) === "cloudTurnProtocolVersion") {
                  if (!ts.isNumericLiteral(node.initializer) || node.initializer.text !== "1")
                    throw new Error("runtime_skew_turn_version_incompatible");
                  advertised = 1;
                }
                ts.forEachChild(node, visit);
              };
              ts.forEachChild(source, visit);
            }
            return { loader: "ts", resolveDir: root, contents: engine ? `
              import { CloudCommandRuntimeError } from "./apps/desktop/src/engine/cloud-command-client";
              import { legacyCloudCommandResponse } from "@zeros/protocol/cloud-commands";
              import { createMessage } from "@zeros/protocol/messages";
              export const cloudTurnProtocolVersion = ${advertised};
              export class EngineReplyContract { ${bodies.join("\n")} }
            ` : `
              import { isCloudWorkspace } from "./apps/desktop/src/renderer/platform/bridge/cloud-workspace-key";
              import { CLOUD_WORKSPACE_V2_REQUIRED_MESSAGE } from "./apps/desktop/src/renderer/platform/cloud-workspace-execution";
              // The gate exercises generic receipt display only. Unsupported
              // model selection is deliberately unavailable in this slice.
              const modelsForAgent = () => { throw new Error("runtime_skew_formatter_scope_exceeded"); };
              ${bodies.join("\n")}
            ` };
          });
          builder.onResolve(
            { filter: /^(?:\.|@zeros\/protocol)/ },
            async (args) => {
              if (
                args.namespace !== "pinned-source" && args.namespace !== "skew-derived" &&
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
              resolveDir: path.dirname(path.join(root, args.path)),
            }),
          );
        },
      },
    ],
  });
  // Runtime and desktop may share a pin. Keep concurrent atomic writes apart.
  const temporary = `${artifact}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, result.outputFiles[0].contents);
  await rename(temporary, artifact);
  // Current source is rebuilt and re-imported on each invocation, including
  // tests which mutate contracts. Immutable cohorts are cached by commit.
  return import(
    `${pathToFileURL(artifact).href}${pin ? "" : `?run=${randomUUID()}`}`
  );
}
