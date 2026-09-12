// Periodic poses for the live Zeros mark field.
// Integer revolutions and births per loop keep t = 0 and t = LOOP_SEC identical.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ZerosLogoFieldModel = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var LOOP_SEC = 10;
  var FRAME_REVS = 1;
  var SHAPE_REVS = 1;
  // Short one-way drift during a rim life. Envelope speed is births, not this.
  var LIFE_ARC = 0.3;

  // Official mark paths, viewBox 0 0 128 128. Order: TL circle, BR circle,
  // BL kidney, TR kidney.
  var LOGO_PATHS = [
    "M62.349 29.2203C62.349 39.8354 53.8386 48.4407 43.3405 48.4407C32.8424 48.4407 24.332 39.8354 24.332 29.2203C24.332 18.6052 32.8424 10 43.3405 10C53.8386 10 62.349 18.6052 62.349 29.2203Z",
    "M67.78 98.7797C67.78 109.395 76.2904 118 86.7885 118C97.2866 118 105.797 109.395 105.797 98.7797C105.797 88.1646 97.2866 79.5593 86.7885 79.5593C76.2904 79.5593 67.78 88.1646 67.78 98.7797Z",
    "M24.332 70.4068C28.77 61.4319 37.9427 55.7627 47.8663 55.7627C55.0025 55.7627 59.8098 65.0843 58.0282 72.0715C56.312 78.8024 55.9589 87.1165 59.6335 96.0339C63.9396 106.484 56.3466 118 45.1508 118H41.5361C35.3331 118 29.5092 114.817 26.4869 109.339C25.3671 107.31 24.2662 105.202 23.4268 103.356C23.0519 102.531 22.6594 101.584 22.2614 100.565C18.4418 90.7796 19.6794 79.8158 24.332 70.4068Z",
    "M102.156 24.2292C97.6668 15.9522 89.2616 10.6133 79.9387 10.1172C78.4733 10.0392 77.0039 10.0823 75.5454 10.2462L74.3441 10.3812C69.0388 10.9772 66.1362 18.0033 68.0898 23.0263C70.7538 29.8759 72.2593 39.4012 67.78 50.2712C63.474 60.7209 71.067 72.2373 82.2627 72.2373H85.0478C92.1313 72.2373 98.52 67.9307 101.244 61.3192L104.634 53.0947C108.229 44.3685 107.706 34.4624 103.210 26.1735L102.156 24.2292Z",
  ];

  var FRAME_SIZE = 1080;
  // Same logo pixel size as the previous 720 frame at scale 0.82.
  var MARK_SCALE = 0.82 * (720 / FRAME_SIZE);

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

  // One particle loop: scale and opacity 0 → 1 → 0. Peak at mid-life, no hold.
  function lifeEnvelope(u) {
    u = wrap01(u);
    var t = u < 0.5 ? u / 0.5 : (1 - u) / 0.5;
    return t * t * (3 - 2 * t);
  }

  function poseParticle(particle, cycle) {
    var u = wrap01(cycle);
    var revs = particle.revs != null ? particle.revs : FRAME_REVS;
    var births = particle.births || 0;
    var lifeU = births > 0 ? wrap01(u * births + (particle.birthPhase || 0)) : u;
    var life = births > 0 ? lifeEnvelope(lifeU) : 1;
    var arc = particle.arc != null ? particle.arc : LIFE_ARC;
    var depth = (u * (particle.revsZ || revs) + (particle.phaseZ || 0)) * Math.PI * 2;
    var wobble = (u * (particle.revsW || 1) + (particle.phaseW || 0)) * Math.PI * 2;
    var x;
    var y;
    var z;
    var vx;
    var vy;
    var ndot = 1;
    if (particle.orbit === "globe") {
      var gx = particle.cx != null ? particle.cx : 0.5;
      var gdx = particle.x - gx;
      var gz0 = particle.z0 != null ? particle.z0 : 0;
      var gtheta = u * revs * Math.PI * 2;
      var gct = Math.cos(gtheta);
      var gst = Math.sin(gtheta);
      x = gx + gdx * gct + gz0 * gst;
      z = -gdx * gst + gz0 * gct;
      y = particle.y + (particle.oy || 0) * Math.cos(wobble);
      var gr = Math.hypot(gdx, gz0);
      ndot = gr < 1e-6 ? 0 : z / gr;
      vx = (-gdx * gst + gz0 * gct) * revs * Math.PI * 2;
      vy = 0;
    } else if (particle.orbit === "shape") {
      var local =
        births > 0
          ? (particle.phase || 0) * Math.PI * 2 + lifeU * arc
          : (u * revs + (particle.phase || 0)) * Math.PI * 2;
      x =
        particle.x +
        (particle.rx || 0) * Math.cos(local) +
        (particle.ox || 0) * Math.sin(wobble);
      y =
        particle.y +
        (particle.ry || 0) * Math.sin(local + (particle.skew || 0)) +
        (particle.oy || 0) * Math.cos(wobble);
      z = Math.sin(depth);
      vx = -(particle.rx || 0) * Math.sin(local);
      vy = (particle.ry || 0) * Math.cos(local + (particle.skew || 0));
      ndot = z;
    } else if (particle.contain) {
      var axis = particle.cx != null ? particle.cx : 0.5;
      var dx = particle.x - axis;
      var z0 = particle.z0 != null ? particle.z0 : 0;
      var r = Math.hypot(dx, z0);
      var rMax =
        particle.xLo != null && particle.xHi != null
          ? (particle.xHi - particle.xLo) / 2
          : r;
      if (r > rMax) r = rMax;
      var a0 = Math.atan2(z0, dx);
      var spin = u * revs * Math.PI * 2;
      var a = a0 - spin;
      if (r < 1e-6) {
        x = axis;
        z = 0;
        ndot = 0;
        vx = 0;
      } else {
        x = axis + r * Math.cos(a);
        z = r * Math.sin(a);
        ndot = z / r;
        vx = r * Math.sin(a) * revs * Math.PI * 2;
      }
      if (particle.xLo != null && particle.xHi != null) {
        if (x < particle.xLo) x = particle.xLo;
        if (x > particle.xHi) x = particle.xHi;
      }
      y = particle.y + (particle.oy || 0) * Math.cos(wobble);
      vy = 0;
    } else {
      var mx = particle.cx != null ? particle.cx : 0.5;
      var mdx = particle.x - mx;
      var mz0 = particle.z0 != null ? particle.z0 : 0;
      var theta = u * revs * Math.PI * 2;
      var ct = Math.cos(theta);
      var st = Math.sin(theta);
      x = mx + mdx * ct + mz0 * st;
      z = -mdx * st + mz0 * ct;
      y = particle.y + (particle.oy || 0) * Math.cos(wobble);
      var mr = Math.hypot(mdx, mz0);
      ndot = mr < 1e-6 ? 0 : z / mr;
      vx = (-mdx * st + mz0 * ct) * revs * Math.PI * 2;
      vy = 0;
    }
    var fieldLayer =
      particle.layer === "field" || particle.layer === "surround";
    var hiddenBack = fieldLayer && ndot < 0;
    var env = hiddenBack ? 0 : life;
    var pulseRevs = particle.pulseRevs || 2;
    var pulse =
      0.9 + 0.1 * Math.sin((u * pulseRevs + (particle.phase || 0)) * Math.PI * 2);
    var scale = particle.size * env;
    var alpha = particle.alpha * env * edgeFade(x, y);
    if (particle.orbit === "globe") {
      var face = 0.42 + 0.58 * (0.5 + 0.5 * ndot);
      scale *= 0.72 + 0.28 * Math.max(0.2, face);
      alpha *= face;
    }
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
      ndot: ndot,
    };
  }

  return {
    LOOP_SEC: LOOP_SEC,
    FRAME_REVS: FRAME_REVS,
    SHAPE_REVS: SHAPE_REVS,
    LIFE_ARC: LIFE_ARC,
    LOGO_PATHS: LOGO_PATHS,
    FRAME_SIZE: FRAME_SIZE,
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
