import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import {
  AdapterRegistry,
  discoverLocalServers,
  probeToolCalling,
  readLayer,
  writeMigrated,
  writeYaml,
  type DiscoveredServer,
} from "@delamain/adapters";
import {
  activeProfile,
  baseModelRef,
  blockingErrors,
  ConfigFile,
  Flow,
  formatIssue,
  harnessLibrary,
  loadHarness,
  mergeLayers,
  mergeSources,
  parseModelRef,
  parseYaml,
  presetSources,
  PRESET_CONFIG_YAML,
  providerBaseUrl,
  requiresApiKey,
  resolveLimits,
  validateConfig,
  validateFlow,
  validateWith,
  type CheckedConfig,
  type DiscoveredModels,
  type HarnessSnapshot,
  type Health,
  type Issue,
  type ModelInfo,
  type ResolvedHarness,
} from "@delamain/core";
import type { Log } from "./log.ts";
import type { Secrets } from "./secrets.ts";

export type Destination = "global" | "project";

const CATALOGS_KEY = "harness.catalogs";

/** Where catalogs are kept between VS Code sessions; in the extension this is `globalState`. */
export interface CatalogCache {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * Loads the four configuration layers (preset, global, project; the session layer is the
 * chat's choice), keeps provider health and catalogs, and saves edits back to YAML.
 */
export class HarnessService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  resolved: ResolvedHarness;
  readonly registry: AdapterRegistry;
  readonly health: Record<string, Health> = {};
  readonly catalogs: Record<string, ModelInfo[]> = {};
  discovered: DiscoveredServer[] = [];
  /** Base refs of favorites whose local server no longer has them loaded. */
  readonly unavailableModels = new Set<string>();
  /** Goes up whenever a stored API key changes, so running sessions retry rejected profiles. */
  secretsVersion = 0;
  private secretStatus: Record<string, boolean> = {};
  private readonly disposables: vscode.Disposable[] = [];
  private globalWatcher: vscode.Disposable | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private reloading: Promise<void> | undefined;
  private queuedReload: Promise<void> | undefined;

  constructor(
    private readonly secrets: Secrets,
    private readonly log: Log,
    private readonly cache?: CatalogCache,
  ) {
    this.resolved = loadHarness(presetSources());
    this.registry = new AdapterRegistry(this.resolved.config, secrets);
    this.disposables.push(
      secrets.onDidChange(() => {
        this.registry.invalidate();
        for (const [id, health] of Object.entries(this.health)) if (health.status === "auth_error") delete this.health[id];
        this.secretsVersion++;
        void this.refreshSecrets().then(() => this.changed.fire());
      }),
    );
  }

  get globalDir(): string {
    const setting = vscode.workspace.getConfiguration("harness").get<string>("globalDirectory");
    return setting?.trim() ? setting.trim().replace(/^~(?=$|\/)/, homedir()) : join(homedir(), ".harness");
  }

  get workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  get projectDir(): string | undefined {
    const root = this.workspaceRoot;
    return root ? join(root, ".harness") : undefined;
  }

  dirOf(destination: Destination): string | undefined {
    return destination === "global" ? this.globalDir : this.projectDir;
  }

  watch(): void {
    this.watchGlobal();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) this.disposables.push(this.watcher(new vscode.RelativePattern(folder, ".harness/**/*")));
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("harness.globalDirectory")) return;
        this.watchGlobal();
        this.reloadInBackground();
      }),
    );
  }

  private watchGlobal(): void {
    this.globalWatcher?.dispose();
    this.globalWatcher = this.watcher(new vscode.RelativePattern(vscode.Uri.file(this.globalDir), "**/*"));
  }

  private watcher(pattern: vscode.GlobPattern): vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const reload = () => this.reloadInBackground();
    watcher.onDidChange(reload);
    watcher.onDidCreate(reload);
    watcher.onDidDelete(reload);
    return watcher;
  }

  private reloadInBackground(): void {
    void this.reload().catch((e: unknown) => this.log.error("Could not reload the configuration", e));
  }

  /**
   * Concurrent calls share one reload, but a call made while a reload is running gets the next
   * one: the running reload may have read the files before the caller wrote them.
   */
  reload(): Promise<void> {
    if (!this.reloading) {
      this.reloading = this.doReload().finally(() => (this.reloading = undefined));
      return this.reloading;
    }
    this.queuedReload ??= this.reloading
      .catch(() => undefined)
      .then(() => {
        this.queuedReload = undefined;
        return this.reload();
      });
    return this.queuedReload;
  }

  private async doReload(): Promise<void> {
    const layers = [presetSources(), await readLayer(this.globalDir, "global")];
    if (this.projectDir) layers.push(await readLayer(this.projectDir, "project"));
    this.resolved = loadHarness(mergeSources(...layers));
    for (const file of this.resolved.configFiles) {
      if (file.migratedFrom !== undefined) {
        await writeMigrated(file);
        this.log.info(`Migrated ${file.path} from schema_version ${file.migratedFrom}; the original is in ${file.path}.bak`);
      }
    }
    this.registry.update(this.resolved.config);
    this.pruneUnavailable();
    this.restoreCatalogs();
    await this.refreshSecrets();
    const errors = this.resolved.issues.filter((i) => i.severity === "error");
    if (errors.length) this.log.warn(`Configuration has ${errors.length} error(s):\n${errors.map(formatIssue).join("\n")}`);
    this.changed.fire();
    this.scheduleRefresh();
  }

  private async refreshSecrets(): Promise<void> {
    const status: Record<string, boolean> = {};
    for (const layer of ["global", "project"] as const) {
      for (const provider of this.layerConfig(layer)?.providers ?? []) {
        for (const profile of provider.profiles ?? []) status[profile.secret] = await this.secrets.has(profile.secret);
      }
    }
    for (const provider of this.resolved.config.providers ?? []) {
      for (const profile of provider.profiles ?? []) status[profile.secret] ??= await this.secrets.has(profile.secret);
    }
    this.secretStatus = status;
  }

  layerConfig(layer: "preset" | Destination): Partial<ConfigFile> | undefined {
    return this.resolved.configFiles.find((f) => f.layer === layer)?.value;
  }

  private layerPath(layer: Destination): string | undefined {
    const dir = this.dirOf(layer);
    return dir ? join(dir, "config.yml") : undefined;
  }

  snapshot(): HarnessSnapshot {
    const preset = parseYaml(PRESET_CONFIG_YAML).value as Partial<ConfigFile>;
    const layers: HarnessSnapshot["layers"] = { preset };
    const global = this.layerConfig("global");
    const project = this.layerConfig("project");
    if (global) layers.global = global;
    if (project) layers.project = project;
    const layerPaths: HarnessSnapshot["layerPaths"] = { global: this.layerPath("global")! };
    const projectPath = this.layerPath("project");
    if (projectPath) layerPaths.project = projectPath;
    return {
      layers,
      layerPaths,
      merged: this.resolved.config,
      origins: this.resolved.origins,
      flows: [
        ...[...this.resolved.flows.entries()].map(([name, entry]) => ({ name, layer: entry.layer, path: entry.path, flow: entry.flow })),
        ...[...this.resolved.invalidFlows.entries()]
          .filter(([name]) => !this.resolved.flows.has(name))
          .map(([name, entry]) => ({ name, layer: entry.layer, path: entry.path, flow: entry.flow, invalid: true })),
      ],
      subflows: [...this.resolved.subflows].filter(([ref]) => ref.startsWith("flows/")).map(([ref, flow]) => ({ ref, name: flow.name, flow })),
      agents: [...this.resolved.agents.values()].map((a) => ({ name: a.name, role: a.role, ...(a.source ? { source: a.source } : {}) })),
      issues: this.resolved.issues,
      secrets: this.secretStatus,
      health: this.health,
      catalogs: this.catalogs,
      discovered: this.discovered.map((s) => ({ id: s.id, label: s.label, base_url: s.base_url, models: s.models.map((m) => m.id) })),
      trusted: vscode.workspace.isTrusted,
      hasProject: this.projectDir !== undefined,
    };
  }

  /** Models reported by providers, so favorites get their context window and pricing. */
  discoveredModels(): DiscoveredModels[] {
    return Object.entries(this.catalogs).map(([provider, models]) => ({ provider, models }));
  }

  async saveConfig(destination: Destination, config: Partial<ConfigFile>): Promise<{ ok: boolean; issues: Issue[]; path?: string }> {
    const dir = this.dirOf(destination);
    if (!dir) return { ok: false, issues: [{ severity: "error", path: [], message: "Open a folder to save project configuration" }] };
    const value = { schema_version: 1 as const, ...config };
    const schema = validateWith(ConfigFile, value);
    if (!schema.ok) return { ok: false, issues: schema.issues };
    const after = this.checkWith(destination, schema.value);
    const blocking = blockingErrors(destination, after, this.checkWith(destination, this.layerConfig(destination)));
    if (blocking.length) return { ok: false, issues: blocking };
    const path = join(dir, "config.yml");
    await writeYaml(path, value);
    await this.reload();
    return { ok: true, issues: [...after.issues], path };
  }

  /** The merged configuration with `config` in place of the destination layer, and its issues. */
  private checkWith(destination: Destination, config: Partial<ConfigFile> | undefined): CheckedConfig {
    const merged = mergeLayers(
      (["preset", "global", "project"] as const).map((name) => ({ name, config: name === destination ? config : this.layerConfig(name) })),
    );
    return { merged, issues: validateConfig(merged.config, { complete: true, flows: [...this.resolved.flows.keys()] }) };
  }

  async saveFlow(destination: Destination, name: string, flow: Flow, previousName?: string): Promise<{ ok: boolean; issues: Issue[]; path?: string }> {
    const dir = this.dirOf(destination);
    if (!dir) return { ok: false, issues: [{ severity: "error", path: [], message: "Open a folder to save project flows" }] };
    const parsed = validateWith(Flow, { ...flow, schema_version: 1, name });
    if (!parsed.ok) return { ok: false, issues: parsed.issues };
    const issues = validateFlow(parsed.value as Flow, {
      limits: resolveLimits(this.resolved.config.limits),
      agents: this.resolved.agents,
      library: harnessLibrary(this.resolved, { includeInvalid: true }),
      config: this.resolved.config,
    });
    if (issues.some((i) => i.severity === "error")) return { ok: false, issues };
    const files = await this.flowFiles(dir, destination);
    const renaming = previousName !== undefined && previousName !== name;
    if (renaming && files.has(name)) {
      return { ok: false, issues: [{ severity: "error", path: ["name"], message: `The ${destination} layer already has a flow named "${name}"` }] };
    }
    const current = files.get(renaming ? previousName : name);
    const path = !renaming && current ? current : join(dir, "workflows", `${slug(name)}.yml`);
    if (path !== current && existsSync(path)) {
      return { ok: false, issues: [{ severity: "error", path: ["name"], message: `${path} already exists; choose another name` }] };
    }
    await writeYaml(path, parsed.value);
    if (current && current !== path) await rm(current, { force: true });
    await this.reload();
    return { ok: true, issues, path };
  }

  async deleteFlow(destination: Destination, name: string): Promise<void> {
    const dir = this.dirOf(destination);
    const path = dir ? (await this.flowFiles(dir, destination)).get(name) : undefined;
    if (!path) return;
    await rm(path, { force: true });
    await this.reload();
  }

  /**
   * Flow name to file in one layer folder, read from disk: the loaded flows only keep the winning
   * layer of each name and the file name need not match the flow name.
   */
  private async flowFiles(dir: string, layer: Destination): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    for (const file of (await readLayer(dir, layer)).workflows) {
      const name = (parseYaml(file.text).value as { name?: unknown } | null | undefined)?.name;
      if (typeof name === "string") files.set(name, file.path);
    }
    return files;
  }

  async testConnection(providerId: string): Promise<Health> {
    const adapter = await this.registry.get(providerId).catch((e: Error) => {
      this.health[providerId] = { status: "offline", message: e.message };
      return undefined;
    });
    if (!adapter) return this.health[providerId] ?? { status: "offline", message: "Unknown provider" };
    const health = await adapter.healthCheck();
    this.health[providerId] = health;
    if (health.status === "online") await this.loadCatalog(providerId).catch(() => undefined);
    this.changed.fire();
    return health;
  }

  async loadCatalog(providerId: string): Promise<ModelInfo[]> {
    const adapter = await this.registry.get(providerId);
    if (!adapter) return [];
    const models = await adapter.listModels();
    this.setCatalog(providerId, models);
    this.updateUnavailable(providerId, models);
    return models;
  }

  /**
   * Billing contexts the router must skip: profiles of key-only APIs without a stored key, and
   * the active profile when the last connection test rejected its key.
   */
  credentialProblems(): Map<string, string> {
    const problems = new Map<string, string>();
    for (const provider of this.resolved.config.providers ?? []) {
      if (provider.enabled === false || provider.type === "cli") continue;
      const profiles = provider.profiles ?? [];
      if (requiresApiKey(provider)) {
        if (!profiles.length) problems.set(provider.id, "no credential profile");
        for (const profile of profiles) {
          if (this.secretStatus[profile.secret] !== true) problems.set(`${provider.id}@${profile.label}`, "no API key stored");
        }
      }
      if (this.health[provider.id]?.status === "auth_error") {
        const active = activeProfile(provider);
        problems.set(active ? `${provider.id}@${active.label}` : provider.id, "authentication failed");
      }
    }
    return problems;
  }

  /** Catalogs are keyed by type and endpoint in the cache, so they survive renames and restarts. */
  private catalogKey(providerId: string): string | undefined {
    const provider = (this.resolved.config.providers ?? []).find((p) => p.id === providerId);
    return provider ? `${provider.type}|${providerBaseUrl(provider) ?? provider.command ?? ""}` : undefined;
  }

  private setCatalog(providerId: string, models: ModelInfo[]): void {
    this.catalogs[providerId] = models;
    const key = this.catalogKey(providerId);
    if (!this.cache || !key) return;
    const stored = this.cache.get<Record<string, ModelInfo[]>>(CATALOGS_KEY) ?? {};
    void this.cache.update(CATALOGS_KEY, { ...stored, [key]: models });
  }

  private restoreCatalogs(): void {
    const stored = this.cache?.get<Record<string, ModelInfo[]>>(CATALOGS_KEY);
    if (!stored) return;
    for (const provider of this.resolved.config.providers ?? []) {
      const key = this.catalogKey(provider.id);
      if (!this.catalogs[provider.id] && key && stored[key]) this.catalogs[provider.id] = stored[key];
    }
  }

  async probe(ref: string): Promise<{ toolCalling: boolean | undefined; contextWindow?: number; message: string }> {
    const parsed = parseModelRef(ref);
    const adapter = await this.registry.get(parsed.provider, parsed.profile);
    if (!adapter) return { toolCalling: undefined, message: `Unknown provider ${parsed.provider}` };
    const result = await probeToolCalling(adapter, parsed.model);
    const contextWindow = this.catalogs[parsed.provider]?.find((m) => m.id === parsed.model)?.contextWindow;
    return { ...result, ...(contextWindow ? { contextWindow } : {}) };
  }

  /** "Find local servers": GET /v1/models on each known port with a short timeout. */
  async discover(): Promise<DiscoveredServer[]> {
    const discovery = this.resolved.config.discovery;
    this.discovered = await discoverLocalServers(discovery?.servers ?? [], discovery?.timeout_ms ?? 300);
    for (const server of this.discovered) {
      const provider = (this.resolved.config.providers ?? []).find((p) => p.base_url?.replace(/\/$/, "") === server.base_url.replace(/\/$/, ""));
      if (provider) {
        this.setCatalog(provider.id, server.models);
        this.health[provider.id] = { status: "online", latencyMs: server.latencyMs, models: server.models.length };
        this.updateUnavailable(provider.id, server.models);
      }
    }
    for (const provider of this.resolved.config.providers ?? []) {
      if (provider.local && !this.discovered.some((s) => s.base_url.replace(/\/$/, "") === provider.base_url?.replace(/\/$/, ""))) {
        const health = await (await this.registry.get(provider.id))?.healthCheck().catch(() => undefined);
        if (health) this.health[provider.id] = health;
        if (health?.status === "online") await this.loadCatalog(provider.id).catch(() => undefined);
      }
    }
    this.changed.fire();
    return this.discovered;
  }

  /** The model loaded in local apps can change at any time; a missing favorite is skipped. */
  private updateUnavailable(providerId: string, models: ModelInfo[]): void {
    const provider = (this.resolved.config.providers ?? []).find((p) => p.id === providerId);
    if (!provider?.local) return;
    const loaded = new Set(models.map((m) => `${providerId}/${m.id}`));
    for (const favorite of this.resolved.config.models ?? []) {
      const base = baseModelRef(favorite.ref);
      if (!base.startsWith(`${providerId}/`)) continue;
      if (loaded.has(base)) this.unavailableModels.delete(base);
      else this.unavailableModels.add(base);
    }
  }

  private pruneUnavailable(): void {
    const favorites = new Set((this.resolved.config.models ?? []).map((m) => baseModelRef(m.ref)));
    const local = new Set((this.resolved.config.providers ?? []).filter((p) => p.local).map((p) => p.id));
    for (const ref of this.unavailableModels) {
      if (!favorites.has(ref) || !local.has(parseModelRef(ref).provider)) this.unavailableModels.delete(ref);
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    const discovery = this.resolved.config.discovery;
    if (discovery?.enabled === false) return;
    const seconds = discovery?.refresh_seconds ?? 60;
    this.refreshTimer = setInterval(() => void this.discover().catch(() => undefined), seconds * 1000);
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.globalWatcher?.dispose();
    for (const d of this.disposables) d.dispose();
    this.changed.dispose();
  }
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "flow";
}
