import { createHash } from "node:crypto";
import { load, JSON_SCHEMA } from "js-yaml";
import { LIMITS, PROVIDERS, managedPath } from "./config.mjs";
import {
  canonical,
  invariant,
  parseJson,
  plain,
  sha,
  validateTask,
} from "./contracts.mjs";

export function gitBlob(text) {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

export function validateManifestChange(beforeText, afterText, task) {
  const before = parseJson(beforeText, LIMITS.file);
  const after = parseJson(afterText, LIMITS.file);
  const name = PROVIDERS[task.provider].package;
  invariant(
    before.dependencies?.[name] === task.from &&
      after.dependencies?.[name] === task.version,
    "Manifest does not match the selected runtime transition.",
  );
  const expected = structuredClone(before);
  expected.dependencies[name] = task.version;
  if (task.provider === "codex") expected.codexProtocolVersion = task.version;
  invariant(
    canonical(expected) === canonical(after),
    "Preparation changed unrelated manifest fields.",
  );
}

function safeYaml(text) {
  invariant(
    Buffer.byteLength(text) <= LIMITS.file,
    "Lockfile exceeds its bound.",
  );
  const value = load(text, { schema: JSON_SCHEMA });
  let nodes = 0;
  const active = new Set();
  function walk(node, depth) {
    invariant(
      ++nodes < 500_000 && depth < 64,
      "Lockfile shape exceeds its bound.",
    );
    if (node === null || typeof node !== "object") return;
    invariant(!active.has(node), "Recursive lockfile alias.");
    active.add(node);
    for (const [key, child] of Object.entries(node)) {
      invariant(
        !["__proto__", "constructor", "prototype"].includes(key),
        "Unsafe lockfile key.",
      );
      walk(child, depth + 1);
    }
    active.delete(node);
  }
  walk(value, 0);
  invariant(
    plain(value) && plain(value.importers?.["."]),
    "Lockfile importer shape changed.",
  );
  return value;
}

export function validateLockChange(beforeText, afterText, task) {
  const before = safeYaml(beforeText);
  const after = safeYaml(afterText);
  const name = PROVIDERS[task.provider].package;
  const selected = after.importers["."].dependencies?.[name];
  invariant(
    selected?.specifier === task.version &&
      selected.version?.split("(")[0] === task.version,
    "Lockfile runtime pin is not exact.",
  );
  const expectedImporters = structuredClone(before.importers);
  expectedImporters["."].dependencies[name] = selected;
  invariant(
    canonical(expectedImporters) === canonical(after.importers),
    "Preparation changed another dependency or workspace importer.",
  );
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (!["importers", "packages", "snapshots"].includes(key))
      invariant(
        canonical(before[key]) === canonical(after[key]),
        "Preparation changed lockfile configuration.",
      );
  const closure = (lock) => {
    const snapshots = new Set();
    const packages = new Set();
    const visit = (name, ref) => {
      invariant(
        typeof ref === "string",
        "Invalid dependency edge in runtime lock graph.",
      );
      if (/^(?:link|file|workspace):/.test(ref)) return;
      const key = Object.hasOwn(lock.snapshots ?? {}, `${name}@${ref}`)
        ? `${name}@${ref}`
        : ref.replace(/^npm:/, "");
      if (snapshots.has(key)) return;
      snapshots.add(key);
      packages.add(key.split("(")[0]);
      for (const [dependency, version] of Object.entries({
        ...lock.snapshots?.[key]?.dependencies,
        ...lock.snapshots?.[key]?.optionalDependencies,
      }))
        visit(dependency, version);
    };
    visit(name, lock.importers["."].dependencies[name].version);
    return { snapshots, packages };
  };
  const oldClosure = closure(before),
    newClosure = closure(after);
  for (const section of ["packages", "snapshots"]) {
    invariant(
      plain(before[section]) && plain(after[section]),
      "Incomplete runtime lock graph.",
    );
    for (const key of new Set([
      ...Object.keys(before[section]),
      ...Object.keys(after[section]),
    ])) {
      const old = before[section][key],
        next = after[section][key];
      if (canonical(old) === canonical(next)) continue;
      invariant(
        oldClosure[section].has(key) || newClosure[section].has(key),
        "Preparation changed an unrelated lockfile package.",
      );
      // An existing immutable version must retain its integrity and resolution.
      // Regeneration never authorizes rewriting a shared installed dependency.
      invariant(
        old === undefined || next === undefined,
        "Preparation rewrote an existing lockfile package.",
      );
    }
  }
  if (Object.keys(before.snapshots).length) {
    invariant(
      after.snapshots[`${name}@${selected.version}`] &&
        after.packages[`${name}@${task.version}`],
      "Candidate runtime is missing from the lock graph.",
    );
  }
}

export function validatePatch(patch, task, tree) {
  validateTask(task);
  invariant(
    plain(patch) &&
      patch.schema === 1 &&
      patch.taskId === task.id &&
      patch.head === task.head &&
      patch.provider === task.provider &&
      patch.version === task.version,
    "Prepared patch provenance mismatch.",
  );
  invariant(
    Array.isArray(patch.files) &&
      (patch.files.length > 0 ||
        (task.regenerate &&
          task.pr !== null &&
          task.from === task.version &&
          task.lastBotCommit === task.head)) &&
      patch.files.length <= LIMITS.files,
    "Invalid prepared file inventory.",
  );
  invariant(
    Buffer.byteLength(JSON.stringify(patch)) <= LIMITS.patch,
    "Prepared patch exceeds its size limit.",
  );
  invariant(
    Array.isArray(tree) &&
      new Set(tree.map((entry) => entry.path)).size === tree.length,
    "Incomplete base tree.",
  );
  const existing = new Map(tree.map((entry) => [entry.path, entry]));
  if (patch.files.length === 0)
    for (const path of ["package.json", "pnpm-lock.yaml"]) {
      const current = existing.get(path);
      invariant(
        current?.type === "blob" &&
          current.mode === "100644" &&
          sha(current.sha),
        "Regeneration input is not a regular file.",
      );
    }
  const paths = new Set();
  for (const file of patch.files) {
    invariant(
      plain(file) &&
        typeof file.path === "string" &&
        managedPath(task.provider, file.path) &&
        !paths.has(file.path),
      "Prepared patch has an unexpected or duplicate path.",
    );
    paths.add(file.path);
    const current = existing.get(file.path);
    invariant(
      file.beforeBlob === (current?.sha ?? null),
      "Prepared file does not match the observed base.",
    );
    invariant(
      !current ||
        (current.type === "blob" &&
          current.mode === "100644" &&
          sha(current.sha)),
      "Managed input is not a regular file.",
    );
    invariant(
      file.after === null ||
        (typeof file.after === "string" &&
          !file.after.includes("\0") &&
          Buffer.byteLength(file.after) <= LIMITS.file),
      "Prepared file is not bounded UTF-8 text.",
    );
    invariant(
      file.after !== null || file.path.includes("/codex/generated/"),
      "Preparation cannot delete a manifest, lockfile or license bundle.",
    );
    if (file.path.endsWith("/generated/.version"))
      invariant(
        file.after?.split(/\r?\n/)[0] === task.version &&
          file.after
            .split(/\r?\n/)
            .slice(1)
            .every((line) => !line || line.startsWith("#")),
        "Generated protocol stamp disagrees with the runtime.",
      );
  }
  invariant(
    paths.has("package.json") || task.regenerate,
    "Version preparation did not include the manifest.",
  );
  return patch;
}
