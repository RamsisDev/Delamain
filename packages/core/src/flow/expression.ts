/**
 * Small, side-effect free expression language for `when` and `until`:
 *   tests.passed and not bugbot.needs_qa
 *   loop.first or bugbot.needs_qa
 *   tests.exit_code == 0
 * Identifiers may contain '-' (block ids such as final-checks), so there is no arithmetic.
 */

export type Expr =
  | { kind: "literal"; value: unknown }
  | { kind: "path"; path: string[] }
  | { kind: "not"; operand: Expr }
  | { kind: "and" | "or"; left: Expr; right: Expr }
  | { kind: "compare"; op: CompareOp; left: Expr; right: Expr };

type CompareOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

type Token =
  | { type: "ident"; value: string; pos: number }
  | { type: "number"; value: number; pos: number }
  | { type: "string"; value: string; pos: number }
  | { type: "op"; value: string; pos: number }
  | { type: "eof"; pos: number };

export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_\-.]/.test(source[i]!)) i++;
      let value = source.slice(start, i);
      while (value.endsWith(".") || value.endsWith("-")) {
        value = value.slice(0, -1);
        i--;
      }
      tokens.push({ type: "ident", value, pos: start });
      continue;
    }
    if (/[0-9]/.test(char)) {
      const start = i;
      while (i < source.length && /[0-9.]/.test(source[i]!)) i++;
      tokens.push({ type: "number", value: Number(source.slice(start, i)), pos: start });
      continue;
    }
    if (char === '"' || char === "'") {
      const start = i;
      i++;
      let value = "";
      while (i < source.length && source[i] !== char) {
        if (source[i] === "\\" && i + 1 < source.length) i++;
        value += source[i];
        i++;
      }
      if (i >= source.length) throw new ExpressionError("Unterminated string", start);
      i++;
      tokens.push({ type: "string", value, pos: start });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
      tokens.push({ type: "op", value: two, pos: i });
      i += 2;
      continue;
    }
    if ("()<>!".includes(char)) {
      tokens.push({ type: "op", value: char, pos: i });
      i++;
      continue;
    }
    throw new ExpressionError(`Unexpected character "${char}"`, i);
  }
  tokens.push({ type: "eof", pos: source.length });
  return tokens;
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Expr {
    const expr = this.or();
    const token = this.peek();
    if (token.type !== "eof") throw new ExpressionError("Unexpected token", token.pos);
    return expr;
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private next(): Token {
    return this.tokens[this.index++]!;
  }

  private isWord(word: string): boolean {
    const token = this.peek();
    return token.type === "ident" && token.value === word;
  }

  private isOp(op: string): boolean {
    const token = this.peek();
    return token.type === "op" && token.value === op;
  }

  private or(): Expr {
    let left = this.and();
    while (this.isWord("or") || this.isOp("||")) {
      this.next();
      left = { kind: "or", left, right: this.and() };
    }
    return left;
  }

  private and(): Expr {
    let left = this.not();
    while (this.isWord("and") || this.isOp("&&")) {
      this.next();
      left = { kind: "and", left, right: this.not() };
    }
    return left;
  }

  private not(): Expr {
    if (this.isWord("not") || this.isOp("!")) {
      this.next();
      return { kind: "not", operand: this.not() };
    }
    return this.compare();
  }

  private compare(): Expr {
    const left = this.primary();
    const token = this.peek();
    if (token.type === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(token.value)) {
      this.next();
      return { kind: "compare", op: token.value as CompareOp, left, right: this.primary() };
    }
    return left;
  }

  private primary(): Expr {
    const token = this.next();
    if (token.type === "op" && token.value === "(") {
      const expr = this.or();
      const close = this.next();
      if (close.type !== "op" || close.value !== ")") throw new ExpressionError("Expected )", close.pos);
      return expr;
    }
    if (token.type === "number" || token.type === "string") return { kind: "literal", value: token.value };
    if (token.type === "ident") {
      if (token.value === "true") return { kind: "literal", value: true };
      if (token.value === "false") return { kind: "literal", value: false };
      if (token.value === "null") return { kind: "literal", value: null };
      if (["and", "or", "not"].includes(token.value)) {
        throw new ExpressionError(`Unexpected "${token.value}"`, token.pos);
      }
      return { kind: "path", path: token.value.split(".") };
    }
    throw new ExpressionError(token.type === "eof" ? "Unexpected end" : "Unexpected token", token.pos);
  }
}

const cache = new Map<string, Expr>();

export function parseExpression(source: string): Expr {
  const cached = cache.get(source);
  if (cached) return cached;
  const expr = new Parser(tokenize(source)).parse();
  cache.set(source, expr);
  return expr;
}

export type Scope = (path: readonly string[]) => unknown;

export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

export function evaluate(expr: Expr, scope: Scope): unknown {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "path":
      return scope(expr.path);
    case "not":
      return !truthy(evaluate(expr.operand, scope));
    case "and":
      return truthy(evaluate(expr.left, scope)) && truthy(evaluate(expr.right, scope));
    case "or":
      return truthy(evaluate(expr.left, scope)) || truthy(evaluate(expr.right, scope));
    case "compare": {
      const left = evaluate(expr.left, scope) as never;
      const right = evaluate(expr.right, scope) as never;
      switch (expr.op) {
        case "==":
          return left === right;
        case "!=":
          return left !== right;
        case "<":
          return left < right;
        case "<=":
          return left <= right;
        case ">":
          return left > right;
        case ">=":
          return left >= right;
      }
    }
  }
}

export function evaluateBoolean(source: string, scope: Scope): boolean {
  return truthy(evaluate(parseExpression(source), scope));
}

/** Every path the expression reads, for validation. */
export function references(expr: Expr): string[][] {
  switch (expr.kind) {
    case "literal":
      return [];
    case "path":
      return [expr.path];
    case "not":
      return references(expr.operand);
    case "and":
    case "or":
    case "compare":
      return [...references(expr.left), ...references(expr.right)];
  }
}

/** Resolves a dotted path inside a plain value. */
export function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
