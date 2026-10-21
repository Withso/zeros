import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { requestTiming, type RequestDatabaseCost } from "./request-timing.js";

function observed() {
  const summaries: RequestDatabaseCost[] = [];
  const app = new Hono();
  app.use("*", requestTiming({ slowMs: Infinity, costObserver: value => { summaries.push(value); } }));
  app.get("/test", c => c.text("unchanged"));
  return { app, summaries };
}

describe("request-cost monotonic interval", () => {
  it("reports the bounded CP process interval", async () => {
    const { app, summaries } = observed();
    const clock = vi.spyOn(process.hrtime, "bigint").mockReturnValueOnce(1_000_000n).mockReturnValue(2_000_000n);
    try { expect((await app.request("/test")).status).toBe(200); } finally { clock.mockRestore(); }
    expect(summaries[0]).toMatchObject({ clockSource: "node-process-hrtime", startedAtUs: 1000,
      completedAtUs: 2000, clockCoverage: "complete" });
  });

  it("marks a regressed clock unavailable without changing the HTTP response", async () => {
    const { app, summaries } = observed();
    const clock = vi.spyOn(process.hrtime, "bigint").mockReturnValueOnce(2_000_000n).mockReturnValue(1_000_000n);
    try { expect((await app.request("/test")).status).toBe(200); } finally { clock.mockRestore(); }
    expect(summaries[0]).toMatchObject({ clockCoverage: "unavailable", startedAtUs: null, completedAtUs: null });
  });
});
