export interface DiffLine {
  type: "context" | "add" | "remove";
  text: string;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  oldPath?: string;
  newPath?: string;
  /** The path the change applies to (new path, or old path for deletions). */
  path: string;
  hunks: Hunk[];
  isNew: boolean;
  isDeleted: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(path: string): string | undefined {
  const clean = path.split("\t")[0]!.trim();
  if (clean === "/dev/null") return undefined;
  return clean.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  let current: FileDiff | undefined;
  let hunk: Hunk | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const oldPath = stripPrefix(line.slice(4));
      const newPath = stripPrefix(lines[i + 1]!.slice(4));
      current = {
        ...(oldPath ? { oldPath } : {}),
        ...(newPath ? { newPath } : {}),
        path: newPath ?? oldPath ?? "",
        hunks: [],
        isNew: oldPath === undefined,
        isDeleted: newPath === undefined,
      };
      files.push(current);
      hunk = undefined;
      i++;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header && current) {
      hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("+")) hunk.lines.push({ type: "add", text: line.slice(1) });
    else if (line.startsWith("-")) hunk.lines.push({ type: "remove", text: line.slice(1) });
    else if (line.startsWith(" ")) hunk.lines.push({ type: "context", text: line.slice(1) });
    else if (line === "" && i < lines.length - 1) hunk.lines.push({ type: "context", text: "" });
  }
  return files;
}

/** Lines of the old file touched by the diff (removals, and insertion points for additions). */
export function touchedOldLines(file: FileDiff): number[] {
  const touched = new Set<number>();
  for (const hunk of file.hunks) {
    let oldLine = hunk.oldStart;
    let previous: DiffLine["type"] | undefined;
    for (const line of hunk.lines) {
      if (line.type === "context") oldLine++;
      else if (line.type === "remove") {
        touched.add(oldLine);
        oldLine++;
      } else if (previous !== "remove" && previous !== "add") {
        touched.add(Math.max(1, oldLine - 1));
      }
      previous = line.type;
    }
  }
  return [...touched].sort((a, b) => a - b);
}

export class PatchError extends Error {}

/**
 * Applies one file's hunks to its content. Hunks are located by their context, allowing the
 * line numbers to drift, which is common in diffs written by models.
 */
export function applyFileDiff(original: string | undefined, file: FileDiff): string | undefined {
  if (file.isDeleted) return undefined;
  const source = file.isNew || original === undefined ? [] : original.replace(/\r\n/g, "\n").split("\n");
  const result = [...source];
  let offset = 0;
  for (const hunk of file.hunks) {
    const before = hunk.lines.filter((l) => l.type !== "add").map((l) => l.text);
    const after = hunk.lines.filter((l) => l.type !== "remove").map((l) => l.text);
    const expected = Math.max(0, hunk.oldStart - 1 + offset);
    const at = before.length === 0 ? Math.min(expected, result.length) : findBlock(result, before, expected);
    if (at < 0) {
      throw new PatchError(`Hunk at line ${hunk.oldStart} of ${file.path} does not match the file`);
    }
    result.splice(at, before.length, ...after);
    offset += after.length - before.length + (at - expected);
  }
  return result.join("\n");
}

function findBlock(lines: string[], block: string[], near: number): number {
  const matchesAt = (index: number) =>
    index >= 0 && index + block.length <= lines.length && block.every((text, j) => lines[index + j] === text);
  if (matchesAt(near)) return near;
  for (let distance = 1; distance <= lines.length; distance++) {
    if (matchesAt(near - distance)) return near - distance;
    if (matchesAt(near + distance)) return near + distance;
  }
  const trimmed = block.map((t) => t.trim());
  for (let index = 0; index + block.length <= lines.length; index++) {
    if (trimmed.every((text, j) => lines[index + j]!.trim() === text)) return index;
  }
  return -1;
}

/** Extracts the first fenced ```diff block, or the raw text when it already is a diff. */
export function extractDiff(text: string): string | undefined {
  const fenced = /```(?:diff|patch)?\s*\n([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  return /^--- /m.test(candidate) && /^\+\+\+ /m.test(candidate) ? candidate : undefined;
}

/** Minimal unified diff between two texts, used to show changes made outside git. */
export function createUnifiedDiff(path: string, before: string | undefined, after: string | undefined): string {
  const a = before === undefined ? [] : before.split("\n");
  const b = after === undefined ? [] : after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return "";
  const context = 3;
  const from = Math.max(0, start - context);
  const toA = Math.min(a.length, endA + context);
  const toB = Math.min(b.length, endB + context);
  const lines = [
    `--- ${before === undefined ? "/dev/null" : `a/${path}`}`,
    `+++ ${after === undefined ? "/dev/null" : `b/${path}`}`,
    `@@ -${from + 1},${toA - from} +${from + 1},${toB - from} @@`,
    ...a.slice(from, start).map((l) => ` ${l}`),
    ...a.slice(start, endA).map((l) => `-${l}`),
    ...b.slice(start, endB).map((l) => `+${l}`),
    ...a.slice(endA, toA).map((l) => ` ${l}`),
  ];
  return `${lines.join("\n")}\n`;
}
