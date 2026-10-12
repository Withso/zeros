import { describe, expect, it } from "vitest";
import { LIMITS } from "../agent-runtime/config.mjs";
import {
  bootstrapTracking,
  publishPrReport,
  publishTracking,
} from "../agent-runtime/publish.mjs";
import {
  BODY_END,
  BODY_START,
  renderDashboard,
  renderDigest,
  updateOwnedDashboard,
} from "../agent-runtime/report.mjs";
import {
  decodeState,
  addProposalEvent,
  dueEvents,
  encodeState,
  initialState,
  reduceObservations,
  STATE_MARKER,
} from "../agent-runtime/state.mjs";

const now = "2026-10-12T12:00:00.000Z";
function fakeGitHub() {
  const state = initialState(now);
  const comments: any[] = [
    {
      id: 7,
      body: encodeState(state),
      created_at: now,
      issue_url: "https://api.github.com/repos/Withso/zeros/issues/42",
      user: { login: "github-actions[bot]", type: "Bot" },
    },
  ];
  let issue: any = {
    number: 42,
    state: "open",
    body: renderDashboard(state, 7),
  };
  let pr: any = {
    number: 42,
    state: "open",
    head: { sha: "a".repeat(40), repo: { full_name: "Withso/zeros" } },
  };
  const writes: any[] = [];
  let loseResponse = false;
  const github = {
    async get(path: string) {
      return structuredClone(
        path.startsWith("/issues/comments/")
          ? comments.find((c) => c.id === Number(path.split("/").at(-1)))
          : path.startsWith("/pulls/")
            ? pr
            : issue,
      );
    },
    async pages(path: string) {
      return structuredClone(path.includes("comments") ? comments : [issue]);
    },
    async post(path: string, input: any) {
      writes.push({ path, input });
      const value = { ...comments[0], id: comments.length + 10, ...input };
      comments.push(value);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response lost");
      }
      return structuredClone(value);
    },
    async patch(path: string, input: any) {
      writes.push({ path, input });
      if (path.startsWith("/issues/comments/"))
        Object.assign(
          comments.find((c) => c.id === Number(path.split("/").at(-1))),
          input,
        );
      else issue = { ...issue, ...input };
      return structuredClone(issue);
    },
  };
  return {
    github,
    state,
    comments,
    writes,
    tracking: {
      issue: structuredClone(issue),
      stateComment: structuredClone(comments[0]),
      state,
      comments: [],
    },
    loseNextResponse: () => {
      loseResponse = true;
    },
    moveHead: () => {
      pr.head.sha = "b".repeat(40);
    },
  };
}

describe("GitHub publication", () => {
  it("preserves human notes outside the dashboard", () => {
    const original = `human before\n${BODY_START}\nold\n${BODY_END}\nhuman after`;
    expect(
      updateOwnedDashboard(original, `${BODY_START}\nnew\n${BODY_END}`),
    ).toBe(`human before\n${BODY_START}\nnew\n${BODY_END}\nhuman after`);
    expect(() => updateOwnedDashboard("deleted", original)).toThrow();
  });
  it("recovers an ambiguous POST without a duplicate digest", async () => {
    const fake = fakeGitHub();
    const state = reduceObservations(
      fake.state,
      [
        {
          schema: 1,
          id: "cursor-advisories",
          provider: "cursor",
          kind: "advisory",
          status: "complete",
          observedAt: now,
          data: {
            advisories: [
              {
                id: "GHSA-fixture",
                severity: "high",
                summary: "Fixture advisory",
                url: "https://github.com/advisories/GHSA-fixture",
              },
            ],
          },
        },
      ],
      now,
    );
    fake.loseNextResponse();
    const published = await publishTracking(
      fake.github,
      fake.tracking,
      state,
      now,
    );
    expect(dueEvents(published)).toHaveLength(0);
    expect(
      fake.writes.filter((write) => write.path === "/issues/42/comments"),
    ).toHaveLength(1);
    expect(decodeState(fake.comments[0].body).publishedAt).toBe(now);
  });
  it("refuses moved state and human-forged ownership", async () => {
    const fake = fakeGitHub();
    fake.comments[0].user.type = "User";
    await expect(
      publishTracking(fake.github, fake.tracking, fake.state, now),
    ).rejects.toThrow("state moved");
    expect(fake.writes).toHaveLength(0);
  });
  it("reconciles a posted digest after reducing from pre-crash durable state", async () => {
    const fake = fakeGitHub();
    const observation = {
      schema: 1,
      id: "cursor-advisories",
      provider: "cursor",
      kind: "advisory",
      status: "complete",
      observedAt: now,
      data: {
        advisories: [
          {
            id: "GHSA-fixture",
            severity: "high",
            summary: "Fixture",
            url: "https://github.com/advisories/GHSA-fixture",
          },
        ],
      },
    };
    const reduced = reduceObservations(fake.state, [observation], now);
    // The digest POST succeeded, but saving the newly observed events did not.
    fake.comments.push({
      ...fake.comments[0],
      id: 9,
      body: renderDigest(dueEvents(reduced)),
    });
    const published = await publishTracking(
      fake.github,
      fake.tracking,
      reduced,
      now,
    );
    expect(dueEvents(published)).toHaveLength(0);
    expect(
      fake.writes.filter((write) => write.path === "/issues/42/comments"),
    ).toHaveLength(0);
  });
  it("does not publish old qualification results after a newer PR head", async () => {
    const fake = fakeGitHub();
    fake.moveHead();
    expect(
      await publishPrReport(fake.github, 42, { head: "a".repeat(40) }),
    ).toEqual({ status: "stale" });
    expect(fake.writes).toHaveLength(0);
  });
  it("reuses an initialized issue on repeated bootstrap", async () => {
    const fake = fakeGitHub();
    expect((await bootstrapTracking(fake.github, now)).issue.number).toBe(42);
    expect(fake.writes).toHaveLength(0);
  });
  it("reduces and checkpoints a long catch-up without exceeding persistent limits or losing events", async () => {
    const fake = fakeGitHub();
    const input = structuredClone(fake.state);
    for (let index = 0; index < 100; index++)
      addProposalEvent(
        input,
        "codex",
        "release",
        index,
        `Release ${index}: ${"fixture ".repeat(250)}`,
        now,
      );
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(
      LIMITS.state,
    );
    expect(() => encodeState(input)).toThrow("checkpoint");
    expect(() =>
      decodeState(
        `${STATE_MARKER}\n\`\`\`json\n${JSON.stringify(input)}\n\`\`\``,
      ),
    ).toThrow("size limit");
    // The CLI reduces public observations and then delivery before publication.
    const reduced = reduceObservations(
      input,
      [
        {
          schema: 1,
          id: "codex-delivery",
          provider: "codex",
          kind: "delivery",
          status: "complete",
          observedAt: now,
          data: { desktop: {}, cloud: { status: "unknown" } },
        },
      ],
      now,
    );
    const published = await publishTracking(
      fake.github,
      fake.tracking,
      reduced,
      now,
    );
    expect(dueEvents(published)).toHaveLength(0);
    expect(Object.keys(published.events).length).toBeGreaterThan(0);
    expect(Object.keys(published.events).length).toBeLessThanOrEqual(24);
    expect(decodeState(fake.comments[0].body)).toEqual(published);
    expect(
      fake.writes.every(
        (write) => Buffer.byteLength(write.input.body) <= LIMITS.comment,
      ),
    ).toBe(true);
    const json = (body: string) =>
      JSON.parse(body.split("```json\n")[1].split("\n```")[0]);
    const index = json(
      fake.comments.find((comment) => comment.id === published.checkpoint).body,
    );
    expect(index.encoding).toBe("base64-json-parts");
    const bytes = index.parts.map((part: any) =>
      Buffer.from(
        json(fake.comments.find((comment) => comment.id === part.comment).body)
          .data,
        "base64",
      ),
    );
    expect(
      Object.keys(JSON.parse(Buffer.concat(bytes).toString("utf8")).events),
    ).toHaveLength(100);
  });
});
