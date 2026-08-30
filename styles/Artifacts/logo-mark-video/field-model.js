// Periodic poses for the live Zeros mark field.
// Integer revolutions and births per loop keep t = 0 and t = LOOP_SEC identical.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ZerosLogoFieldModel = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var LOOP_SEC = 10;

  // Official mark paths, viewBox 0 0 128 128. Order: TL circle, BR circle,
  // BL kidney, TR kidney.
  var LOGO_PATHS = [
    "M62.349 29.2203C62.349 39.8354 53.8386 48.4407 43.3405 48.4407C32.8424 48.4407 24.332 39.8354 24.332 29.2203C24.332 18.6052 32.8424 10 43.3405 10C53.8386 10 62.349 18.6052 62.349 29.2203Z",
    "M67.78 98.7797C67.78 109.395 76.2904 118 86.7885 118C97.2866 118 105.797 109.395 105.797 98.7797C105.797 88.1646 97.2866 79.5593 86.7885 79.5593C76.2904 79.5593 67.78 88.1646 67.78 98.7797Z",
    "M24.332 70.4068C28.77 61.4319 37.9427 55.7627 47.8663 55.7627C55.0025 55.7627 59.8098 65.0843 58.0282 72.0715C56.312 78.8024 55.9589 87.1165 59.6335 96.0339C63.9396 106.484 56.3466 118 45.1508 118H41.5361C35.3331 118 29.5092 114.817 26.4869 109.339C25.3671 107.31 24.2662 105.202 23.4268 103.356C23.0519 102.531 22.6594 101.584 22.2614 100.565C18.4418 90.7796 19.6794 79.8158 24.332 70.4068Z",
    "M102.156 24.2292C97.6668 15.9522 89.2616 10.6133 79.9387 10.1172C78.4733 10.0392 77.0039 10.0823 75.5454 10.2462L74.3441 10.3812C69.0388 10.9772 66.1362 18.0033 68.0898 23.0263C70.7538 29.8759 72.2593 39.4012 67.78 50.2712C63.474 60.7209 71.067 72.2373 82.2627 72.2373H85.0478C92.1313 72.2373 98.52 67.9307 101.244 61.3192L104.634 53.0947C108.229 44.3685 107.706 34.4624 103.210 26.1735L102.156 24.2292Z",
  ];

  var MARK_SCALE = 0.82;

  function wrap01(value) {
    return value - Math.floor(value);
  }

  function cycle01(seconds) {
    return wrap01(seconds / LOOP_SEC);
  }

  function logoToUnit(sx, sy) {
    var ox = (1 - MARK_SCALE) / 2;
    return {
      x: ox + (sx / 128) * MARK_SCALE,
      y: ox + (sy / 128) * MARK_SCALE,
    };
  }

  function unitToLogo(x, y) {
    var ox = (1 - MARK_SCALE) / 2;
    return {
      x: ((x - ox) / MARK_SCALE) * 128,
      y: ((y - ox) / MARK_SCALE) * 128,
    };
  }

  function mulberry32(seed) {
    var t = seed >>> 0;
    return function next() {
      t += 0x6d2b79f5;
      var r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function edgeFade(x, y) {
    var m = Math.min(x, 1 - x, y, 1 - y);
    if (m >= 0.09) return 1;
    if (m <= 0) return 0;
    var t = m / 0.09;
    return t * t * (3 - 2 * t);
  }

  // Birth at 0, scale up, hold, scale down to nothing. Continuous at wrap.
  function lifeEnvelope(u) {
    u = wrap01(u);
    if (u < 0.16) {
      var rise = u / 0.16;
      return rise * rise * (3 - 2 * rise);
    }
    if (u < 0.58) return 1;
    var fall = (u - 0.58) / 0.42;
    return 1 - fall * fall * (3 - 2 * fall);
  }

  function poseParticle(particle, cycle) {
    var u = wrap01(cycle);
    var spin = (u * particle.revs + particle.phase) * Math.PI * 2;
    var depth = (u * particle.revsZ + particle.phaseZ) * Math.PI * 2;
    var wobble = (u * particle.revsW + particle.phaseW) * Math.PI * 2;
    var z = Math.sin(depth);
    var x =
      particle.x +
      particle.rx * Math.cos(spin) +
      particle.ox * Math.sin(wobble);
    var y =
      particle.y +
      particle.ry * Math.sin(spin + particle.skew) +
      particle.oy * Math.cos(wobble);
    var births = particle.births || 0;
    var env =
      births > 0
        ? lifeEnvelope(u * births + (particle.birthPhase || 0))
        : 1;
    var pulseRevs = particle.pulseRevs || 2;
    var pulse =
      0.78 + 0.22 * Math.sin((u * pulseRevs + particle.phase) * Math.PI * 2);
    var depthScale = 0.62 + 0.38 * (0.5 + 0.5 * z);
    var scale = particle.size * env * depthScale;
    var alpha =
      particle.alpha *
      env *
      pulse *
      (0.42 + 0.58 * (0.5 + 0.5 * z)) *
      edgeFade(x, y);
    var vx = -particle.rx * Math.sin(spin);
    var vy = particle.ry * Math.cos(spin + particle.skew);
    return {
      x: x,
      y: y,
      z: z,
      scale: scale,
      alpha: alpha,
      vx: vx,
      vy: vy,
      env: env,
      pulse: pulse,
    };
  }

  return {
    LOOP_SEC: LOOP_SEC,
    LOGO_PATHS: LOGO_PATHS,
    MARK_SCALE: MARK_SCALE,
    wrap01: wrap01,
    cycle01: cycle01,
    logoToUnit: logoToUnit,
    unitToLogo: unitToLogo,
    mulberry32: mulberry32,
    edgeFade: edgeFade,
    lifeEnvelope: lifeEnvelope,
    poseParticle: poseParticle,
  };
});
