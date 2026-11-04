import type { HarnessConfig } from "../schema/config.ts";
import type { ResolvedLimits } from "../schema/limits.ts";
import { providerMaxConcurrent } from "../schema/providers.ts";
import { profileKey, type Catalog, type CatalogModel } from "./catalog.ts";
import {
  advanceChain,
  DEFAULT_CONTEXT_MARGIN,
  route,
  type AdvanceCause,
  type RouteDecision,
  type RouteOptions,
  type RouteRequest,
  type RouterState,
} from "./route.ts";

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    }),
};

/** How long a provider that failed stays out of the chains before it is tried again. */
export const OFFLINE_COOLDOWN_MS = 60_000;

export interface ProfileUsage {
  tokens: number;
  costUsd: number;
}

class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: number) {}

  get busy(): boolean {
    return this.active >= this.max;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => resolve();
      this.queue.push(grant);
      signal?.addEventListener(
        "abort",
        () => {
          const index = this.queue.indexOf(grant);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason);
        },
        { once: true },
      );
    });
    this.active++;
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }
}

/**
 * Stateful wrapper around the pure router: provider health, per-profile session budgets and
 * per-provider concurrency slots.
 */
export class RouterService {
  readonly health: RouterState["providers"] = {};
  /** Base refs a local server no longer has loaded, kept in sync with discovery. */
  readonly unavailableModels = new Set<string>();
  /** Base refs a provider answered 404 for during this session. */
  readonly missingModels = new Set<string>();
  readonly exhaustedProfiles = new Set<string>();
  readonly credentialProblems = new Map<string, string>();
  readonly usage = new Map<string, ProfileUsage>();
  private readonly slots = new Map<string, Semaphore>();

  constructor(
    readonly config: HarnessConfig,
    readonly catalog: Catalog,
    readonly limits: ResolvedLimits,
    readonly options: RouteOptions,
    private readonly clock: Clock = systemClock,
  ) {}

  state(): RouterState {
    return {
      now: this.clock.now(),
      providers: this.health,
      unavailableModels: this.missingModels.size ? new Set([...this.unavailableModels, ...this.missingModels]) : this.unavailableModels,
      exhaustedProfiles: this.exhaustedProfiles,
      credentialProblems: this.credentialProblems,
    };
  }

  route(request: RouteRequest, overrides: Partial<RouteOptions> = {}): RouteDecision {
    return route(request, this.config, this.catalog, this.state(), { ...this.options, ...overrides });
  }

  advance(decision: RouteDecision, from: number, cause: AdvanceCause, request: RouteRequest): number | undefined {
    const margin = this.config.router?.context_margin_tokens ?? DEFAULT_CONTEXT_MARGIN;
    return advanceChain(decision, from, cause, request, this.catalog, this.state(), margin);
  }

  markRateLimited(provider: string, retryAfterMs: number | undefined): void {
    this.health[provider] = { status: "rate_limited", untilMs: this.clock.now() + (retryAfterMs ?? 30_000) };
  }

  /** Outages are usually transient, so the provider is tried again after a cooldown. */
  markOffline(provider: string, forMs = OFFLINE_COOLDOWN_MS): void {
    this.health[provider] = { status: "offline", untilMs: this.clock.now() + forMs };
  }

  markOnline(provider: string): void {
    this.health[provider] = { status: "online" };
  }

  markModelMissing(baseRef: string): void {
    this.missingModels.add(baseRef);
  }

  markCredentialProblem(profileKey: string, reason: string): void {
    this.credentialProblems.set(profileKey, reason);
  }

  /** Adds usage to the model's profile; returns true when that profile's budget ran out. */
  recordUsage(model: CatalogModel, tokens: number, costUsd: number): boolean {
    const key = profileKey(model);
    const current = this.usage.get(key) ?? { tokens: 0, costUsd: 0 };
    current.tokens += tokens;
    current.costUsd += costUsd;
    this.usage.set(key, current);
    const budget = this.limits.session.per_profile;
    const exhausted =
      (budget.max_tokens !== undefined && current.tokens >= budget.max_tokens) ||
      (budget.max_cost_usd !== undefined && current.costUsd >= budget.max_cost_usd);
    if (exhausted) this.exhaustedProfiles.add(key);
    return exhausted;
  }

  slotBusy(provider: string): boolean {
    return this.semaphore(provider).busy;
  }

  acquireSlot(provider: string, signal?: AbortSignal): Promise<() => void> {
    return this.semaphore(provider).acquire(signal);
  }

  private semaphore(provider: string): Semaphore {
    let semaphore = this.slots.get(provider);
    if (!semaphore) {
      const config = this.catalog.providers.get(provider);
      semaphore = new Semaphore(config ? providerMaxConcurrent(config) : 1);
      this.slots.set(provider, semaphore);
    }
    return semaphore;
  }
}
