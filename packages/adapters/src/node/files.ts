import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { matchesGlob, type FileAccess, type ToolHost } from "@delamain/core";

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "out", ".next", "target", ".harness-cache"]);
const MAX_FILE_BYTES = 2_000_000;
const MAX_FETCH_CHARS = 60_000;

async function inside(cwd: string, path: string): Promise<string> {
  const root = await realpath(cwd);
  const full = resolve(root, path);
  if (full !== root && !full.startsWith(root + sep)) throw new Error(`${path} is outside the working directory`);
  try {
    const real = await realpath(full);
    if (real !== root && !real.startsWith(root + sep)) throw new Error(`${path} resolves outside the working directory`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return full;
}

export const nodeFileAccess: FileAccess = {
  read: async (path) => readFile(path, "utf8").catch(() => undefined),
  remove: async (path) => rm(path, { force: true }),
  join: (...parts) => join(...parts),
};

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

/** File tools for agents, confined to the agent's working directory. */
export class NodeToolHost implements ToolHost {
  async readFile(cwd: string, path: string): Promise<string | undefined> {
    const full = await inside(cwd, path);
    try {
      const content = await readFile(full);
      if (content.length > MAX_FILE_BYTES) return `${content.subarray(0, MAX_FILE_BYTES).toString("utf8")}\n… file truncated`;
      if (content.includes(0)) return "(binary file)";
      return content.toString("utf8");
    } catch {
      return undefined;
    }
  }

  async writeFile(cwd: string, path: string, content: string): Promise<void> {
    const full = await inside(cwd, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  async listFiles(cwd: string, dir: string, glob?: string): Promise<string[]> {
    const root = await inside(cwd, dir);
    const base = await realpath(cwd);
    const files: string[] = [];
    const walk = async (current: string) => {
      if (files.length >= 5000) return;
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(join(current, entry.name));
        } else if (entry.isFile()) {
          const rel = relative(base, join(current, entry.name)).split(sep).join("/");
          if (!glob || matchesGlob(rel, glob)) files.push(rel);
        }
      }
    };
    await walk(root);
    return files.sort();
  }

  async search(cwd: string, pattern: string, glob?: string): Promise<{ file: string; line: number; text: string }[]> {
    const args = ["grep", "-n", "-I", "-E", "--untracked", "--no-color", "-e", pattern];
    if (glob) args.push("--", `:(glob)${glob}`);
    const output = await new Promise<string>((resolveOutput) => {
      execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (_error, stdout) => resolveOutput(stdout ?? ""));
    });
    if (output) {
      return output
        .split("\n")
        .filter(Boolean)
        .slice(0, 500)
        .map((line) => {
          const match = /^([^:]+):(\d+):(.*)$/.exec(line);
          return match ? { file: match[1]!, line: Number(match[2]), text: match[3]!.slice(0, 300) } : { file: line, line: 0, text: "" };
        });
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      return [];
    }
    const hits: { file: string; line: number; text: string }[] = [];
    for (const file of await this.listFiles(cwd, ".", glob)) {
      const content = await this.readFile(cwd, file);
      if (!content) continue;
      content.split("\n").forEach((text, index) => {
        if (hits.length < 500 && regex.test(text)) hits.push({ file, line: index + 1, text: text.slice(0, 300) });
      });
      if (hits.length >= 500) break;
    }
    return hits;
  }

  async fetchUrl(url: string, signal?: AbortSignal): Promise<string> {
    const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(20_000), headers: { "user-agent": "DelamainHarness/0.1" } });
    const type = response.headers.get("content-type") ?? "";
    const body = await response.text();
    const text = type.includes("html") ? stripHtml(body) : body;
    return `${response.status} ${url}\n\n${text.slice(0, MAX_FETCH_CHARS)}`;
  }
}
