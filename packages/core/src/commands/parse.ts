import { XMLParser } from "fast-xml-parser";
import { canonicalJson, stableHash } from "../util/hash.ts";

export interface Failure {
  test: string;
  message: string;
  trace?: string;
  file?: string;
  line?: number;
}

export type ParseSpec =
  | { kind: "none" }
  | { kind: "junit"; file: string }
  | { kind: "json"; file?: string }
  | { kind: "regex"; pattern: string };

export function parseSpecOf(parse: string | undefined): ParseSpec {
  if (!parse || parse === "none") return { kind: "none" };
  if (parse === "json") return { kind: "json" };
  const colon = parse.indexOf(":");
  const kind = parse.slice(0, colon);
  const arg = parse.slice(colon + 1);
  if (kind === "junit") return { kind: "junit", file: arg };
  if (kind === "json") return { kind: "json", file: arg };
  if (kind === "regex") return { kind: "regex", pattern: arg };
  return { kind: "none" };
}

const MAX_TRACE = 1200;
const MAX_FAILURES = 50;

function trim(text: string | undefined, max = MAX_TRACE): string | undefined {
  if (!text) return undefined;
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

type XmlNode = Record<string, unknown>;

/** Extracts failed and errored test cases from a JUnit XML report. */
export function parseJunit(xml: string): Failure[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    textNodeName: "#text",
    isArray: (name) => ["testsuite", "testcase", "failure", "error"].includes(name),
  });
  const doc = parser.parse(xml) as XmlNode;
  const failures: Failure[] = [];
  const visitSuite = (suite: XmlNode) => {
    for (const nested of asArray(suite.testsuite as XmlNode[] | undefined)) visitSuite(nested);
    for (const testcase of asArray(suite.testcase as XmlNode[] | undefined)) {
      const problems = [
        ...asArray(testcase.failure as unknown[] | undefined),
        ...asArray(testcase.error as unknown[] | undefined),
      ];
      for (const problem of problems) {
        const node = (typeof problem === "object" && problem !== null ? problem : { "#text": problem }) as XmlNode;
        const name = [testcase["@classname"], testcase["@name"]].filter(Boolean).join(" > ");
        const message = String(node["@message"] ?? node["@type"] ?? "failed");
        const failure: Failure = { test: name || "unknown test", message: trim(message, 400) ?? "failed" };
        const trace = trim(String(node["#text"] ?? ""));
        if (trace) failure.trace = trace;
        if (typeof testcase["@file"] === "string") failure.file = testcase["@file"];
        if (testcase["@line"] !== undefined) failure.line = Number(testcase["@line"]);
        failures.push(failure);
      }
    }
  };
  const root = (doc.testsuites ?? doc) as XmlNode;
  visitSuite(root);
  return failures.slice(0, MAX_FAILURES);
}

/**
 * Reads failures from JSON: either `{ failures: [{test, message, trace}] }` or a Jest/Vitest
 * report (`testResults[].assertionResults[]`).
 */
export function parseJsonFailures(text: string): Failure[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.failures)) {
    return (record.failures as Record<string, unknown>[]).slice(0, MAX_FAILURES).map((f) => {
      const failure: Failure = {
        test: String(f.test ?? f.name ?? "unknown test"),
        message: trim(String(f.message ?? "failed"), 400) ?? "failed",
      };
      const trace = trim(typeof f.trace === "string" ? f.trace : undefined);
      if (trace) failure.trace = trace;
      if (typeof f.file === "string") failure.file = f.file;
      if (typeof f.line === "number") failure.line = f.line;
      return failure;
    });
  }
  const failures: Failure[] = [];
  for (const file of asArray(record.testResults as Record<string, unknown>[] | undefined)) {
    for (const assertion of asArray(file.assertionResults as Record<string, unknown>[] | undefined)) {
      if (assertion.status !== "failed") continue;
      const messages = asArray(assertion.failureMessages as string[] | undefined);
      const failure: Failure = {
        test: String(assertion.fullName ?? assertion.title ?? "unknown test"),
        message: trim(messages[0]?.split("\n")[0], 400) ?? "failed",
      };
      const trace = trim(messages.join("\n"));
      if (trace) failure.trace = trace;
      if (typeof file.name === "string") failure.file = file.name;
      failures.push(failure);
    }
  }
  return failures.slice(0, MAX_FAILURES);
}

/** Applies a regex with named groups (test, message, file, line) to every output line. */
export function parseRegexFailures(output: string, pattern: string): Failure[] {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return [];
  }
  const failures: Failure[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = regex.exec(line);
    if (!match) continue;
    const groups = match.groups ?? {};
    const failure: Failure = {
      test: groups.test ?? groups.file ?? match[0],
      message: groups.message ?? match[0],
    };
    if (groups.file) failure.file = groups.file;
    if (groups.line) failure.line = Number(groups.line);
    failures.push(failure);
    if (failures.length >= MAX_FAILURES) break;
  }
  return failures;
}

export function tailLines(output: string, lines: number): string {
  const all = output.replace(/\s+$/, "").split(/\r?\n/);
  if (all.length <= lines) return all.join("\n");
  return [`… ${all.length - lines} earlier lines omitted`, ...all.slice(-lines)].join("\n");
}

/** Volatile bits (durations, addresses, timestamps, temp paths) are dropped from fingerprints. */
function normalizeForSignature(text: string): string {
  return text
    .replace(/\b0x[0-9a-f]+\b/gi, "0x")
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|seconds)\b/gi, "<t>")
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, "<date>")
    .replace(/\/(tmp|var\/folders)\/[^\s:]+/g, "<tmp>")
    .replace(/:\d+:\d+/g, ":<pos>")
    .trim();
}

/**
 * Fingerprint of a command's failures. Two consecutive iterations with the same signature
 * mean no progress.
 */
export function failureSignature(failures: Failure[], outputTail: string, passed: boolean): string {
  if (passed) return "";
  if (failures.length) {
    const items = failures
      .map((f) => ({ test: f.test, message: normalizeForSignature(f.message) }))
      .sort((a, b) => (a.test < b.test ? -1 : a.test > b.test ? 1 : 0));
    return stableHash(canonicalJson(items));
  }
  const lastLines = outputTail.split("\n").slice(-20).join("\n");
  return stableHash(normalizeForSignature(lastLines));
}
