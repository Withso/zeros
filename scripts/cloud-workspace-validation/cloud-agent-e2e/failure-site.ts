const SOURCES = [
  ["renderer-turn", "scripts/cloud-workspace-validation/cloud-agent-e2e/renderer-turn.ts"],
  ["renderer-grant", "scripts/cloud-workspace-validation/cloud-agent-e2e/renderer-grant.ts"],
  ["renderer-driver", "scripts/cloud-workspace-validation/cloud-agent-e2e/renderer-driver.ts"],
  ["baseline", "scripts/cloud-workspace-validation/cloud-agent-e2e/baseline.ts"],
  ["driver", "scripts/cloud-workspace-validation/cloud-agent-e2e/driver.ts"],
  ["measurement", "scripts/cloud-workspace-validation/cloud-agent-e2e/measurement.ts"],
  ["ingress", "scripts/cloud-workspace-validation/cloud-agent-e2e/ingress.ts"],
  ["run", "scripts/cloud-workspace-validation/cloud-agent-e2e/run.mts"],
  ["bridge-client", "scripts/cloud-workspace-validation/lib/bridge-client.ts"],
  ["cloud-agent-connection", "apps/desktop/src/renderer/platform/bridge/cloud-agent-connection.ts"],
  ["cloud-event-reader", "apps/desktop/src/renderer/platform/bridge/cloud-event-reader.ts"],
] as const;
const CLASSES = ["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "HarnessFailure", "ZodError"] as const;

/** Advisory harness locations only. Error text, paths, functions and unknown
 * frames never leave this parser or participate in an acceptance assertion. */
export function harnessFailureSite(error: unknown) {
  if (!(error instanceof Error)) return undefined;
  let name: unknown, stack: unknown;
  try { name = error.name; } catch { /* No diagnostic getter is trusted. */ }
  try { stack = error.stack; } catch { /* Preserve the original failure. */ }
  const errorClass = typeof name === "string" && (CLASSES as readonly string[]).includes(name) ? name : "other";
  const sites: { file: typeof SOURCES[number][0]; line: number; column: number }[] = [];
  if (typeof stack !== "string" || stack.length > 16_384) return { errorClass, sites };
  for (const row of stack.split("\n").slice(0, 64)) {
    if (!/^\s+at\s/.test(row)) continue;
    for (const [file, source] of SOURCES) {
      const match = row.match(new RegExp("/" + source.replaceAll(".", "\\.") + ":([0-9]{1,7}):([0-9]{1,7})\\)?$"));
      if (!match) continue;
      const line = Number(match[1]), column = Number(match[2]);
      if (line > 0 && line <= 1_000_000 && column > 0 && column <= 1_000_000) sites.push({ file, line, column });
      break;
    }
    if (sites.length === 4) break;
  }
  return { errorClass, sites };
}
