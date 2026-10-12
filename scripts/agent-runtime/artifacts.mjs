import { inflateRawSync } from "node:zlib";
import { LIMITS, REPOSITORY } from "./config.mjs";
import { hash, invariant, parseJson, sha } from "./contracts.mjs";
import { readBounded } from "./network.mjs";

/** Read exactly one named regular JSON entry in memory. Never extract a ZIP. */
export function jsonFromZip(bytes, name, maximum = LIMITS.report) {
  invariant(
    Buffer.isBuffer(bytes) &&
      bytes.length >= 22 &&
      bytes.length <= maximum + 128 * 1024,
    "Artifact ZIP exceeds its bound.",
  );
  let end = -1;
  for (
    let i = bytes.length - 22;
    i >= Math.max(0, bytes.length - 65_557);
    i--
  ) {
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  invariant(
    end >= 0 &&
      bytes.readUInt16LE(end + 4) === 0 &&
      bytes.readUInt16LE(end + 6) === 0 &&
      bytes.readUInt16LE(end + 8) === 1 &&
      bytes.readUInt16LE(end + 10) === 1,
    "Artifact must contain one entry on one disk.",
  );
  const offset = bytes.readUInt32LE(end + 16),
    length = bytes.readUInt32LE(end + 12);
  invariant(
    offset + length === end &&
      length >= 46 &&
      bytes.readUInt32LE(offset) === 0x02014b50,
    "Invalid artifact directory.",
  );
  const flags = bytes.readUInt16LE(offset + 8),
    method = bytes.readUInt16LE(offset + 10);
  const compressed = bytes.readUInt32LE(offset + 20),
    expanded = bytes.readUInt32LE(offset + 24);
  const nameLength = bytes.readUInt16LE(offset + 28),
    extraLength = bytes.readUInt16LE(offset + 30),
    commentLength = bytes.readUInt16LE(offset + 32);
  const external = bytes.readUInt32LE(offset + 38),
    local = bytes.readUInt32LE(offset + 42);
  const mode = (external >>> 16) & 0xf000;
  invariant(
    (flags & ~0x808) === 0 &&
      [0, 8].includes(method) &&
      [0, 0x8000].includes(mode) &&
      (external & 0x10) === 0,
    "Encrypted, linked or unsupported artifact entry.",
  );
  invariant(
    46 + nameLength + extraLength + commentLength === length &&
      bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8") ===
        name,
    "Unexpected artifact filename.",
  );
  invariant(
    expanded > 0 &&
      expanded <= maximum &&
      compressed <= maximum + 1024 &&
      local + 30 <= offset &&
      bytes.readUInt32LE(local) === 0x04034b50,
    "Artifact entry exceeds its bound.",
  );
  const localNameLength = bytes.readUInt16LE(local + 26),
    localExtra = bytes.readUInt16LE(local + 28);
  invariant(
    bytes.readUInt16LE(local + 6) === flags &&
      bytes.readUInt16LE(local + 8) === method &&
      bytes
        .subarray(local + 30, local + 30 + localNameLength)
        .toString("utf8") === name,
    "Artifact local header mismatch.",
  );
  const start = local + 30 + localNameLength + localExtra;
  invariant(start + compressed <= offset, "Truncated artifact entry.");
  const payload = bytes.subarray(start, start + compressed);
  const decoded =
    method === 0
      ? payload
      : inflateRawSync(payload, { maxOutputLength: maximum });
  invariant(
    decoded.length === expanded &&
      Buffer.from(decoded.toString("utf8"), "utf8").equals(decoded),
    "Artifact is not complete UTF-8 JSON.",
  );
  return parseJson(decoded.toString("utf8"), maximum);
}

export function validateRun(
  run,
  { id, attempt, workflow, events, head, completed = false },
) {
  invariant(
    Number.isSafeInteger(id) &&
      id > 0 &&
      Number.isSafeInteger(attempt) &&
      attempt > 0,
    "Invalid workflow run identity.",
  );
  invariant(
    run.id === id &&
      run.run_attempt === attempt &&
      run.repository?.full_name?.toLowerCase() === REPOSITORY.toLowerCase() &&
      run.head_repository?.full_name?.toLowerCase() ===
        REPOSITORY.toLowerCase(),
    "Workflow run repository/attempt mismatch.",
  );
  invariant(
    run.path === `.github/workflows/${workflow}` &&
      events.includes(run.event) &&
      sha(run.head_sha) &&
      (!head || run.head_sha === head),
    "Workflow run source/provenance mismatch.",
  );
  invariant(
    !completed || run.status === "completed",
    "Workflow is not complete.",
  );
  return run;
}

export async function artifactsForRun(github, id) {
  const rows = [];
  for (let page = 1; page <= LIMITS.pages; page++) {
    const response = await github.get(
      `/actions/runs/${id}/artifacts?per_page=100&page=${page}`,
    );
    invariant(
      Array.isArray(response.artifacts),
      "Artifact listing changed shape.",
    );
    rows.push(...response.artifacts);
    if (response.artifacts.length < 100) return rows;
  }
  throw new Error("Artifact pagination is incomplete.");
}

export async function downloadArtifact(github, artifact, maximum) {
  invariant(
    Number.isSafeInteger(artifact.id) &&
      artifact.id > 0 &&
      artifact.expired === false &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= maximum + 128 * 1024,
    "Artifact is missing, expired or oversized.",
  );
  let url = new URL(
    `https://api.github.com${github.prefix}/actions/artifacts/${artifact.id}/zip`,
  );
  for (let i = 0; i < 5; i++) {
    const api = i === 0;
    invariant(
      url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        (api ||
          url.hostname === "objects.githubusercontent.com" ||
          url.hostname.endsWith(".blob.core.windows.net") ||
          url.hostname.endsWith(".actions.githubusercontent.com")),
      "Artifact redirect is outside GitHub storage.",
    );
    const response = await github.fetch(url.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(LIMITS.timeout),
      headers: {
        accept: "application/vnd.github+json",
        ...(api && github.token
          ? { authorization: `Bearer ${github.token}` }
          : {}),
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = new URL(response.headers.get("location"), url);
      continue;
    }
    invariant(response.ok, "Artifact download unavailable.");
    const bytes = await readBounded(response, maximum + 128 * 1024);
    // GitHub's v4 digest covers the uploaded ZIP, not its decoded JSON body.
    if (artifact.digest)
      invariant(
        artifact.digest === `sha256:${hash(bytes)}`,
        "Artifact digest mismatch.",
      );
    return bytes;
  }
  throw new Error("Artifact download has too many redirects.");
}

export async function readArtifact(
  github,
  run,
  name,
  entry,
  maximum = LIMITS.report,
) {
  const matches = (await artifactsForRun(github, run.id)).filter(
    (artifact) => artifact.name === name,
  );
  invariant(
    matches.length === 1 &&
      matches[0].workflow_run?.id === run.id &&
      matches[0].workflow_run?.head_sha === run.head_sha,
    "Artifact has no unique matching producer.",
  );
  return jsonFromZip(
    await downloadArtifact(github, matches[0], maximum),
    entry,
    maximum,
  );
}
