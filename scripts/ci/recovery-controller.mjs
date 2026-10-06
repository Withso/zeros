import {
  canonicalJson,
  classifyFailures,
  CONTROLLER_PATH,
  decideRecovery,
  digest,
  failureSignature,
  isAncestorComparison,
  isFullyGreen,
  isSourceRun,
  MAIN_REF,
  latestJobs,
  recoveryMode,
  REPOSITORY,
  requiredLanesCovered,
  rootKey,
} from "./recovery-policy.mjs";
import {
  buildContract,
  contractDigest,
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
} from "./recovery-contract.mjs";
import {
  paginate,
  parseReservationName,
  REPO_API,
  reservationName,
} from "./recovery-api.mjs";

const SHA = /^[a-f0-9]{40}$/;
const ID = /^[1-9]\d{0,19}$/;
const BRANCH = /^ci-fix\/([a-f0-9]{64})$/;
const sameRepo = (repo) =>
  repo?.full_name?.toLowerCase() === REPOSITORY.toLowerCase();
const newestFirst = (a, b) =>
  BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0;
const occurrence = (run) => ({
  sha: run.head_sha,
  run_id: String(run.id),
  attempt: run.run_attempt,
});

export function isControllerRun(run, workflow) {
  return (
    workflow?.path === CONTROLLER_PATH &&
    workflow.name === "CI Recovery" &&
    String(run.workflow_id) === String(workflow.id) &&
    run.name === "CI Recovery" &&
    run.path === CONTROLLER_PATH &&
    ["workflow_run", "schedule"].includes(run.event) &&
    run.head_branch === "main" &&
    sameRepo(run.repository) &&
    sameRepo(run.head_repository) &&
    SHA.test(run.head_sha ?? "") &&
    ID.test(String(run.id))
  );
}

export class RecoveryController {
  constructor({ readApi, writeApi = null, env = {}, now = new Date() }) {
    this.read = readApi;
    this.write = writeApi;
    this.env = env;
    this.now = new Date(now);
    this.mode = recoveryMode(env.ZEROS_CI_RECOVERY);
    this.receipts = new Map();
    this.appAuthors = new Map();
    this.ancestry = new Map();
  }

  async metadata({ writing = false } = {}) {
    const repository = await this.read.get(REPO_API);
    if (!sameRepo(repository) || repository.default_branch !== "main")
      throw new Error(
        "Recovery requires this repository's main default branch",
      );
    const main = await this.read.get(REPO_API + "/git/ref/heads/main");
    if (!SHA.test(main?.object?.sha ?? "") || main.object.type !== "commit")
      throw new Error("Invalid current main head");
    const workflow = await this.read.get(
      REPO_API + "/actions/workflows/preflight.yml",
    );
    if (
      workflow.path !== ".github/workflows/preflight.yml" ||
      workflow.name !== "Preflight"
    )
      throw new Error("Canonical Preflight identity changed");
    const controller = await this.read.get(
      REPO_API + "/actions/workflows/ci-recovery.yml",
      { missing: true },
    );
    const metadata = {
      repository,
      head: main.object.sha,
      workflow,
      controller,
    };
    if (writing || this.env.GITHUB_ACTIONS === "true") {
      if (
        this.env.GITHUB_ACTIONS !== "true" ||
        this.env.GITHUB_REF !== MAIN_REF ||
        this.env.GITHUB_REPOSITORY?.toLowerCase() !==
          REPOSITORY.toLowerCase() ||
        !ID.test(this.env.GITHUB_RUN_ID ?? "") ||
        !SHA.test(this.env.GITHUB_SHA ?? "")
      ) {
        throw new Error(
          "Recovery writes require an authenticated main Actions controller",
        );
      }
      const observer = await this.read.get(
        REPO_API + "/actions/runs/" + this.env.GITHUB_RUN_ID,
      );
      if (
        !isControllerRun(observer, controller) ||
        observer.head_sha !== this.env.GITHUB_SHA ||
        observer.run_attempt !== Number(this.env.GITHUB_RUN_ATTEMPT) ||
        !(await this.ancestor(observer.head_sha, metadata.head))
      )
        throw new Error("Untrusted recovery controller revision");
    }
    return metadata;
  }

  async ancestor(ancestor, head) {
    if (!SHA.test(ancestor ?? "") || !SHA.test(head ?? "")) return false;
    if (ancestor === head) return true;
    const key = ancestor + ":" + head;
    if (this.ancestry.has(key)) return this.ancestry.get(key);
    // Changed files and patches appear only on the first compare page; page 2
    // keeps the status and merge base within the 2 MiB response bound.
    const comparison = await this.read.get(
      REPO_API + "/compare/" + ancestor + "..." + head + "?per_page=1&page=2",
    );
    const result = isAncestorComparison(comparison, ancestor, head);
    this.ancestry.set(key, result);
    return result;
  }

  async snapshot(runId, workflow, { listedRun = null } = {}) {
    if (!ID.test(String(runId))) throw new Error("Invalid source run ID");
    const run =
      listedRun ?? (await this.read.get(REPO_API + "/actions/runs/" + runId));
    if (!isSourceRun(run, workflow)) return null;
    const allJobs =
      run.status === "completed"
        ? await paginate(
            this.read,
            REPO_API + "/actions/runs/" + run.id + "/jobs?filter=all",
            "jobs",
          )
        : [];
    for (const job of allJobs) {
      if (
        !ID.test(String(job.id)) ||
        (job.run_id && String(job.run_id) !== String(run.id)) ||
        (job.head_sha && job.head_sha !== run.head_sha) ||
        (job.run_attempt && job.run_attempt > run.run_attempt)
      )
        throw new Error("Invalid source job linkage");
    }
    const jobs = latestJobs(allJobs);
    // Inspection can share metadata freshly fetched by the runs API. Every
    // privileged transition uses the direct, twice-read snapshot instead.
    const latest = listedRun
      ? run
      : await this.read.get(REPO_API + "/actions/runs/" + runId);
    if (
      !isSourceRun(latest, workflow) ||
      latest.run_attempt !== run.run_attempt ||
      latest.head_sha !== run.head_sha ||
      latest.status !== run.status ||
      latest.conclusion !== run.conclusion
    )
      return null;
    const { roots } = classifyFailures(jobs);
    return {
      run,
      jobs,
      roots,
      signature: roots.length
        ? failureSignature(REPOSITORY, run.workflow_id, roots)
        : null,
    };
  }

  async recentRuns(workflow) {
    const since = new Date(this.now.getTime() - 7 * 86400_000).toISOString();
    const runs = await paginate(
      this.read,
      REPO_API +
        "/actions/workflows/" +
        workflow.id +
        "/runs?branch=main&event=push&created=" +
        encodeURIComponent(">=" + since),
      "workflow_runs",
      // Run objects embed head commit messages; 100 per page reached 1.2 MB.
      20,
      50,
    );
    return runs.filter((run) => isSourceRun(run, workflow)).sort(newestFirst);
  }

  async verifyReceipt(artifact, metadata) {
    if (this.receipts.has(String(artifact.id)))
      return this.receipts.get(String(artifact.id));
    const reservation = parseReservationName(artifact.name);
    let verified = null;
    if (
      reservation &&
      !artifact.expired &&
      /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "") &&
      String(artifact.workflow_run?.id) === reservation.runId &&
      ID.test(String(artifact.id)) &&
      Number.isFinite(Date.parse(artifact.created_at)) &&
      artifact.size_in_bytes <= 128 * 1024
    ) {
      const run = await this.read.get(
        REPO_API + "/actions/runs/" + reservation.runId,
        { missing: true },
      );
      if (
        run &&
        isControllerRun(run, metadata.controller) &&
        run.run_attempt >= reservation.attempt &&
        artifact.workflow_run.head_branch === "main" &&
        artifact.workflow_run.head_sha === run.head_sha &&
        (await this.ancestor(run.head_sha, metadata.head))
      ) {
        const jobs = await paginate(
          this.read,
          REPO_API +
            "/actions/runs/" +
            run.id +
            "/attempts/" +
            reservation.attempt +
            "/jobs",
          "jobs",
        );
        if (
          jobs.some((job) =>
            job.steps?.some(
              (step) =>
                step.name === "Save recovery reservation" &&
                step.conclusion === "success",
            ),
          )
        ) {
          verified = { ...artifact, reservation };
        }
      }
    }
    this.receipts.set(String(artifact.id), verified);
    return verified;
  }

  async reservations(metadata, ignoreId = null) {
    const since = this.now.getTime() - 7 * 86400_000;
    const receipts = [];
    for (let page = 1; page <= 20; page++) {
      const result = await this.read.get(
        REPO_API + "/actions/artifacts?per_page=100&page=" + page,
      );
      if (!Array.isArray(result.artifacts))
        throw new Error("Invalid recovery artifact collection");
      for (const artifact of result.artifacts) {
        if (
          Date.parse(artifact.created_at) < since ||
          String(artifact.id) === String(ignoreId)
        )
          continue;
        if (!parseReservationName(artifact.name)) continue;
        const receipt = await this.verifyReceipt(artifact, metadata);
        if (receipt) receipts.push(receipt);
      }
      if (
        result.artifacts.length < 100 ||
        Date.parse(result.artifacts.at(-1).created_at) < since
      )
        return receipts;
    }
    throw new Error(
      "Recovery reservation history exceeds its bound; no writes are safe",
    );
  }

  async authenticateContract(contract, metadata) {
    validateContract(contract);
    const evidence = contract.controller_evidence;
    const artifact = await this.read.get(
      REPO_API + "/actions/artifacts/" + evidence.artifact_id,
      { missing: true },
    );
    if (!artifact) return false;
    const receipt = await this.verifyReceipt(artifact, metadata);
    if (
      !receipt ||
      receipt.reservation.key !== contract.signature ||
      receipt.reservation.payloadHash !== contractDigest(contract) ||
      receipt.reservation.runId !== evidence.run_id ||
      receipt.reservation.attempt !== evidence.attempt ||
      receipt.digest !== evidence.artifact_digest ||
      !["create", "upsert", "resolve"].includes(receipt.reservation.intent)
    )
      return false;
    const source = await this.read.get(
      REPO_API + "/actions/runs/" + contract.latest_failure.run_id,
    );
    return (
      isSourceRun(source, metadata.workflow) &&
      source.head_sha === contract.latest_failure.sha &&
      source.run_attempt >= contract.latest_failure.attempt
    );
  }

  async appAuthor(pr) {
    const expectedSlug =
      this.env.INCIDENT_APP_SLUG || this.env.ZEROS_CI_INCIDENT_APP_SLUG;
    if (expectedSlug && /^[A-Za-z0-9-]+$/.test(expectedSlug)) {
      if (pr.user?.type !== "Bot" || pr.user.login !== expectedSlug + "[bot]")
        return null;
      const key = "bot:" + expectedSlug;
      if (!this.appAuthors.has(key)) {
        this.appAuthors.set(
          key,
          await this.read.get(
            "/users/" + encodeURIComponent(expectedSlug + "[bot]"),
          ),
        );
      }
      const bot = this.appAuthors.get(key);
      return bot?.type === "Bot" && String(bot.id) === String(pr.user.id)
        ? bot
        : null;
    }
    const issue = await this.read.get(REPO_API + "/issues/" + pr.number);
    const app = issue.performed_via_github_app;
    if (
      !app ||
      pr.user?.type !== "Bot" ||
      String(issue.user?.id) !== String(pr.user.id) ||
      pr.user.login !== app.slug + "[bot]"
    )
      return null;
    const key = String(app.id);
    if (!this.appAuthors.has(key)) {
      let registered = app;
      if (
        !registered.client_id &&
        !this.env.INCIDENT_APP_SLUG &&
        !this.env.ZEROS_CI_INCIDENT_APP_SLUG
      ) {
        registered = await this.read.get("/apps/" + app.slug, {
          missing: true,
        });
      }
      const clientMatches =
        this.env.ZEROS_CI_INCIDENT_APP_CLIENT_ID &&
        registered?.client_id === this.env.ZEROS_CI_INCIDENT_APP_CLIENT_ID;
      const slugMatches =
        app.slug ===
        (this.env.INCIDENT_APP_SLUG || this.env.ZEROS_CI_INCIDENT_APP_SLUG);
      const bot =
        clientMatches || slugMatches
          ? await this.read.get(
              "/users/" + encodeURIComponent(app.slug + "[bot]"),
            )
          : null;
      this.appAuthors.set(key, bot && bot.type === "Bot" ? bot : null);
    }
    const bot = this.appAuthors.get(key);
    return bot && String(bot.id) === String(pr.user.id) ? bot : null;
  }

  async untouched(pr, initial, bot) {
    if (
      !bot ||
      !pr.draft ||
      pr.commits !== 1 ||
      pr.assignees?.length ||
      !pr.labels?.some((label) => label.name === "autofix")
    )
      return false;
    const commit = await this.read.get(REPO_API + "/commits/" + pr.head.sha);
    if (
      String(commit.author?.id) !== String(bot.id) ||
      commit.parents?.length !== 1 ||
      commit.files?.length !== 1 ||
      commit.files[0].filename !== initial.marker_path ||
      commit.files[0].status !== "added"
    )
      return false;
    const file = await this.read.get(
      REPO_API + "/contents/" + initial.marker_path + "?ref=" + pr.head.sha,
      { missing: true },
    );
    if (
      !file ||
      file.type !== "file" ||
      file.encoding !== "base64" ||
      file.size > 4096
    )
      return false;
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.length !== file.size || bytes.length > 4096) return false;
    const marker = JSON.parse(bytes.toString("utf8"));
    validateSchema(marker, INCIDENT_SCHEMA.$defs.marker);
    return (
      canonicalJson(marker) === canonicalJson(JSON.parse(renderMarker(initial)))
    );
  }

  async incidents(metadata) {
    // Full pull requests include their descriptions: 100 per page exceeded
    // the 2 MiB response bound. Smaller pages keep the ~1,000-PR scan.
    const pulls = await paginate(
      this.read,
      REPO_API + "/pulls?state=all&sort=created&direction=desc",
      null,
      34,
      30,
    );
    const records = [];
    for (const candidate of pulls.filter((pr) =>
      BRANCH.test(pr.head?.ref ?? ""),
    )) {
      const pr = await this.read.get(REPO_API + "/pulls/" + candidate.number);
      const signature = BRANCH.exec(pr.head?.ref ?? "")?.[1];
      if (!signature) continue;
      const bot = await this.appAuthor(pr);
      const record = {
        signature,
        number: pr.number,
        branch: pr.head.ref,
        state: pr.state,
        created_at: pr.created_at,
        head: pr.head.sha,
        appAuthor: Boolean(bot),
        bot,
        contract: null,
        untouched: false,
        pr,
      };
      try {
        if (
          !bot ||
          pr.base?.ref !== "main" ||
          !sameRepo(pr.base.repo) ||
          !sameRepo(pr.head.repo)
        ) {
          records.push(record);
          continue;
        }
        const initial = parseContractBody(pr.body);
        if (
          initial.signature !== signature ||
          !(await this.authenticateContract(initial, metadata))
        )
          throw new Error("Invalid initial incident authority");
        let latest = initial;
        const comments = await paginate(
          this.read,
          REPO_API + "/issues/" + pr.number + "/comments",
          null,
          4,
        );
        const snapshots = comments.filter(
          (comment) =>
            String(comment.user?.id) === String(bot.id) &&
            comment.user?.type === "Bot" &&
            comment.body?.includes(START),
        );
        if (snapshots.length > 32)
          throw new Error("Incident snapshot history exceeds its bound");
        for (const comment of snapshots) {
          const next = parseContractBody(comment.body);
          if (
            next.signature !== signature ||
            canonicalJson(next.first_failure) !==
              canonicalJson(initial.first_failure) ||
            !(await this.authenticateContract(next, metadata))
          )
            throw new Error("Invalid incident snapshot authority");
          if (
            BigInt(next.controller_evidence.run_id) >
              BigInt(latest.controller_evidence.run_id) ||
            (next.controller_evidence.run_id ===
              latest.controller_evidence.run_id &&
              next.controller_evidence.attempt >
                latest.controller_evidence.attempt)
          )
            latest = next;
        }
        record.contract = latest;
        record.untouched = await this.untouched(pr, initial, bot);
      } catch {
        // Malformed/tampered contracts, missing receipts and human edits all
        // retain the PR/ref and require owner attention.
        record.untouched = false;
      }
      records.push(record);
    }
    return records;
  }

  async reconcile({ eventRunId = null, ignoreReservationId = null } = {}) {
    this.receipts.clear();
    const metadata = await this.metadata();
    const records = await this.incidents(metadata);
    const reservations = await this.reservations(metadata, ignoreReservationId);
    const runs = await this.recentRuns(metadata.workflow);
    const extraIds = new Set([
      ...(eventRunId && ID.test(String(eventRunId))
        ? [String(eventRunId)]
        : []),
      ...records
        .filter((record) => record.state === "open" && record.contract)
        .map((record) => record.contract.latest_failure.run_id),
    ]);
    for (const id of extraIds) {
      if (!runs.some((run) => String(run.id) === id)) {
        const run = await this.read.get(REPO_API + "/actions/runs/" + id);
        if (isSourceRun(run, metadata.workflow)) runs.push(run);
      }
    }
    runs.sort(newestFirst);
    const snapshots = new Map();
    const completed = runs.filter((run) => run.status === "completed");
    const latestCompleted = completed[0]
      ? await this.snapshot(completed[0].id, metadata.workflow)
      : null;
    if (latestCompleted)
      snapshots.set(String(latestCompleted.run.id), latestCompleted);
    const historicalGreen = completed.find(
      (run) => run.conclusion === "success",
    );
    const green = historicalGreen
      ? (snapshots.get(String(historicalGreen.id)) ??
        (await this.snapshot(historicalGreen.id, metadata.workflow)))
      : null;
    const bySignature = new Map();
    for (const run of completed.filter(
      (candidate) => candidate.conclusion !== "success",
    )) {
      const snapshot =
        snapshots.get(String(run.id)) ??
        (await this.snapshot(run.id, metadata.workflow, { listedRun: run }));
      if (!snapshot?.signature) continue;
      if (!bySignature.has(snapshot.signature))
        bySignature.set(snapshot.signature, snapshot);
    }
    for (const record of records.filter(
      (candidate) => candidate.state === "open",
    )) {
      if (!bySignature.has(record.signature)) {
        const snapshot = record.contract
          ? await this.snapshot(
              record.contract.latest_failure.run_id,
              metadata.workflow,
            )
          : null;
        bySignature.set(
          record.signature,
          snapshot ?? {
            run: null,
            jobs: [],
            roots: [],
            signature: record.signature,
          },
        );
      }
    }

    const today = this.now.toISOString().slice(0, 10);
    const createdToday = new Set(
      records
        .filter(
          (record) => record.appAuthor && record.created_at?.startsWith(today),
        )
        .map((record) => record.signature),
    );
    reservations
      .filter(
        (receipt) =>
          receipt.reservation.intent === "create" &&
          receipt.created_at.startsWith(today),
      )
      .forEach((receipt) => createdToday.add(receipt.reservation.key));
    let newToday = createdToday.size;
    let openCount = records.filter(
      (record) => record.appAuthor && record.state === "open",
    ).length;
    const decisions = [];
    for (const [signature, snapshot] of bySignature) {
      const matches = records.filter(
        (record) => record.signature === signature && record.state === "open",
      );
      const incident = matches[0] ?? null;
      let resolved = false;
      if (
        incident?.contract &&
        latestCompleted &&
        isFullyGreen(latestCompleted.run, latestCompleted.jobs) &&
        latestCompleted.run.head_sha === metadata.head &&
        requiredLanesCovered(incident.contract, latestCompleted.jobs)
      ) {
        const failures = [
          incident.contract.first_failure.sha,
          incident.contract.latest_failure.sha,
          snapshot.run?.head_sha,
        ].filter(Boolean);
        resolved = (
          await Promise.all(
            failures.map((sha) => this.ancestor(sha, metadata.head)),
          )
        ).every(Boolean);
      } else if (
        !incident &&
        snapshot.run &&
        green &&
        isFullyGreen(green.run, green.jobs) &&
        BigInt(green.run.id) >= BigInt(snapshot.run.id)
      ) {
        const required = {
          required_lanes: [...new Set(snapshot.roots.map((root) => root.lane))],
        };
        resolved =
          requiredLanesCovered(required, green.jobs) &&
          (await this.ancestor(snapshot.run.head_sha, green.run.head_sha));
      }
      const branch = incident
        ? null
        : await this.read.get(REPO_API + "/git/ref/heads/ci-fix/" + signature, {
            missing: true,
          });
      const retryReserved = reservations.some(
        (receipt) =>
          receipt.reservation.intent === "retry" &&
          receipt.reservation.key === String(snapshot.run?.id),
      );
      const decision = decideRecovery({
        ...snapshot,
        signature,
        incident,
        duplicate: matches.length > 1,
        branchExists: Boolean(branch),
        openCount,
        newToday,
        retryReserved,
        retryHistoryComplete:
          Date.parse(snapshot.run?.created_at) >=
          this.now.getTime() - 7 * 86400_000,
        resolved,
        mode: this.mode,
      });
      const row = {
        ...decision,
        run_id: snapshot.run ? String(snapshot.run.id) : null,
        attempt: snapshot.run?.run_attempt ?? null,
        roots: snapshot.roots.map(rootKey),
        snapshot,
        incident,
      };
      decisions.push(row);
      if (decision.action === "upsert" && !incident) {
        openCount++;
        newToday++;
      }
    }
    return {
      metadata,
      decisions,
      records,
      reservations,
      latestCompleted,
      green,
      openCount,
      newToday,
    };
  }

  async retryDecision(runId, signature, attempt, ignoreReservationId = null) {
    const metadata = await this.metadata({ writing: true });
    const snapshot = await this.snapshot(runId, metadata.workflow);
    if (
      !snapshot ||
      snapshot.signature !== signature ||
      snapshot.run.run_attempt !== attempt
    )
      return null;
    if (
      !(
        Date.parse(snapshot.run.created_at) >=
        this.now.getTime() - 7 * 86400_000
      )
    )
      return null;
    const receipts = await this.reservations(metadata, ignoreReservationId);
    const reserved = receipts.some(
      (receipt) =>
        receipt.reservation.intent === "retry" &&
        receipt.reservation.key === String(runId),
    );
    const decision = decideRecovery({
      ...snapshot,
      signature,
      retryReserved: reserved,
      mode: this.mode,
    });
    if (decision.action !== "retry" || !decision.writeAllowed) return null;
    const runs = await this.recentRuns(metadata.workflow);
    const latest = runs.find((run) => run.status === "completed");
    if (
      latest?.conclusion === "success" &&
      BigInt(latest.id) >= BigInt(runId)
    ) {
      const green = await this.snapshot(latest.id, metadata.workflow);
      const required = {
        required_lanes: [...new Set(snapshot.roots.map((root) => root.lane))],
      };
      if (
        green &&
        isFullyGreen(green.run, green.jobs) &&
        requiredLanesCovered(required, green.jobs) &&
        (await this.ancestor(snapshot.run.head_sha, green.run.head_sha))
      )
        return null;
    }
    return { metadata, snapshot, decision };
  }

  async prepare({ intent, signature, runId, attempt }) {
    if (
      !["retry", "upsert", "resolve"].includes(intent) ||
      !/^[a-f0-9]{64}$/.test(signature) ||
      !ID.test(String(runId)) ||
      !Number.isInteger(attempt)
    )
      throw new Error("Invalid recovery transition");
    let payload,
      source,
      actualIntent,
      previousDigest = null;
    if (intent === "retry") {
      const current = await this.retryDecision(runId, signature, attempt);
      if (!current) return null;
      source = occurrence(current.snapshot.run);
      payload = {
        ...source,
        signature,
        root_keys: current.snapshot.roots.map(rootKey).sort(),
      };
      actualIntent = "retry";
    } else {
      await this.metadata({ writing: true });
      const state = await this.reconcile();
      const row = state.decisions.find(
        (decision) => decision.signature === signature,
      );
      if (
        !row ||
        row.action !== intent ||
        !row.writeAllowed ||
        row.run_id !== String(runId) ||
        row.attempt !== attempt
      )
        return null;
      if (intent === "upsert") {
        const fresh = await this.snapshot(runId, state.metadata.workflow);
        if (
          !fresh ||
          fresh.signature !== signature ||
          fresh.run.run_attempt !== attempt ||
          fresh.run.status !== "completed" ||
          fresh.run.conclusion === "success"
        )
          return null;
        row.snapshot = fresh;
      }
      source = row.snapshot.run
        ? occurrence(row.snapshot.run)
        : occurrence(state.latestCompleted.run);
      previousDigest = row.incident?.contract
        ? contractDigest(row.incident.contract)
        : null;
      actualIntent = intent === "upsert" && !row.incident ? "create" : intent;
      if (intent === "resolve")
        payload = resolveContract(
          row.incident.contract,
          state.latestCompleted.run,
        );
      else {
        const associatedPrs = await paginate(
          this.read,
          REPO_API + "/commits/" + source.sha + "/pulls",
        );
        payload = buildContract({
          run: row.snapshot.run,
          roots: row.snapshot.roots,
          previous: row.incident?.contract,
          associatedPrs,
          lastGreenSha: state.green?.run.head_sha ?? null,
          retried: state.reservations.some(
            (receipt) =>
              receipt.reservation.intent === "retry" &&
              receipt.reservation.key === String(runId),
          ),
        });
      }
    }
    const payloadHash =
      intent === "retry"
        ? digest(canonicalJson(payload))
        : contractDigest(payload);
    const name = reservationName({
      intent: actualIntent,
      key: intent === "retry" ? String(runId) : signature,
      payloadHash,
      runId: this.env.GITHUB_RUN_ID,
      attempt: Number(this.env.GITHUB_RUN_ATTEMPT),
    });
    return {
      schema: "zeros.ci-recovery-reservation/v1",
      intent: actualIntent,
      signature,
      source,
      previous_digest: previousDigest,
      payload,
      payload_hash: payloadHash,
      artifact_name: name,
    };
  }

  async apply(reservation, { artifactId, artifactDigest }) {
    if (!this.write) throw new Error("Recovery write client is missing");
    const metadata = await this.metadata({ writing: true });
    const isRetry = reservation.intent === "retry";
    if (!(this.mode === "enabled" || (isRetry && this.mode === "retry")))
      return { applied: false, reason: "mode-off" };
    const parsed = parseReservationName(reservation.artifact_name);
    const payloadHash = isRetry
      ? digest(canonicalJson(reservation.payload))
      : contractDigest(reservation.payload);
    if (
      reservation.schema !== "zeros.ci-recovery-reservation/v1" ||
      !parsed ||
      parsed.intent !== reservation.intent ||
      parsed.key !==
        (isRetry ? reservation.source.run_id : reservation.signature) ||
      parsed.runId !== this.env.GITHUB_RUN_ID ||
      parsed.attempt !== Number(this.env.GITHUB_RUN_ATTEMPT) ||
      parsed.payloadHash !== payloadHash ||
      reservation.payload_hash !== payloadHash ||
      !ID.test(String(artifactId))
    )
      throw new Error("Invalid local recovery reservation");
    // The pinned upload action emits bare hex; REST returns "sha256:<hex>".
    artifactDigest = /^[a-f0-9]{64}$/.test(artifactDigest ?? "")
      ? "sha256:" + artifactDigest
      : artifactDigest;
    const artifact = await this.read.get(
      REPO_API + "/actions/artifacts/" + artifactId,
    );
    const receipt = await this.verifyReceipt(artifact, metadata);
    if (
      !receipt ||
      receipt.name !== reservation.artifact_name ||
      receipt.digest !== artifactDigest
    )
      throw new Error("Recovery reservation was not saved successfully");

    if (isRetry) {
      const current = await this.retryDecision(
        reservation.source.run_id,
        reservation.signature,
        reservation.source.attempt,
        artifactId,
      );
      if (!current || current.snapshot.run.head_sha !== reservation.source.sha)
        return { applied: false, reason: "stale-source" };
      // This is the last GET before the POST. A queued rerun, manual attempt,
      // concurrent delivery or changed conclusion consumes no second retry.
      const latest = await this.read.get(
        REPO_API + "/actions/runs/" + reservation.source.run_id,
      );
      if (
        !isSourceRun(latest, metadata.workflow) ||
        latest.run_attempt !== 1 ||
        latest.status !== "completed" ||
        latest.conclusion !== current.snapshot.run.conclusion ||
        latest.head_sha !== reservation.source.sha
      )
        return { applied: false, reason: "stale-attempt" };
      await this.write.post(
        REPO_API + "/actions/runs/" + latest.id + "/rerun-failed-jobs",
        {},
      );
      return { applied: true, action: "retry", run_id: String(latest.id) };
    }

    const state = await this.reconcile({ ignoreReservationId: artifactId });
    const row = state.decisions.find(
      (decision) => decision.signature === reservation.signature,
    );
    const expected =
      reservation.intent === "create" ? "upsert" : reservation.intent;
    if (
      !row ||
      row.action !== expected ||
      !row.writeAllowed ||
      row.run_id !== reservation.source.run_id ||
      row.attempt !== reservation.source.attempt ||
      row.snapshot.run?.head_sha !== reservation.source.sha ||
      (row.incident?.contract
        ? contractDigest(row.incident.contract)
        : null) !== reservation.previous_digest
    ) {
      return { applied: false, reason: "stale-decision" };
    }
    if (expected === "upsert") {
      const fresh = await this.snapshot(
        reservation.source.run_id,
        metadata.workflow,
      );
      if (
        !fresh ||
        fresh.signature !== reservation.signature ||
        fresh.run.run_attempt !== reservation.source.attempt ||
        fresh.run.head_sha !== reservation.source.sha ||
        fresh.run.status !== "completed" ||
        fresh.run.conclusion === "success"
      ) {
        return { applied: false, reason: "stale-source" };
      }
    }
    const contract = {
      ...reservation.payload,
      controller_evidence: {
        run_id: this.env.GITHUB_RUN_ID,
        attempt: Number(this.env.GITHUB_RUN_ATTEMPT),
        artifact_id: String(artifactId),
        artifact_digest: artifactDigest,
        payload_sha256: payloadHash,
      },
    };
    validateContract(contract);
    if (row.incident) {
      const pr = await this.read.get(
        REPO_API + "/pulls/" + row.incident.number,
      );
      if (
        pr.head.sha !== row.incident.head ||
        pr.assignees?.length ||
        !pr.draft ||
        !pr.labels?.some((label) => label.name === "autofix")
      )
        return { applied: false, reason: "new-human-claim" };
      if (expected === "resolve") {
        const main = await this.read.get(REPO_API + "/git/ref/heads/main");
        const latest = await this.read.get(
          REPO_API + "/actions/runs/" + contract.resolved_by.run_id,
        );
        if (
          main.object.sha !== contract.resolved_by.sha ||
          !isSourceRun(latest, metadata.workflow) ||
          latest.run_attempt !== contract.resolved_by.attempt ||
          latest.status !== "completed" ||
          latest.conclusion !== "success"
        )
          return { applied: false, reason: "new-main-evidence" };
      }
      if (
        expected !== "resolve" ||
        row.incident.contract.state !== "resolved"
      ) {
        await this.write.post(REPO_API + "/issues/" + pr.number + "/comments", {
          body:
            (expected === "resolve"
              ? "CI recovery resolved this untouched incident. The owner may close this draft."
              : "CI recovery recorded another occurrence.") +
            "\n\n" +
            renderJsonBlock(contract),
        });
      }
      if (expected === "resolve")
        await this.write.delete(
          REPO_API + "/issues/" + pr.number + "/labels/autofix",
        );
      else
        await this.write.post(REPO_API + "/issues/" + pr.number + "/labels", {
          labels: ["ci-failure", "autofix", ...contract.required_ci_additions],
        });
      return { applied: true, action: expected, pr: pr.number };
    }
    if (expected !== "upsert")
      return { applied: false, reason: "incident-missing" };
    return this.createIncident(contract);
  }

  async createIncident(contract) {
    const branch = await this.read.get(
      REPO_API + "/git/ref/heads/" + contract.branch,
      { missing: true },
    );
    if (branch) return { applied: false, reason: "retained-ref-needs-owner" };
    if (!/^[A-Za-z0-9-]+$/.test(this.env.INCIDENT_APP_SLUG ?? ""))
      throw new Error("Minted incident App identity is missing");
    if (
      this.env.INCIDENT_APP_SLUG === "zeros-agent" ||
      (this.env.ZEROS_CI_INCIDENT_APP_SLUG &&
        this.env.ZEROS_CI_INCIDENT_APP_SLUG !== this.env.INCIDENT_APP_SLUG)
    ) {
      throw new Error(
        "Minted App does not match the dedicated incident identity",
      );
    }
    const bot = await this.read.get(
      "/users/" + encodeURIComponent(this.env.INCIDENT_APP_SLUG + "[bot]"),
    );
    if (bot.type !== "Bot" || !ID.test(String(bot.id)))
      throw new Error("Invalid incident App bot identity");
    const identity = {
      name: bot.login,
      email: bot.id + "+" + bot.login + "@users.noreply.github.com",
    };
    const main = await this.read.get(REPO_API + "/git/ref/heads/main");
    const parent = await this.read.get(
      REPO_API + "/git/commits/" + main.object.sha,
    );
    const blob = await this.write.post(REPO_API + "/git/blobs", {
      content: renderMarker(contract),
      encoding: "utf-8",
    });
    const tree = await this.write.post(REPO_API + "/git/trees", {
      base_tree: parent.tree.sha,
      tree: [
        {
          path: contract.marker_path,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
        },
      ],
    });
    const lane =
      contract.required_lanes.length === 1
        ? contract.required_lanes[0]
        : "full suite";
    const commit = await this.write.post(REPO_API + "/git/commits", {
      message: "ci: record " + lane + " failure on main",
      tree: tree.sha,
      parents: [main.object.sha],
      author: identity,
      committer: identity,
    });
    try {
      await this.write.post(REPO_API + "/git/refs", {
        ref: "refs/heads/" + contract.branch,
        sha: commit.sha,
      });
    } catch (error) {
      if (error.status === 422)
        return { applied: false, reason: "ref-collision-needs-owner" };
      throw error;
    }
    let pr;
    try {
      pr = await this.write.post(REPO_API + "/pulls", {
        title: incidentTitle(contract),
        body: renderBody(contract),
        head: contract.branch,
        base: "main",
        draft: true,
      });
    } catch (error) {
      if (error.status === 422) {
        const matches = await paginate(
          this.read,
          REPO_API +
            "/pulls?state=open&head=" +
            encodeURIComponent("Withso:" + contract.branch),
        );
        if (matches.length === 1 && (await this.appAuthor(matches[0])))
          return {
            applied: false,
            reason: "pr-already-created",
            pr: matches[0].number,
          };
      }
      throw error;
    }
    await this.write.post(REPO_API + "/issues/" + pr.number + "/labels", {
      labels: ["ci-failure", "autofix", ...contract.required_ci_additions],
    });
    return { applied: true, action: "upsert", pr: pr.number };
  }
}
