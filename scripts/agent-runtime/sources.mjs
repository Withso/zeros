import {
  DAY,
  LIMITS,
  PROVIDERS,
  PUBLIC_NOTES,
  SCHEMA,
  WATCHES,
} from "./config.mjs";
import {
  boundedText,
  compareVersions,
  hash,
  invariant,
  observationError,
  plain,
  stableVersion,
  timestamp,
  validateObservation,
} from "./contracts.mjs";
import { githubPages, publicFetch } from "./network.mjs";

export function registrySnapshot(packument, pin, now, releaseAge = DAY) {
  invariant(
    plain(packument) && plain(packument.versions) && plain(packument.time),
    "Registry metadata changed shape.",
  );
  const latest = packument["dist-tags"]?.latest;
  invariant(
    stableVersion(pin) &&
      stableVersion(latest) &&
      plain(packument.versions[latest]),
    "Missing stable registry latest/pin.",
  );
  const versions = Object.entries(packument.versions)
    .filter(
      ([version]) =>
        stableVersion(version) &&
        compareVersions(version, pin) >= 0 &&
        compareVersions(version, latest) <= 0,
    )
    .map(([version, manifest]) => {
      invariant(
        timestamp(packument.time[version]) && plain(manifest),
        "Registry publication time is missing.",
      );
      return {
        version,
        publishedAt: packument.time[version],
        deprecated: Boolean(manifest.deprecated),
      };
    })
    .sort((a, b) => compareVersions(a.version, b.version));
  invariant(
    versions.length <= 5000,
    "Registry release history exceeds its bound.",
  );
  const eligible = versions.filter(
    (release) =>
      !release.deprecated &&
      Date.parse(now) - Date.parse(release.publishedAt) >= releaseAge,
  );
  const candidate = eligible.at(-1)?.version ?? null;
  const manifest = packument.versions[candidate ?? latest];
  return {
    pin,
    latest,
    candidate,
    versions,
    tags: Object.fromEntries(
      Object.entries(packument["dist-tags"]).filter(
        ([tag, version]) =>
          ["latest", "stable", "next", "alpha", "beta"].includes(tag) &&
          typeof version === "string",
      ),
    ),
    nativeVersion:
      typeof manifest.claudeCodeVersion === "string"
        ? manifest.claudeCodeVersion
        : null,
    engines: plain(manifest.engines)
      ? { node: boundedText(manifest.engines.node, 120) }
      : {},
    deprecated: Boolean(packument.versions[latest].deprecated),
    integrity: manifest.dist?.integrity ?? null,
    tarball: manifest.dist?.tarball ?? null,
    installable: "unknown",
  };
}

function observation(source, now, data, extra = {}) {
  return validateObservation({
    schema: SCHEMA,
    id: source.id,
    provider: source.provider,
    kind: source.kind,
    url: source.url,
    observedAt: now,
    status: "complete",
    data,
    ...extra,
  });
}

async function platformAvailability(provider, manifest, options) {
  const optional = Object.entries(manifest.optionalDependencies ?? {});
  const wanted = ["darwin-arm64", "linux-x64"];
  for (const platform of wanted) {
    const entry = optional.find(
      ([name, version]) =>
        name.includes(platform) || String(version).includes(platform),
    );
    if (!entry) return false;
    let [name, version] = entry;
    if (String(version).startsWith("npm:")) {
      const split = version.lastIndexOf("@");
      name = version.slice(4, split);
      version = version.slice(split + 1);
    }
    invariant(
      /^@[a-z0-9-]+\/[a-z0-9._-]+$/.test(name) &&
        /^[0-9][a-zA-Z0-9.+-]{0,100}$/.test(version),
      "Platform dependency is not exact.",
    );
    const { data } = await publicFetch(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
      { ...options, json: true },
    );
    if (data?.version !== version || !data?.dist?.integrity) return false;
  }
  return true;
}

export async function collectRegistry(provider, pin, now, options = {}) {
  const config = PROVIDERS[provider];
  const source = {
    id: `${provider}-registry`,
    provider,
    kind: "registry",
    url: `https://registry.npmjs.org/${encodeURIComponent(config.package)}`,
  };
  try {
    const result = await publicFetch(source.url, {
      ...options,
      json: true,
      maximum: LIMITS.registry,
    });
    const snapshot = registrySnapshot(
      result.data,
      pin,
      now,
      options.releaseAge,
    );
    const manifest =
      result.data.versions[snapshot.candidate ?? snapshot.latest];
    if (provider === "claude")
      invariant(
        stableVersion(snapshot.nativeVersion),
        "Claude SDK does not declare its native CLI pairing.",
      );
    try {
      snapshot.installable = await platformAvailability(
        provider,
        manifest,
        options,
      );
    } catch {
      snapshot.installable = "unknown";
    }
    return observation(source, now, snapshot);
  } catch {
    return observationError(source, now, "registry-incomplete");
  }
}

export function notesText(text) {
  invariant(
    typeof text === "string" && text.length >= 60,
    "Release notes are empty.",
  );
  const main =
    /<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i.exec(
      text,
    )?.[1] ?? text;
  const normalized = main
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot);/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  invariant(
    normalized.length >= 60 &&
      /release|changelog|sdk|codex|claude|cursor/i.test(normalized),
    "Release-note parser did not find its document.",
  );
  // Store the most recent text, not navigation/build payloads or an unbounded archive.
  return normalized.slice(0, 16_000);
}

export function watchMatches(provider, text) {
  return WATCHES.filter(
    (watch) =>
      (watch.provider === provider || watch.provider === "all") &&
      watch.terms.some((term) =>
        text.toLowerCase().includes(term.toLowerCase()),
      ),
  ).map((watch) => watch.id);
}

export async function collectNotes(source, now, previous, options = {}) {
  const spec = { ...source, kind: "notes" };
  try {
    const result = await publicFetch(source.url, {
      ...options,
      etag: previous?.etag,
    });
    if (result.notModified) {
      invariant(
        previous?.data,
        "Source returned 304 without a last-good snapshot.",
      );
      return observation(spec, now, previous.data, { etag: previous.etag });
    }
    const text = notesText(result.text);
    return observation(
      spec,
      now,
      {
        digest: hash(text),
        excerpt: text.slice(0, 1800),
        watches: watchMatches(source.provider, text),
        advisory: source.advisory,
      },
      { etag: result.etag },
    );
  } catch {
    return observationError(spec, now, "release-notes-incomplete");
  }
}

export async function collectReleases(provider, pin, now, options = {}) {
  const config = PROVIDERS[provider];
  const source = {
    id: `${provider}-releases`,
    provider,
    kind: "releases",
    url: `https://api.github.com/repos/${config.releaseRepo}/releases`,
  };
  try {
    const releases = [];
    let complete = false;
    for (let page = 1; page <= LIMITS.pages; page++) {
      // Codex release assets make a 100-release response exceed 16 MiB.
      const { data } = await publicFetch(
        `${source.url}?per_page=20&page=${page}`,
        { ...options, json: true },
      );
      invariant(Array.isArray(data), "Release API changed shape.");
      for (const release of data) {
        if (release.draft || release.prerelease) continue;
        const version = String(release.tag_name).replace(/^(?:rust-v|v)/, "");
        if (!stableVersion(version)) continue;
        if (compareVersions(version, pin) < 0) {
          complete = true;
          continue;
        }
        invariant(
          timestamp(release.published_at) && typeof release.body === "string",
          "Release notes are incomplete.",
        );
        const body = boundedText(release.body, 16_000);
        releases.push({
          version,
          publishedAt: release.published_at,
          url: `https://github.com/${config.releaseRepo}/releases/tag/${encodeURIComponent(release.tag_name)}`,
          digest: hash(body),
          excerpt: body.slice(0, 1600),
          watches: watchMatches(provider, body),
        });
        if (version === pin) complete = true;
      }
      if (complete || data.length < 20) {
        complete = true;
        break;
      }
    }
    invariant(complete, "Release pagination incomplete.");
    return observation(source, now, {
      releases: releases.sort((a, b) => compareVersions(a.version, b.version)),
    });
  } catch {
    return observationError(source, now, "release-history-incomplete");
  }
}

export async function collectAdvisories(provider, pin, now, options = {}) {
  const affects = encodeURIComponent(`${PROVIDERS[provider].package}@${pin}`);
  const path = `/advisories?ecosystem=npm&affects=${affects}`;
  const source = {
    id: options.keeper ? "codex-keeper-advisories" : `${provider}-advisories`,
    provider,
    kind: "advisory",
    url: `https://api.github.com${path}`,
  };
  try {
    const values = await githubPages(path, options);
    const advisories = values.map((value) => {
      invariant(
        /^GHSA-[a-z0-9-]+$/.test(value.ghsa_id) &&
          typeof value.summary === "string",
        "Advisory shape changed.",
      );
      return {
        id: value.ghsa_id,
        severity: boundedText(value.severity, 24),
        summary: boundedText(value.summary, 800),
        url: `https://github.com/advisories/${value.ghsa_id}`,
        fixed: (value.vulnerabilities ?? [])
          .filter((v) => v.package?.name === PROVIDERS[provider].package)
          .map((v) => v.first_patched_version ?? null),
      };
    });
    return observation(source, now, {
      advisories,
      pin,
      role: options.keeper ? "independent-auth-keeper" : "bundled-runtime",
    });
  } catch {
    return observationError(source, now, "advisories-incomplete");
  }
}

export async function collectPublic(
  pins,
  previous = {},
  { now = new Date().toISOString(), ...options } = {},
) {
  const jobs = [];
  for (const provider of Object.keys(PROVIDERS)) {
    invariant(
      stableVersion(pins[provider]),
      "The shipping runtime manifest must contain exact pins.",
    );
    jobs.push(
      collectRegistry(provider, pins[provider], now, options),
      collectAdvisories(provider, pins[provider], now, options),
    );
    if (PROVIDERS[provider].releaseRepo)
      jobs.push(collectReleases(provider, pins[provider], now, options));
  }
  for (const source of PUBLIC_NOTES)
    jobs.push(
      collectNotes(source, now, previous[source.id]?.lastGood, options),
    );
  if (options.keeperPin) {
    invariant(
      stableVersion(options.keeperPin),
      "The independent keeper pin must be exact.",
    );
    jobs.push(
      collectAdvisories("codex", options.keeperPin, now, {
        ...options,
        keeper: true,
      }),
    );
  }
  return Promise.all(jobs);
}

export function driftSummary(rows) {
  const behind = rows.filter((row) => row.status === "behind");
  const unknown = rows.filter(
    (row) => !["behind", "current", "ahead"].includes(row.status),
  );
  if (unknown.length)
    return `Runtime drift incomplete: ${unknown.length} unavailable, ${behind.length} behind, ${rows.length - unknown.length - behind.length} checked without an upgrade.`;
  if (behind.length)
    return `${behind.length} of ${rows.length} runtime pins are behind latest. See the runtime tracking issue and upgrade PRs.`;
  if (!rows.length)
    return "Runtime drift unavailable: no installed runtime pins were checked.";
  if (rows.some((row) => row.status === "ahead"))
    return "Runtime pins checked; at least one pin is newer than the current registry latest tag. Review rollback/withdrawal evidence.";
  return `All ${rows.length} runtime pins are at latest.`;
}
