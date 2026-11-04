import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DecisionsFile,
  parseYaml,
  presetFiles,
  stringifyYaml,
  updateYamlText,
  type Decision,
  type HarnessSources,
  type LayerName,
  type LoadedFile,
  type SourceFile,
} from "@delamain/core";

async function readDir(dir: string, extensions: string[], layer: LayerName): Promise<SourceFile[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files: SourceFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !extensions.some((ext) => entry.name.endsWith(ext)) || entry.name.startsWith("_")) continue;
    const path = join(dir, entry.name);
    files.push({ layer, path, text: await readFile(path, "utf8") });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Reads one layer folder: ~/.harness (global) or <repo>/.harness (project). */
export async function readLayer(dir: string, layer: LayerName): Promise<HarnessSources> {
  const configPath = join(dir, "config.yml");
  return {
    configs: existsSync(configPath) ? [{ layer, path: configPath, text: await readFile(configPath, "utf8") }] : [],
    agents: await readDir(join(dir, "agents"), [".md"], layer),
    workflows: await readDir(join(dir, "workflows"), [".yml", ".yaml"], layer),
    subflows: await readDir(join(dir, "flows"), [".yml", ".yaml"], layer),
    decisions: await readDir(join(dir, "decisions"), [".yml", ".yaml"], layer),
  };
}

/** Writes a YAML file, keeping comments and layout of what did not change. */
export async function writeYaml(path: string, value: unknown): Promise<void> {
  const original = existsSync(path) ? await readFile(path, "utf8") : undefined;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, updateYamlText(original, value), "utf8");
}

/** Saves a migrated file and keeps the original next to it as <file>.bak. */
export async function writeMigrated(file: LoadedFile<unknown>): Promise<void> {
  if (!file.migrated || file.layer === "preset") return;
  await copyFile(file.path, `${file.path}.bak`);
  await writeYaml(file.path, file.migrated);
}

/** "Harness: Customize": copies the preset into a layer folder without overwriting edits. */
export async function copyPreset(dir: string): Promise<string[]> {
  const written: string[] = [];
  for (const file of presetFiles()) {
    const path = join(dir, file.path);
    if (existsSync(path)) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.text, "utf8");
    written.push(path);
  }
  return written;
}

/** Appends a decision to .harness/decisions/<session>.yml, validated by the decisions schema. */
export async function appendDecision(dir: string, sessionId: string, decision: Decision): Promise<string> {
  const path = join(dir, "decisions", `${sessionId}.yml`);
  let decisions: Decision[] = [];
  if (existsSync(path)) {
    const parsed = DecisionsFile.safeParse(parseYaml(await readFile(path, "utf8")).value);
    if (parsed.success) decisions = parsed.data.decisions;
  }
  decisions = [...decisions.filter((d) => d.id !== decision.id), decision];
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyYaml({ schema_version: 1, decisions }, " Decisions made during a harness session"), "utf8");
  return path;
}
