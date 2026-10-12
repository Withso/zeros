import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { LIMITS, PROVIDERS, SCHEMA } from "./config.mjs";
import {
  hash,
  invariant,
  modelPublicIds,
  parseJson,
  plain,
  stableVersion,
} from "./contracts.mjs";
import { qualifiesAgainst } from "../cursor-curated-ids.mjs";
import { resolveCodexRuntimeSource } from "../stage-codex-cli.mjs";

function timeout(promise, milliseconds = 35_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Model listing timed out.")),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function listCodexModels(transport) {
  await transport.request("initialize", {
    clientInfo: {
      name: "zeros_runtime_models",
      title: "Zeros model listing",
      version: "1.0.0",
    },
    capabilities: { experimentalApi: true },
  });
  transport.notify("initialized", {});
  let cursor = null;
  const seen = new Set();
  const models = [];
  for (let page = 0; page < 100; page++) {
    const reply = await transport.request("model/list", {
      cursor,
      limit: 100,
      includeHidden: false,
    });
    invariant(
      Array.isArray(reply?.data) &&
        (reply.nextCursor === null ||
          (typeof reply.nextCursor === "string" &&
            reply.nextCursor.length > 0)),
      "Model listing pagination is incomplete.",
    );
    models.push(...reply.data);
    invariant(models.length <= 5000, "Model listing exceeds its bound.");
    if (reply.nextCursor === null) return models;
    invariant(
      !seen.has(reply.nextCursor),
      "Model listing repeated a page cursor.",
    );
    seen.add(reply.nextCursor);
    cursor = reply.nextCursor;
  }
  throw new Error("Model listing exceeded its page limit.");
}

export function codexTransport(binary, env, cwd) {
  const child = spawn(binary, ["app-server"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = new Map();
  let nextId = 0;
  let buffered = "";
  let total = 0;
  let stopped = false;
  const fail = () => {
    for (const waiter of pending.values())
      waiter.reject(new Error("Bundled app-server listing stopped."));
    pending.clear();
  };
  child.once("error", fail);
  child.once("exit", fail);
  child.stdin.on("error", fail);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    total += Buffer.byteLength(chunk);
    if (total > LIMITS.report) {
      fail();
      child.kill("SIGKILL");
      return;
    }
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const reply = parseJson(line);
        if (Object.hasOwn(reply, "id") && reply.method) {
          // Discovery never grants a tool/approval request.
          child.stdin.write(
            `${JSON.stringify({ id: reply.id, error: { code: -32601, message: "Listing-only client" } })}\n`,
          );
          continue;
        }
        const waiter = pending.get(reply.id);
        if (!waiter) continue;
        pending.delete(reply.id);
        if (reply.error)
          waiter.reject(new Error("Bundled model listing RPC failed."));
        else waiter.resolve(reply.result);
      } catch {
        fail();
        child.kill("SIGKILL");
      }
    }
  });
  return {
    request(method, params) {
      invariant(
        ["initialize", "model/list"].includes(method) && !stopped,
        "Only listing RPCs are permitted.",
      );
      const id = ++nextId;
      return timeout(
        new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        }),
      );
    },
    notify(method, params) {
      invariant(
        method === "initialized" && !stopped,
        "Only initialization notification is permitted.",
      );
      child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    },
    close() {
      stopped = true;
      fail();
      child.stdin.destroy();
      child.kill("SIGKILL");
    },
  };
}

export async function listClaudeModels(sdk, options) {
  // The input iterator never yields a user message. supportedModels() waits for
  // initialization/control metadata only. No prompt, agent turn or tool is sent.
  let release;
  const closed = new Promise((resolve) => {
    release = resolve;
  });
  const prompt = {
    async *[Symbol.asyncIterator]() {
      await closed;
    },
  };
  const abortController = new AbortController();
  const query = sdk.query({
    prompt,
    options: {
      ...options,
      abortController,
      settingSources: [],
      tools: [],
      mcpServers: {},
      hooks: {},
      permissionMode: "dontAsk",
      persistSession: false,
      stderr: () => {},
    },
  });
  try {
    const result = await timeout(query.supportedModels());
    invariant(Array.isArray(result), "Claude model listing changed shape.");
    return result;
  } finally {
    abortController.abort();
    release();
    query.close();
  }
}

export async function listCursorModels(sdk, apiKey) {
  const result = await timeout(sdk.Cursor.models.list({ apiKey }));
  invariant(Array.isArray(result), "Cursor model listing changed shape.");
  return result;
}

const claudeBaseId = (value) =>
  value.replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");

export function normalizeModels(provider, rows, { catalog, publicIds = {} }) {
  invariant(
    Array.isArray(rows) && rows.length > 0 && rows.length <= 5000,
    "Empty or oversized model listing.",
  );
  const allowed = modelPublicIds(catalog, provider, publicIds);
  const rawIds = new Set();
  const ids = new Set();
  const items = rows
    .map((row) => {
      invariant(plain(row), "Invalid model record.");
      const value = row.id ?? row.value ?? row.model;
      invariant(
        typeof value === "string" &&
          value.length > 0 &&
          value.length <= 200 &&
          !/[\s\u0000-\u001f]/.test(value),
        "Invalid model identity.",
      );
      if (provider === "claude") {
        // Native resolution wins over a curated selector alias, which may lag
        // the provider. Context modifiers and dated revisions share a base ID.
        // This is only presence matching; disclosure still uses the exact allowlist.
        const resolved =
          typeof row.resolvedModel === "string" ? row.resolvedModel.trim() : "";
        rawIds.add(
          claudeBaseId(resolved || catalog.aliases?.claude?.[value] || value),
        );
      } else rawIds.add(value);
      const visible =
        allowed.has(value) && !row.hidden && !row.isHidden && !row.private;
      // Account-only/unknown IDs are not copied into a public issue or artifact.
      const id = visible
        ? value
        : `unreviewed-${hash([provider, value]).slice(0, 20)}`;
      invariant(!ids.has(id), "Model listing contains duplicate identities.");
      ids.add(id);
      const item = { id, public: visible };
      if (!visible) return item;
      for (const key of [
        "isDefault",
        "supportsImages",
        "supportsTools",
        "supportsFast",
        "supportsReasoning",
      ])
        if (typeof row[key] === "boolean") item[key] = row[key];
      if (provider === "claude") {
        if (typeof row.supportsEffort === "boolean")
          item.supportsReasoning = row.supportsEffort;
        if (typeof row.supportsFastMode === "boolean")
          item.supportsFast = row.supportsFastMode;
      }
      if (provider === "codex") {
        const serviceTiers = Array.isArray(row.serviceTiers)
          ? row.serviceTiers
          : undefined;
        const speedTiers = Array.isArray(row.additionalSpeedTiers)
          ? row.additionalSpeedTiers
          : undefined;
        if (serviceTiers || speedTiers)
          item.supportsFast =
            (serviceTiers ?? []).some((tier) => tier?.id === "fast") ||
            (speedTiers ?? []).includes("fast");
      }
      for (const key of [
        "contextWindow",
        "maxContextTokens",
        "maxOutputTokens",
      ])
        if (
          Number.isSafeInteger(row[key]) &&
          row[key] >= 0 &&
          row[key] <= 100_000_000
        )
          item[key] = row[key];
      const effort = row.defaultReasoningEffort ?? row.defaultEffort;
      if (typeof effort === "string" && /^[a-z0-9_-]{1,32}$/.test(effort))
        item.defaultEffort = effort;
      const efforts =
        provider === "claude" && row.supportsEffort === false
          ? []
          : ((provider === "claude" ? row.supportedEffortLevels : undefined) ??
            row.supportedReasoningEfforts ??
            row.effortLevels);
      if (Array.isArray(efforts))
        item.efforts = efforts
          .map((e) => (typeof e === "string" ? e : e?.reasoningEffort))
          .filter((e) => typeof e === "string" && /^[a-z0-9_-]{1,32}$/.test(e))
          .slice(0, 16)
          .sort();
      if (Array.isArray(row.aliases))
        item.aliases = row.aliases
          .filter((alias) => allowed.has(alias))
          .slice(0, 32)
          .sort();
      // Cursor describes options in parameters/variants. Publish only bounded
      // structural fingerprints; these can change without a package version bump.
      for (const key of ["parameters", "variants", "inputModalities"])
        if (row[key] !== undefined) item[`${key}Digest`] = hash(row[key]);
      return item;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const missing = (catalog.families?.[provider] ?? [])
    .filter((model) =>
      provider === "cursor"
        ? !qualifiesAgainst(model, rawIds)
        : provider === "claude"
          ? !rawIds.has(claudeBaseId(model.value)) &&
            model.liveRequired !== true
          : !rawIds.has(model.value) &&
            model.liveRequired !== true &&
            !Object.entries(catalog.aliases?.[provider] ?? {}).some(
              ([alias, target]) => target === model.value && rawIds.has(alias),
            ),
    )
    .map((model) => model.value);
  return {
    items,
    requiredCuratedMissing: missing,
    unreviewedCount: items.filter((item) => !item.public).length,
  };
}

export async function discoverModels(
  provider,
  {
    root,
    env = process.env,
    scope = "alpha-test",
    now = new Date().toISOString(),
    loadSdk,
    makeTransport = codexTransport,
    additionalPublicIds = {},
  } = {},
) {
  invariant(
    Object.hasOwn(PROVIDERS, provider) && /^[a-z][a-z0-9-]{0,39}$/.test(scope),
    "Invalid model discovery scope.",
  );
  const base = {
    schema: SCHEMA,
    id: `${provider}-models`,
    provider,
    kind: "models",
    observedAt: now,
    url: PROVIDERS[provider].notes,
  };
  const configured =
    provider === "claude"
      ? Boolean(env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN)
      : provider === "cursor"
        ? Boolean(env.CURSOR_API_KEY)
        : Boolean(env.OPENAI_API_KEY || env.AGENT_RUNTIME_CODEX_AUTH_JSON);
  if (!configured)
    return {
      ...base,
      status: "unavailable",
      reason: "dedicated-test-credentials-unconfigured",
      data: {},
    };
  let directory;
  let transport;
  try {
    const manifest = parseJson(
      readFileSync(join(root, "package.json"), "utf8"),
    );
    const version = manifest.dependencies?.[PROVIDERS[provider].package];
    const installed = parseJson(
      readFileSync(
        join(
          root,
          "node_modules",
          ...PROVIDERS[provider].package.split("/"),
          "package.json",
        ),
        "utf8",
      ),
    );
    invariant(
      stableVersion(version) && installed.version === version,
      "Discovery runtime does not match its exact pin.",
    );
    const catalog = parseJson(
      readFileSync(join(root, "catalogs/models-v1.json"), "utf8"),
    );
    directory = mkdtempSync(join(tmpdir(), "zeros-runtime-models-"));
    const nativeEnv = {
      PATH: env.PATH ?? "",
      HOME: directory,
      LANG: "C.UTF-8",
      DISABLE_TELEMETRY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    };
    const require = createRequire(join(root, "package.json"));
    const load =
      loadSdk ??
      (async () =>
        import(
          pathToFileURL(require.resolve(PROVIDERS[provider].package)).href
        ));
    let rows;
    if (provider === "claude") {
      const sdkEnv = {
        ...nativeEnv,
        CLAUDE_CONFIG_DIR: directory,
        ...(env.ANTHROPIC_API_KEY
          ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }
          : { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN }),
      };
      rows = await listClaudeModels(await load(), {
        cwd: directory,
        env: sdkEnv,
      });
    } else if (provider === "cursor") {
      rows = await listCursorModels(await load(), env.CURSOR_API_KEY);
    } else {
      const auth = env.AGENT_RUNTIME_CODEX_AUTH_JSON
        ? parseJson(env.AGENT_RUNTIME_CODEX_AUTH_JSON, 64 * 1024)
        : { OPENAI_API_KEY: env.OPENAI_API_KEY };
      invariant(plain(auth), "Invalid dedicated Codex auth snapshot.");
      writeFileSync(join(directory, "auth.json"), JSON.stringify(auth), {
        mode: 0o600,
      });
      const runtime = resolveCodexRuntimeSource();
      invariant(
        runtime.version === version,
        "Resolved bundled Codex runtime differs from the pin.",
      );
      invariant(
        realpathSync(
          runtime.files.find((file) => file.relativePath === "package.json")
            .source,
        ) ===
          realpathSync(join(root, "node_modules/@openai/codex/package.json")),
        "Discovery resolved a different checkout's Codex installation.",
      );
      const binary = runtime.files.find(
        (file) => file.relativePath === runtime.binaryRelativePath,
      )?.source;
      invariant(binary, "Bundled Codex executable is unavailable.");
      transport = makeTransport(
        binary,
        { ...nativeEnv, CODEX_HOME: directory },
        directory,
      );
      rows = await timeout(listCodexModels(transport));
    }
    const data = normalizeModels(provider, rows, {
      catalog,
      publicIds: additionalPublicIds,
    });
    return {
      ...base,
      status: "complete",
      data: {
        ...data,
        scope,
        runtimeVersion: version,
        freshness: "provider-cache-age-unknown",
        evidence: "bundled-runtime-account-listing",
      },
    };
  } catch {
    return {
      ...base,
      status: "incomplete",
      reason: "bundled-listing-incomplete",
      data: {},
    };
  } finally {
    transport?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

export async function discoverAll(options) {
  return Promise.all(
    Object.keys(PROVIDERS).map((provider) => discoverModels(provider, options)),
  );
}
