#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { groupAlive, signalGroup } from "./electron-local-process-group.mjs";

const parent = Number(process.argv[2]);
const group = Number(process.argv[3]);
const grace = Number(process.argv[4] ?? 20_000);
if (
  !Number.isSafeInteger(parent) ||
  parent <= 0 ||
  (process.argv[3] && (!Number.isSafeInteger(group) || group <= 0))
)
  process.exit(1);

function parentAlive() {
  try {
    process.kill(parent, 0);
    return !execFileSync("ps", ["-o", "stat=", "-p", String(parent)], {
      encoding: "utf8",
      timeout: 2000,
    })
      .trim()
      .startsWith("Z");
  } catch (error) {
    return error.code === "EPERM";
  }
}

while (parentAlive()) {
  if (group && !groupAlive(group)) process.exit(0);
  await delay(250);
}
// The stack's watchdog exits to trigger concurrently -k. A separate guardian
// also owns preparation and enforces escalation if the launcher was SIGKILLed.
if (group) {
  signalGroup(group, "SIGTERM");
  const deadline = Date.now() + grace;
  while (groupAlive(group) && Date.now() < deadline) await delay(25);
  if (groupAlive(group)) signalGroup(group, "SIGKILL");
  while (groupAlive(group)) await delay(25);
}
process.exitCode = 1;
