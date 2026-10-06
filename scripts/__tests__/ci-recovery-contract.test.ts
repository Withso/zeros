import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { classifyFailures } from "../ci/recovery-policy.mjs";
import {
  buildContract,
  contractDigest,
  END,
  INCIDENT_SCHEMA,
  incidentTitle,
  parseContractBody,
  renderBody,
  renderJsonBlock,
  renderMarker,
  resolveContract,
  START,
  validateContract,
  validateSchema,
} from "../ci/recovery-contract.mjs";

const jobs = JSON.parse(
  readFileSync(
    new URL("./fixtures/ci-recovery-jobs.json", import.meta.url),
    "utf8",
  ),
);
const run = {
  id: 123,
  workflow_id: 321408597,
  head_sha: "a".repeat(40),
  run_attempt: 2,
};
const evidence = {
  run_id: "456",
  attempt: 1,
  artifact_id: "789",
  artifact_digest: "sha256:" + "b".repeat(64),
  payload_sha256: "c".repeat(64),
};
const make = (overrides = {}) =>
  buildContract({
    run,
    roots: classifyFailures([jobs.composer]).roots,
    evidence,
    retried: true,
    ...overrides,
  });
const ajv = new Ajv2020({ strict: true });
const validate = ajv.compile(INCIDENT_SCHEMA);
const markerSchema = {
  ...INCIDENT_SCHEMA.$defs.marker,
  $defs: INCIDENT_SCHEMA.$defs,
};
const validateMarker = ajv.compile(markerSchema);

describe("incident contract and rendering", () => {
  it("validates with the independent schema engine and the stdlib validator", () => {
    const contract = make();
    expect(validate(contract), JSON.stringify(validate.errors)).toBe(true);
    expect(validateContract(contract)).toEqual(contract);
    expect(contract.controller_evidence.payload_sha256).toBe(
      contractDigest(contract),
    );
    expect(contract.required_lanes).toEqual(["composer"]);
    expect(contract.required_ci_additions).toEqual(["ci:ui-smoke"]);
  });

  it("emits one parseable block, canonical links and registered reproduction", () => {
    const contract = make({
      associatedPrs: [
        {
          number: 22,
          base: { ref: "main", repo: { full_name: "Withso/zeros" } },
          title: "Untrusted title",
          body: "Untrusted body",
          user: { email: "private" },
        },
      ],
    });
    const body = renderBody(contract);
    expect(body.split(START)).toHaveLength(2);
    expect(body.split(END)).toHaveLength(2);
    expect(parseContractBody(body)).toEqual(contract);
    expect(body).toContain("pnpm test:ui-smoke --shard=1/3");
    expect(body).toContain(
      "https://github.com/Withso/zeros/actions/runs/123/job/101",
    );
    expect(body).toContain("https://github.com/Withso/zeros/pull/22");
    expect(body).not.toMatch(/Untrusted|private/);
    expect(incidentTitle(contract)).toBe("fix(ci): restore composer on main");
  });

  it("reports the coalesced commit range since the last green main run", () => {
    const green = "d".repeat(40);
    const body = renderBody(make({ lastGreenSha: green }));
    expect(body).toContain(
      `https://github.com/Withso/zeros/compare/${green}...${run.head_sha}`,
    );
    expect(body).toContain("every merge since the last green main run");
    expect(renderBody(make())).toContain(
      "Commits under test: unknown; no earlier green main run is recorded.",
    );
  });

  it("renders a bounded marker with compulsory lanes and source linkage", () => {
    const contract = make({
      roots: classifyFailures([jobs.composer, jobs.database, jobs.setupFailure])
        .roots,
    });
    const content = renderMarker(contract);
    const marker = JSON.parse(content);
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(4096);
    expect(validateMarker(marker), JSON.stringify(validateMarker.errors)).toBe(
      true,
    );
    expect(validateSchema(marker, INCIDENT_SCHEMA.$defs.marker)).toBe(true);
    expect(marker.required_ci_additions).toEqual([
      "ci:control-plane-db",
      "ci:macos",
      "ci:ui-smoke",
    ]);
    expect(marker.source).toEqual({
      sha: run.head_sha,
      run_id: "123",
      attempt: 2,
    });
    expect(incidentTitle(contract)).toBe("fix(ci): restore full suite on main");
  });

  it("preserves different failing lanes within one aggregate job", () => {
    const contract = make({
      roots: classifyFailures([
        {
          ...jobs.testAggregate,
          name: "control plane",
          steps: [
            { number: 1, name: "Set up job", conclusion: "success" },
            {
              number: 4,
              name: "Typecheck control plane",
              conclusion: "failure",
            },
            {
              number: 5,
              name: "Enforce control-plane results",
              conclusion: "failure",
            },
          ],
        },
      ]).roots,
    });
    expect(validateContract(contract)).toEqual(contract);
    expect(contract.required_lanes).toEqual([
      "control-plane-db",
      "control-plane-static",
    ]);
    expect(contract.latest_failure.failing_jobs.map((job) => job.lane)).toEqual(
      ["control-plane-static", "control-plane-db"],
    );
    expect(parseContractBody(renderBody(contract))).toEqual(contract);
  });

  it("renders unfamiliar conclusions as generic failures without API text", () => {
    const contract = make({
      roots: classifyFailures([
        {
          ...jobs.quality,
          conclusion: "unrecognized private conclusion",
          steps: [
            {
              number: 8,
              name: "Private diagnostic",
              conclusion: "unrecognized private conclusion",
            },
          ],
        },
      ]).roots,
    });
    expect(validateContract(contract)).toEqual(contract);
    expect(renderBody(contract)).not.toMatch(
      /unrecognized private|Private diagnostic/,
    );
    expect(contract.latest_failure.failing_jobs[0].steps[0].conclusion).toBe(
      "failure",
    );
  });

  it("omits secret findings, API outputs and unknown names", () => {
    const contract = make({
      roots: classifyFailures([
        jobs.secretScan,
        {
          ...jobs.quality,
          id: 199,
          name: "unknown private workload",
          steps: [
            {
              number: 2,
              name: "unknown sensitive finding",
              conclusion: "failure",
              output: "private data",
            },
          ],
        },
      ]).roots,
    });
    const body = renderBody(contract);
    expect(body).not.toMatch(
      /unknown sensitive finding|private data|unknown private|sensitive finding never forwarded/,
    );
    expect(body).toContain("SECURITY.md");
    expect(
      contract.latest_failure.failing_jobs.every(
        (job) => job.redacted_excerpt === null,
      ),
    ).toBe(true);
  });

  it("rejects forged, oversized or executable data at the trust boundary", () => {
    const contract = make();
    for (const mutation of [
      { ...contract, extra: "unexpected" },
      { ...contract, branch: "release/1.2.3" },
      { ...contract, required_ci_additions: [] },
      {
        ...contract,
        latest_failure: {
          ...contract.latest_failure,
          run_url: "https://evil.example/run",
        },
      },
      { ...contract, occurrences: Array(33).fill(contract.first_failure) },
      {
        ...contract,
        controller_evidence: {
          ...contract.controller_evidence,
          payload_sha256: "d".repeat(64),
        },
      },
    ]) {
      expect(() => validateContract(mutation)).toThrow();
      expect(() => renderMarker(mutation)).toThrow();
    }
    const forged = structuredClone(contract);
    forged.latest_failure.failing_jobs[0].reproduction.display_command =
      "execute arbitrary data";
    forged.controller_evidence.payload_sha256 = contractDigest(forged);
    expect(() => validateContract(forged)).toThrow("Unregistered reproduction");
    expect(() =>
      parseContractBody(renderBody(contract) + renderJsonBlock(contract)),
    ).toThrow();
    expect(() => parseContractBody("x".repeat(65537))).toThrow();
  });

  it("retains the first failure and bounds idempotent occurrence history", () => {
    let contract = make();
    for (let i = 124; i <= 160; i++) {
      contract = make({
        run: { ...run, id: i, head_sha: "d".repeat(40) },
        previous: contract,
      });
    }
    contract = make({
      run: { ...run, id: 160, head_sha: "d".repeat(40) },
      previous: contract,
    });
    expect(contract.first_failure).toEqual({
      sha: run.head_sha,
      run_id: "123",
      attempt: 2,
    });
    expect(contract.occurrences).toHaveLength(32);
    expect(contract.occurrences.at(-1)?.run_id).toBe("160");
    expect(validate(contract)).toBe(true);
  });

  it("records resolution without dropping the failure or compulsory lanes", () => {
    const previous = make();
    const resolved = resolveContract(
      previous,
      { ...run, id: 200, head_sha: "e".repeat(40) },
      evidence,
    );
    expect(validateContract(resolved).state).toBe("resolved");
    expect(resolved.first_failure).toEqual(previous.first_failure);
    expect(resolved.latest_failure).toEqual(previous.latest_failure);
    expect(resolved.required_lanes).toEqual(["composer"]);
    expect(resolved.resolved_by.sha).toBe("e".repeat(40));
    expect(previous.state).toBe("awaiting_agent");
  });
});
