import { describe, expect, it, vi } from "vitest";
import { createResidentRuntimeUpdateHandlers } from "./runtime-resident-update.js";

describe("resident update service binding", () => {
  it("commits consumption before retirement and never retires after a refused or ambiguous receipt", async () => {
    const order: string[] = [];
    const service = {
      recordResidentConsumption: vi.fn(async () => { order.push("consumed"); return true; }),
      retireResidentSource: vi.fn(async () => { order.push("retired"); return true; }),
    };
    const claim = { workspaceId: "workspace", organizationId: "org", transitionId: "transition", executionFence: "fence" };
    const context = { input: { operation: "activate", transitionId: "transition", fence: "fence", handoff: {},
      scope: { workspaceId: "workspace", organizationId: "org" } }, resident: {}, controller: {} };
    // Shapes are independently tested at the duplex parser/database boundary;
    // this test isolates commit ordering and exception propagation.
    const handlers = createResidentRuntimeUpdateHandlers({ service, claim } as never);
    expect(await handlers.consumed!(context as never)).toBe(true);
    expect(order).toEqual(["consumed", "retired"]);
    service.recordResidentConsumption.mockResolvedValueOnce(false);
    expect(await handlers.consumed!(context as never)).toBe(false);
    expect(service.retireResidentSource).toHaveBeenCalledTimes(1);
    service.recordResidentConsumption.mockRejectedValueOnce(new Error("closed failure"));
    await expect(handlers.consumed!(context as never)).rejects.toThrow();
    expect(service.retireResidentSource).toHaveBeenCalledTimes(1);
    expect(await handlers.consumed!({ ...context, input: { ...context.input, fence: "stale" } } as never)).toBe(false);
    expect(service.recordResidentConsumption).toHaveBeenCalledTimes(3);
  });
});
