import type { LayerName, Origin } from "../config/merge.ts";
import type { HarnessEvent } from "../events/types.ts";
import type { DryRunReport } from "../flow/dry-run.ts";
import type { Health, ModelInfo } from "../providers/types.ts";
import type { ConfigFile, HarnessConfig } from "../schema/config.ts";
import type { Flow } from "../schema/flow.ts";
import type { Issue } from "../util/issues.ts";

/** Everything the configuration screen needs, sent whenever a layer changes on disk. */
export interface HarnessSnapshot {
  layers: Partial<Record<Exclude<LayerName, "session">, Partial<ConfigFile>>>;
  layerPaths: Partial<Record<Exclude<LayerName, "session">, string>>;
  merged: HarnessConfig;
  origins: Record<string, Origin>;
  /** Invalid flows are listed so they can be fixed in the editor; they never run. */
  flows: { name: string; layer: LayerName; path: string; flow: Flow; invalid?: boolean }[];
  /** Reusable flows from the flows/ folders, by the path subflow blocks use. */
  subflows: { ref: string; name: string; flow: Flow }[];
  agents: { name: string; role: string; source?: string }[];
  issues: Issue[];
  secrets: Record<string, boolean>;
  health: Record<string, Health>;
  catalogs: Record<string, ModelInfo[]>;
  discovered: { id: string; label: string; base_url: string; models: string[] }[];
  trusted: boolean;
  hasProject: boolean;
}

export interface SessionSummary {
  id: string;
  message: string;
  flow: string;
  startedAt: number;
  status: string;
}

export interface ChatSettings {
  flow: string;
  principal?: string;
  approval: "auto" | "review";
}

export type ToExtension =
  | { type: "ready"; view: "chat" | "config" }
  | { type: "chat.send"; text: string; settings: ChatSettings }
  | { type: "chat.cancel" }
  | { type: "chat.new" }
  | { type: "chat.settings"; settings: ChatSettings }
  | { type: "question.answer"; id: string; answer: string }
  | { type: "approval.answer"; approved: boolean; note?: string }
  | { type: "command.answer"; id: string; answer: "allow" | "allow_always" | "deny" }
  | { type: "session.resume"; id: string }
  | { type: "session.discard"; id: string }
  | { type: "result.commit" }
  | { type: "result.keep" }
  | { type: "result.diff" }
  | { type: "task.action"; task: string; action: "cancel" | "retry" | "retry-model" | "skip" }
  | { type: "step.open"; key: string }
  | { type: "config.save"; destination: "global" | "project"; config: Partial<ConfigFile> }
  | { type: "flow.save"; destination: "global" | "project"; name: string; flow: Flow; previousName?: string }
  | { type: "flow.delete"; destination: "global" | "project"; name: string }
  | { type: "provider.test"; provider: string }
  | { type: "provider.discover" }
  | { type: "provider.catalog"; provider: string }
  | { type: "provider.probe"; ref: string }
  | { type: "secret.set"; secret: string; value: string }
  | { type: "secret.delete"; secret: string }
  | { type: "config.import" }
  | { type: "config.export" }
  | { type: "config.open"; destination: "global" | "project" }
  | { type: "dryrun"; flow: string };

export type ToWebview =
  | { type: "init"; view: "chat" | "config"; settings?: ChatSettings }
  | { type: "events"; events: HarnessEvent[]; reset?: boolean }
  | { type: "harness"; snapshot: HarnessSnapshot }
  | { type: "health"; provider: string; health: Health }
  | { type: "catalog"; provider: string; models: ModelInfo[] }
  | { type: "probe"; ref: string; toolCalling: boolean | undefined; contextWindow?: number; message?: string }
  | { type: "saved"; ok: boolean; issues: Issue[]; path?: string }
  | { type: "chat.reset" }
  | { type: "command.confirm"; id: string; command: string; cwd: string; reason: "new" | "destructive" }
  | { type: "command.resolved"; id: string }
  | { type: "sessions"; resumable: SessionSummary[] }
  | { type: "result"; status: string; summary: string; branch?: string; files: string[]; canCommit: boolean }
  | { type: "dryrun"; report: DryRunReport }
  | { type: "status"; running: boolean };
