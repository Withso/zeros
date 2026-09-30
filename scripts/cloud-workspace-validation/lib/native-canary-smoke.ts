type SmokeStages = Record<"toolTurn" | "renew" | "retire" | "resume" | "resumeTurn" | "permission" | "stop" | "revoke", () => Promise<void>>;

export async function runNativeSmokeCanary(stages: SmokeStages) {
  await stages.toolTurn();
  await stages.renew();
  await stages.retire();
  await stages.resume();
  await stages.resumeTurn();
  await stages.permission();
  await stages.stop();
  await stages.revoke();
}
