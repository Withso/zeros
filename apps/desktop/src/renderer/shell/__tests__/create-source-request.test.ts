import { beforeEach, describe, expect, it } from "vitest";

import {
  consumeCreateFromSourceRequest,
  peekCreateFromSourceRequest,
  requestCreateFromSource,
  resetCreateFromSourceRequestForTests,
  resolveCreateFromSourceRequest,
} from "../dispatcher/create-source-request";

beforeEach(() => resetCreateFromSourceRequestForTests());

describe("Create from… request", () => {
  it("publishes one request per action and ignores an empty project", () => {
    requestCreateFromSource("");
    expect(peekCreateFromSourceRequest()).toBeNull();

    requestCreateFromSource("project-a");
    const first = peekCreateFromSourceRequest();
    requestCreateFromSource("project-a");
    const second = peekCreateFromSourceRequest();

    expect(first?.projectId).toBe("project-a");
    expect(second?.id).toBeGreaterThan(first!.id);
  });

  it("consumes only the request it settles", () => {
    requestCreateFromSource("project-a");
    const stale = peekCreateFromSourceRequest()!;
    requestCreateFromSource("project-b");

    consumeCreateFromSourceRequest(stale.id);
    expect(peekCreateFromSourceRequest()?.projectId).toBe("project-b");

    consumeCreateFromSourceRequest(peekCreateFromSourceRequest()!.id);
    expect(peekCreateFromSourceRequest()).toBeNull();
  });

  it("waits while the routed repository is still being selected", () => {
    requestCreateFromSource("project-a");
    const request = peekCreateFromSourceRequest()!;
    const base = {
      request,
      routedProjectId: "project-a",
      projectIds: ["project-a", "project-b"],
      sourceAvailable: true,
    };

    expect(
      resolveCreateFromSourceRequest({
        ...base,
        selectedProjectId: "project-b",
      }),
    ).toBe("wait");
    expect(
      resolveCreateFromSourceRequest({
        ...base,
        selectedProjectId: "project-a",
      }),
    ).toBe("open");
  });

  it("drops a request for another route, a removed repository or a folder", () => {
    requestCreateFromSource("project-a");
    const request = peekCreateFromSourceRequest()!;
    const base = {
      request,
      routedProjectId: "project-a",
      selectedProjectId: "project-a",
      projectIds: ["project-a"],
      sourceAvailable: true,
    };

    expect(
      resolveCreateFromSourceRequest({ ...base, routedProjectId: "project-b" }),
    ).toBe("drop");
    expect(resolveCreateFromSourceRequest({ ...base, projectIds: [] })).toBe(
      "drop",
    );
    expect(
      resolveCreateFromSourceRequest({ ...base, sourceAvailable: false }),
    ).toBe("drop");
  });
});
