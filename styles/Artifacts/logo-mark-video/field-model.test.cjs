const test = require("node:test");
const assert = require("node:assert/strict");
const Model = require("./field-model.js");

function dummyParticle() {
  return {
    x: 0.41,
    y: 0.28,
    rx: 0.02,
    ry: 0.015,
    ox: 0.004,
    oy: -0.003,
    revs: 4,
    revsZ: 4,
    revsW: 1,
    phase: 0.37,
    phaseZ: 0.11,
    phaseW: 0.9,
    skew: 0.2,
    size: 12,
    alpha: 0.8,
    births: 4,
    birthPhase: 0.37,
    pulseRevs: 2,
  };
}

test("pose at t=0 equals pose at t=LOOP_SEC", () => {
  const particle = dummyParticle();
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

test("life envelope is 0 at birth and death and peaks mid-life", () => {
  assert.equal(Model.lifeEnvelope(0), 0);
  assert.equal(Model.lifeEnvelope(1), 0);
  assert.ok(Model.lifeEnvelope(0.08) > 0);
  assert.ok(Model.lifeEnvelope(0.08) < 1);
  assert.equal(Model.lifeEnvelope(0.4), 1);
  assert.ok(Model.lifeEnvelope(0.9) > 0);
  assert.ok(Model.lifeEnvelope(0.9) < 0.4);
});

test("integer births keep the envelope periodic across the loop", () => {
  const particle = dummyParticle();
  particle.births = 3;
  particle.birthPhase = 0;
  const a = Model.poseParticle(particle, 0);
  const b = Model.poseParticle(particle, 1);
  assert.equal(a.env, 0);
  assert.equal(b.env, 0);
  assert.equal(a.scale, b.scale);
});
