import { describe, expect, it } from "vitest";
import {
  CommandGate,
  applyFileDiff,
  checkFixScope,
  createUnifiedDiff,
  failureSignature,
  matchesGlob,
  parseJsonFailures,
  parseJunit,
  parseRegexFailures,
  parseUnifiedDiff,
  renderTemplate,
  routeFinding,
  type Finding,
  type FindingsRouting,
} from "../src/index.ts";

describe("command templates", () => {
  it("interpolates and quotes lists, and expands project commands", () => {
    const vars = {
      task: { worktree: "/tmp/wt", files: ["src/a.ts", "src/b c.ts"] },
      commands: { test: "npm test -- {{task.files}}" },
    };
    expect(renderTemplate("cd {{task.worktree}} && {{commands.test}}", vars)).toBe("cd /tmp/wt && npm test -- src/a.ts 'src/b c.ts'");
    expect(() => renderTemplate("{{missing.value}}", vars)).toThrow("Unknown variable");
  });
});

describe("failure extraction", () => {
  it("parses JUnit XML", () => {
    const xml = `<?xml version="1.0"?>
<testsuites><testsuite name="orders">
  <testcase classname="orders.test.ts" name="retries 429"><failure message="expected 3 calls">trace here</failure></testcase>
  <testcase classname="orders.test.ts" name="ok"/>
</testsuite></testsuites>`;
    expect(parseJunit(xml)).toEqual([{ test: "orders.test.ts > retries 429", message: "expected 3 calls", trace: "trace here" }]);
  });

  it("parses generic and Jest/Vitest JSON", () => {
    expect(parseJsonFailures(JSON.stringify({ failures: [{ test: "t", message: "m" }] }))).toEqual([{ test: "t", message: "m" }]);
    const jest = { testResults: [{ name: "a.test.ts", assertionResults: [{ status: "failed", fullName: "a works", failureMessages: ["Error: boom\n at x"] }, { status: "passed" }] }] };
    expect(parseJsonFailures(JSON.stringify(jest))[0]).toMatchObject({ test: "a works", message: "Error: boom", file: "a.test.ts" });
  });

  it("parses with a regex with named groups", () => {
    const out = "src/a.ts:10: error: bad type\nok\nsrc/b.ts:3: error: oops";
    expect(parseRegexFailures(out, "^(?<file>[^:]+):(?<line>\\d+): error: (?<message>.*)$")).toHaveLength(2);
  });

  it("signatures ignore volatile details", () => {
    const a = failureSignature([{ test: "t", message: "timeout after 123 ms at 0xdeadbeef" }], "", false);
    const b = failureSignature([{ test: "t", message: "timeout after 98 ms at 0x0001" }], "", false);
    expect(a).toBe(b);
    expect(failureSignature([], "", true)).toBe("");
  });
});

describe("command gate", () => {
  const make = (trusted: boolean, answer: "allow" | "allow_always" | "deny") => {
    const allow = new Set<string>();
    const asked: string[] = [];
    const gate = new CommandGate({
      trusted,
      destructivePatterns: ["\\bgit\\s+push\\b"],
      allowlist: { has: async (c) => allow.has(c), add: async (c) => void allow.add(c) },
      approver: { confirm: async (r) => (asked.push(`${r.reason}:${r.command}`), answer) },
    });
    return { gate, asked, allow };
  };
  const request = (command: string) => ({ command, cwd: "/w", source: "flow" as const, fromProject: false });

  it("approves new commands once and remembers them", async () => {
    const { gate, asked } = make(true, "allow_always");
    expect(await gate.authorize(request("make test"))).toEqual({ allowed: true });
    expect(await gate.authorize(request("make test"))).toEqual({ allowed: true });
    expect(asked).toEqual(["new:make test"]);
  });

  it("always confirms destructive commands and blocks untrusted workspaces", async () => {
    const { gate, asked } = make(true, "allow_always");
    await gate.authorize(request("git push origin main"));
    await gate.authorize(request("git push origin main"));
    expect(asked).toEqual(["destructive:git push origin main", "destructive:git push origin main"]);
    const untrusted = make(false, "allow");
    expect((await untrusted.gate.authorize(request("make test"))).allowed).toBe(false);
  });
});

describe("findings routing", () => {
  const table: FindingsRouting = [
    { name: "Auto-fixable format and lint", when: { category: ["format", "lint"], autofix: true }, route: "command_fix", fix: "make fmt", verify: "make lint" },
    { name: "Types and lint with no behavior impact", when: { category: ["typecheck", "lint"], affects_ac: "none", behavior_change: false }, route: "worker_then_command", verify: "make typecheck" },
    { name: "Minor with no impact", when: { severity: "low", affects_ac: "none", behavior_change: false }, route: "report_only" },
    { default: { route: "worker_then_qa" } },
  ];
  const finding = (over: Partial<Finding>): Finding => ({
    id: "F1",
    severity: "medium",
    category: "logic",
    file: "src/a.ts",
    line: 10,
    message: "m",
    affects_ac: [],
    behavior_change: false,
    autofix: false,
    ...over,
  });

  it("routes by the first matching rule", () => {
    expect(routeFinding(finding({ category: "format", autofix: true, severity: "low" }), table).route).toBe("command_fix");
    expect(routeFinding(finding({ category: "typecheck" }), table).route).toBe("worker_then_command");
    expect(routeFinding(finding({ category: "typecheck", affects_ac: ["AC1"] }), table).route).toBe("worker_then_qa");
    expect(routeFinding(finding({ severity: "low", category: "performance" }), table).route).toBe("report_only");
    expect(routeFinding(finding({ severity: "high" }), table).rule).toBe("default");
  });

  it("the safeguard flags fixes outside the finding's lines", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const near = before.replace("line 11", "line eleven");
    const far = before.replace("line 25", "line twenty-five");
    expect(checkFixScope(createUnifiedDiff("src/a.ts", before, near), [finding({})], 3)).toEqual([]);
    expect(checkFixScope(createUnifiedDiff("src/a.ts", before, far), [finding({})], 3)).toEqual([{ file: "src/a.ts", lines: [25] }]);
    expect(checkFixScope(createUnifiedDiff("src/other.ts", "a", "b"), [finding({})], 3)[0]?.file).toBe("src/other.ts");
  });
});

describe("diffs", () => {
  it("applies hunks even when line numbers drift", () => {
    const original = "a\nb\nc\nd\ne\n";
    const patch = "--- a/f.txt\n+++ b/f.txt\n@@ -10,3 +10,3 @@\n b\n-c\n+C\n d\n";
    const [file] = parseUnifiedDiff(patch);
    expect(applyFileDiff(original, file!)).toBe("a\nb\nC\nd\ne\n");
  });

  it("round-trips created diffs", () => {
    const before = "one\ntwo\nthree";
    const after = "one\n2\nthree\nfour";
    const [file] = parseUnifiedDiff(createUnifiedDiff("x.txt", before, after));
    expect(applyFileDiff(before, file!)).toBe(after);
  });

  it("matches globs", () => {
    expect(matchesGlob("src/secrets/a/b.ts", "src/secrets/**")).toBe(true);
    expect(matchesGlob("src/a.test.ts", "**/*.test.ts")).toBe(true);
    expect(matchesGlob("src/a.ts", "src/*.{ts,js}")).toBe(true);
    expect(matchesGlob("lib/a.ts", "src/**")).toBe(false);
  });
});
