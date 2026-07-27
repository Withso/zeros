(function installStoryShimmer(root) {
  "use strict";

  const library = root.StoryShimmerLibrary;
  if (!library) {
    throw new Error("StoryShimmer requires story-poses.js to be loaded first.");
  }

  const TAU = Math.PI * 2;
  const DEFAULTS = Object.freeze({
    autoplay: true,
    baseColor: "#a7a3a0",
    dotScale: 1,
    frameBlend: true,
    maxDevicePixelRatio: 2,
    respectReducedMotion: true,
    shimmer: true,
    shimmerColor: "#f0eeee",
    shimmerIntensity: 0.9,
    speed: 1,
    story: library.defaultStoryId,
  });

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function lerp(from, to, progress) {
    return from + (to - from) * progress;
  }

  function unpackPose(pose) {
    return new Map(pose.map((entry) => [entry.id, entry]));
  }

  function makeTransitions(poses) {
    return poses.map((fromPose, poseIndex) => {
      const toPose = poses[(poseIndex + 1) % poses.length];
      const ids = new Set([...fromPose.keys(), ...toPose.keys()]);
      return [...ids]
        .map((id) => {
          const from = fromPose.get(id);
          const to = toPose.get(id);
          const anchor = from || to;
          return {
            from: from || { ...anchor, alpha: 0 },
            id,
            to: to || { ...anchor, alpha: 0 },
          };
        })
        .sort(
          (first, second) =>
            first.from.y - second.from.y || first.from.x - second.from.x,
        );
    });
  }

  function resolveStory(story) {
    const resolved = typeof story === "string" ? library.stories[story] : story;
    if (!resolved || !Array.isArray(resolved.poses)) {
      throw new Error(`Unknown StoryShimmer story: ${String(story)}`);
    }
    return resolved;
  }

  class StoryShimmer {
    constructor(canvas, options = {}) {
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new TypeError("StoryShimmer expects a canvas element.");
      }

      this.canvas = canvas;
      this.context = canvas.getContext("2d");
      if (!this.context) {
        throw new Error("A 2D canvas context is required.");
      }

      const normalizedOptions = { ...options };
      if (normalizedOptions.color && !normalizedOptions.baseColor) {
        normalizedOptions.baseColor = normalizedOptions.color;
      }
      if ("glitter" in normalizedOptions && !("shimmer" in normalizedOptions)) {
        normalizedOptions.shimmer = normalizedOptions.glitter;
      }
      if (
        "glitterIntensity" in normalizedOptions &&
        !("shimmerIntensity" in normalizedOptions)
      ) {
        normalizedOptions.shimmerIntensity = normalizedOptions.glitterIntensity;
      }

      this.options = { ...DEFAULTS, ...normalizedOptions };
      this.speed = Math.max(0.05, Number(this.options.speed) || DEFAULTS.speed);
      this.dotScale = clamp(
        Number(this.options.dotScale) || DEFAULTS.dotScale,
        0.65,
        1.4,
      );
      this.frameBlend = Boolean(this.options.frameBlend);
      this.shimmer = Boolean(this.options.shimmer);
      this.shimmerIntensity = clamp(
        Number.isFinite(Number(this.options.shimmerIntensity))
          ? Number(this.options.shimmerIntensity)
          : DEFAULTS.shimmerIntensity,
        0,
        1,
      );
      this.baseColor = this.options.baseColor;
      this.shimmerColor = this.options.shimmerColor;
      this.progress = 0;
      this.playing = false;
      this.layout = {
        deviceScale: 1,
        grid: 1,
        height: 1,
        originX: 0,
        originY: 0,
        width: 1,
      };
      this._anchorProgress = 0;
      this._anchorTime = 0;
      this._animationFrame = 0;
      this._tick = this._tick.bind(this);

      this.setStory(this.options.story, { resetProgress: true });
      this.resize();
      this._watchSize();

      const reducedMotion =
        this.options.respectReducedMotion &&
        root.matchMedia &&
        root.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (this.options.autoplay && !reducedMotion) {
        this.play();
      } else {
        this.canvas.dataset.motion = reducedMotion ? "reduced" : "paused";
        this.render(0);
      }
    }

    get isPlaying() {
      return this.playing;
    }

    // Backwards-compatible aliases for the first prototype's public controls.
    get glitter() {
      return this.shimmer;
    }

    get glitterIntensity() {
      return this.shimmerIntensity;
    }

    _watchSize() {
      if ("ResizeObserver" in root) {
        this._resizeObserver = new ResizeObserver(() => this.resize());
        this._resizeObserver.observe(this.canvas);
        return;
      }
      this._windowResize = () => this.resize();
      root.addEventListener("resize", this._windowResize);
    }

    resize() {
      const bounds = this.canvas.getBoundingClientRect();
      const width = Math.max(
        1,
        Math.round(bounds.width || this.canvas.width || 1),
      );
      const height = Math.max(
        1,
        Math.round(bounds.height || this.canvas.height || 1),
      );
      const deviceScale = clamp(
        root.devicePixelRatio || 1,
        1,
        this.options.maxDevicePixelRatio,
      );
      const pixelWidth = Math.round(width * deviceScale);
      const pixelHeight = Math.round(height * deviceScale);

      if (
        this.canvas.width !== pixelWidth ||
        this.canvas.height !== pixelHeight
      ) {
        this.canvas.width = pixelWidth;
        this.canvas.height = pixelHeight;
      }
      this.context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
      this.layout = {
        deviceScale,
        grid: Math.min(
          width / this.story.viewWidth,
          height / this.story.viewHeight,
        ),
        height,
        originX: width * 0.5,
        originY: height * 0.5,
        width,
      };
      this.render(this.progress);
    }

    _reanchor() {
      this._anchorProgress = this.progress;
      this._anchorTime = performance.now();
    }

    play() {
      if (this.playing) return;
      this.playing = true;
      this.canvas.dataset.motion = "playing";
      this._reanchor();
      this._animationFrame = requestAnimationFrame(this._tick);
    }

    pause() {
      if (!this.playing) return;
      this.playing = false;
      this.canvas.dataset.motion = "paused";
      cancelAnimationFrame(this._animationFrame);
      this._animationFrame = 0;
    }

    toggle() {
      if (this.playing) this.pause();
      else this.play();
      return this.playing;
    }

    setStory(story, { resetProgress = true } = {}) {
      this.story = resolveStory(story);
      this.duration = this.story.duration;
      this.poses = this.story.poses.map(unpackPose);
      this.transitions = makeTransitions(this.poses);
      this.poseCount = this.poses.length;
      this.keyPoseCount = this.story.keyPoseCount || this.poseCount;
      this.canvas.dataset.story = this.story.id;
      if (resetProgress) this.progress = 0;
      this._reanchor();
      if (this.layout) this.resize();
      return this.story;
    }

    setProgress(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return;
      this.progress = numeric >= 1 ? 0 : clamp(numeric, 0, 1);
      this._reanchor();
      this.render(this.progress);
    }

    setSpeed(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return;
      this._reanchor();
      this.speed = Math.max(0.05, numeric);
    }

    setDuration(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return;
      this._reanchor();
      this.duration = clamp(numeric, 240, 20000);
    }

    setDotScale(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return;
      this.dotScale = clamp(numeric, 0.65, 1.4);
      this.render(this.progress);
    }

    setFrameBlend(enabled) {
      this.frameBlend = Boolean(enabled);
      this.render(this.progress);
    }

    setShimmer(enabled) {
      this.shimmer = Boolean(enabled);
      this.render(this.progress);
    }

    setShimmerIntensity(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return;
      this.shimmerIntensity = clamp(numeric, 0, 1);
      this.render(this.progress);
    }

    setColors(baseColor, shimmerColor = this.shimmerColor) {
      this.baseColor = baseColor;
      this.shimmerColor = shimmerColor;
      this.render(this.progress);
    }

    setColor(color) {
      this.setColors(color, this.shimmerColor);
    }

    setGlitter(enabled) {
      this.setShimmer(enabled);
    }

    setGlitterIntensity(value) {
      this.setShimmerIntensity(value);
    }

    _tick(now) {
      if (!this.playing) return;
      const elapsed = ((now - this._anchorTime) * this.speed) / this.duration;
      this.progress = (((this._anchorProgress + elapsed) % 1) + 1) % 1;
      this.render(this.progress);
      this._animationFrame = requestAnimationFrame(this._tick);
    }

    render(progress = this.progress) {
      const { context: ctx } = this;
      const { deviceScale, grid, height, originX, originY, width } =
        this.layout;
      ctx.clearRect(0, 0, width, height);

      const exactPose = progress * this.poseCount;
      const poseIndex = Math.floor(exactPose) % this.poseCount;
      const localProgress = exactPose - Math.floor(exactPose);
      const blend = this.frameBlend ? localProgress : 0;
      const isMicro = width <= 32 && height <= 32;
      const baseRadius = Math.max(
        grid * this.story.dotRadius * this.dotScale,
        isMicro ? 0.36 : 0.52 / deviceScale,
      );
      const snapScale = Math.max(1, deviceScale);
      const sceneFrameCount = this.story.sceneFrameCount || this.poseCount;
      const sceneProgress = (exactPose % sceneFrameCount) / sceneFrameCount;
      const shimmerCenter = -0.22 + sceneProgress * 1.44;
      const activeDots = [];

      for (const transition of this.transitions[poseIndex]) {
        const x = lerp(transition.from.x, transition.to.x, blend);
        const y = lerp(transition.from.y, transition.to.y, blend);
        const alpha = lerp(transition.from.alpha, transition.to.alpha, blend);
        const radiusScale = lerp(
          transition.from.radius,
          transition.to.radius,
          blend,
        );
        if (alpha < 0.015 || radiusScale < 0.05) continue;

        const rawCanvasX = originX + x * grid;
        const rawCanvasY = originY + y * grid;
        // A physical-pixel center (n + 0.5), rather than an intersection,
        // keeps neighboring Retina dots from rasterizing as touching 2×2 blocks.
        const canvasX = isMicro
          ? (Math.floor(rawCanvasX * snapScale) + 0.5) / snapScale
          : rawCanvasX;
        const canvasY = isMicro
          ? (Math.floor(rawCanvasY * snapScale) + 0.5) / snapScale
          : rawCanvasY;
        const projection = (x + 7 + (y + 7) * 0.38) / (14 * 1.38);
        const distance = Math.abs(projection - shimmerCenter);
        const shimmerAmount = this.shimmer
          ? Math.exp(-Math.pow(distance / 0.115, 2)) * this.shimmerIntensity
          : 0;

        activeDots.push({
          alpha,
          canvasX,
          canvasY,
          radius: baseRadius * radiusScale,
          shimmerAmount,
          x,
          y,
        });
      }

      this.renderSnapshot = Object.freeze({
        activeDotCount: activeDots.length,
        dots: Object.freeze(
          activeDots.map((dot) =>
            Object.freeze({
              alpha: dot.alpha,
              radius: dot.radius,
              shimmer: dot.shimmerAmount,
              x: dot.canvasX,
              y: dot.canvasY,
            }),
          ),
        ),
        frame: poseIndex,
        isMicro,
        sceneProgress,
      });

      ctx.save();
      ctx.fillStyle = this.baseColor;
      for (const dot of activeDots) {
        ctx.globalAlpha = dot.alpha;
        ctx.beginPath();
        ctx.arc(dot.canvasX, dot.canvasY, dot.radius, 0, TAU);
        ctx.fill();
      }

      if (this.shimmer && this.shimmerIntensity > 0.001) {
        ctx.fillStyle = this.shimmerColor;
        for (const dot of activeDots) {
          if (dot.shimmerAmount < 0.015) continue;
          ctx.globalAlpha = dot.alpha * dot.shimmerAmount;
          ctx.beginPath();
          ctx.arc(dot.canvasX, dot.canvasY, dot.radius, 0, TAU);
          ctx.fill();
        }
      }
      ctx.restore();

      if (typeof this.options.onFrame === "function") {
        this.options.onFrame({
          blend,
          frame: poseIndex,
          frameCount: this.poseCount,
          isMicro,
          keyPoseCount: this.keyPoseCount,
          progress,
          scene: this.story.frameScenes?.[poseIndex] || null,
          sceneProgress,
          story: this.story,
        });
      }
    }

    destroy() {
      this.pause();
      if (this._resizeObserver) this._resizeObserver.disconnect();
      if (this._windowResize)
        root.removeEventListener("resize", this._windowResize);
    }
  }

  root.StoryShimmer = StoryShimmer;
})(window);
