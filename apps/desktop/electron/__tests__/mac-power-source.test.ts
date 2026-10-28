import { describe, expect, it } from "vitest";
import { parseMacPowerSource } from "../mac-power-source";

describe("pmset system battery snapshot", () => {
  it("supports a desktop without a battery and AC power with low charge", () => {
    expect(parseMacPowerSource("Now drawing from 'AC Power'\n"))
      .toEqual({ onBattery: false, percent: null });
    expect(parseMacPowerSource("Now drawing from 'AC Power'\n -InternalBattery-0 (id=123)\t3%; charging; 1:20 remaining present: true\n"))
      .toEqual({ onBattery: false, percent: null });
  });

  it.each([0, 9, 10, 100])("reads %s%% without interpreting the time remaining", percent => {
    expect(parseMacPowerSource(`Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123)\t${percent}%; discharging; 2:15 remaining present: true\n`))
      .toEqual({ onBattery: true, percent });
  });

  it("handles UPS power and conservatively uses the lowest system battery", () => {
    expect(parseMacPowerSource("Now drawing from 'UPS Power'\n -UPS (id=123)\t8%; discharging; (no estimate)\n"))
      .toEqual({ onBattery: true, percent: 8 });
    expect(parseMacPowerSource("Now drawing from 'Battery Power'\n -InternalBattery-0\t70%; discharging\n -InternalBattery-1\t9%; discharging\n"))
      .toEqual({ onBattery: true, percent: 9 });
  });

  it.each(["", "pmset failed", "Now drawing from 'Other Power'"])("rejects unrecognized power source %s", text => {
    expect(parseMacPowerSource(text)).toBeNull();
  });

  it.each(["(no estimate)", "101%;", "-1%;", "nan%;", "1.5%;", "9000%;"])("does not invent a charge from malformed output %s", charge => {
    expect(parseMacPowerSource(`Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123)\t${charge} discharging\n`))
      .toEqual({ onBattery: true, percent: null });
  });
});
