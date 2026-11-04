import {
  Document,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  type Node,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";
import type { Issue, IssuePath } from "../util/issues.ts";

export interface ParsedYaml {
  doc: Document;
  value: unknown;
  issues: Issue[];
}

export interface TextRange {
  start: number;
  end: number;
}

export function parseYaml(text: string): ParsedYaml {
  const doc = parseDocument(text, { prettyErrors: false, uniqueKeys: true });
  const issues: Issue[] = [];
  for (const err of doc.errors) {
    issues.push({ severity: "error", path: [], message: `YAML: ${err.message.split("\n")[0]}` });
  }
  for (const warn of doc.warnings) {
    issues.push({ severity: "warning", path: [], message: `YAML: ${warn.message.split("\n")[0]}` });
  }
  return { doc, value: doc.errors.length ? undefined : doc.toJS({ maxAliasCount: 100 }), issues };
}

/** Syntax error ranges, which carry their own position instead of a path. */
export function yamlErrorRanges(doc: Document): { range: TextRange; message: string }[] {
  return doc.errors.map((err) => ({
    range: { start: err.pos[0], end: Math.max(err.pos[1], err.pos[0] + 1) },
    message: `YAML: ${err.message.split("\n")[0]}`,
  }));
}

/**
 * Text range for a path. Falls back to the closest existing ancestor; for a missing key it
 * points at the parent's key so the error sits next to the field that is incomplete.
 */
export function locate(doc: Document, path: IssuePath): TextRange | undefined {
  let node: unknown = doc.contents;
  let anchor: TextRange | undefined = startOf(node);
  for (const segment of path) {
    let next: unknown;
    let keyRange: TextRange | undefined;
    if (isMap(node)) {
      const pair = node.items.find(
        (item) => isScalar(item.key) && String(item.key.value) === String(segment),
      );
      if (!pair) break;
      keyRange = rangeOf(pair.key);
      next = pair.value;
    } else if (isSeq(node) && typeof segment === "number" && segment < node.items.length) {
      next = node.items[segment];
    } else {
      break;
    }
    node = next;
    anchor = keyRange ?? startOf(next) ?? anchor;
  }
  if (isScalar(node)) return rangeOf(node) ?? anchor;
  return anchor;
}

function startOf(node: unknown): TextRange | undefined {
  const range = rangeOf(node);
  return range ? { start: range.start, end: range.start + 1 } : undefined;
}

function rangeOf(node: unknown): TextRange | undefined {
  if (!isNode(node) || !node.range) return undefined;
  return { start: node.range[0], end: Math.max(node.range[1], node.range[0] + 1) };
}

export function offsetToPosition(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < Math.min(offset, text.length); i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

const IDENTITY_KEYS = ["id", "name", "ref", "label"] as const;

function identityOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of IDENTITY_KEYS) {
    if (typeof record[key] === "string") return `${key}:${record[key]}`;
  }
  if ("default" in record && Object.keys(record).length === 1) return "default";
  return undefined;
}

function nodeIdentity(node: unknown): string | undefined {
  if (!isMap(node)) return undefined;
  for (const key of IDENTITY_KEYS) {
    const value = node.get(key);
    if (typeof value === "string") return `${key}:${value}`;
  }
  if (node.items.length === 1 && node.has("default")) return "default";
  return undefined;
}

/**
 * Updates a YAML document in place so it represents `value`, keeping comments, key order and
 * formatting of everything that did not change. Sequence items are matched by id, name, ref
 * or label when they have one, so reordering a list keeps each item's comments.
 */
export function patchDocument(doc: Document, value: unknown): void {
  if (!isNode(doc.contents) || !sameShape(doc.contents, value)) {
    doc.contents = doc.createNode(value) as typeof doc.contents;
    return;
  }
  patchNode(doc, doc.contents, value);
}

function sameShape(node: unknown, value: unknown): boolean {
  if (isMap(node)) return value !== null && typeof value === "object" && !Array.isArray(value);
  if (isSeq(node)) return Array.isArray(value);
  return isScalar(node) && (value === null || typeof value !== "object");
}

function patchNode(doc: Document, node: Node, value: unknown): Node {
  if (!sameShape(node, value)) return doc.createNode(value) as Node;
  if (isMap(node)) {
    patchMap(doc, node, value as Record<string, unknown>);
    return node;
  }
  if (isSeq(node)) {
    patchSeq(doc, node, value as unknown[]);
    return node;
  }
  if (isScalar(node)) {
    if (node.value !== value) node.value = value;
    return node;
  }
  return doc.createNode(value) as Node;
}

function patchMap(doc: Document, node: YAMLMap, value: Record<string, unknown>): void {
  const wanted = Object.entries(value).filter(([, v]) => v !== undefined);
  const wantedKeys = new Set(wanted.map(([k]) => k));
  node.items = node.items.filter(
    (pair) => isPair(pair) && isScalar(pair.key) && wantedKeys.has(String(pair.key.value)),
  );
  for (const [key, child] of wanted) {
    const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === key);
    if (pair) {
      pair.value = isNode(pair.value) ? patchNode(doc, pair.value, child) : doc.createNode(child);
    } else {
      node.set(doc.createNode(key), doc.createNode(child));
    }
  }
}

function patchSeq(doc: Document, node: YAMLSeq, value: unknown[]): void {
  const existing = [...node.items];
  const byIdentity = new Map<string, unknown>();
  for (const item of existing) {
    const id = nodeIdentity(item);
    if (id) byIdentity.set(id, item);
  }
  node.items = value.map((child, index) => {
    const id = identityOf(child);
    const match = id ? byIdentity.get(id) : existing[index];
    if (id) byIdentity.delete(id);
    if (isNode(match) && sameShape(match, child)) return patchNode(doc, match, child);
    return doc.createNode(child);
  });
}

export function stringifyYaml(value: unknown, header?: string): string {
  const doc = new Document(value);
  if (header) doc.commentBefore = header;
  return doc.toString({ lineWidth: 100 });
}

/** Writes `value` over `originalText`, preserving comments and layout where possible. */
export function updateYamlText(originalText: string | undefined, value: unknown): string {
  if (!originalText?.trim()) return stringifyYaml(value);
  const doc = parseDocument(originalText);
  if (doc.errors.length) return stringifyYaml(value);
  patchDocument(doc, value);
  return doc.toString({ lineWidth: 100 });
}
