#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHubApi } from "./recovery-api.mjs";
import { RecoveryController } from "./recovery-controller.mjs";

export function guardMarkers(root = process.cwd()) {
  const directory = path.join(root, ".github/ci-incidents");
  if (!existsSync(directory)) return;
  if (readdirSync(directory).some((name) => name.endsWith(".json"))) {
    throw new Error(
      "Unresolved CI incident marker: remove .github/ci-incidents/*.json together with the real fix and regression test. Keep the requested CI labels.",
    );
  }
}

export function publicSummary(state, mode) {
  return {
    mode,
    writes_enabled: mode === "enabled",
    retries_enabled: mode === "retry" || mode === "enabled",
    main_head: state.metadata.head,
    latest_completed_preflight: state.latestCompleted
      ? {
          run_id: String(state.latestCompleted.run.id),
          attempt: state.latestCompleted.run.run_attempt,
          conclusion: state.latestCompleted.run.conclusion,
        }
      : null,
    decisions: state.decisions.map(
      ({
        signature,
        action,
        reason,
        writeAllowed,
        run_id,
        attempt,
        roots,
      }) => ({
        signature,
        decision: action,
        reason,
        write_allowed: writeAllowed,
        run_id,
        attempt,
        root_keys: roots,
      }),
    ),
  };
}

const output = (env, name, value) => {
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, name + "=" + value + "\n");
};
const boundedJsonFile = (file) => {
  const buffer = readFileSync(file);
  if (buffer.length > 64 * 1024)
    throw new Error("Recovery JSON file exceeds 64 KiB");
  return JSON.parse(buffer.toString("utf8"));
};

export async function runCli(args = process.argv.slice(2), env = process.env) {
  const [command, ...flags] = args;
  const option = (name) => {
    const index = flags.indexOf(name);
    return index >= 0 ? flags[index + 1] : null;
  };
  if (command === "guard-markers") {
    guardMarkers();
    return;
  }
  if (!["inspect", "prepare", "apply"].includes(command))
    throw new Error("Use inspect, prepare, apply or guard-markers");
  if (!env.GH_TOKEN)
    throw new Error("A read token is required for GitHub recovery metadata");
  const readApi = createGitHubApi({ token: env.GH_TOKEN });
  const intent = option("--intent");
  const writeApi =
    command === "apply"
      ? createGitHubApi({
          token: intent === "retry" ? env.GH_TOKEN : env.INCIDENT_WRITE_TOKEN,
          writeKind: intent === "retry" ? "retry" : "incident",
        })
      : null;
  if (command === "apply" && intent !== "retry" && !env.INCIDENT_WRITE_TOKEN)
    throw new Error("The protected incident App token is required");
  const controller = new RecoveryController({ readApi, writeApi, env });
  if (command === "inspect") {
    let eventRunId = null;
    const eventFile = option("--event-file");
    if (eventFile)
      eventRunId = boundedJsonFile(eventFile).workflow_run?.id ?? null;
    const state = await controller.reconcile({ eventRunId });
    const summary = publicSummary(state, controller.mode);
    const json = JSON.stringify(summary, null, 2);
    console.log(json);
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        "CI Recovery inspection\n\n" + json + "\n",
      );
    for (const [action, name] of [
      ["retry", "retries"],
      ["upsert", "upserts"],
      ["resolve", "resolutions"],
    ]) {
      const rows = state.decisions
        .filter(
          (decision) => decision.action === action && decision.writeAllowed,
        )
        .slice(0, 32)
        .map(({ signature, run_id, attempt }) => ({
          signature,
          run_id,
          attempt,
        }));
      output(env, name, JSON.stringify(rows));
      output(env, "has_" + name, String(rows.length > 0));
    }
    return summary;
  }
  if (command === "prepare") {
    const reservation = await controller.prepare({
      intent,
      signature: env.RECOVERY_SIGNATURE,
      runId: env.RECOVERY_RUN_ID,
      attempt: Number(env.RECOVERY_RUN_ATTEMPT),
    });
    output(env, "proceed", String(Boolean(reservation)));
    if (!reservation) {
      console.log("Recovery decision is stale or disabled; no side effect.");
      return;
    }
    const outFile = option("--out-file");
    if (!outFile) throw new Error("A reservation output file is required");
    const json = JSON.stringify(reservation);
    if (Buffer.byteLength(json) > 64 * 1024)
      throw new Error("Recovery reservation exceeds 64 KiB");
    writeFileSync(outFile, json + "\n", { mode: 0o600 });
    output(env, "artifact_name", reservation.artifact_name);
    return;
  }
  const file = option("--reservation");
  if (!file) throw new Error("A saved recovery reservation is required");
  const reservation = boundedJsonFile(file);
  if (
    (intent === "retry") !== (reservation.intent === "retry") ||
    (intent === "resolve" && reservation.intent !== "resolve")
  )
    throw new Error("Recovery intent does not match reservation");
  const result = await controller.apply(reservation, {
    artifactId: env.RESERVATION_ARTIFACT_ID,
    artifactDigest: env.RESERVATION_ARTIFACT_DIGEST,
  });
  console.log(JSON.stringify(result));
  return result;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCli().catch((error) => {
    // Fetch/network errors may carry implementation details. The controller
    // emits only its own bounded error messages, never API response bodies.
    console.error(
      "CI Recovery stopped: " +
        (error instanceof Error
          ? error.message.slice(0, 300)
          : "unknown error"),
    );
    process.exitCode = 1;
  });
}
