import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { ChatMessage, HarnessEvent, HarnessEventBody, Journal, RecordedStep, SessionSummary } from "@delamain/core";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface SessionMeta {
  id: string;
  message: string;
  flow: string;
  startedAt: number;
  status: "running" | "succeeded" | "failed" | "cancelled" | "answered";
  settings: { flow: string; principal?: string; approval: "auto" | "review" };
  branch?: string;
}

function hash(key: string): string {
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

/**
 * One session on disk, in the extension's workspace storage (never in the repo): the
 * append-only event log, the step journal used to resume, and conversation checkpoints.
 * Once the session ends the log is gzipped and the resume data is dropped.
 */
export class SessionStore implements Journal {
  private readonly steps = new Map<string, RecordedStep>();
  private readonly values = new Map<string, unknown>();
  private seq = 0;
  readonly dir: string;

  constructor(root: string, readonly id: string) {
    this.dir = join(root, "sessions", id);
    mkdirSync(join(this.dir, "conversations"), { recursive: true });
    this.load();
  }

  private load(): void {
    const journal = join(this.dir, "journal.jsonl");
    if (existsSync(journal)) {
      for (const line of readFileSync(journal, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as { k: string; step?: RecordedStep; value?: unknown };
          if (entry.step) this.steps.set(entry.k, entry.step);
          else this.values.set(entry.k, entry.value);
        } catch {
          // A partial last line after a crash is ignored.
        }
      }
    }
    const events = join(this.dir, "events.jsonl");
    if (existsSync(events)) {
      const lines = readFileSync(events, "utf8").split("\n").filter(Boolean);
      const last = lines.at(-1);
      if (last) {
        try {
          this.seq = (JSON.parse(last) as HarnessEvent).seq;
        } catch {
          this.seq = lines.length;
        }
      }
    }
  }

  get(key: string): RecordedStep | undefined {
    return this.steps.get(key);
  }

  put(key: string, record: RecordedStep): void {
    this.steps.set(key, record);
    appendFileSync(join(this.dir, "journal.jsonl"), `${JSON.stringify({ k: key, step: record })}\n`);
  }

  getValue<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  putValue(key: string, value: unknown): void {
    this.values.set(key, value);
    appendFileSync(join(this.dir, "journal.jsonl"), `${JSON.stringify({ k: key, value })}\n`);
  }

  conversation(key: string): ChatMessage[] | undefined {
    const file = join(this.dir, "conversations", `${hash(key)}.json`);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as ChatMessage[];
    } catch {
      return undefined;
    }
  }

  saveConversation(key: string, messages: ChatMessage[]): void {
    writeFileSync(join(this.dir, "conversations", `${hash(key)}.json`), JSON.stringify(messages));
  }

  appendEvent(event: HarnessEventBody): HarnessEvent {
    const full = { ...event, seq: ++this.seq, ts: Date.now(), session: this.id } as HarnessEvent;
    appendFileSync(join(this.dir, "events.jsonl"), `${JSON.stringify(full)}\n`);
    return full;
  }

  readEvents(): HarnessEvent[] {
    const file = join(this.dir, "events.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as HarnessEvent];
        } catch {
          return [];
        }
      });
  }

  writeMeta(meta: SessionMeta): void {
    writeFileSync(join(this.dir, "meta.json"), JSON.stringify(meta, null, 2));
  }

  readMeta(): SessionMeta | undefined {
    const file = join(this.dir, "meta.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as SessionMeta) : undefined;
  }

  writeMetrics(metrics: unknown): void {
    writeFileSync(join(this.dir, "metrics.json"), JSON.stringify(metrics, null, 2));
  }

  /** Compresses the log and drops what is only needed to resume. */
  async close(): Promise<void> {
    const events = join(this.dir, "events.jsonl");
    if (existsSync(events)) {
      await writeFile(`${events}.gz`, await gzipAsync(await readFile(events)));
      await rm(events, { force: true });
    }
    await rm(join(this.dir, "journal.jsonl"), { force: true });
    await rm(join(this.dir, "conversations"), { recursive: true, force: true });
  }
}

export async function readClosedEvents(root: string, id: string): Promise<HarnessEvent[]> {
  const file = join(root, "sessions", id, "events.jsonl.gz");
  if (!existsSync(file)) return [];
  const text = (await gunzipAsync(await readFile(file))).toString("utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HarnessEvent);
}

export async function listSessions(root: string): Promise<SessionMeta[]> {
  const dir = join(root, "sessions");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const metas: SessionMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "meta.json");
    if (!existsSync(file)) continue;
    try {
      metas.push(JSON.parse(await readFile(file, "utf8")) as SessionMeta);
    } catch {
      // Unreadable metadata means the session cannot be listed or resumed.
    }
  }
  return metas.sort((a, b) => b.startedAt - a.startedAt);
}

export function toSummary(meta: SessionMeta): SessionSummary {
  return { id: meta.id, message: meta.message, flow: meta.flow, startedAt: meta.startedAt, status: meta.status };
}
