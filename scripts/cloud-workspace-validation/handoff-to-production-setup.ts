import { DaytonaNotFoundError } from "@daytona/sdk";

import { healthUrl, loadState, makeDaytona } from "./config";

const DIRECT_ENGINE_SESSION = "zeros-engine";

async function engineIsHealthy(previewUrl: string): Promise<boolean> {
  const endpoint = new URL(healthUrl(previewUrl));
  endpoint.searchParams.set("handoff", String(Date.now()));
  try {
    const response = await fetch(endpoint, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const body = (await response.json()) as { status?: unknown };
    return body.status === "ok";
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const state = loadState();
  const sandbox = await makeDaytona().get(state.sandboxId);
  try {
    const session = await sandbox.process.getSession(DIRECT_ENGINE_SESSION);
    if (session.sessionId !== DIRECT_ENGINE_SESSION) {
      throw new Error("Daytona returned a different engine session");
    }
    await sandbox.process.deleteSession(DIRECT_ENGINE_SESSION);
  } catch (error) {
    if (!(error instanceof DaytonaNotFoundError)) throw error;
  }

  const deadline = Date.now() + 30_000;
  while (await engineIsHealthy(state.previewUrl)) {
    if (Date.now() >= deadline) {
      throw new Error(
        "the direct qualification engine remained live after session deletion",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(
    "Direct qualification engine stopped; the image supervisor now owns the production setup handoff.",
  );
}

main().catch((error) => {
  console.error(
    "cloud production-setup handoff failed:",
    error instanceof Error ? error.message : "unknown failure",
  );
  process.exit(1);
});
