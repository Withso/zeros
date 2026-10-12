import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS, PROVIDERS, REPOSITORY } from "./config.mjs";
import {
  hash,
  invariant,
  parseJson,
  plain,
  sha,
  stableVersion,
  timestamp,
} from "./contracts.mjs";
import { manifestPins } from "./controller.mjs";
import { publicFetch } from "./network.mjs";
import { readArtifact, validateRun } from "./artifacts.mjs";

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

export function publicationReceipt({
  directory,
  diagnostic,
  runId,
  attempt,
  source,
}) {
  invariant(
    sha(source) &&
      Number.isSafeInteger(runId) &&
      runId > 0 &&
      Number.isSafeInteger(attempt) &&
      attempt > 0,
    "Invalid publication identity.",
  );
  const result = {
    schema: "zeros.runtime-publication/v1",
    repository: REPOSITORY,
    sourceSha: source,
    runId,
    attempt,
    channel: "alpha",
    status: "unknown",
    qualification: "unknown",
    pins: null,
    runtimeId: null,
    manifestSha256: null,
  };
  if (
    diagnostic?.schema !== "zeros.diagnostic/v1" ||
    diagnostic.component !== "publication"
  )
    return result;
  result.status =
    diagnostic.ok === true &&
    diagnostic.stage === "done" &&
    diagnostic.exitCode === 0
      ? "published"
      : diagnostic.stage === "disabled"
        ? "disabled"
        : "failed";
  if (result.status !== "published") return result;
  const descriptor = parseJson(
    readFileSync(join(directory, "descriptor.json"), "utf8"),
  );
  const bytes = readFileSync(join(directory, "manifest.json"));
  invariant(
    bytes.length <= 64 * 1024 * 1024 &&
      descriptor.sourceCommit === source &&
      descriptor.manifestSha256 === hash(bytes) &&
      descriptor.runtimeId === `r1-${descriptor.manifestSha256}`,
    "Publication descriptor/manifest mismatch.",
  );
  const manifest = parseJson(bytes.toString("utf8"), 64 * 1024 * 1024);
  const pins = {
    claude: manifest.agents?.claude?.sdk,
    codex: manifest.agents?.codex?.package,
    cursor: manifest.agents?.cursor?.sdk,
  };
  invariant(
    manifest.source?.commit === source &&
      Object.values(pins).every(stableVersion),
    "Publication pins/source mismatch.",
  );
  return {
    ...result,
    pins,
    runtimeId: descriptor.runtimeId,
    manifestSha256: descriptor.manifestSha256,
  };
}

export function validatePublication(receipt, run) {
  invariant(
    receipt?.schema === "zeros.runtime-publication/v1" &&
      receipt.repository === REPOSITORY &&
      receipt.channel === "alpha" &&
      receipt.sourceSha === run.head_sha &&
      receipt.runId === run.id &&
      receipt.attempt === run.run_attempt &&
      ["published", "disabled", "failed", "unknown"].includes(receipt.status) &&
      receipt.qualification === "unknown",
    "Cloud publication receipt provenance mismatch.",
  );
  if (receipt.status === "published")
    invariant(
      plain(receipt.pins) &&
        Object.keys(PROVIDERS).every((provider) =>
          stableVersion(receipt.pins[provider]),
        ) &&
        /^[a-f0-9]{64}$/.test(receipt.manifestSha256) &&
        receipt.runtimeId === `r1-${receipt.manifestSha256}`,
      "Invalid cloud runtime publication identity.",
    );
  return receipt;
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

export async function cloudDelivery(github) {
  const value = await github.get(
    "/actions/workflows/release-alpha.yml/runs?branch=main&per_page=5",
  );
  invariant(
    Array.isArray(value.workflow_runs),
    "Cloud publication run listing changed shape.",
  );
  for (const run of value.workflow_runs) {
    if (run.status !== "completed") continue;
    validateRun(run, {
      id: run.id,
      attempt: run.run_attempt,
      workflow: "release-alpha.yml",
      events: ["push", "workflow_dispatch", "workflow_run"],
      completed: true,
    });
    try {
      const receipt = validatePublication(
        await readArtifact(
          github,
          run,
          `agent-runtime-publication-${run.id}-${run.run_attempt}`,
          "publication.json",
          16 * 1024,
        ),
        run,
      );
      const jobs = await runJobs(github, run);
      const saved = jobs.find(
        (job) =>
          job.run_attempt === run.run_attempt &&
          job.steps?.some(
            (step) =>
              step.name === "Save runtime publication evidence" &&
              step.conclusion === "success",
          ),
      );
      invariant(saved, "Publication receipt has no successful producer step.");
      if (receipt.status === "published")
        invariant(
          saved.steps.some(
            (step) =>
              step.name === "Publish using GitHub Actions OIDC" &&
              step.conclusion === "success",
          ),
          "Cloud publication did not succeed.",
        );
      return {
        ...receipt,
        url: `https://github.com/${REPOSITORY}/actions/runs/${run.id}/attempts/${run.run_attempt}`,
      };
    } catch {
      /* Older runs have no receipt; only a bounded recent window is read. */
    }
  }
  return {
    status: "unknown",
    qualification: "unknown",
    reason: "no-recent-verified-receipt",
  };
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
    cloudDelivery(github),
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
    const cloudResult = results[3];
    if (cloudResult.status === "rejected") incomplete = true;
    const cloud =
      cloudResult.status === "fulfilled"
        ? cloudResult.value
        : {
            status: "unknown",
            qualification: "unknown",
            reason: "source-incomplete",
          };
    const { pins, ...cloudEvidence } = cloud;
    const previous =
      state.sources[`${provider}-delivery`]?.lastGood?.data?.cloud;
    const retained =
      cloud.status === "unknown" && previous?.status === "published"
        ? { ...previous, freshness: "retained-receipt-latest-unknown" }
        : {
            ...cloudEvidence,
            pin: pins?.[provider] ?? null,
            includesMergedUpgrade: await includesCommit(
              github,
              state.proposals[provider]?.mergedCommit,
              cloud.sourceSha,
            ),
          };
    observations.push({
      schema: 1,
      id: `${provider}-delivery`,
      provider,
      kind: "delivery",
      observedAt: now,
      status: incomplete ? "incomplete" : "complete",
      reason: incomplete ? "delivery-source-incomplete" : undefined,
      data: { desktop, cloud: retained, failure: cloud.status === "failed" },
    });
  }
  return observations;
}
