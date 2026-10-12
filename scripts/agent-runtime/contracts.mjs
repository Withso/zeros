import { createHash } from "node:crypto";
import { LIMITS, PROVIDERS, SCHEMA } from "./config.mjs";

export function invariant(ok, message) {
  if (!ok) throw new Error(message);
}

export const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export const hash = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : canonical(value),
    )
    .digest("hex");
export const stableVersion = (value) =>
  typeof value === "string" &&
  /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(value);
export const timestamp = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT/.test(value) &&
  Number.isFinite(Date.parse(value));
export const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function compareVersions(a, b) {
  invariant(
    stableVersion(a) && stableVersion(b),
    "Expected exact stable runtime versions.",
  );
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}

export function parseJson(text, maximum = LIMITS.report) {
  invariant(
    typeof text === "string" && Buffer.byteLength(text) <= maximum,
    "JSON input exceeds its size limit.",
  );
  return JSON.parse(text, (key, value) => {
    invariant(
      !["__proto__", "constructor", "prototype"].includes(key),
      "Unsafe JSON property.",
    );
    return value;
  });
}

export function boundedText(value, limit = 1200) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .slice(0, limit);
}

export function markdown(value, limit = 1200) {
  return boundedText(value, limit)
    .replace(/@/g, "＠")
    .replace(/[\\`*_[\]<>|]/g, (c) => `\\${c}`)
    .replace(/\r?\n/g, " ");
}

const modelIdentity = (value) =>
  typeof value === "string" &&
  value.length <= 200 &&
  /^[A-Za-z0-9][A-Za-z0-9._:+/-]*(?:\[1m\])?$/i.test(value);
const effortValue = (value) =>
  typeof value === "string" && /^[a-z0-9_-]{1,32}$/.test(value);
const digestValue = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function onlyKeys(value, keys) {
  invariant(
    plain(value) && Object.keys(value).every((key) => keys.includes(key)),
    "Unexpected public model field.",
  );
}

function validateModelObservation(value) {
  onlyKeys(value, [
    "schema",
    "id",
    "provider",
    "kind",
    "observedAt",
    "url",
    "status",
    "reason",
    "data",
  ]);
  invariant(
    value.id === `${value.provider}-models` &&
      (value.url === undefined ||
        value.url === PROVIDERS[value.provider].notes),
    "Invalid model observation provenance.",
  );
  if (value.status !== "complete") {
    onlyKeys(value.data, []);
    invariant(
      [
        "dedicated-test-credentials-unconfigured",
        "bundled-listing-incomplete",
      ].includes(value.reason),
      "Invalid model discovery failure.",
    );
    return;
  }
  invariant(
    value.reason === undefined,
    "Complete model observation contains a failure reason.",
  );
  const data = value.data;
  onlyKeys(data, [
    "items",
    "requiredCuratedMissing",
    "unreviewedCount",
    "scope",
    "runtimeVersion",
    "freshness",
    "evidence",
  ]);
  invariant(
    typeof data.scope === "string" &&
      /^[a-z][a-z0-9-]{0,39}$/.test(data.scope) &&
      stableVersion(data.runtimeVersion),
    "Invalid model observation scope.",
  );
  invariant(
    data.freshness === "provider-cache-age-unknown" &&
      data.evidence === "bundled-runtime-account-listing",
    "Invalid model evidence scope.",
  );
  invariant(
    Array.isArray(data.items) &&
      data.items.length <= 5000 &&
      Array.isArray(data.requiredCuratedMissing) &&
      data.requiredCuratedMissing.length <= 500 &&
      data.requiredCuratedMissing.every(modelIdentity),
    "Invalid public model inventory.",
  );
  invariant(
    Number.isSafeInteger(data.unreviewedCount) &&
      data.unreviewedCount >= 0 &&
      data.unreviewedCount <= data.items.length,
    "Invalid unreviewed model count.",
  );
  const seen = new Set();
  for (const item of data.items) {
    invariant(
      plain(item) && modelIdentity(item.id) && !seen.has(item.id),
      "Invalid public model identity.",
    );
    seen.add(item.id);
    if (Object.hasOwn(item, "digest")) {
      onlyKeys(item, ["id", "digest"]);
      invariant(digestValue(item.digest), "Invalid compact model fingerprint.");
      continue;
    }
    invariant(
      typeof item.public === "boolean",
      "Missing model disclosure disposition.",
    );
    if (!item.public) {
      onlyKeys(item, ["id", "public"]);
      invariant(
        /^unreviewed-[a-f0-9]{20}$/.test(item.id),
        "Unknown model identity was not withheld.",
      );
      continue;
    }
    const booleans = [
      "isDefault",
      "supportsImages",
      "supportsTools",
      "supportsFast",
      "supportsReasoning",
    ];
    const numbers = ["contextWindow", "maxContextTokens", "maxOutputTokens"];
    const digests = [
      "parametersDigest",
      "variantsDigest",
      "inputModalitiesDigest",
    ];
    onlyKeys(item, [
      "id",
      "public",
      ...booleans,
      ...numbers,
      ...digests,
      "defaultEffort",
      "efforts",
      "aliases",
    ]);
    for (const key of booleans)
      invariant(
        item[key] === undefined || typeof item[key] === "boolean",
        "Invalid model capability flag.",
      );
    for (const key of numbers)
      invariant(
        item[key] === undefined ||
          (Number.isSafeInteger(item[key]) &&
            item[key] >= 0 &&
            item[key] <= 100_000_000),
        "Invalid model capability bound.",
      );
    for (const key of digests)
      invariant(
        item[key] === undefined || digestValue(item[key]),
        "Invalid model capability fingerprint.",
      );
    invariant(
      item.defaultEffort === undefined || effortValue(item.defaultEffort),
      "Invalid model effort.",
    );
    invariant(
      item.efforts === undefined ||
        (Array.isArray(item.efforts) &&
          item.efforts.length <= 16 &&
          item.efforts.every(effortValue)),
      "Invalid model efforts.",
    );
    invariant(
      item.aliases === undefined ||
        (Array.isArray(item.aliases) &&
          item.aliases.length <= 32 &&
          item.aliases.every(modelIdentity)),
      "Invalid model aliases.",
    );
  }
}

export function modelPublicIds(catalog, provider, additional = {}) {
  return new Set([
    ...(catalog.families?.[provider] ?? []).map((model) => model.value),
    ...Object.keys(catalog.aliases?.[provider] ?? {}),
    ...Object.values(catalog.aliases?.[provider] ?? {}),
    ...(additional[provider] ?? []),
  ]);
}

/** Revalidate credentialed artifacts against trusted main's public-ID policy. */
export function validatePublicModelObservation(
  value,
  { catalog, publicIds = {} },
) {
  validateObservation(value);
  invariant(value.kind === "models", "Expected a model observation.");
  if (value.status !== "complete") return value;
  const allowed = modelPublicIds(catalog, value.provider, publicIds);
  const curated = new Set(
    (catalog.families?.[value.provider] ?? []).map((model) => model.value),
  );
  for (const item of value.data.items) {
    invariant(
      typeof item.public === "boolean" && !Object.hasOwn(item, "digest"),
      "Model artifact must contain normalized observations, not state fingerprints.",
    );
    if (item.public)
      invariant(
        allowed.has(item.id) &&
          (item.aliases ?? []).every((alias) => allowed.has(alias)),
        "Model artifact disclosed an unreviewed identity.",
      );
  }
  invariant(
    value.data.requiredCuratedMissing.every((id) => curated.has(id)),
    "Missing model is not part of the curated catalog.",
  );
  invariant(
    value.data.unreviewedCount ===
      value.data.items.filter((item) => !item.public).length,
    "Model disclosure count mismatch.",
  );
  return value;
}

export function validateObservation(value) {
  invariant(
    plain(value) &&
      value.schema === SCHEMA &&
      typeof value.id === "string" &&
      /^[a-z][a-z0-9-]{0,79}$/.test(value.id),
    "Invalid observation identity.",
  );
  invariant(
    Object.hasOwn(PROVIDERS, value.provider) && timestamp(value.observedAt),
    "Invalid observation scope/time.",
  );
  invariant(
    ["complete", "incomplete", "unavailable"].includes(value.status),
    "Invalid observation status.",
  );
  invariant(
    [
      "registry",
      "notes",
      "releases",
      "models",
      "delivery",
      "advisory",
    ].includes(value.kind),
    "Invalid observation kind.",
  );
  invariant(plain(value.data), "Invalid observation data.");
  invariant(
    Buffer.byteLength(JSON.stringify(value)) <= LIMITS.report,
    "Observation exceeds its size limit.",
  );
  if (value.kind === "models") validateModelObservation(value);
  if (value.kind === "registry" && value.status === "complete") {
    invariant(
      stableVersion(value.data.latest) && Array.isArray(value.data.versions),
      "Invalid registry observation.",
    );
    invariant(
      value.data.versions.every(
        (v) => plain(v) && stableVersion(v.version) && timestamp(v.publishedAt),
      ),
      "Invalid registry release.",
    );
    invariant(
      value.data.candidate === null || stableVersion(value.data.candidate),
      "Invalid registry candidate.",
    );
  }
  return value;
}

export function validateTask(value) {
  invariant(
    plain(value) &&
      value.schema === SCHEMA &&
      Object.hasOwn(PROVIDERS, value.provider),
    "Invalid preparation task.",
  );
  invariant(
    sha(value.head) && sha(value.main) && sha(value.automation),
    "Invalid task commits.",
  );
  invariant(
    stableVersion(value.version) && stableVersion(value.from),
    "Invalid task version.",
  );
  invariant(
    compareVersions(value.version, value.from) >= 0,
    "Automatic runtime downgrades are forbidden.",
  );
  invariant(
    typeof value.branch === "string" &&
      new RegExp(
        `^automation/agent-runtime/${value.provider}/[a-f0-9]{12}$`,
      ).test(value.branch),
    "Invalid managed branch.",
  );
  invariant(
    value.pr === null || (Number.isSafeInteger(value.pr) && value.pr > 0),
    "Invalid task PR.",
  );
  invariant(
    value.lastBotCommit === null || sha(value.lastBotCommit),
    "Invalid task baseline.",
  );
  invariant(
    typeof value.regenerate === "boolean" && timestamp(value.createdAt),
    "Invalid task controls.",
  );
  invariant(
    value.recoveryTaskId === undefined ||
      (value.pr === null && /^[a-f0-9]{64}$/.test(value.recoveryTaskId)),
    "Invalid interrupted-creation recovery.",
  );
  invariant(
    typeof value.id === "string" && /^[a-f0-9]{64}$/.test(value.id),
    "Invalid task identity.",
  );
  const { id, ...identity } = value;
  invariant(id === hash(identity), "Preparation task identity mismatch.");
  return value;
}

export function observationError(source, now, reason = "source-unavailable") {
  return {
    schema: SCHEMA,
    id: source.id,
    provider: source.provider,
    kind: source.kind,
    url: source.url,
    observedAt: now,
    status: "incomplete",
    reason,
    data: {},
  };
}
