import { beforeEach, describe, expect, it } from "vitest";

import {
  designMotionPlayhead,
  publishDesignMotionPlayhead,
  resetDesignMotionPlayheadsForTests,
  useDesignMotionPlayheadStore,
} from "../state/design-motion-playhead";

describe("design motion playhead store", () => {
  beforeEach(() => resetDesignMotionPlayheadsForTests());

  it("isolates hot playback ticks by semantic motion owner", () => {
    publishDesignMotionPlayhead("workspace-a\u0000home.html\u0000hero", 42);
    publishDesignMotionPlayhead("workspace-b\u0000home.html\u0000hero", 75);

    expect(designMotionPlayhead("workspace-a\u0000home.html\u0000hero")).toBe(
      42,
    );
    expect(designMotionPlayhead("workspace-b\u0000home.html\u0000hero")).toBe(
      75,
    );
  });

  it("does not publish equal ticks and bounds abandoned motion owners", () => {
    let notifications = 0;
    const unsubscribe = useDesignMotionPlayheadStore.subscribe(() => {
      notifications += 1;
    });
    publishDesignMotionPlayhead("active", 10);
    publishDesignMotionPlayhead("active", 10);
    expect(notifications).toBe(1);

    for (let index = 0; index < 40; index += 1) {
      publishDesignMotionPlayhead(`owner-${index}`, index);
    }
    unsubscribe();

    expect(
      Object.keys(useDesignMotionPlayheadStore.getState().byOwner),
    ).toHaveLength(32);
    expect(
      Object.hasOwn(useDesignMotionPlayheadStore.getState().byOwner, "owner-0"),
    ).toBe(false);
    expect(designMotionPlayhead("owner-39")).toBe(39);
  });
});
