const test = require("node:test");
const assert = require("node:assert/strict");
const Model = require("./field-model.js");

function dummyParticle() {
  return {
    x: 0.41,
    y: 0.28,
    cx: 0.5,
    cy: 0.5,
    ox: 0.004,
    oy: -0.003,
    revs: 2,
    revsZ: 2,
    revsW: 1,
    phase: 0.37,
    phaseZ: 0.11,
    phaseW: 0.9,
    z0: 0,
    size: 12,
    alpha: 0.8,
    births: 4,
    birthPhase: 0.37,
    pulseRevs: 2,
  };
}

test("pose at t=0 equals pose at t=LOOP_SEC", () => {
  const particle = dummyParticle();
  particle.orbit = "shape";
  const a = Model.poseParticle(particle, Model.cycle01(0));
  const b = Model.poseParticle(particle, Model.cycle01(Model.LOOP_SEC));
  assert.equal(a.x, b.x);
  assert.equal(a.y, b.y);
  assert.equal(a.z, b.z);
  assert.equal(a.scale, b.scale);
  assert.equal(a.alpha, b.alpha);
  assert.equal(a.env, b.env);
  assert.equal(a.pulse, b.pulse);
});

test("edge fade is 1 in the interior and 0 at the frame edge", () => {
  assert.equal(Model.edgeFade(0.5, 0.5), 1);
  assert.equal(Model.edgeFade(0, 0.5), 0);
  assert.ok(Model.edgeFade(0.04, 0.5) > 0);
  assert.ok(Model.edgeFade(0.04, 0.5) < 1);
});

test("logo unit mapping is invertible at the mark center", () => {
  const unit = Model.logoToUnit(64, 64);
  const back = Model.unitToLogo(unit.x, unit.y);
  assert.ok(Math.abs(back.x - 64) < 1e-9);
  assert.ok(Math.abs(back.y - 64) < 1e-9);
});

test("1080 frame keeps the previous 720-frame logo pixel size", () => {
  assert.equal(Model.FRAME_SIZE, 1080);
  assert.ok(Math.abs(Model.MARK_SCALE * Model.FRAME_SIZE - 0.82 * 720) < 1e-9);
});

test("life envelope is 0 at birth and death and peaks mid-life", () => {
  assert.equal(Model.lifeEnvelope(0), 0);
  assert.equal(Model.lifeEnvelope(1), 0);
  assert.ok(Model.lifeEnvelope(0.08) > 0);
  assert.ok(Model.lifeEnvelope(0.08) < 1);
  assert.equal(Model.lifeEnvelope(0.5), 1);
  assert.ok(Model.lifeEnvelope(0.25) > 0.4);
  assert.ok(Model.lifeEnvelope(0.25) < 1);
  assert.ok(Math.abs(Model.lifeEnvelope(0.25) - Model.lifeEnvelope(0.75)) < 1e-9);
  assert.ok(Model.lifeEnvelope(0.9) > 0);
  assert.ok(Model.lifeEnvelope(0.9) < 0.4);
});

test("poses move continuously across a 60fps step", () => {
  const particle = dummyParticle();
  particle.orbit = "shape";
  particle.revs = 2;
  particle.revsZ = 2;
  particle.births = 1;
  const a = Model.poseParticle(particle, 0.41);
  const b = Model.poseParticle(particle, 0.41 + 1 / 60 / Model.LOOP_SEC);
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(dist > 0);
  assert.ok(dist < 0.01);
  assert.ok(Math.abs(a.scale - b.scale) < 0.35);
  assert.ok(Math.abs(a.alpha - b.alpha) < 0.05);
});

test("scale and opacity follow the same 0-1-0 life envelope", () => {
  const particle = dummyParticle();
  particle.orbit = "shape";
  particle.ox = 0;
  particle.oy = 0;
  particle.rx = 0;
  particle.ry = 0;
  particle.births = 1;
  particle.birthPhase = 0;
  const born = Model.poseParticle(particle, 0);
  const mid = Model.poseParticle(particle, 0.5);
  const dead = Model.poseParticle(particle, 1);
  assert.equal(born.env, 0);
  assert.equal(dead.env, 0);
  assert.equal(born.scale, 0);
  assert.equal(dead.scale, 0);
  assert.equal(born.alpha, 0);
  assert.equal(dead.alpha, 0);
  assert.equal(mid.env, 1);
  assert.ok(Math.abs(mid.scale - particle.size) < 1e-9);
  assert.ok(Math.abs(mid.alpha - particle.alpha) < 1e-9);
});

test("contained particles stay inside the blob occupancy", () => {
  const particle = dummyParticle();
  particle.contain = true;
  particle.x = 0.38;
  particle.y = 0.26;
  particle.cx = 0.34;
  particle.z0 = 0.06;
  particle.xLo = 0.26;
  particle.xHi = 0.42;
  particle.oy = 0;
  particle.revs = 0.8;
  particle.births = 0;
  [0, 0.2, 0.5, 0.8].forEach((cycle) => {
    const pose = Model.poseParticle(particle, cycle);
    assert.ok(pose.x >= 0.26 - 1e-9);
    assert.ok(pose.x <= 0.42 + 1e-9);
    assert.ok(Math.abs(pose.y - 0.26) < 1e-9);
    assert.ok(pose.x < 0.5);
  });
});

test("contained front particles travel left to right", () => {
  const particle = dummyParticle();
  particle.contain = true;
  particle.x = 0.38;
  particle.y = 0.26;
  particle.cx = 0.34;
  particle.z0 = 0.08;
  particle.xLo = 0.22;
  particle.xHi = 0.46;
  particle.oy = 0;
  particle.revs = 1;
  particle.births = 0;
  const early = Model.poseParticle(particle, 0.02);
  const late = Model.poseParticle(particle, 0.08);
  assert.ok(late.x > early.x);
});

test("edge particles keep a local orbit on the shape", () => {
  const particle = dummyParticle();
  particle.orbit = "shape";
  particle.x = 0.3;
  particle.y = 0.25;
  particle.rx = 0.02;
  particle.ry = 0;
  particle.ox = 0;
  particle.oy = 0;
  particle.phase = 0;
  particle.revs = 1;
  particle.revsZ = 1;
  particle.births = 0;
  const a = Model.poseParticle(particle, 0);
  const b = Model.poseParticle(particle, 0.25);
  assert.ok(Math.abs(a.x - 0.32) < 1e-9);
  assert.ok(Math.abs(a.y - 0.25) < 1e-9);
  assert.ok(Math.abs(b.x - 0.3) < 1e-9);
  assert.ok(Math.abs(b.y - 0.25) < 1e-9);
});

test("contained particles at different speeds are not a rigid blob spin", () => {
  const a = dummyParticle();
  a.contain = true;
  a.x = 0.38;
  a.y = 0.26;
  a.cx = 0.34;
  a.z0 = 0.06;
  a.xLo = 0.26;
  a.xHi = 0.42;
  a.oy = 0;
  a.revs = 0.5;
  a.births = 0;
  const b = Object.assign({}, a, { revs: 1.1, x: 0.36, z0: 0.05 });
  const a0 = Model.poseParticle(a, 0);
  const b0 = Model.poseParticle(b, 0);
  const a1 = Model.poseParticle(a, 0.2);
  const b1 = Model.poseParticle(b, 0.2);
  const rest = Math.hypot(a0.x - b0.x, a0.z - b0.z);
  const later = Math.hypot(a1.x - b1.x, a1.z - b1.z);
  assert.ok(Math.abs(later - rest) > 0.002);
});

test("integer births keep the envelope periodic across the loop", () => {
  const particle = dummyParticle();
  particle.orbit = "shape";
  particle.births = 3;
  particle.birthPhase = 0;
  const a = Model.poseParticle(particle, 0);
  const b = Model.poseParticle(particle, 1);
  assert.equal(a.env, 0);
  assert.equal(b.env, 0);
  assert.equal(a.scale, b.scale);
});

test("back of the surround orbit stays hidden", () => {
  const particle = dummyParticle();
  particle.layer = "surround";
  particle.x = 0.7;
  particle.y = 0.5;
  particle.z0 = 0;
  particle.oy = 0;
  particle.revs = 1;
  particle.births = 0;
  const front = Model.poseParticle(particle, 0.75);
  const back = Model.poseParticle(particle, 0.25);
  assert.equal(front.env, 1);
  assert.equal(back.env, 0);
  assert.equal(back.scale, 0);
  assert.equal(back.alpha, 0);
});

test("circle globe keeps latitude and orbit radius around its own axis", () => {
  const particle = dummyParticle();
  particle.orbit = "globe";
  particle.x = 0.4;
  particle.y = 0.28;
  particle.cx = 0.34;
  particle.z0 = 0.08;
  particle.oy = 0;
  particle.revs = 1;
  particle.births = 0;
  const r = Math.hypot(0.06, 0.08);
  const a = Model.poseParticle(particle, 0);
  const b = Model.poseParticle(particle, 0.25);
  assert.ok(Math.abs(a.y - 0.28) < 1e-9);
  assert.ok(Math.abs(b.y - 0.28) < 1e-9);
  assert.ok(Math.abs(Math.hypot(a.x - 0.34, a.z) - r) < 1e-9);
  assert.ok(Math.abs(Math.hypot(b.x - 0.34, b.z) - r) < 1e-9);
});

test("circle globe front travels left to right", () => {
  const particle = dummyParticle();
  particle.orbit = "globe";
  particle.x = 0.4;
  particle.y = 0.28;
  particle.cx = 0.34;
  particle.z0 = 0.1;
  particle.oy = 0;
  particle.revs = 1;
  particle.births = 0;
  const early = Model.poseParticle(particle, 0.02);
  const late = Model.poseParticle(particle, 0.08);
  assert.ok(late.x > early.x);
});

test("circle globe equator travels farther than a pole", () => {
  const equator = dummyParticle();
  equator.orbit = "globe";
  equator.x = 0.46;
  equator.y = 0.28;
  equator.cx = 0.34;
  equator.z0 = 0;
  equator.oy = 0;
  equator.revs = 1;
  equator.births = 0;
  const pole = dummyParticle();
  pole.orbit = "globe";
  pole.x = 0.35;
  pole.y = 0.4;
  pole.cx = 0.34;
  pole.z0 = 0;
  pole.oy = 0;
  pole.revs = 1;
  pole.births = 0;
  const eq0 = Model.poseParticle(equator, 0);
  const eq1 = Model.poseParticle(equator, 0.08);
  const p0 = Model.poseParticle(pole, 0);
  const p1 = Model.poseParticle(pole, 0.08);
  assert.ok(Math.abs(eq1.x - eq0.x) > Math.abs(p1.x - p0.x));
});

test("circle globe does not orbit the frame center", () => {
  const particle = dummyParticle();
  particle.orbit = "globe";
  particle.x = 0.4;
  particle.y = 0.28;
  particle.cx = 0.34;
  particle.z0 = 0.08;
  particle.oy = 0;
  particle.revs = 1;
  particle.births = 0;
  const a = Model.poseParticle(particle, 0);
  const b = Model.poseParticle(particle, 0.25);
  assert.ok(Math.abs(Math.hypot(a.x - 0.34, a.z) - Math.hypot(b.x - 0.34, b.z)) < 1e-9);
  assert.ok(Math.abs(Math.hypot(a.x - 0.5, a.z) - Math.hypot(b.x - 0.5, b.z)) > 0.02);
});

test("circle globe back stays visible but dimmer than the front", () => {
  const particle = dummyParticle();
  particle.orbit = "globe";
  particle.x = 0.34;
  particle.y = 0.28;
  particle.cx = 0.34;
  particle.z0 = 0.1;
  particle.oy = 0;
  particle.revs = 1;
  particle.births = 0;
  const front = Model.poseParticle(particle, 0);
  const back = Model.poseParticle(particle, 0.5);
  assert.ok(front.env > 0);
  assert.ok(back.env > 0);
  assert.ok(back.alpha < front.alpha);
  assert.ok(back.scale < front.scale);
});
