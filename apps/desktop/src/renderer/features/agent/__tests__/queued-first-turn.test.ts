// A send parked BEFORE the chat can run it must always end somewhere.
//
// The bug (reported 2026-08-24): a message sent while a workspace was still
// being prepared was accepted into the pre-ready park ("Message queued — it
// will send as soon as this workspace finishes setting up") and then never
// went anywhere. Two holes, both of which this policy closes:
//
//  1. The only drain condition was `status === "ready"`. A park whose spawn
//     ended `failed` / `auth-required` sat armed forever — the composer still
//     held the text, nothing was sent, and nothing said so. Compare
//     queueReleaseAction, which has owned exactly this rule for the in-turn
//     send queue since it was written: "every park site needs a release site".
//  2. Nothing bounded the wait. A session that never settled (an admission
//     that hangs, an engine that never comes back) left the park armed with no
//     status transition to re-run the effect on, so it could not even be
//     reported.

import { describe, expect, it } from "vitest";

import {
  QUEUED_FIRST_TURN_MAX_WAIT_MS,
  queuedFirstTurnAction,
  unreadableTranscriptSendAction,
} from "../session-reload-lifecycle";

const base = {
  status: "warming" as const,
  provisioning: false,
  hasPermissionGate: false,
  composerEmpty: false,
  sendInFlight: false,
  armedForMs: 1_000,
};

describe("queuedFirstTurnAction", () => {
  it("dispatches the parked first turn once the session is ready", () => {
    expect(queuedFirstTurnAction({ ...base, status: "ready" })).toBe("send");
  });

  it("waits through every pre-ready state", () => {
    // `idle` is a chat whose spawn has not started yet (chat-view arms it off
    // the park itself), `warming` is one in flight, and `reconnecting` is the
    // engine's respawn pool reviving a transport — none is a failure, and
    // dropping the message on any of them is the reported bug in miniature.
    for (const status of ["idle", "warming", "reconnecting"] as const) {
      expect(queuedFirstTurnAction({ ...base, status })).toBe("wait");
    }
  });

  it("waits while the workspace is still being prepared", () => {
    // The path is announced but not checked out: spawning into it is what the
    // park exists to prevent.
    expect(
      queuedFirstTurnAction({ ...base, status: "ready", provisioning: true }),
    ).toBe("wait");
  });

  it("waits behind a permission gate and behind a send already preparing", () => {
    expect(
      queuedFirstTurnAction({
        ...base,
        status: "ready",
        hasPermissionGate: true,
      }),
    ).toBe("wait");
    expect(
      queuedFirstTurnAction({ ...base, status: "ready", sendInFlight: true }),
    ).toBe("wait");
  });

  it("waits when the composer has nothing left to send", () => {
    // The draft IS the payload here (the park keeps the TipTap document in
    // place rather than copying it). An empty composer is the user having
    // cleared it; the cancel effect owns retiring that intent.
    expect(
      queuedFirstTurnAction({ ...base, status: "ready", composerEmpty: true }),
    ).toBe("wait");
  });

  it("releases a park whose session ended badly instead of waiting forever", () => {
    // Hole 1. `failed` and `auth-required` are terminal: nothing will move
    // this chat to `ready` without the user, so the park has to be handed
    // back rather than held.
    for (const status of ["failed", "auth-required"] as const) {
      expect(queuedFirstTurnAction({ ...base, status })).toBe("release");
    }
  });

  it("keeps a terminal park while the workspace is still provisioning", () => {
    // A spawn that failed INTO an unfinished checkout is expected: chat-view
    // has not been allowed to spawn yet, so the failure belongs to an earlier
    // attempt and the create is still coming.
    expect(
      queuedFirstTurnAction({ ...base, status: "failed", provisioning: true }),
    ).toBe("wait");
  });

  it("releases a park that has waited past the bound, whatever the status", () => {
    // Hole 2. No status transition is guaranteed to arrive, so the bound is
    // what makes the park reportable at all.
    const armedForMs = QUEUED_FIRST_TURN_MAX_WAIT_MS + 1;
    expect(queuedFirstTurnAction({ ...base, armedForMs })).toBe("release");
    expect(
      queuedFirstTurnAction({ ...base, armedForMs, provisioning: true }),
    ).toBe("release");
  });

  it("prefers sending over the bound when the session is finally ready", () => {
    // A long, slow, but ultimately successful admission must deliver the
    // message the user was promised — the bound exists to report a park that
    // CANNOT be dispatched, not to cancel one that now can.
    expect(
      queuedFirstTurnAction({
        ...base,
        status: "ready",
        armedForMs: QUEUED_FIRST_TURN_MAX_WAIT_MS + 1,
      }),
    ).toBe("send");
  });

  it("never releases a park that is still holding the user's text mid-clear", () => {
    // composerEmpty + aged out: releasing would toast about a message that is
    // no longer there. The cancel effect retires it silently instead.
    expect(
      queuedFirstTurnAction({
        ...base,
        composerEmpty: true,
        armedForMs: QUEUED_FIRST_TURN_MAX_WAIT_MS + 1,
      }),
    ).toBe("wait");
  });
});

describe("unreadableTranscriptSendAction", () => {
  const unreadable = {
    hasPayload: true,
    payloadInComposer: true,
    alreadyRetried: false,
    status: "reconnecting" as const,
  };

  it("parks a composer send whose transcript is mid-reconnect", () => {
    // The regression: this used to `return` in silence — no bubble, no toast,
    // and pressing Enter again did the same nothing.
    expect(unreadableTranscriptSendAction(unreadable)).toBe("park");
    expect(
      unreadableTranscriptSendAction({ ...unreadable, status: "ready" }),
    ).toBe("park");
    expect(
      unreadableTranscriptSendAction({ ...unreadable, status: "idle" }),
    ).toBe("park");
  });

  it("says nothing about an Enter on an empty composer", () => {
    expect(
      unreadableTranscriptSendAction({ ...unreadable, hasPayload: false }),
    ).toBe("ignore");
  });

  it("reports a hand-off payload it cannot park", () => {
    // An override (EmptyComposer hand-off, "Continue") is not in the composer,
    // so there is no draft for the drain to pick up.
    expect(
      unreadableTranscriptSendAction({
        ...unreadable,
        payloadInComposer: false,
      }),
    ).toBe("report");
  });

  it("reports instead of parking a second time", () => {
    // One automatic retry: the drain re-enters the same send path, so a second
    // failed read would otherwise cycle park → drain → park.
    expect(
      unreadableTranscriptSendAction({ ...unreadable, alreadyRetried: true }),
    ).toBe("report");
  });

  it("reports rather than promising a delivery a terminal chat can't make", () => {
    // Parking here would arm an intent that queuedFirstTurnAction releases on
    // the next commit — two contradictory toasts for one keystroke.
    for (const status of ["failed", "auth-required"] as const) {
      expect(unreadableTranscriptSendAction({ ...unreadable, status })).toBe(
        "report",
      );
    }
  });
});
