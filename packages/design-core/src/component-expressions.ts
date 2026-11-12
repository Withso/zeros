// The expressions a component's template evaluates: holes, data-zd-if,
// data-zd-for and derived values. A small interpreter of our own, so a Design
// directory cloned from anywhere runs no code of its author's: there is no
// eval, no Function and no host object, and the only names are the option
// values, derived values and loop variables the caller passes in a Map.
// Every evaluation is bounded by length, parts, depth and steps.

export const COMPONENT_EXPRESSION_LIMITS = Object.freeze({
  /** Characters in one expression. */
  length: 256,
  /** Tokens in one expression. */
  tokens: 96,
  /** Nesting of parentheses, lists, calls and operators. */
  depth: 16,
  /** Nodes one evaluation may visit. */
  steps: 2_000,
  /** Items in a list, and the largest range(). */
  list: 256,
  /** Characters of text an expression may build. */
  text: 2_048,
});

export type ComponentExpressionScalar = number | string | boolean;
export type ComponentExpressionValue = ComponentExpressionScalar | readonly ComponentExpressionScalar[];

export class ComponentExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComponentExpressionError";
  }
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "text"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "name"; value: string }
  | { kind: "operator"; value: string };

export type ComponentExpression =
  | { kind: "literal"; value: ComponentExpressionScalar }
  | { kind: "name"; name: string }
  | { kind: "list"; items: ComponentExpression[] }
  | { kind: "call"; name: ComponentFunctionName; args: ComponentExpression[] }
  | { kind: "unary"; operator: "!" | "-"; arg: ComponentExpression }
  | { kind: "binary"; operator: string; left: ComponentExpression; right: ComponentExpression }
  | { kind: "conditional"; test: ComponentExpression; yes: ComponentExpression; no: ComponentExpression };

const fail = (message: string): never => {
  throw new ComponentExpressionError(message);
};

const describeValue = (value: ComponentExpressionValue): string =>
  Array.isArray(value) ? "a list" : typeof value === "string" ? "text" : typeof value === "boolean" ? "true or false" : "a number";
const asNumber = (value: ComponentExpressionValue): number =>
  typeof value === "number" ? value : fail(`Expected a number, got ${describeValue(value)}.`);
const asBoolean = (value: ComponentExpressionValue): boolean =>
  typeof value === "boolean" ? value : fail(`Expected true or false, got ${describeValue(value)}.`);
const finite = (value: number): number => (Number.isFinite(value) ? value : fail("The result is not a finite number."));
const wholeNumber = (value: ComponentExpressionValue, max: number): number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max
    ? (value as number)
    : fail(`Expected a whole number from 0 to ${max}, got ${typeof value === "number" ? value : describeValue(value)}.`);

const FUNCTIONS = {
  range: { arity: 1, run: (n: ComponentExpressionValue) => Array.from({ length: wholeNumber(n, COMPONENT_EXPRESSION_LIMITS.list) }, (_, index) => index) },
  min: { arity: 2, run: (a: ComponentExpressionValue, b: ComponentExpressionValue) => Math.min(asNumber(a), asNumber(b)) },
  max: { arity: 2, run: (a: ComponentExpressionValue, b: ComponentExpressionValue) => Math.max(asNumber(a), asNumber(b)) },
  clamp: {
    arity: 3,
    run: (value: ComponentExpressionValue, low: ComponentExpressionValue, high: ComponentExpressionValue) =>
      Math.min(Math.max(asNumber(value), asNumber(low)), asNumber(high)),
  },
  round: { arity: 1, run: (value: ComponentExpressionValue) => Math.round(asNumber(value)) },
  floor: { arity: 1, run: (value: ComponentExpressionValue) => Math.floor(asNumber(value)) },
  ceil: { arity: 1, run: (value: ComponentExpressionValue) => Math.ceil(asNumber(value)) },
  len: {
    arity: 1,
    run: (value: ComponentExpressionValue) =>
      typeof value === "string" || Array.isArray(value) ? value.length : fail(`len() takes text or a list, got ${describeValue(value)}.`),
  },
} as const;
export type ComponentFunctionName = keyof typeof FUNCTIONS;
const FUNCTION_NAMES = new Set<string>(Object.keys(FUNCTIONS));

/** Names an option, derived value or loop variable may not take. */
export const COMPONENT_EXPRESSION_RESERVED_NAMES: ReadonlySet<string> = new Set([
  "true", "false", "in", ...FUNCTION_NAMES,
  // Names an object carries in JavaScript. Scopes are Maps, so they could not
  // reach one, but refusing them keeps every declared name plainly data.
  "constructor", "prototype", "tostring", "tolocalestring", "valueof", "hasownproperty", "isprototypeof", "propertyisenumerable",
]);

// One pattern written here, never built from authored text: numbers,
// lowercase names with hyphens, and the operators of the grammar. Quoted text
// and the space between tokens are read a character at a time, so no input
// can make the tokenizer do more than one pass.
const TOKEN = /(\d+(?:\.\d+)?)|([a-z][a-z0-9-]*)|(==|!=|<=|>=|&&|\|\||[-+*/%<>!?:(),[\]])/y;
const isSpace = (character: string) =>
  character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f" || character === "\v";

function tokenize(source: string): Token[] {
  if (source.length > COMPONENT_EXPRESSION_LIMITS.length)
    fail(`An expression may be at most ${COMPONENT_EXPRESSION_LIMITS.length} characters.`);
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const first = source[index]!;
    if (isSpace(first)) {
      index += 1;
      continue;
    }
    if (first === '"' || first === "'") {
      let text = "";
      let at = index + 1;
      let closed = false;
      while (at < source.length) {
        const character = source[at]!;
        if (character === "\\" && at + 1 < source.length) {
          text += source[at + 1]!;
          at += 2;
        } else if (character === first) {
          closed = true;
          at += 1;
          break;
        } else {
          text += character;
          at += 1;
        }
      }
      if (!closed) fail(`Unexpected "${first}" in the expression.`);
      tokens.push({ kind: "text", value: text });
      index = at;
    } else {
      TOKEN.lastIndex = index;
      const match = TOKEN.exec(source);
      if (!match) fail(`Unexpected "${first}" in the expression.`);
      index = TOKEN.lastIndex;
      const [, number, name, operator] = match!;
      if (number !== undefined) tokens.push({ kind: "number", value: Number(number) });
      else if (name === "true" || name === "false") tokens.push({ kind: "boolean", value: name === "true" });
      else if (name !== undefined) tokens.push({ kind: "name", value: name });
      else tokens.push({ kind: "operator", value: operator! });
    }
    if (tokens.length > COMPONENT_EXPRESSION_LIMITS.tokens)
      fail(`An expression may have at most ${COMPONENT_EXPRESSION_LIMITS.tokens} parts.`);
  }
  if (tokens.length === 0) fail("The expression is empty.");
  return tokens;
}

const BINARY_LEVELS: readonly (readonly string[])[] = [["||"], ["&&"], ["==", "!="], ["<", "<=", ">", ">="], ["+", "-"], ["*", "/", "%"]];

/** Parse once; evaluate as often as values change. */
export function parseComponentExpression(source: string): ComponentExpression {
  const tokens = tokenize(source);
  let position = 0;
  let depth = 0;
  const isOperator = (value: string) => {
    const token = tokens[position];
    return token?.kind === "operator" && token.value === value;
  };
  const expect = (value: string) => {
    if (!isOperator(value)) fail(`Expected "${value}" in the expression.`);
    position += 1;
  };
  const nested = <T>(parse: () => T): T => {
    if (++depth > COMPONENT_EXPRESSION_LIMITS.depth) fail(`An expression may nest at most ${COMPONENT_EXPRESSION_LIMITS.depth} deep.`);
    try {
      return parse();
    } finally {
      depth -= 1;
    }
  };
  const list = (close: string): ComponentExpression[] => {
    const items: ComponentExpression[] = [];
    if (!isOperator(close)) {
      do items.push(expression());
      while (isOperator(",") && ++position);
    }
    expect(close);
    return items;
  };
  const primary = (): ComponentExpression =>
    nested(() => {
      const token = tokens[position++];
      if (!token) return fail("The expression ends too early.");
      if (token.kind === "number" || token.kind === "text" || token.kind === "boolean") return { kind: "literal", value: token.value };
      if (token.kind === "name") {
        if (!isOperator("(")) return { kind: "name", name: token.value };
        if (!FUNCTION_NAMES.has(token.value)) return fail(`Unknown function ${token.value}().`);
        const name = token.value as ComponentFunctionName;
        position += 1;
        const args = list(")");
        if (args.length !== FUNCTIONS[name].arity) fail(`${name}() takes ${FUNCTIONS[name].arity} ${FUNCTIONS[name].arity === 1 ? "value" : "values"}.`);
        return { kind: "call", name, args };
      }
      if (token.value === "(") {
        const inner = expression();
        expect(")");
        return inner;
      }
      if (token.value === "[") return { kind: "list", items: list("]") };
      if (token.value === "!" || token.value === "-") return { kind: "unary", operator: token.value, arg: primary() };
      return fail(`Unexpected "${token.value}" in the expression.`);
    });
  const binary = (level: number): ComponentExpression => {
    if (level === BINARY_LEVELS.length) return primary();
    let left = binary(level + 1);
    while (BINARY_LEVELS[level]!.some(isOperator)) {
      const operator = (tokens[position++] as { value: string }).value;
      left = nested(() => ({ kind: "binary", operator, left, right: binary(level + 1) }));
    }
    return left;
  };
  const expression = (): ComponentExpression =>
    nested(() => {
      const test = binary(0);
      if (!isOperator("?")) return test;
      position += 1;
      const yes = expression();
      expect(":");
      return { kind: "conditional", test, yes, no: expression() };
    });
  const tree = expression();
  if (position < tokens.length) {
    const token = tokens[position]!;
    fail(`Unexpected ${token.kind === "operator" ? `"${token.value}"` : JSON.stringify(token.value)} in the expression.`);
  }
  return tree;
}

/** The steps an evaluation may still take; a caller may share one budget
 * across evaluations to bound a whole expansion. */
export interface ComponentExpressionBudget {
  steps: number;
}

export function createComponentExpressionBudget(steps: number = COMPONENT_EXPRESSION_LIMITS.steps): ComponentExpressionBudget {
  return { steps };
}

const joinable = (value: ComponentExpressionValue): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : fail(`Cannot join ${describeValue(value)} to text.`);

function compare(operator: string, left: ComponentExpressionValue, right: ComponentExpressionValue): boolean {
  if (typeof left !== typeof right || (typeof left !== "number" && typeof left !== "string") || Array.isArray(left))
    fail(`Cannot compare ${describeValue(left)} with ${describeValue(right)}.`);
  const a = left as number | string;
  const b = right as number | string;
  return operator === "<" ? a < b : operator === "<=" ? a <= b : operator === ">" ? a > b : a >= b;
}

function equal(left: ComponentExpressionValue, right: ComponentExpressionValue): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => item === right[index]);
  }
  return left === right;
}

export function evaluateComponentExpression(
  tree: ComponentExpression,
  scope: ReadonlyMap<string, ComponentExpressionValue>,
  budget: ComponentExpressionBudget = createComponentExpressionBudget(),
): ComponentExpressionValue {
  const run = (node: ComponentExpression): ComponentExpressionValue => {
    if (--budget.steps < 0) fail("The expression took too many steps.");
    switch (node.kind) {
      case "literal":
        return node.value;
      case "name": {
        const value = scope.get(node.name);
        if (value !== undefined) return value;
        return fail(
          node.name.includes("-") && /-\d/.test(node.name)
            ? `Unknown name ${node.name}. To subtract, put spaces around the minus: "${node.name.replace(/-(?=\d)/, " - ")}".`
            : `Unknown name ${node.name}.`,
        );
      }
      case "list": {
        if (node.items.length > COMPONENT_EXPRESSION_LIMITS.list) fail(`A list may hold at most ${COMPONENT_EXPRESSION_LIMITS.list} values.`);
        return node.items.map((item) => {
          const value = run(item);
          return Array.isArray(value) ? fail("A list may not hold another list.") : (value as ComponentExpressionScalar);
        });
      }
      case "call": {
        const fn = FUNCTIONS[node.name] as { run: (...args: ComponentExpressionValue[]) => ComponentExpressionValue };
        const result = fn.run(...node.args.map(run));
        return typeof result === "number" ? finite(result) : result;
      }
      case "unary":
        return node.operator === "!" ? !asBoolean(run(node.arg)) : finite(-asNumber(run(node.arg)));
      case "conditional":
        return asBoolean(run(node.test)) ? run(node.yes) : run(node.no);
      case "binary": {
        if (node.operator === "&&") return asBoolean(run(node.left)) && asBoolean(run(node.right));
        if (node.operator === "||") return asBoolean(run(node.left)) || asBoolean(run(node.right));
        const left = run(node.left);
        const right = run(node.right);
        switch (node.operator) {
          case "==":
            return equal(left, right);
          case "!=":
            return !equal(left, right);
          case "+": {
            if (typeof left === "string" || typeof right === "string") {
              const text = joinable(left) + joinable(right);
              return text.length <= COMPONENT_EXPRESSION_LIMITS.text
                ? text
                : fail(`Text may be at most ${COMPONENT_EXPRESSION_LIMITS.text.toLocaleString("en-US")} characters.`);
            }
            return finite(asNumber(left) + asNumber(right));
          }
          case "-":
            return finite(asNumber(left) - asNumber(right));
          case "*":
            return finite(asNumber(left) * asNumber(right));
          case "/":
            return asNumber(right) === 0 ? fail("Division by zero.") : finite(asNumber(left) / (right as number));
          case "%":
            return asNumber(right) === 0 ? fail("Division by zero.") : finite(asNumber(left) % (right as number));
          default:
            return compare(node.operator, left, right);
        }
      }
    }
  };
  return run(tree);
}

/** Every name an expression reads (not function names). */
export function componentExpressionNames(tree: ComponentExpression, into: Set<string> = new Set()): Set<string> {
  switch (tree.kind) {
    case "name":
      into.add(tree.name);
      break;
    case "list":
      tree.items.forEach((item) => componentExpressionNames(item, into));
      break;
    case "call":
      tree.args.forEach((arg) => componentExpressionNames(arg, into));
      break;
    case "unary":
      componentExpressionNames(tree.arg, into);
      break;
    case "binary":
      componentExpressionNames(tree.left, into);
      componentExpressionNames(tree.right, into);
      break;
    case "conditional":
      componentExpressionNames(tree.test, into);
      componentExpressionNames(tree.yes, into);
      componentExpressionNames(tree.no, into);
      break;
    default:
      break;
  }
  return into;
}
