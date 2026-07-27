(function installShapeShimmer(root) {
  "use strict";

  const poseData = root.ShapeShimmerPoseData;
  if (!poseData) {
    throw new Error("ShapeShimmer requires horse-poses.js to be loaded first.");
  }

  const TAU = Math.PI * 2;
  const DEFAULTS = Object.freeze({
    autoplay: true,
    color: "#0b4bc9",
    dotScale: 1,
    duration: 1760,
    frameBlend: true,
    glitter: true,
    glitterIntensity: 0.78,
    maxDevicePixelRatio: 2,
    respectReducedMotion: true,
    speed: 1,
  });

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function gridHash(x, y) {
    let value = Math.imul(x + 37, 374761393) ^ Math.imul(y - 71, 668265263);
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
  }

  function unpackPose(flatPose) {
    const pose = new Map();
    for (let index = 0; index < flatPose.length; index += 3) {
      const x = flatPose[index];
      const y = flatPose[index + 1];
      pose.set(`${x}:${y}`, flatPose[index + 2] / 255);
    }
    return pose;
  }

  function makeTransitions(poses) {
    return poses.map((fromPose, poseIndex) => {
      const toPose = poses[(poseIndex + 1) % poses.length];
      const keys = new Set([...fromPose.keys(), ...toPose.keys()]);

      return [...keys]
        .map((key) => {
          const [x, y] = key.split(":").map(Number);
          return {
            from: fromPose.get(key) || 0,
            seed: gridHash(x, y),
            to: toPose.get(key) || 0,
            x,
            y,
          };
        })
        .sort((a, b) => a.y - b.y || a.x - b.x);
    });
  }

  class ShapeShimmer {
    constructor(canvas, options = {}) {
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new TypeError("ShapeShimmer expects a canvas element.");
      }

      this.canvas = canvas;
      this.context = canvas.getContext("2d");
      if (!this.context) {
        throw new Error("A 2D canvas context is required.");
      }

      this.options = { ...DEFAULTS, ...options };
      this.duration = Math.max(
        240,
        Number(this.options.duration) || DEFAULTS.duration,
      );
      this.speed = Math.max(0.05, Number(this.options.speed) || DEFAULTS.speed);
      this.dotScale = clamp(
        Number(this.options.dotScale) || DEFAULTS.dotScale,
        0.55,
        1.45,
      );
      this.frameBlend = Boolean(this.options.frameBlend);
      this.glitter = Boolean(this.options.glitter);
      const glitterIntensity = Number(this.options.glitterIntensity);
      this.glitterIntensity = clamp(
        Number.isFinite(glitterIntensity)
          ? glitterIntensity
          : DEFAULTS.glitterIntensity,
        0,
        1,
      );
      this.color = this.options.color;
      this.progress = 0;
      this.playing = false;
      this.layout = { grid: 1, height: 1, originX: 0, originY: 0, width: 1 };
      this._anchorProgress = 0;
      this._anchorTime = 0;
      this._animationFrame = 0;
      this._tick = this._tick.bind(this);

      this.poses = poseData.poses.map(unpackPose);
      this.transitions = makeTransitions(this.poses);
      this.poseCount = this.poses.length;
      this.keyPoseCount = poseData.keyPoseCount || this.poseCount;

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

      const grid = Math.min(width / 32, height / 24);
      this.layout = {
        grid,
        height,
        originX: width * 0.5,
        originY: height * 0.51,
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
      this.duration = clamp(numeric, 240, 10000);
    }

    setDotScale(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return;
      this.dotScale = clamp(numeric, 0.55, 1.45);
      this.render(this.progress);
    }

    setFrameBlend(enabled) {
      this.frameBlend = Boolean(enabled);
      this.render(this.progress);
    }

    setGlitter(enabled) {
      this.glitter = Boolean(enabled);
      this.render(this.progress);
    }

    setGlitterIntensity(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return;
      this.glitterIntensity = clamp(numeric, 0, 1);
      this.render(this.progress);
    }

    setColor(color) {
      this.color = color;
      this.render(this.progress);
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
      const { grid, height, originX, originY, width } = this.layout;
      ctx.clearRect(0, 0, width, height);

      const exactPose = progress * this.poseCount;
      const poseIndex = Math.floor(exactPose) % this.poseCount;
      const localProgress = exactPose - Math.floor(exactPose);
      const blend = this.frameBlend ? localProgress : 0;
      const maxRadius = grid * 0.43 * this.dotScale;
      const activeDots = [];

      for (const dot of this.transitions[poseIndex]) {
        const amount = dot.from + (dot.to - dot.from) * blend;
        if (amount < 0.018) continue;

        const x = originX + dot.x * grid;
        const y = originY + dot.y * grid;
        const wave =
          0.5 +
          0.5 *
            Math.sin(
              TAU * (progress * 2.0 - dot.x * 0.035 + dot.y * 0.019 + dot.seed),
            );
        const pulse = this.glitter
          ? 1 + 0.041 * this.glitterIntensity * wave
          : 1;
        const radius = maxRadius * amount * pulse;

        if (
          x + radius < 0 ||
          x - radius > width ||
          y + radius < 0 ||
          y - radius > height
        ) {
          continue;
        }

        activeDots.push({ ...dot, radius, wave, x, y });
      }

      ctx.save();
      ctx.fillStyle = this.color;
      ctx.shadowBlur = grid * 0.12;
      ctx.shadowColor = "rgba(25, 75, 190, 0.22)";
      ctx.beginPath();
      for (const dot of activeDots) {
        ctx.moveTo(dot.x + dot.radius, dot.y);
        ctx.arc(dot.x, dot.y, dot.radius, 0, TAU);
      }
      ctx.fill();
      ctx.shadowBlur = 0;

      if (this.glitter && this.glitterIntensity > 0.001) {
        ctx.globalCompositeOperation = "screen";

        for (const dot of activeDots) {
          if (dot.radius < maxRadius * 0.26) continue;
          const crest = Math.pow(dot.wave, 8);
          if (crest < 0.08) continue;

          const highlightRadius = Math.max(
            0.45,
            dot.radius * (0.08 + crest * 0.12),
          );
          const highlightAlpha = (0.08 + crest * 0.62) * this.glitterIntensity;
          ctx.fillStyle = `rgba(176, 218, 255, ${highlightAlpha})`;
          ctx.beginPath();
          ctx.arc(
            dot.x - dot.radius * 0.28,
            dot.y - dot.radius * 0.3,
            highlightRadius,
            0,
            TAU,
          );
          ctx.fill();

          if (
            crest > 0.72 &&
            dot.seed > 0.68 &&
            dot.radius > maxRadius * 0.62
          ) {
            const arm = grid * (0.07 + crest * 0.045);
            ctx.strokeStyle = `rgba(220, 239, 255, ${
              crest * 0.78 * this.glitterIntensity
            })`;
            ctx.lineWidth = Math.max(0.7, grid * 0.035);
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(dot.x - arm, dot.y);
            ctx.lineTo(dot.x + arm, dot.y);
            ctx.moveTo(dot.x, dot.y - arm);
            ctx.lineTo(dot.x, dot.y + arm);
            ctx.stroke();
          }
        }
      }

      ctx.restore();

      if (typeof this.options.onFrame === "function") {
        this.options.onFrame({
          blend,
          frame: poseIndex,
          frameCount: this.poseCount,
          keyPoseCount: this.keyPoseCount,
          pose: poseIndex,
          poseCount: this.poseCount,
          progress,
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

  root.ShapeShimmer = ShapeShimmer;
})(window);
