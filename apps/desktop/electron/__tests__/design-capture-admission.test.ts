import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { expect, it } from "vitest";
import { designCaptureAcquire, designCaptureRelease, electronDesignCaptureAdmission } from "../design-capture-admission";

function owner() {
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false });
  return { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent;
}
const jobId = "a74675d2-627d-44ed-8954-0b9d80519a49";

it("binds reservation release to the exact main frame, WebContents and job", () => {
  const first = owner();
  const other = owner();
  try {
    expect(() => designCaptureAcquire({ jobId: "invalid", explicit: true }, first)).toThrow();
    expect(() => designCaptureAcquire({ jobId, explicit: true }, { ...first, senderFrame: {} } as IpcMainInvokeEvent)).toThrow();
    expect(designCaptureAcquire({ jobId, explicit: true }, first)).toEqual({ acquired: true });
    expect(designCaptureAcquire({ jobId, explicit: true }, other)).toEqual({ acquired: false });
    expect(designCaptureRelease({ jobId }, other)).toEqual({ released: false });
    expect(designCaptureRelease({ jobId: "b74675d2-627d-44ed-8954-0b9d80519a49" }, first)).toEqual({ released: false });
    expect(electronDesignCaptureAdmission.usage().running).toBe(1);
    expect(designCaptureRelease({ jobId }, first)).toEqual({ released: true });
  } finally { electronDesignCaptureAdmission.retireOwner(first.sender); }
});

it("retains lost reservations on navigation and only retires them on confirmed WebContents destruction", () => {
  const first = owner();
  try {
    expect(designCaptureAcquire({ jobId, explicit: true }, first)).toEqual({ acquired: true });
    first.sender.emit("did-start-navigation");
    first.sender.emit("render-process-gone");
    expect(electronDesignCaptureAdmission.usage().running).toBe(1);
    first.sender.emit("destroyed");
    expect(electronDesignCaptureAdmission.usage()).toEqual({ running: 0, reservedBytes: 0 });
  } finally { electronDesignCaptureAdmission.retireOwner(first.sender); }
});
