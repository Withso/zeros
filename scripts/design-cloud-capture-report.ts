import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

/** Report the installed runtime identity only after the worker proves it. */
export function expectedCloudCaptureRenderer(): string {
  const require = createRequire(import.meta.url);
  const packageFile = require.resolve("playwright-core/package.json");
  const { version } = JSON.parse(readFileSync(packageFile, "utf8"));
  const { browsers } = JSON.parse(
    readFileSync(path.join(path.dirname(packageFile), "browsers.json"), "utf8"),
  );
  const chromium = browsers.find(
    (browser: { name: string }) => browser.name === "chromium",
  );
  if (
    typeof version !== "string" ||
    typeof chromium?.browserVersion !== "string"
  )
    throw new Error("Pinned capture renderer identity is unavailable.");
  return `chromium-${chromium.browserVersion}/playwright-${version}`;
}

export async function writeCloudCaptureReport(
  report: Record<string, unknown>,
): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "zeros-design-cloud-qualification-"),
  );
  const file = path.join(directory, "report.json");
  try {
    await writeFile(file, JSON.stringify(report, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    return file;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
