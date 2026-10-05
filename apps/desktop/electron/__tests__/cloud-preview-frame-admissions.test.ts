import { describe, expect, it } from "vitest";
import { CloudPreviewFrameAdmissions } from "../cloud-preview-frame-admissions";

describe("native preview frame admission", () => {
  it("rejects replaced frames and revocation during a network wait", () => {
    const admissions = new CloudPreviewFrameAdmissions<object>();
    const frame = {};
    const first = admissions.begin("zeros-browser-tab", frame);
    expect(first.current(frame)).toBe(true);
    expect(first.current({})).toBe(false);
    admissions.cancel("zeros-browser-tab");
    expect(first.current(frame)).toBe(false);
  });
  it("fences queued renewals and bounds pending frame identities", () => {
    const admissions = new CloudPreviewFrameAdmissions<object>(2);
    const frame = {};
    const prior = admissions.begin("zeros-browser-tab", frame);
    const next = admissions.begin("zeros-browser-tab", frame);
    expect(prior.current(frame)).toBe(false);
    expect(next.current(frame)).toBe(true);
    admissions.begin("zeros-browser-b", {});
    admissions.begin("zeros-browser-c", {});
    expect(next.current(frame)).toBe(false);
    admissions.clear();
  });
});
