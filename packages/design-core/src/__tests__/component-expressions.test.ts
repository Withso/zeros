import { describe, expect, it } from "vitest";

import {
  COMPONENT_EXPRESSION_LIMITS,
  ComponentExpressionError,
  createComponentExpressionBudget,
  evaluateComponentExpression,
  parseComponentExpression,
  type ComponentExpressionValue,
} from "../component-expressions";

const scope = new Map<string, ComponentExpressionValue>([
  ["width", 1120],
  ["attachments", 2],
  ["mode", "plan"],
  ["toolbar", true],
  ["send-label", "Send"],
  ["density", "comfortable"],
]);
const run = (source: string, names = scope) =>
  evaluateComponentExpression(parseComponentExpression(source), names, createComponentExpressionBudget());
const refusal = (source: string, names = scope) => {
  try {
    run(source, names);
  } catch (error) {
    expect(error).toBeInstanceOf(ComponentExpressionError);
    return (error as Error).message;
  }
  throw new Error(`${source} evaluated`);
};

describe("component expressions", () => {
  it("covers holes, conditions, loops and derived values", () => {
    expect(run('"composer composer--" + mode')).toBe("composer composer--plan");
    expect(run("attachments > 0 && toolbar")).toBe(true);
    expect(run("range(attachments)")).toEqual([0, 1]);
    expect(run('["default", "secondary", "ghost"]')).toEqual(["default", "secondary", "ghost"]);
    expect(run("width >= 1200 ? 24 : 16")).toBe(16);
    expect(run("clamp(round(width / 40), 16, 32)")).toBe(28);
    expect(run('mode == "plan" ? "Plan" : "Ask"')).toBe("Plan");
    expect(run('send-label + " (" + attachments + ")"')).toBe("Send (2)");
    expect(run('density == "compact" ? 4 : density == "comfortable" ? 8 : 12')).toBe(8);
    expect(run("len(send-label) > 12 || !toolbar")).toBe(false);
    expect(run("min(width, 800) - max(1, 2) * 3 % 4")).toBe(798);
    expect(run("floor(2.7) + ceil(2.1) + -1")).toBe(4);
    expect(run("'single' + \"\\\"\"")).toBe('single"');
  });

  it("refuses wrong types instead of coercing them", () => {
    expect(refusal("mode + 1 > 2")).toMatch(/compare/);
    expect(refusal('toolbar + "x"')).toMatch(/true or false/);
    expect(refusal("toolbar && 1")).toMatch(/true or false/);
    expect(refusal("width ? 1 : 2")).toMatch(/true or false/);
    expect(refusal("-mode")).toMatch(/number/);
    expect(refusal("1 / 0")).toMatch(/zero/);
    expect(refusal("5 % 0")).toMatch(/zero/);
  });

  it("never reaches anything but the names it is given", () => {
    for (const source of ["window.alert(1)", "this", "globalThis", "constructor", "__proto__", "tostring", "a[0]", "f`x`", "x = 1", "import('x')", "eval('1')", "new Date()"]) {
      expect(() => run(source), source).toThrow(ComponentExpressionError);
    }
    expect(refusal("eval(1)")).toMatch(/Unknown function eval/);
    expect(refusal("missing")).toMatch(/Unknown name missing/);
  });

  it("says to put spaces around a minus written inside a name", () => {
    expect(refusal("width-1")).toBe('Unknown name width-1. To subtract, put spaces around the minus: "width - 1".');
    expect(run("width - 1")).toBe(1119);
  });

  it("stays within its limits", () => {
    expect(refusal("a".repeat(COMPONENT_EXPRESSION_LIMITS.length + 1))).toMatch(/at most 256 characters/);
    expect(refusal(Array.from({ length: 50 }, () => "1").join(" + "))).toMatch(/at most 96 parts/);
    expect(refusal(`${"(".repeat(17)}1${")".repeat(17)}`)).toMatch(/nest at most 16/);
    expect(refusal("range(257)")).toMatch(/whole number from 0 to 256/);
    expect(refusal("range(1.5)")).toMatch(/whole number/);
    const budget = createComponentExpressionBudget();
    const tree = parseComponentExpression("width + width + width + width");
    budget.steps = 3;
    expect(() => evaluateComponentExpression(tree, scope, budget)).toThrow(/too many steps/);
  });

  it("caps text it builds", () => {
    const long = new Map<string, ComponentExpressionValue>([["t", "x".repeat(2_000)]]);
    expect(refusal("t + t", long)).toMatch(/2,048 characters/);
  });

  it("refuses malformed expressions", () => {
    for (const source of ["", "1 +", "(1", "[1, 2", "1 ? 2", "min(1)", "max(1, 2, 3)", "1 2", "@"]) {
      expect(() => run(source), source).toThrow(ComponentExpressionError);
    }
  });
});
