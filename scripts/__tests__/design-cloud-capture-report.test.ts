import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  expectedCloudCaptureRenderer,
  writeCloudCaptureReport,
} from "../design-cloud-capture-report";

const reports: string[] = [];
afterEach(async () => {
  await Promise.all(
    reports
      .splice(0)
      .map((file) => rm(path.dirname(file), { recursive: true, force: true })),
  );
});

it("retains each qualification report in its own private directory", async () => {
  const report = { renderer: expectedCloudCaptureRenderer(), networkReads: 0 };
  const first = await writeCloudCaptureReport(report);
  reports.push(first);
  const second = await writeCloudCaptureReport({ ...report, networkReads: 1 });
  reports.push(second);

  expect(first).not.toBe(second);
  expect(JSON.parse(await readFile(first, "utf8"))).toEqual(report);
  expect((await stat(path.dirname(first))).mode & 0o777).toBe(0o700);
  expect((await stat(first)).mode & 0o777).toBe(0o600);
  expect(report.renderer).toMatch(
    /^chromium-\d+(?:\.\d+){3}\/playwright-\d+\.\d+\.\d+$/,
  );
});
