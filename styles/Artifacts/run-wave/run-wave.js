// ── Run loader — Audio Wave ────────────────────────────────────────────────
//
// Five quiet, rounded strokes share a fixed lower baseline while one cosine
// crest rolls across their top endpoints at the reference animation's speed.
// Periodic splines keep the upper contour smooth without a visible loop seam.
//
// Markup: give any element `data-run-wave` and `data-wave-size="16"`; the
// script injects a sized SVG inside it. Colour comes from the host's `color`.
(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var VIEWBOX_SIZE = 20;

  function rounded(value) {
    return Math.round(value * 1000) / 1000;
  }

  var WAVE_BAR_X = [2.5, 6.25, 10, 13.75, 17.5];
  var WAVE_POSE_COUNT = 20;
  var WAVE_MIN_SCALE = 0.35;
  var WAVE_MAX_SCALE = 1;
  var WAVE_START_CREST_BAR = 2;

  function scaleForPose(barIndex, poseIndex) {
    var midpoint = (WAVE_MIN_SCALE + WAVE_MAX_SCALE) / 2;
    var amplitude = (WAVE_MAX_SCALE - WAVE_MIN_SCALE) / 2;
    var phase =
      (barIndex - WAVE_START_CREST_BAR) / WAVE_BAR_X.length -
      poseIndex / WAVE_POSE_COUNT;

    return rounded(midpoint + amplitude * Math.cos(phase * Math.PI * 2));
  }

  var WAVE_BARS = WAVE_BAR_X.map(function (x, index) {
    return { x: x, rest: scaleForPose(index, 0) };
  });
  var WAVE_POSES = [];
  for (var poseIndex = 0; poseIndex < WAVE_POSE_COUNT; poseIndex++) {
    WAVE_POSES.push(
      WAVE_BAR_X.map(function (_x, barIndex) {
        return scaleForPose(barIndex, poseIndex);
      }),
    );
  }

  var RUN_WAVE_MOTION = {
    cycleDurationMs: 1500,
    poseDurationMs: 75,
    // Dense samples preserve the smooth contour at the faster cadence.
    subdivisionsPerPose: 3,
    bars: WAVE_BARS,
    poses: WAVE_POSES,
  };

  function visibleStrokeWidthForSize(size) {
    var safeSize = Number(size);
    if (!isFinite(safeSize) || safeSize <= 0) safeSize = 16;
    return rounded(Math.max(0.8, safeSize * 0.1 - 0.4));
  }

  function wrappedIndex(index, length) {
    return ((index % length) + length) % length;
  }

  function catmullRom(p0, p1, p2, p3, t) {
    var t2 = t * t;
    var t3 = t2 * t;
    return (
      0.5 *
      (2 * p1 +
        (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
    );
  }

  function scaleAtProgress(barIndex, progress) {
    var poseCount = RUN_WAVE_MOTION.poses.length;
    var safeProgress = Number(progress);
    if (!isFinite(safeProgress)) safeProgress = 0;
    safeProgress = ((safeProgress % 1) + 1) % 1;

    var posePosition = safeProgress * poseCount;
    var p1Index = Math.floor(posePosition);
    var localProgress = posePosition - p1Index;
    var p0 = RUN_WAVE_MOTION.poses[wrappedIndex(p1Index - 1, poseCount)];
    var p1 = RUN_WAVE_MOTION.poses[wrappedIndex(p1Index, poseCount)];
    var p2 = RUN_WAVE_MOTION.poses[wrappedIndex(p1Index + 1, poseCount)];
    var p3 = RUN_WAVE_MOTION.poses[wrappedIndex(p1Index + 2, poseCount)];

    return catmullRom(
      p0[barIndex],
      p1[barIndex],
      p2[barIndex],
      p3[barIndex],
      localProgress,
    );
  }

  function element(name, attributes) {
    var node = document.createElementNS(SVG_NS, name);
    Object.keys(attributes).forEach(function (key) {
      node.setAttribute(key, attributes[key]);
    });
    return node;
  }

  var STYLE_ID = "run-wave-style";
  function buildKeyframesForBar(barIndex) {
    var sampleCount =
      RUN_WAVE_MOTION.poses.length * RUN_WAVE_MOTION.subdivisionsPerPose;
    var frames = ["@keyframes run-wave-bar-" + barIndex + "{"];

    for (var sample = 0; sample <= sampleCount; sample++) {
      var progress = sample / sampleCount;
      frames.push(
        rounded(progress * 100) +
          "%{transform:scaleY(" +
          rounded(scaleAtProgress(barIndex, progress)) +
          ")}",
      );
    }
    frames.push("}");
    return frames.join("");
  }

  function buildStyleText() {
    var styles = [];
    RUN_WAVE_MOTION.bars.forEach(function (_bar, index) {
      styles.push(buildKeyframesForBar(index));
    });

    styles.push(
      ".run-wave-svg{display:block;overflow:visible}",
      ".run-wave-bar{",
      "transform-box:fill-box;transform-origin:center bottom;",
      "animation-duration:" + RUN_WAVE_MOTION.cycleDurationMs + "ms;",
      "animation-timing-function:linear;",
      "animation-iteration-count:infinite;animation-fill-mode:both;",
      "will-change:transform}",
    );

    RUN_WAVE_MOTION.bars.forEach(function (bar, index) {
      styles.push(
        ".run-wave-bar--" +
          index +
          "{--run-wave-rest:" +
          bar.rest +
          ";animation-name:run-wave-bar-" +
          index +
          "}",
      );
    });

    styles.push(
      "@media (prefers-reduced-motion:reduce){",
      ".run-wave-bar{animation:none;",
      "transform:scaleY(var(--run-wave-rest))}}",
    );
    return styles.join("");
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = buildStyleText();
    (document.head || document.documentElement).appendChild(style);
  }

  function mount(host) {
    var size =
      parseInt(host.getAttribute("data-wave-size"), 10) ||
      host.clientWidth ||
      16;
    var svg = element("svg", {
      class: "run-wave-svg",
      viewBox: "0 0 " + VIEWBOX_SIZE + " " + VIEWBOX_SIZE,
      width: size,
      height: size,
      "aria-hidden": "true",
    });
    RUN_WAVE_MOTION.bars.forEach(function (bar, index) {
      svg.appendChild(
        element("line", {
          class: "run-wave-bar run-wave-bar--" + index,
          x1: bar.x,
          x2: bar.x,
          y1: 4,
          y2: 18,
          fill: "none",
          stroke: "currentColor",
          "stroke-width": visibleStrokeWidthForSize(size),
          "stroke-linecap": "round",
          "vector-effect": "non-scaling-stroke",
        }),
      );
    });

    host.appendChild(svg);
  }

  function mountAll() {
    injectStyles();
    var hosts = document.querySelectorAll("[data-run-wave]");
    for (var i = 0; i < hosts.length; i++) {
      if (!hosts[i].querySelector(".run-wave-svg")) mount(hosts[i]);
    }
  }

  var api = {
    RUN_WAVE_MOTION: RUN_WAVE_MOTION,
    buildStyleText: buildStyleText,
    mountAll: mountAll,
    scaleAtProgress: scaleAtProgress,
    visibleStrokeWidthForSize: visibleStrokeWidthForSize,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof window !== "undefined") {
    window.RunWave = api;
  }
  if (typeof document === "undefined") return;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountAll);
  } else {
    mountAll();
  }
})();
