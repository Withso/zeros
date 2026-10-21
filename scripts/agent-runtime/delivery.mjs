import { LIMITS, PROVIDERS, REPOSITORY } from "./config.mjs";
import {
  invariant,
  plain,
  sha,
  timestamp,
} from "./contracts.mjs";
import { manifestPins } from "./controller.mjs";
import { publicFetch } from "./network.mjs";

export function validateLedger(value, channel) {
  invariant(
    value?.version === 1 &&
      value.channel === channel &&
      Array.isArray(value.releases) &&
      value.releases.length <= 200,
    "Invalid public release ledger.",
  );
  const pattern =
    channel === "production"
      ? /^\d+\.\d+\.\d+$/
      : new RegExp(`^\\d+\\.\\d+\\.\\d+-${channel}\\.\\d+$`);
  const seen = new Set();
  for (const release of value.releases) {
    invariant(
      plain(release) &&
        pattern.test(release.version) &&
        !seen.has(release.version) &&
        sha(release.sourceSha) &&
        timestamp(release.publishedAt),
      "Invalid public release entry.",
    );
    seen.add(release.version);
  }
  return value;
}

export async function desktopDelivery(github, channel) {
  let release;
  try {
    release = await github.get(
      `/releases/${channel === "production" ? "latest" : `tags/${channel}`}`,
    );
  } catch (error) {
    if (error.status === 404)
      return { status: "unknown", reason: "feed-unavailable" };
    throw error;
  }
  invariant(
    release.draft === false &&
      release.prerelease === (channel !== "production") &&
      (channel === "production"
        ? /^v\d+\.\d+\.\d+$/.test(release.tag_name)
        : release.tag_name === channel),
    "Release feed identity mismatch.",
  );
  const name =
    channel === "production"
      ? "release-ledger.json"
      : `${channel}-release-ledger.json`;
  const assets = (release.assets ?? []).filter((asset) => asset.name === name);
  if (!assets.length)
    return { status: "unknown", reason: "ledger-unavailable" };
  const url = `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(release.tag_name)}/${name}`;
  invariant(
    assets.length === 1 &&
      assets[0].browser_download_url === url &&
      assets[0].size <= 256 * 1024,
    "Release ledger asset mismatch.",
  );
  const { data } = await publicFetch(url, {
    fetchImpl: github.fetch,
    json: true,
    maximum: 256 * 1024,
  });
  const ledger = validateLedger(data, channel);
  const latest = [...ledger.releases]
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
    .at(-1);
  if (!latest) return { status: "unknown", reason: "empty-ledger" };
  return {
    status: "published",
    ...latest,
    pins: manifestPins(await github.file("package.json", latest.sourceSha)),
    url,
  };
}

export async function runJobs(github, run) {
  const jobs = [];
  for (let page = 1; page <= LIMITS.pages; page++) {
    const value = await github.get(
      `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
    );
    invariant(Array.isArray(value.jobs), "Workflow job listing changed shape.");
    jobs.push(...value.jobs);
    if (value.jobs.length < 100) return jobs;
  }
  throw new Error("Workflow job pagination incomplete.");
}

export async function includesCommit(github, ancestor, source) {
  if (!sha(ancestor) || !sha(source)) return "unknown";
  if (ancestor === source) return true;
  try {
    const comparison = await github.get(
      `/compare/${ancestor}...${source}?per_page=1`,
    );
    return ["ahead", "identical"].includes(comparison.status);
  } catch {
    return "unknown";
  }
}

export async function collectDelivery(github, state, now) {
  const results = await Promise.allSettled([
    ...["alpha", "beta", "production"].map((channel) =>
      desktopDelivery(github, channel),
    ),
  ]);
  const observations = [];
  for (const provider of Object.keys(PROVIDERS)) {
    const desktop = {};
    let incomplete = false;
    for (const [index, channel] of ["alpha", "beta", "production"].entries()) {
      const result = results[index];
      if (result.status === "rejected") {
        incomplete = true;
        desktop[channel] = { status: "unknown", reason: "source-incomplete" };
        continue;
      }
      const { pins, ...delivery } = result.value;
      desktop[channel] = {
        ...delivery,
        pin: pins?.[provider] ?? null,
        includesMergedUpgrade: await includesCommit(
          github,
          state.proposals[provider]?.mergedCommit,
          delivery.sourceSha,
        ),
        policy:
          channel === "alpha"
            ? "automatic-after-gates"
            : "maintainer-promotion",
      };
    }
    // Old runtime-bundle receipts are not evidence for the standalone worker.
    // Keep the observation shape stable until v2 has its own delivery source.
    const cloud = {
      status: "unknown",
      qualification: "unknown",
      reason: "v2-delivery-not-observed",
    };
    observations.push({
      schema: 1,
      id: `${provider}-delivery`,
      provider,
      kind: "delivery",
      observedAt: now,
      status: incomplete ? "incomplete" : "complete",
      reason: incomplete ? "delivery-source-incomplete" : undefined,
      data: { desktop, cloud, failure: false },
    });
  }
  return observations;
}
