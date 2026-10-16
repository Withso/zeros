import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AFTER_ACTION_MS,
  MAX_KEY_FRAMES,
  MAX_SCENE_SAMPLES,
  MIN_KEY_FRAME_GAP_MS,
  isVideoFile,
  keyFrameFileName,
  pickKeyFrames,
  pictureBrightness,
  pictureChange,
  sceneChanges,
  sceneSampleTimes,
  videoFingerprint,
  videoTimelineFileName,
  videoTimelineText,
  type PictureSample,
} from "../composer-editor/video-key-frames";

const picture = (value: number) => new Uint8Array(16).fill(value);

/** Samples every 500ms up to `lastMs`, each showing `scene(atMs)`. */
function samplesEvery500(lastMs: number, scene: (atMs: number) => number): PictureSample[] {
  const samples: PictureSample[] = [];
  for (let atMs = 0; atMs <= lastMs; atMs += 500) {
    samples.push({ atMs, brightness: picture(scene(atMs)) });
  }
  return samples;
}

describe("isVideoFile", () => {
  it("knows videos by type, or by name when the type is missing", () => {
    expect(isVideoFile({ name: "clip.mp4", mimeType: "video/mp4" })).toBe(true);
    expect(isVideoFile({ name: "clip", mimeType: "video/quicktime" })).toBe(true);
    expect(isVideoFile({ name: "clip.MOV", mimeType: "" })).toBe(true);
    expect(isVideoFile({ name: "clip.webm", mimeType: "application/octet-stream" })).toBe(true);
  });

  it("leaves everything else alone", () => {
    expect(isVideoFile({ name: "shot.png", mimeType: "image/png" })).toBe(false);
    expect(isVideoFile({ name: "notes.mp4", mimeType: "text/plain" })).toBe(false);
    expect(isVideoFile({ name: "notes", mimeType: "" })).toBe(false);
  });
});

describe("sceneSampleTimes", () => {
  it("samples nothing when the length is unknown", () => {
    for (const durationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(sceneSampleTimes(durationMs)).toEqual([]);
    }
  });

  it("runs from the first frame to the last, about every half second", () => {
    const times = sceneSampleTimes(12_000);
    expect(times[0]).toBe(0);
    expect(times.at(-1)).toBe(11_950);
    expect(times).toHaveLength(25);
    for (let index = 1; index < times.length; index++) {
      expect(times[index]! - times[index - 1]!).toBeGreaterThan(450);
      expect(times[index]! - times[index - 1]!).toBeLessThan(550);
    }
  });

  it("samples a short video at both ends", () => {
    expect(sceneSampleTimes(100)).toEqual([0, 50]);
  });

  it("samples a long video no more often than a short one costs", () => {
    const times = sceneSampleTimes(10 * 60_000);
    expect(times).toHaveLength(MAX_SCENE_SAMPLES);
    expect(times.at(-1)).toBe(10 * 60_000 - 50);
  });

  it("ends on the moment the last key frame is read, in whole milliseconds", () => {
    expect(sceneSampleTimes(4_871.667).at(-1)).toBe(4_821);
    expect(
      pickKeyFrames({ durationMs: 4_871.667, actionsAtMs: [], samples: [] }).at(-1),
    ).toEqual({ atMs: 4_821, reason: "last" });
  });
});

describe("pictures", () => {
  it("weighs color the way the eye does", () => {
    expect([
      ...pictureBrightness([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 0]),
    ]).toEqual([76, 150, 29, 255]);
  });

  it("measures change from none to complete", () => {
    expect(pictureChange([10, 20], [10, 20])).toBe(0);
    expect(pictureChange([0, 0], [255, 255])).toBe(1);
    expect(pictureChange([0, 255], [255, 255])).toBe(0.5);
  });

  it("finds no change between pictures it can't compare", () => {
    expect(pictureChange([], [])).toBe(0);
    expect(pictureChange([0], [0, 0])).toBe(0);
  });
});

describe("sceneChanges", () => {
  it("finds none in a still video", () => {
    expect(sceneChanges(samplesEvery500(5_000, () => 40))).toEqual([]);
  });

  it("finds a cut at the first sample after it", () => {
    const changes = sceneChanges(samplesEvery500(5_000, (atMs) => (atMs < 2_200 ? 0 : 255)));
    expect(changes).toEqual([{ atMs: 2_500, amount: 1, sample: 5 }]);
  });

  it("waits for a screen sliding in to settle", () => {
    // Half way across at 2s, settled by 2.5s: one change, measured from the
    // picture before it began.
    const scene = (atMs: number) => (atMs < 2_000 ? 0 : atMs === 2_000 ? 100 : 200);
    expect(sceneChanges(samplesEvery500(5_000, scene))).toEqual([
      { atMs: 2_500, amount: 200 / 255, sample: 5 },
    ]);
  });

  it("keeps changes apart once the picture has had time to settle", () => {
    // Changing at every sample from 2s on: each change gets SCENE_SETTLE_MS
    // to settle, then the next one starts.
    const scene = (atMs: number) => (atMs < 2_000 ? 0 : 30 + ((atMs - 2_000) / 500) * 30);
    const changes = sceneChanges(samplesEvery500(5_000, scene));
    expect(changes.map((change) => change.atMs)).toEqual([2_500, 3_500, 4_500, 5_000]);
  });

  it("measures a flash by where it ends up", () => {
    const scene = (atMs: number) => (atMs === 2_000 ? 255 : 0);
    expect(sceneChanges(samplesEvery500(5_000, scene))).toEqual([
      { atMs: 2_500, amount: 0, sample: 5 },
    ]);
  });
});

describe("pickKeyFrames", () => {
  it("keeps only the first frame of a video too short or too strange to read", () => {
    for (const durationMs of [Number.NaN, 0, 300]) {
      expect(pickKeyFrames({ durationMs, actionsAtMs: [], samples: [] })).toEqual([
        { atMs: 0, reason: "first" },
      ]);
    }
  });

  it("keeps the first and last frames of a still video", () => {
    expect(
      pickKeyFrames({
        durationMs: 5_000,
        actionsAtMs: [],
        samples: samplesEvery500(4_950, () => 40),
      }),
    ).toEqual([
      { atMs: 0, reason: "first" },
      { atMs: 4_950, reason: "last" },
    ]);
  });

  it("shows what each action did", () => {
    expect(pickKeyFrames({ durationMs: 10_000, actionsAtMs: [1_000, 4_000], samples: [] })).toEqual([
      { atMs: 0, reason: "first" },
      { atMs: 1_000 + AFTER_ACTION_MS, reason: "action", action: 0 },
      { atMs: 4_000 + AFTER_ACTION_MS, reason: "action", action: 1 },
      { atMs: 9_950, reason: "last" },
    ]);
  });

  it("leaves out an action whose frame the last frame already shows", () => {
    expect(
      pickKeyFrames({ durationMs: 10_000, actionsAtMs: [9_500], samples: [] }).map(
        (moment) => moment.reason,
      ),
    ).toEqual(["first", "last"]);
  });

  it("spreads frames across a video with more actions than room", () => {
    const actionsAtMs = Array.from({ length: 40 }, (_, index) => index * 500);
    const moments = pickKeyFrames({ durationMs: 20_000, actionsAtMs, samples: [] });
    expect(moments).toHaveLength(MAX_KEY_FRAMES);
    const gaps = moments.slice(1).map((moment, index) => moment.atMs - moments[index]!.atMs);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2_000);
    expect(moments.filter((moment) => moment.reason === "action")).toHaveLength(6);
  });

  it("adds a scene change to a picture not kept yet", () => {
    // The start screen, another screen from 3s, then back to the start.
    const scene = (atMs: number) => (atMs >= 3_000 && atMs < 6_000 ? 200 : 0);
    expect(
      pickKeyFrames({ durationMs: 9_050, actionsAtMs: [], samples: samplesEvery500(9_000, scene) }),
    ).toEqual([
      { atMs: 0, reason: "first" },
      { atMs: 3_000, reason: "change" },
      { atMs: 9_000, reason: "last" },
    ]);
  });

  it("doesn't take a change right beside a frame it has", () => {
    const scene = (atMs: number) => (atMs >= 3_000 && atMs < 6_000 ? 200 : 0);
    const moments = pickKeyFrames({
      durationMs: 9_050,
      actionsAtMs: [2_500],
      samples: samplesEvery500(9_000, scene),
    });
    // The action's frame at 3.2s already shows the change at 3s.
    expect(moments.map((moment) => moment.reason)).toEqual(["first", "action", "last"]);
    expect(moments[1]!.atMs - 3_000).toBeLessThan(MIN_KEY_FRAME_GAP_MS);
  });

  it("takes the biggest changes when room runs out", () => {
    // Five action frames leave one slot. A small change at 1.5s and a big one
    // at 13s, each well away from every action, and each back where it
    // started a second later.
    const actionsAtMs = [4_000, 6_000, 8_000, 10_000, 17_000];
    const scene = (atMs: number) =>
      atMs >= 1_500 && atMs < 2_500 ? 30 : atMs >= 13_000 && atMs < 14_500 ? 250 : 0;
    const moments = pickKeyFrames({
      durationMs: 22_050,
      actionsAtMs,
      samples: samplesEvery500(22_000, scene),
    });
    expect(moments).toHaveLength(MAX_KEY_FRAMES);
    expect(moments.filter((moment) => moment.reason === "change")).toEqual([
      { atMs: 13_000, reason: "change" },
    ]);
  });
});

describe("file names", () => {
  it("names frames and timelines after the video", () => {
    expect(keyFrameFileName("Recording of iPhone 17 at 07.46.12.mp4", 0)).toBe(
      "Recording-of-iPhone-17-at-07-46-12-frame-1.jpg",
    );
    expect(videoTimelineFileName("clip.webm")).toBe("clip-timeline.txt");
  });

  it("keeps names short and never empty", () => {
    expect(keyFrameFileName(`${"a".repeat(100)}.mov`, 7)).toBe(`${"a".repeat(60)}-frame-8.jpg`);
    expect(keyFrameFileName("..mp4", 2)).toBe("video-frame-3.jpg");
    expect(videoTimelineFileName("???")).toBe("video-timeline.txt");
  });
});

describe("videoTimelineText", () => {
  it("describes a Zeros recording: its device, frames and actions", () => {
    expect(
      videoTimelineText({
        videoName: "Recording.mp4",
        durationMs: 12_500,
        frames: [
          { fileName: "Recording-frame-1.jpg", moment: { atMs: 0, reason: "first" } },
          {
            fileName: "Recording-frame-2.jpg",
            moment: { atMs: 3_900, reason: "action", action: 0 },
          },
          {
            fileName: "Recording-frame-3.jpg",
            moment: { atMs: 5_000, reason: "action", action: 1 },
          },
          { fileName: "Recording-frame-4.jpg", moment: { atMs: 8_000, reason: "change" } },
          { fileName: "Recording-frame-5.jpg", moment: { atMs: 12_450, reason: "last" } },
        ],
        timeline: {
          deviceName: "iPhone 17",
          osLabel: "iOS 27.0",
          actions: [
            { atMs: 3_200, agent: null, text: 'tap Button "Sign in"' },
            { atMs: 4_300, agent: "Codex", text: 'type "hello"' },
          ],
        },
      }),
    ).toBe(
      [
        "Video: Recording.mp4",
        "Length: 00:12.5",
        "Recorded in Zeros on iPhone 17 (iOS 27.0)",
        "",
        "Key frames:",
        "00:00.0 Recording-frame-1.jpg: first frame",
        '00:03.9 Recording-frame-2.jpg: after tap Button "Sign in"',
        '00:05.0 Recording-frame-3.jpg: after type "hello" (by Codex)',
        "00:08.0 Recording-frame-4.jpg: the picture changed",
        "00:12.5 Recording-frame-5.jpg: last frame",
        "",
        "Actions, by the user unless an agent is named:",
        '00:03.2 tap Button "Sign in"',
        '00:04.3 type "hello" (by Codex)',
        "",
      ].join("\n"),
    );
  });

  it("says a recording had no actions", () => {
    expect(
      videoTimelineText({
        videoName: "Recording.mp4",
        durationMs: 1_000,
        frames: [],
        timeline: { deviceName: "iPad Pro", osLabel: "iPadOS 27.0", actions: [] },
      }),
    ).toBe(
      [
        "Video: Recording.mp4",
        "Length: 00:01.0",
        "Recorded in Zeros on iPad Pro (iPadOS 27.0)",
        "",
        "Actions, by the user unless an agent is named:",
        "none",
        "",
      ].join("\n"),
    );
  });

  it("describes any other video by its frames alone", () => {
    expect(
      videoTimelineText({
        videoName: "screen.webm",
        durationMs: null,
        frames: [{ fileName: "screen-frame-1.jpg", moment: { atMs: 0, reason: "first" } }],
        timeline: null,
      }),
    ).toBe("Video: screen.webm\n\nKey frames:\n00:00.0 screen-frame-1.jpg: first frame\n");
  });
});

describe("videoFingerprint", () => {
  // The same derivation the main process test pins for recordingFingerprint:
  // the two must agree for a dropped recording to find its timeline.
  const expected = (bytes: Uint8Array, ranges: Array<[number, number]>) => {
    const hash = createHash("sha256").update(`zeros-recording\n${bytes.length}\n`);
    for (const [start, end] of ranges) hash.update(bytes.subarray(start, end));
    return hash.digest("hex");
  };

  it("hashes a long video's size, first and last 64 KiB", async () => {
    const bytes = new Uint8Array(200_000);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    expect(await videoFingerprint(new Blob([bytes]))).toBe(
      expected(bytes, [
        [0, 65_536],
        [200_000 - 65_536, 200_000],
      ]),
    );
  });

  it("hashes a short video whole", async () => {
    const bytes = new Uint8Array(1_000).fill(7);
    expect(await videoFingerprint(new Blob([bytes]))).toBe(expected(bytes, [[0, 1_000]]));
  });
});
