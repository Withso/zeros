import { describe, expect, it, vi } from "vitest";
import { AlphaTransport } from "../zeros-dev/transport";

describe("zeros-dev transport deadlines", () => {
  it.each(["AbortError", "TimeoutError"])("closes an already aborted %s before invoking the fetcher", async name => {
    const fetcher = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort(new DOMException("synthetic private abort text", name));
    await expect(new AlphaTransport(fetcher).json("/healthz", { signal: controller.signal }))
      .rejects.toMatchObject({ code: "deadline", message: "zeros_dev_deadline" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
