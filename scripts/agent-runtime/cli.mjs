#!/usr/bin/env node
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { GitHub } from "./github.mjs";
import {
  hash,
  invariant,
  parseJson,
  sha,
  validatePublicModelObservation,
  validateTask,
} from "./contracts.mjs";
import {
  addProposalEvent,
  dueEvents,
  healthFindings,
  initialState,
  reduceObservations,
} from "./state.mjs";
import {
  bootstrapTracking,
  ensureControlLabels,
  loadTracking,
  publishHealth,
  publishTracking,
} from "./publish.mjs";
import {
  confirmWrittenResults,
  finalizeResults,
  manifestPins,
  preparedEnvelope,
  reconcileProposals,
  refreshPrReports,
  workflowContext,
} from "./controller.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    root: { type: "string" },
    base: { type: "string" },
    "public-only": { type: "boolean", default: false },
  },
});
const command = positionals[0] ?? "scan",
  root = resolve(values.root ?? process.cwd());
const output = resolve(values.out ?? ".context/agent-runtime"),
  now = new Date().toISOString();
const env = process.env,
  github = new GitHub();
const mode =
  env.AGENT_RUNTIME_ACTION === "dry-run"
    ? "dry-run"
    : (env.ZEROS_AGENT_RUNTIME_MODE ?? "dry-run");
const publishing = ["notify", "enabled"].includes(mode),
  appSlug = env.ZEROS_AGENT_RUNTIME_APP_SLUG;
const issue = Number(env.ZEROS_AGENT_RUNTIME_TRACKING_ISSUE);
const save = (name, value) => {
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, name), `${JSON.stringify(value)}\n`);
};
const githubOutput = (name, value) => {
  if (env.GITHUB_OUTPUT)
    appendFileSync(
      env.GITHUB_OUTPUT,
      `${name}=${typeof value === "string" ? value : JSON.stringify(value)}\n`,
    );
};
const gitSha = (ref = "HEAD") => {
  const result = execFileSync(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  invariant(sha(result), "Invalid local commit.");
  return result;
};

async function trackingState() {
  if (publishing) {
    workflowContext();
    return loadTracking(github, issue, now);
  }
  return { state: initialState(now) };
}

async function publish(tracking, state) {
  if (!publishing) return state;
  const saved = await publishTracking(github, tracking, state, now);
  await refreshPrReports(github, saved, {
    trackingIssue: tracking.issue.number,
    updatesEnabled: mode === "enabled",
  });
  return saved;
}

async function main() {
  invariant(
    ["off", "dry-run", "notify", "enabled"].includes(mode),
    "Unknown runtime notification rollout mode.",
  );
  if (command === "scan" || command === "bootstrap") {
    let tracking;
    if (command === "bootstrap") {
      invariant(publishing, "Bootstrap requires notification mode.");
      workflowContext();
      await ensureControlLabels(github);
      tracking = await bootstrapTracking(github, now);
      githubOutput("tracking-issue", String(tracking.issue.number));
      console.log(
        `Runtime tracking issue: #${tracking.issue.number}. Set ZEROS_AGENT_RUNTIME_TRACKING_ISSUE to this number.`,
      );
    } else tracking = await trackingState();
    const automation = gitSha(),
      pins = manifestPins(readFileSync(join(root, "package.json"), "utf8"));
    const { collectPublic } = await import("./sources.mjs");
    const keeperPin = parseJson(
      readFileSync(join(root, "apps/control-plane/package.json"), "utf8"),
    ).dependencies["@openai/codex"];
    const observations = await collectPublic(pins, tracking.state.sources, {
      now,
      token: github.token,
      keeperPin,
    });
    let state = reduceObservations(tracking.state, observations, now, {
      bootstrap: command === "bootstrap",
    });
    state.modelsEnabledAt =
      env.ZEROS_AGENT_RUNTIME_MODELS === "enabled"
        ? (state.modelsEnabledAt ?? now)
        : null;
    let tasks = [];
    if (!values["public-only"]) {
      const main = (await github.get("/git/ref/heads/main")).object.sha;
      // The checkout is the workflow's immutable main, not a moving ref fetched
      // midway through scanning. A later main push is handled by the next run.
      invariant(
        !publishing || automation === env.GITHUB_SHA,
        "Trusted scan checkout mismatch.",
      );
      if (mode === "enabled")
        invariant(
          /^[a-z0-9-]+$/.test(appSlug ?? ""),
          "Configure the updater App slug before enabling writes.",
        );
      ({ state, tasks } = await reconcileProposals({
        github,
        input: state,
        observations,
        pins: manifestPins(await github.file("package.json", main)),
        main,
        automation,
        now,
        appSlug,
        createTasks: mode === "enabled",
      }));
      if (publishing)
        state = await (
          await import("./pr-evidence.mjs")
        ).refreshLatestPrEvidence(github, state, appSlug);
      const { collectDelivery } = await import("./delivery.mjs");
      state = reduceObservations(
        state,
        await collectDelivery(github, state, now),
        now,
      );
    }
    if (command === "bootstrap")
      addProposalEvent(
        state,
        "all",
        "initial-inventory",
        "v1",
        "Runtime notifications initialized for Claude, Codex and Cursor. Subscribe to this issue for release, model, capability, health and delivery updates; historical releases were seeded without a notification flood.",
        now,
        "info",
      );
    const hasEvidence =
      !publishing ||
      command === "bootstrap" ||
      tasks.length > 0 ||
      observations.some((item) => item.status !== "complete") ||
      dueEvents(state).length > 0;
    state = await publish(tracking, state);
    save("scan.json", {
      schema: 1,
      automation,
      now,
      mode,
      observations,
      state,
      tasks,
    });
    githubOutput("tasks", { include: tasks });
    githubOutput("has-tasks", tasks.length ? "true" : "false");
    githubOutput("has-evidence", hasEvidence ? "true" : "false");
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `Runtime scan: ${observations.filter((item) => item.status === "complete").length}/${observations.length} public sources complete; ${tasks.length} preparation task(s); mode ${mode}.\n${publishing ? `\n[Tracking issue](https://github.com/Withso/zeros/issues/${tracking.issue.number})\n` : ""}`,
      );
    console.log(
      `Runtime scan: ${observations.filter((item) => item.status === "complete").length}/${observations.length} public sources complete; ${tasks.length} preparation task(s); mode ${mode}.`,
    );
    return;
  }
  if (command === "prepare") {
    const task = validateTask(parseJson(env.TASK_JSON));
    const context = {
      id: Number(env.GITHUB_RUN_ID),
      attempt: Number(env.GITHUB_RUN_ATTEMPT),
    };
    let result;
    try {
      result = await (
        await import("./prepare.mjs")
      ).prepareUpdate(task, { root });
    } catch {
      result = {
        status: "blocked",
        reason: "managed-files-conflict-or-preparation-failed",
      };
    }
    save("prepared.json", preparedEnvelope(task, result, context));
    console.log(`Runtime preparation: ${task.provider} ${result.status}.`);
    return;
  }
  if (command === "bundle-writer") {
    const { build } = await import("esbuild");
    mkdirSync(output, { recursive: true });
    const file = join(output, "writer.mjs");
    await build({
      entryPoints: [join(root, "scripts/agent-runtime/writer-entry.mjs")],
      outfile: file,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      logLevel: "error",
    });
    githubOutput("writer-sha256", hash(readFileSync(file)));
    return;
  }
  if (command === "finalize") {
    invariant(publishing, "Finalization requires notification mode.");
    const context = workflowContext(),
      tracking = await trackingState();
    const tasks = parseJson(env.TASKS_JSON).include.map(validateTask);
    const { readArtifact, validateRun } = await import("./artifacts.mjs");
    const { validateReport } = await import("./qualification.mjs");
    const run = validateRun(await github.get(`/actions/runs/${context.id}`), {
      ...context,
      workflow: "agent-runtime-radar.yml",
      events: ["schedule", "workflow_dispatch"],
    });
    const results = [];
    for (const task of tasks) {
      try {
        const value = await readArtifact(
          github,
          run,
          `agent-runtime-written-${task.provider}-${context.id}-${context.attempt}`,
          "result.json",
        );
        invariant(
          value.schema === 1 &&
            value.runId === context.id &&
            value.attempt === context.attempt &&
            value.result?.taskId === task.id,
          "Writer receipt mismatch.",
        );
        if (value.result.report) validateReport(value.result.report);
        results.push(value.result);
      } catch {
        /* Reconcile the signed App commits even if an artifact is absent. */
      }
    }
    const verified = await confirmWrittenResults(
      github,
      tasks,
      results,
      appSlug,
    );
    let state = finalizeResults(
      tracking.state,
      tasks,
      verified,
      now,
      context.runUrl,
    );
    const main = (await github.get("/git/ref/heads/main")).object.sha;
    ({ state } = await reconcileProposals({
      github,
      input: state,
      pins: manifestPins(await github.file("package.json", main)),
      main,
      automation: context.head,
      now,
      appSlug,
    }));
    await publish(tracking, state);
    return;
  }
  if (command === "models") {
    const { discoverAll } = await import("./models.mjs");
    const observations = await discoverAll({
      root,
      env,
      now,
      scope: env.ZEROS_AGENT_RUNTIME_MODEL_SCOPE ?? "dedicated-test",
      additionalPublicIds: parseJson(
        readFileSync(
          join(root, "scripts/agent-runtime/public-model-ids.json"),
          "utf8",
        ),
      ),
    });
    save("models.json", {
      schema: 1,
      source: gitSha(),
      runId: Number(env.GITHUB_RUN_ID) || null,
      attempt: Number(env.GITHUB_RUN_ATTEMPT) || null,
      observations,
    });
    console.log(
      `Listing-only discovery: ${observations.filter((item) => item.status === "complete").length}/3 complete. No prompts or inference were requested.`,
    );
    if (
      observations.some(
        (item) =>
          item.status !== "complete" ||
          item.data.requiredCuratedMissing?.length,
      )
    )
      process.exitCode = 1;
    return;
  }
  if (command === "publish-models") {
    invariant(publishing, "Model publication requires notification mode.");
    const context = workflowContext(),
      tracking = await trackingState();
    const { readArtifact, validateRun } = await import("./artifacts.mjs");
    const run = validateRun(await github.get(`/actions/runs/${context.id}`), {
      ...context,
      workflow: "agent-runtime-models.yml",
      events: ["schedule", "workflow_dispatch"],
    });
    const value = await readArtifact(
      github,
      run,
      `agent-runtime-models-${context.id}-${context.attempt}`,
      "models.json",
    );
    invariant(
      value.schema === 1 &&
        value.source === context.head &&
        value.runId === context.id &&
        value.attempt === context.attempt &&
        Array.isArray(value.observations) &&
        value.observations.length === 3,
      "Model discovery provenance mismatch.",
    );
    const modelPolicy = {
      catalog: parseJson(
        readFileSync(join(root, "catalogs/models-v1.json"), "utf8"),
      ),
      publicIds: parseJson(
        readFileSync(
          join(root, "scripts/agent-runtime/public-model-ids.json"),
          "utf8",
        ),
      ),
    };
    const observations = value.observations.map((item) =>
      validatePublicModelObservation(item, modelPolicy),
    );
    invariant(
      new Set(observations.map((item) => item.provider)).size === 3 &&
        observations.every(
          (item) =>
            item.kind === "models" && item.id === `${item.provider}-models`,
        ),
      "Invalid model discovery inventory.",
    );
    const state = reduceObservations(tracking.state, observations, now);
    state.scannedAt = tracking.state.scannedAt;
    await publish(tracking, state);
    return;
  }
  if (command === "watchdog") {
    if (!publishing) return;
    workflowContext();
    let findings;
    try {
      findings = healthFindings(
        (await loadTracking(github, issue, now)).state,
        now,
        { modelsEnabled: env.ZEROS_AGENT_RUNTIME_MODELS === "enabled" },
      );
    } catch {
      findings = [
        "Durable notification state is unavailable or corrupt; operator recovery is required.",
      ];
    }
    await publishHealth(github, issue, findings, now);
    console.log(
      `Independent notification health: ${findings.length ? "needs attention" : "healthy"}.`,
    );
    if (findings.length) process.exitCode = 1;
    return;
  }
  if (command === "report") {
    if (!publishing) return;
    workflowContext();
    const event = parseJson(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    if (event.workflow_run?.event !== "pull_request") return;
    const tracking = await trackingState();
    const { acceptPrEvidence } = await import("./pr-evidence.mjs");
    const accepted = await acceptPrEvidence(github, tracking.state, {
      id: event.workflow_run.id,
      attempt: event.workflow_run.run_attempt,
      appSlug,
    });
    if (accepted.status === "accepted") {
      const main = (await github.get("/git/ref/heads/main")).object.sha;
      const reconciled = await reconcileProposals({
        github,
        input: accepted.state,
        pins: manifestPins(await github.file("package.json", main)),
        main,
        automation: env.GITHUB_SHA,
        now,
        appSlug,
      });
      await publish(tracking, reconciled.state);
    }
    console.log(`Runtime report: ${accepted.status}.`);
    return;
  }
  if (command === "surfaces") {
    const changes = await (
      await import("./surfaces.mjs")
    ).inspectSurfaces({ root, base: gitSha(values.base ?? "origin/main") });
    save("surfaces.json", { schema: 1, changes });
    console.log(
      `Runtime surfaces: ${changes.length} structural change(s), ${changes.filter((change) => !change.disposition).length} pending dispositions. Details: ${join(output, "surfaces.json")}`,
    );
    if (changes.some((change) => !change.disposition)) process.exitCode = 1;
    return;
  }
  if (command === "qualify") {
    const testedHead = gitSha(),
      head = env.RUNTIME_SOURCE_SHA || testedHead;
    const base = env.RUNTIME_BASE_SHA || gitSha(values.base ?? "origin/main");
    const { qualify } = await import("./qualification.mjs");
    const report = await qualify({
      root,
      output,
      head,
      testedHead,
      base,
      pr: Number(env.RUNTIME_PR) || null,
      runId: Number(env.GITHUB_RUN_ID) || null,
      attempt: Number(env.GITHUB_RUN_ATTEMPT) || null,
      event: env.GITHUB_EVENT_NAME ?? "local",
      setup: env.RUNTIME_SETUP_OK !== "false",
    });
    if (report.gates.some((gate) => gate.status !== "passed"))
      process.exitCode = 1;
    return;
  }
  if (command === "publication-receipt") {
    const { publicationReceipt } = await import("./delivery.mjs");
    let diagnostic = null;
    try {
      diagnostic = parseJson(
        readFileSync(env.RUNTIME_PUBLICATION_DIAGNOSTIC, "utf8"),
      );
    } catch {
      /* A failed setup still emits unknown evidence. */
    }
    const receipt = publicationReceipt({
      directory: env.RUNTIME_BUNDLE_DIRECTORY,
      diagnostic,
      runId: Number(env.GITHUB_RUN_ID),
      attempt: Number(env.GITHUB_RUN_ATTEMPT),
      source: env.GITHUB_SHA,
    });
    save("publication.json", receipt);
    return;
  }
  throw new Error("Unknown runtime notification command.");
}

main().catch(() => {
  console.error(
    `Agent runtime ${/^[a-z-]+$/.test(command) ? command : "command"} failed. State was not reset; inspect configuration, source availability and run provenance before retrying.`,
  );
  process.exitCode = 1;
});
