(function startStoryPreview() {
  "use strict";

  const root = document.documentElement;
  const library = window.StoryShimmerLibrary;
  const journey = library?.stories[library.defaultStoryId];
  const canvas = document.querySelector("#story-shimmer");
  const inspector = document.querySelector("#micro-inspector");
  const frame = document.querySelector(".canvas-frame");
  const fallback = document.querySelector(".animation-fallback");
  const playButton = document.querySelector("#play-toggle");
  const previousButton = document.querySelector("#previous-frame");
  const nextButton = document.querySelector("#next-frame");
  const shimmerButton = document.querySelector("#shimmer-toggle");
  const blendButton = document.querySelector("#blend-toggle");
  const blendValue = document.querySelector(".switch-value");
  const resetButton = document.querySelector("#reset-controls");
  const scrubber = document.querySelector("#loop-progress");
  const frameLabel = document.querySelector("#pose-label");
  const statusLabel = document.querySelector("#status-label");
  const speedRange = document.querySelector("#speed-range");
  const speedValue = document.querySelector("#speed-value");
  const dotScaleRange = document.querySelector("#dot-scale-range");
  const dotScaleValue = document.querySelector("#dot-scale-value");
  const shimmerRange = document.querySelector("#shimmer-range");
  const shimmerValue = document.querySelector("#shimmer-value");
  const storyTitle = document.querySelector("#selected-story-title");
  const storyDescription = document.querySelector(
    "#selected-story-description",
  );
  const cornerStory = document.querySelector("#corner-story");
  const factStory = document.querySelector("#fact-story");
  const actualSizeLabels = [
    ...document.querySelectorAll("[data-actual-size-label]"),
  ];
  const sourceSizeLabels = [
    ...document.querySelectorAll("[data-source-size-label]"),
  ];
  const sceneButtons = [...document.querySelectorAll("[data-scene-choice]")];
  const sizeButtons = [...document.querySelectorAll("[data-preview-size]")];
  const themeButtons = [...document.querySelectorAll("[data-theme-choice]")];
  const motionCountLabels = [
    ...document.querySelectorAll("[data-motion-frame-count]"),
  ];
  const dotCountLabels = [...document.querySelectorAll("[data-dot-count]")];
  const sceneCountLabels = [...document.querySelectorAll("[data-scene-count]")];
  let isScrubbing = false;
  let resumeAfterScrub = false;
  let activeSceneId = "";

  const DEFAULTS = Object.freeze({
    dotScale: 1,
    frameBlend: true,
    previewSize: "micro16",
    progress: 0,
    shimmer: true,
    shimmerIntensity: 0.9,
    speed: 1,
  });

  function readToken(name) {
    return getComputedStyle(root).getPropertyValue(name).trim();
  }

  function syncRange(range) {
    const minimum = Number(range.min);
    const maximum = Number(range.max);
    const value = Number(range.value);
    const progress = ((value - minimum) / (maximum - minimum)) * 100;
    range.style.setProperty("--range-progress", `${progress}%`);
  }

  function paintMicroInspector() {
    if (!inspector || !canvas.width || !canvas.height) return;
    const bounds = inspector.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width || 180));
    const height = Math.max(1, Math.round(bounds.height || 180));
    const deviceScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const pixelWidth = Math.round(width * deviceScale);
    const pixelHeight = Math.round(height * deviceScale);
    if (inspector.width !== pixelWidth || inspector.height !== pixelHeight) {
      inspector.width = pixelWidth;
      inspector.height = pixelHeight;
    }
    const context = inspector.getContext("2d");
    context.clearRect(0, 0, inspector.width, inspector.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(
      canvas,
      0,
      0,
      canvas.width,
      canvas.height,
      0,
      0,
      inspector.width,
      inspector.height,
    );
  }

  function sceneById(sceneId) {
    return journey.scenes.find((scene) => scene.id === sceneId);
  }

  function syncSceneUi(frameScene) {
    if (!frameScene) return;
    const scene = sceneById(frameScene.sceneId);
    const nextScene = sceneById(frameScene.nextSceneId);

    if (frameScene.transition) {
      storyTitle.textContent = `${scene.code} → ${nextScene.code} · relay wipe`;
      storyDescription.textContent = scene.nextDescription;
      cornerStory.textContent = `${scene.code} → ${nextScene.code} / relay`;
      canvas.setAttribute(
        "aria-label",
        `${scene.name} handing the dotted silhouette to ${nextScene.name}`,
      );
    } else {
      storyTitle.textContent = `${scene.code} · ${scene.name}`;
      storyDescription.textContent = scene.description;
      cornerStory.textContent = `${scene.code} / ${scene.name}`;
      canvas.setAttribute("aria-label", scene.ariaLabel);
    }

    frame.dataset.transition = String(frameScene.transition);
    if (activeSceneId === scene.id) return;
    activeSceneId = scene.id;
    for (const button of sceneButtons) {
      const selected = button.dataset.sceneChoice === scene.id;
      button.setAttribute("aria-current", selected ? "step" : "false");
      button.setAttribute("aria-pressed", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
  }

  try {
    if (!journey) throw new Error("Combined journey data did not load.");

    const shimmer = new window.StoryShimmer(canvas, {
      baseColor: readToken("--fg2"),
      dotScale: DEFAULTS.dotScale,
      frameBlend: DEFAULTS.frameBlend,
      onFrame({ frame: frameIndex, frameCount, progress, scene }) {
        if (!isScrubbing) scrubber.value = Math.round(progress * 1000);
        syncRange(scrubber);
        frameLabel.textContent = `Frame ${String(frameIndex + 1).padStart(
          3,
          "0",
        )} / ${String(frameCount).padStart(3, "0")}`;
        syncSceneUi(scene);
        paintMicroInspector();
      },
      shimmer: DEFAULTS.shimmer,
      shimmerColor: readToken("--fg1"),
      shimmerIntensity: DEFAULTS.shimmerIntensity,
      story: journey,
    });

    window.storyShimmerDemo = shimmer;
    frame.dataset.ready = "true";

    function syncPlaybackUi() {
      const playing = shimmer.isPlaying;
      playButton.dataset.playing = String(playing);
      playButton.setAttribute(
        "aria-label",
        playing ? "Pause animation" : "Play animation",
      );
      playButton.querySelector(".button-label").textContent = playing
        ? "Pause"
        : "Play";
      statusLabel.textContent = playing ? "Shape shimmer looping" : "Paused";
      document.querySelector(".status-light").dataset.active = String(playing);
    }

    function syncTuningUi() {
      speedRange.value = String(shimmer.speed);
      dotScaleRange.value = String(shimmer.dotScale);
      shimmerRange.value = String(shimmer.shimmerIntensity);
      speedValue.textContent = `${shimmer.speed.toFixed(2)}×`;
      dotScaleValue.textContent = `${Math.round(shimmer.dotScale * 100)}%`;
      shimmerValue.textContent = `${Math.round(
        shimmer.shimmerIntensity * 100,
      )}%`;
      shimmerButton.setAttribute("aria-pressed", String(shimmer.shimmer));
      blendButton.setAttribute("aria-checked", String(shimmer.frameBlend));
      blendValue.textContent = shimmer.frameBlend ? "On" : "Off";
      for (const range of [speedRange, dotScaleRange, shimmerRange, scrubber]) {
        syncRange(range);
      }
    }

    function syncJourneyUi() {
      for (const label of motionCountLabels) {
        label.textContent = String(shimmer.poseCount);
      }
      for (const label of dotCountLabels) {
        label.textContent = String(journey.dotCount);
      }
      for (const label of sceneCountLabels) {
        label.textContent = String(journey.scenes.length);
      }
      factStory.textContent = "One loop · A → B → C → D → E";
    }

    function setTheme(theme) {
      root.dataset.theme = theme;
      for (const button of themeButtons) {
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.themeChoice === theme),
        );
      }
      shimmer.setColors(readToken("--fg2"), readToken("--fg1"));
      paintMicroInspector();
    }

    function setPreviewSize(size) {
      frame.dataset.size = size;
      const microSize =
        size === "micro16" ? 16 : size === "micro24" ? 24 : null;
      for (const button of sizeButtons) {
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.previewSize === size),
        );
      }
      if (microSize) {
        for (const label of actualSizeLabels) {
          label.textContent = `${microSize} × ${microSize} px`;
        }
        for (const label of sourceSizeLabels) {
          label.textContent = `Same ${microSize} px source`;
        }
      }
      requestAnimationFrame(() => {
        shimmer.resize();
        paintMicroInspector();
      });
    }

    function seekScene(sceneId) {
      const scene = sceneById(sceneId);
      if (!scene) return;
      shimmer.setProgress(scene.startFrame / shimmer.poseCount);
    }

    function stepFrame(direction) {
      shimmer.pause();
      const current = Math.floor(shimmer.progress * shimmer.poseCount);
      const target =
        (current + direction + shimmer.poseCount) % shimmer.poseCount;
      shimmer.setProgress(target / shimmer.poseCount);
      syncPlaybackUi();
    }

    function resetControls() {
      shimmer.setSpeed(DEFAULTS.speed);
      shimmer.setDotScale(DEFAULTS.dotScale);
      shimmer.setShimmerIntensity(DEFAULTS.shimmerIntensity);
      shimmer.setShimmer(DEFAULTS.shimmer);
      shimmer.setFrameBlend(DEFAULTS.frameBlend);
      shimmer.setProgress(DEFAULTS.progress);
      setPreviewSize(DEFAULTS.previewSize);
      shimmer.play();
      syncPlaybackUi();
      syncTuningUi();
    }

    for (const button of sceneButtons) {
      button.addEventListener("click", () => {
        seekScene(button.dataset.sceneChoice);
      });
      button.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const currentIndex = sceneButtons.indexOf(button);
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const nextIndex =
          (currentIndex + direction + sceneButtons.length) %
          sceneButtons.length;
        sceneButtons[nextIndex].focus();
        seekScene(sceneButtons[nextIndex].dataset.sceneChoice);
      });
    }

    for (const button of themeButtons) {
      button.addEventListener("click", () =>
        setTheme(button.dataset.themeChoice),
      );
    }
    for (const button of sizeButtons) {
      button.addEventListener("click", () =>
        setPreviewSize(button.dataset.previewSize),
      );
    }

    playButton.addEventListener("click", () => {
      shimmer.toggle();
      syncPlaybackUi();
    });
    previousButton.addEventListener("click", () => stepFrame(-1));
    nextButton.addEventListener("click", () => stepFrame(1));
    shimmerButton.addEventListener("click", () => {
      shimmer.setShimmer(!shimmer.shimmer);
      syncTuningUi();
    });
    blendButton.addEventListener("click", () => {
      shimmer.setFrameBlend(!shimmer.frameBlend);
      syncTuningUi();
    });
    speedRange.addEventListener("input", () => {
      shimmer.setSpeed(Number(speedRange.value));
      syncTuningUi();
    });
    dotScaleRange.addEventListener("input", () => {
      shimmer.setDotScale(Number(dotScaleRange.value));
      syncTuningUi();
    });
    shimmerRange.addEventListener("input", () => {
      shimmer.setShimmerIntensity(Number(shimmerRange.value));
      syncTuningUi();
    });

    scrubber.addEventListener("pointerdown", () => {
      isScrubbing = true;
      resumeAfterScrub = shimmer.isPlaying;
      shimmer.pause();
      syncPlaybackUi();
    });
    window.addEventListener("pointerup", () => {
      if (!isScrubbing) return;
      isScrubbing = false;
      if (resumeAfterScrub) shimmer.play();
      syncPlaybackUi();
    });
    scrubber.addEventListener("input", () => {
      shimmer.setProgress(Number(scrubber.value) / 1000);
      syncRange(scrubber);
    });

    resetButton.addEventListener("click", resetControls);
    document.addEventListener("keydown", (event) => {
      if (event.target.closest("button, input")) return;
      if (event.code === "Space") {
        event.preventDefault();
        shimmer.toggle();
        syncPlaybackUi();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepFrame(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        stepFrame(1);
      }
    });

    window.storyShimmerLab = Object.freeze({
      paintMicroInspector,
      seekScene,
      setPreviewSize,
    });

    syncJourneyUi();
    syncPlaybackUi();
    syncTuningUi();
    setPreviewSize(DEFAULTS.previewSize);
  } catch (error) {
    frame.dataset.error = "true";
    fallback.innerHTML =
      "<strong>Animation could not start.</strong><span>Open the browser console for details.</span>";
    console.error("Story Shimmer preview failed to initialize:", error);
  }
})();
