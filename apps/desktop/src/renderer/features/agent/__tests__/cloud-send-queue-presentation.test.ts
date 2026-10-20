import { describe, expect, it } from "vitest";
import type { AgentSessionState, AgentTextMessage } from "../use-agent-session";
import { queuedTranscriptPresentation } from "./helpers/queued-transcript-presentation";

const cloud = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const confirmed: AgentTextMessage = { id: "confirmed", kind: "text", role: "agent", text: "Saved answer", createdAt: 1 };
const prompt: AgentTextMessage = { id: "pending", kind: "text", role: "user", text: "Keep my message", createdAt: 2 };
const project = (message: AgentTextMessage, session: Partial<AgentSessionState>) => queuedTranscriptPresentation([confirmed, message], session);

describe("cloud send queue presentation", () => {
  it.each(["waiting", "failed"] as const)("keeps an undispatched %s message above the composer, with confirmed history intact", state => {
    const result = project({ ...prompt, queued: true, queuedPresentation: "active-turn" }, {
      cwd: cloud, cloudSendWait: { state, turnId: prompt.id },
    });
    expect(result.visibleMessages).toEqual([confirmed]);
    expect(result.queuedMessages).toEqual([expect.objectContaining({ id: prompt.id })]);
  });

  it.each(["streaming", "reconnecting", "warming"] as const)("keeps a CP-queued prompt out of the transcript while %s", status => {
    const result = project(prompt, { cwd: cloud, status, cloudPromptPending: true, foregroundTurnId: prompt.id });
    expect(result.visibleMessages).toEqual([confirmed]);
    expect(result.queuedMessages).toEqual([expect.objectContaining({ id: prompt.id, queuedDelivery: "sending", queuedEditable: false })]);
  });

  it("projects a cloud steering message into the queue until native consumption is confirmed", () => {
    const result = project({ ...prompt, queued: true, queuedDelivery: "sending" }, { cwd: cloud });
    expect(result.visibleMessages).toEqual([confirmed]);
    expect(result.queuedMessages.map(row => row.id)).toEqual([prompt.id]);
  });

  it.each(["/personal/project", "/organization/project"])("retains Local optimistic bubbles in %s", cwd => {
    const result = project({ ...prompt, queued: true, queuedPresentation: "active-turn" }, { cwd });
    expect(result.visibleMessages).toEqual([confirmed, expect.objectContaining({ id: prompt.id })]);
    expect(result.queuedMessages).toEqual([]);
  });

  it("shows the exact accepted turn once, leaving another queued message above the composer", () => {
    const followup: AgentTextMessage = { ...prompt, id: "followup", queued: true };
    const result = queuedTranscriptPresentation([confirmed, prompt, followup], {
      cwd: cloud, cloudPromptPending: false, foregroundTurnId: prompt.id,
    });
    expect(result.visibleMessages).toEqual([confirmed, prompt]);
    expect(result.queuedMessages).toEqual([followup]);
  });
});
