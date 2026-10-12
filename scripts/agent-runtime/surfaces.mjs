import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFileSync, readdirSync, realpathSync, lstatSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { LIMITS, PROVIDERS } from "./config.mjs";
import {
  canonical,
  hash,
  invariant,
  parseJson,
  plain,
  sha,
  stableVersion,
} from "./contracts.mjs";
import { publicFetch, publicUrl, readBounded } from "./network.mjs";

const DECLARATION = /\.d\.(?:ts|mts|cts)$/;
const SCHEMAS = [
  "codex_app_server_protocol.schemas.json",
  "codex_app_server_protocol.v2.schemas.json",
];
export const GENERATED =
  "apps/desktop/src/engine/agents/adapters/codex/generated";

/** Parse npm's archive in memory. Nothing is extracted or executed. */
export function declarationArchive(compressed, integrity) {
  invariant(
    Buffer.isBuffer(compressed) && compressed.length <= LIMITS.patch,
    "Package archive exceeds its bound.",
  );
  const sri = /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity ?? "");
  invariant(sri, "Package archive has no supported integrity digest.");
  const actual = createHash(sri[1]).update(compressed).digest();
  const expected = Buffer.from(sri[2], "base64");
  invariant(
    expected.length === actual.length && timingSafeEqual(expected, actual),
    "Package archive integrity mismatch.",
  );
  const tar = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  const files = {};
  let total = 0;
  let entries = 0;
  let extendedPath = null;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    invariant(++entries <= 20_000, "Package archive has too many entries.");
    const string = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const sizeText = string(124, 12).trim();
    invariant(/^[0-7]+$/.test(sizeText), "Unsupported archive size encoding.");
    const size = Number.parseInt(sizeText, 8);
    invariant(
      Number.isSafeInteger(size) &&
        size >= 0 &&
        offset + 512 + size <= tar.length,
      "Truncated package archive.",
    );
    const type = string(156, 1) || "0";
    const prefix = string(345, 155);
    const content = tar.subarray(offset + 512, offset + 512 + size);
    const filename =
      extendedPath ?? [prefix, string(0, 100)].filter(Boolean).join("/");
    extendedPath = null;
    if (type === "x") {
      invariant(size <= 16_384, "Oversized archive metadata.");
      const metadata = content.toString("utf8");
      // npm/tar uses per-file POSIX path records for long declaration names.
      for (const record of metadata.split("\n").filter(Boolean)) {
        const match = /^(\d+) ([^=]+)=(.*)$/.exec(record);
        invariant(
          match && Number(match[1]) === Buffer.byteLength(record) + 1,
          "Invalid archive extended metadata.",
        );
        if (match[2] === "path") extendedPath = match[3];
        invariant(match[2] !== "linkpath", "Archive links are forbidden.");
      }
    } else {
      invariant(!["1", "2"].includes(type), "Archive links are forbidden.");
      invariant(["0", "5"].includes(type), "Unsupported archive entry type.");
      invariant(
        filename.startsWith("package/") &&
          !filename.includes("\\") &&
          !/[\0\r\n]/.test(filename) &&
          !filename.split("/").some((part) => part === ".." || part === "."),
        "Unsafe archive path.",
      );
      if (
        type === "0" &&
        (DECLARATION.test(filename) || filename === "package/package.json")
      ) {
        total += size;
        invariant(
          size <= LIMITS.file &&
            total <= LIMITS.patch &&
            !Object.hasOwn(files, filename.slice(8)),
          "Declaration archive is oversized or ambiguous.",
        );
        files[filename.slice(8)] = content.toString("utf8");
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  invariant(
    typeof files["package.json"] === "string",
    "Archive has no package manifest.",
  );
  return files;
}

export async function releasedDeclarations(provider, version, options = {}) {
  invariant(stableVersion(version), "Invalid declaration version.");
  const name = PROVIDERS[provider].package;
  const { data } = await publicFetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
    { ...options, json: true },
  );
  invariant(
    data.name === name && data.version === version,
    "Registry declaration identity mismatch.",
  );
  const url = publicUrl(data.dist?.tarball);
  invariant(
    url.hostname === "registry.npmjs.org",
    "Package archive is outside the registry.",
  );
  const response = await (options.fetchImpl ?? fetch)(url.href, {
    redirect: "error",
    signal: AbortSignal.timeout(LIMITS.timeout),
  });
  invariant(response.ok, "Package archive is unavailable.");
  const files = declarationArchive(
    await readBounded(response, LIMITS.patch),
    data.dist.integrity,
  );
  const manifest = parseJson(files["package.json"]);
  invariant(
    manifest.name === name && manifest.version === version,
    "Archive manifest identity mismatch.",
  );
  return declarationSurface(files, manifest);
}

export function declarationSurface(files, manifest) {
  const entry = String(manifest.types ?? manifest.typings ?? "").replace(
    /^\.\//,
    "",
  );
  invariant(
    DECLARATION.test(entry) && Object.hasOwn(files, entry),
    "Package declaration entry is unavailable.",
  );
  const records = {};
  const printer = ts.createPrinter({
    removeComments: true,
    newLine: ts.NewLineKind.LineFeed,
  });
  // Cursor ships equivalent ESM/CJS declarations. Analyze the declared format only.
  const prefix = entry.includes("/")
    ? entry.slice(0, entry.lastIndexOf("/") + 1)
    : "";
  for (const [file, text] of Object.entries(files).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!DECLARATION.test(file) || !file.startsWith(prefix)) continue;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    invariant(
      source.parseDiagnostics.length === 0,
      "Declaration parser could not read the candidate.",
    );
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) || ts.isEmptyStatement(statement))
        continue;
      const name =
        statement.name?.getText(source) ??
        (ts.isVariableStatement(statement)
          ? statement.declarationList.declarations
              .map((d) => d.name.getText(source))
              .join(",")
          : ts.isExportDeclaration(statement)
            ? (statement.moduleSpecifier?.getText(source) ??
              statement.exportClause?.getText(source))
            : null);
      invariant(
        name,
        "Unrecognized declaration surface; manual parser update required.",
      );
      const key = `${file}:${name}`;
      const normalized = printer
        .printNode(ts.EmitHint.Unspecified, statement, source)
        .trim();
      records[key] = [...(records[key] ?? []), normalized];
    }
  }
  invariant(
    Object.keys(records).length > 0 && Object.keys(records).length <= 20_000,
    "Empty or oversized declaration surface.",
  );
  return Object.fromEntries(
    Object.entries(records).map(([key, values]) => [key, values.sort()]),
  );
}

export function installedDeclarationSurface(root, provider, version) {
  const directory = realpathSync(
    join(root, "node_modules", ...PROVIDERS[provider].package.split("/")),
  );
  const manifest = parseJson(
    readFileSync(join(directory, "package.json"), "utf8"),
  );
  invariant(
    manifest.version === version,
    "Installed declaration version does not match the pin.",
  );
  const files = {};
  let bytes = 0;
  function walk(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name);
      invariant(
        !entry.isSymbolicLink(),
        "Declaration package contains a symlink.",
      );
      if (entry.isDirectory() && entry.name !== "node_modules") walk(file);
      else if (entry.isFile() && DECLARATION.test(entry.name)) {
        invariant(
          lstatSync(file).size <= LIMITS.file,
          "Declaration file exceeds its bound.",
        );
        const text = readFileSync(file, "utf8");
        bytes += Buffer.byteLength(text);
        invariant(
          bytes <= LIMITS.patch && Object.keys(files).length < LIMITS.files,
          "Declaration package exceeds its bound.",
        );
        files[relative(directory, file).split("\\").join("/")] = text;
      }
    }
  }
  walk(directory);
  return declarationSurface(files, manifest);
}

const SCHEMA_MAPS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "dependentSchemas",
  "dependencies",
]);
const SUBSCHEMAS = new Set([
  "items",
  "prefixItems",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);

export function normalizeSchema(value, depth = 0, context = "schema") {
  invariant(depth < 100, "Protocol schema exceeds its depth bound.");
  if (Array.isArray(value))
    return value.map((child) => normalizeSchema(child, depth + 1, context));
  if (!plain(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          context !== "schema" ||
          !["description", "title", "$comment", "examples"].includes(key),
      )
      .map(([key, child]) => {
        // Maps contain authored wire names; const/default/enum and extension
        // values are data. Only schema objects carry removable annotations.
        const childContext =
          context === "map"
            ? "schema"
            : context === "schema" && SCHEMA_MAPS.has(key)
              ? "map"
              : context === "schema" && SUBSCHEMAS.has(key)
                ? "schema"
                : "data";
        const normalized = normalizeSchema(child, depth + 1, childContext);
        if (
          context === "schema" &&
          ["required", "enum"].includes(key) &&
          Array.isArray(normalized)
        )
          normalized.sort((a, b) => canonical(a).localeCompare(canonical(b)));
        return [key, normalized];
      }),
  );
}

export function schemaSurface(files) {
  const result = {};
  for (const [name, text] of Object.entries(files)) {
    const schema = parseJson(text, LIMITS.file);
    invariant(
      plain(schema) &&
        (plain(schema.definitions) ||
          plain(schema.$defs) ||
          schema.type ||
          schema.oneOf ||
          schema.anyOf),
      "Protocol schema changed shape.",
    );
    const { definitions, $defs, ...root } = schema;
    result[`${name}:root`] = normalizeSchema(root);
    for (const [key, value] of Object.entries(definitions ?? $defs ?? {}))
      result[`${name}:${key}`] = normalizeSchema(value);
  }
  return result;
}

export function compareSurfaces(provider, before, after) {
  const changes = [];
  for (const subject of [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].sort()) {
    const old = before[subject] ?? null;
    const next = after[subject] ?? null;
    if (canonical(old) === canonical(next)) continue;
    const kind = old === null ? "added" : next === null ? "removed" : "changed";
    changes.push({
      provider,
      kind,
      subject,
      fingerprint: hash([provider, subject, old, next]),
      before: hash(old),
      after: hash(next),
    });
  }
  invariant(changes.length <= 10_000, "Surface diff exceeds its bound.");
  return changes;
}

export function reviewChanges(changes, review) {
  invariant(
    review?.schema === 1 && Array.isArray(review.decisions),
    "Invalid runtime surface review file.",
  );
  const decisions = new Map();
  for (const decision of review.decisions) {
    invariant(
      Object.hasOwn(PROVIDERS, decision.provider) &&
        /^[a-f0-9]{64}$/.test(decision.fingerprint) &&
        [
          "implemented",
          "sdk-owned",
          "preserved-generically",
          "generated-only",
          "intentionally-deferred",
          "upstream-blocked",
        ].includes(decision.disposition) &&
        typeof decision.rationale === "string" &&
        decision.rationale.trim().length >= 12 &&
        Array.isArray(decision.evidence) &&
        decision.evidence.length > 0 &&
        decision.evidence.every(
          (value) => typeof value === "string" && value.length > 0,
        ),
      "Incomplete runtime surface disposition.",
    );
    invariant(
      !decisions.has(decision.fingerprint),
      "Duplicate runtime surface disposition.",
    );
    decisions.set(decision.fingerprint, decision);
  }
  return changes.map((change) => {
    const decision = decisions.get(change.fingerprint);
    invariant(
      !decision || decision.provider === change.provider,
      "Surface disposition provider mismatch.",
    );
    return {
      ...change,
      disposition: decision?.disposition ?? null,
      rationale: decision?.rationale ?? null,
      evidence: decision?.evidence ?? [],
    };
  });
}

export async function inspectSurfaces({ root, base, fetchImpl, token }) {
  invariant(sha(base), "Surface comparison needs an immutable base commit.");
  const gitRead = (file) =>
    execFileSync("git", ["show", `${base}:${file}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: LIMITS.file,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const beforeManifest = parseJson(gitRead("package.json"));
  const current = parseJson(readFileSync(join(root, "package.json"), "utf8"));
  const changes = [];
  for (const [provider, config] of Object.entries(PROVIDERS)) {
    const beforeVersion = beforeManifest.dependencies[config.package];
    const afterVersion = current.dependencies[config.package];
    if (provider === "codex") {
      const before = schemaSurface(
        Object.fromEntries(
          SCHEMAS.map((file) => [file, gitRead(`${GENERATED}/${file}`)]),
        ),
      );
      const after = schemaSurface(
        Object.fromEntries(
          SCHEMAS.map((file) => [
            file,
            readFileSync(join(root, GENERATED, file), "utf8"),
          ]),
        ),
      );
      changes.push(...compareSurfaces(provider, before, after));
    } else if (beforeVersion !== afterVersion) {
      const before = await releasedDeclarations(provider, beforeVersion, {
        fetchImpl,
        token,
      });
      const after = installedDeclarationSurface(
        resolve(root),
        provider,
        afterVersion,
      );
      changes.push(...compareSurfaces(provider, before, after));
    }
  }
  const reviews = parseJson(
    readFileSync(join(root, "scripts/agent-runtime/reviews.json"), "utf8"),
  );
  return reviewChanges(changes, reviews);
}
