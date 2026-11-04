import type { HarnessConfig } from "../schema/config.ts";
import { isFindingsDefault } from "../schema/findings.ts";
import { parseModelRef } from "../schema/models.ts";
import { catalogReportsPricing, requiresApiKey, type Provider } from "../schema/providers.ts";
import { error, warning, type Issue } from "../util/issues.ts";
import { originOf, type LayerName, type MergedConfig } from "./merge.ts";

export interface ValidateConfigOptions {
  /** Names of the orchestrations that exist, to check `defaults.flow`. */
  flows?: readonly string[];
  /** Require the parts the engine cannot run without (router default). True for merged configs. */
  complete?: boolean;
}

/**
 * Cross-field checks the schema cannot express. Paths point into the given config. Tolerates
 * schema-invalid input, so editors can show both kinds of errors at once.
 */
export function validateConfig(config: HarnessConfig, options: ValidateConfigOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const providers = new Map<string, Provider>();

  (config.providers ?? []).forEach((provider, index) => {
    const path = ["providers", index];
    if (providers.has(provider.id)) issues.push(error([...path, "id"], `Duplicate provider id "${provider.id}"`));
    providers.set(provider.id, provider);
    if (provider.type === "cli" && !provider.command) {
      issues.push(error([...path, "command"], "cli providers need a command, e.g. `codex exec`"));
    }
    if (provider.type === "openai-compatible" && !provider.base_url) {
      issues.push(error([...path, "base_url"], "openai-compatible providers need a base_url"));
    }
    const labels = new Set<string>();
    (provider.profiles ?? []).forEach((profile, i) => {
      if (labels.has(profile.label)) {
        issues.push(error([...path, "profiles", i, "label"], `Duplicate profile "${profile.label}"`));
      }
      labels.add(profile.label);
    });
    if (provider.active_profile && !labels.has(provider.active_profile)) {
      issues.push(error([...path, "active_profile"], `No profile named "${provider.active_profile}"`));
    }
    if (provider.type === "cli" && provider.profiles?.length) {
      issues.push(warning([...path, "profiles"], "cli providers use the CLI's own session; profiles are ignored"));
    }
    if (requiresApiKey(provider) && !provider.profiles?.length) {
      issues.push(warning([...path, "profiles"], `${provider.type} needs an API key: add a credential profile`));
    }
  });

  const favorites = config.models ?? [];
  const refs = new Set<string>();
  favorites.forEach((model, index) => {
    const path = ["models", index, "ref"];
    if (typeof model.ref !== "string") return;
    if (refs.has(model.ref)) issues.push(error(path, `Duplicate favorite "${model.ref}"`));
    refs.add(model.ref);
    issues.push(...checkRef(model.ref, path, providers));
    const provider = providers.get(safeProvider(model.ref) ?? "");
    if (provider && !model.pricing && !provider.local && provider.type !== "cli" && !catalogReportsPricing(provider.type)) {
      issues.push(
        warning(["models", index, "pricing"], "No pricing: its cost is unknown, so max_cost and the per-profile cost budget cannot apply to it"),
      );
    }
  });

  const checkTarget = (target: string | undefined, path: (string | number)[]) => {
    if (typeof target !== "string") return;
    if (target.startsWith("role:")) {
      const role = target.slice(5);
      if (!favorites.some((m) => m.roles?.includes(role as never))) {
        issues.push(warning(path, `No favorite has the role "${role}" yet`));
      }
      return;
    }
    issues.push(...checkRef(target, path, providers));
    if (!refs.has(target)) {
      issues.push(warning(path, `"${target}" is not a favorite; its capabilities are unknown`));
    }
  };

  const localOnly = (target: string | undefined, path: (string | number)[]) => {
    if (typeof target !== "string") return;
    issues.push(...stayLocalIssues(target, path, config));
  };

  const ruleNames = new Set<string>();
  (config.router?.rules ?? []).forEach((rule, index) => {
    const path = ["router", "rules", index];
    if (ruleNames.has(rule.name)) issues.push(error([...path, "name"], `Duplicate rule name "${rule.name}"`));
    ruleNames.add(rule.name);
    const fallback = rule.fallback ?? [];
    checkTarget(rule.use, [...path, "use"]);
    fallback.forEach((target, i) => checkTarget(target, [...path, "fallback", i]));
    if (fallback.length === 0) issues.push(error([...path, "fallback"], "Add at least one backup model"));
    if (rule.stay_local) {
      localOnly(rule.use, [...path, "use"]);
      fallback.forEach((target, i) => localOnly(target, [...path, "fallback", i]));
    }
    if (Object.keys(rule.when ?? {}).length === 0) {
      issues.push(warning([...path, "when"], "This rule has no conditions and matches every task"));
    }
  });

  const routerDefault = config.router?.default;
  if (routerDefault) {
    checkTarget(routerDefault.use, ["router", "default", "use"]);
    (routerDefault.fallback ?? []).forEach((t, i) => checkTarget(t, ["router", "default", "fallback", i]));
  } else if (options.complete) {
    issues.push(error(["router"], "The router needs a default route"));
  }

  const thresholds = config.router?.thresholds;
  if (thresholds?.short && thresholds.medium) {
    if (thresholds.short.max_tokens > thresholds.medium.max_tokens) {
      issues.push(error(["router", "thresholds", "short", "max_tokens"], "short must not exceed medium"));
    }
    if (thresholds.short.max_files > thresholds.medium.max_files) {
      issues.push(error(["router", "thresholds", "short", "max_files"], "short must not exceed medium"));
    }
  }

  const findingNames = new Set<string>();
  const routing = config.findings_routing ?? [];
  routing.forEach((entry, index) => {
    const path = ["findings_routing", index];
    if (isFindingsDefault(entry)) {
      if (index !== routing.length - 1) issues.push(error(path, "The default entry must be the last one"));
      if (entry.default.route === "command_fix" && !entry.default.fix) {
        issues.push(error([...path, "default", "fix"], "command_fix needs a fix command"));
      }
      return;
    }
    if (findingNames.has(entry.name)) issues.push(error([...path, "name"], `Duplicate name "${entry.name}"`));
    findingNames.add(entry.name);
    if (entry.route === "command_fix" && !entry.fix) {
      issues.push(error([...path, "fix"], "command_fix needs a fix command"));
    }
    if ((entry.route === "command_fix" || entry.route === "worker_then_command") && !entry.verify) {
      issues.push(error([...path, "verify"], `${entry.route} needs a verify command`));
    }
  });
  if (routing.filter(isFindingsDefault).length > 1) {
    issues.push(error(["findings_routing"], "Only one default entry is allowed"));
  }

  (config.security?.destructive_patterns ?? []).forEach((pattern, index) => {
    try {
      new RegExp(pattern);
    } catch {
      issues.push(error(["security", "destructive_patterns", index], "Invalid regular expression"));
    }
  });

  if (options.flows && config.defaults?.flow && !options.flows.includes(config.defaults.flow)) {
    issues.push(error(["defaults", "flow"], `No orchestration named "${config.defaults.flow}"`));
  }
  return issues;
}

/** A merged configuration and the cross-field issues `validateConfig` found in it. */
export interface CheckedConfig {
  merged: MergedConfig;
  issues: readonly Issue[];
}

/**
 * Errors that block saving `layer`: the ones that layer owns and the ones the edit introduced.
 * Errors that already existed in other layers are reported but do not block. The configuration
 * screen and the extension both apply this rule, so a Save the screen allows is never rejected.
 */
export function blockingErrors(layer: LayerName, after: CheckedConfig, before: CheckedConfig): Issue[] {
  const keyOf = (issue: Issue, { merged }: CheckedConfig) => {
    const origin = originOf(merged.origins, issue.path);
    return `${origin ? `${origin.layer}:${origin.path.join(".")}` : issue.path.join(".")}|${issue.message}`;
  };
  const existing = new Set(before.issues.map((issue) => keyOf(issue, before)));
  return after.issues.filter(
    (issue) =>
      issue.severity === "error" &&
      (originOf(after.merged.origins, issue.path)?.layer === layer || !existing.has(keyOf(issue, after))),
  );
}

/**
 * A stay_local chain may only use models on providers marked `local: true`. A model named
 * directly is an error; the remote favorites of a role are skipped at run time, so they warn.
 */
export function stayLocalIssues(target: string, path: (string | number)[], config: Pick<HarnessConfig, "providers" | "models">): Issue[] {
  const remote = (ref: string) => {
    const provider = safeProvider(ref);
    return provider !== undefined && (config.providers ?? []).find((p) => p.id === provider)?.local !== true;
  };
  if (!target.startsWith("role:")) {
    return remote(target) ? [error(path, `stay_local only allows local providers; "${target}" is not on a local provider`)] : [];
  }
  const skipped = (config.models ?? []).filter((m) => m.roles?.includes(target.slice(5) as never) && remote(m.ref)).map((m) => `"${m.ref}"`);
  return skipped.length ? [warning(path, `stay_local skips ${skipped.join(", ")} from ${target}: not on a local provider`)] : [];
}

function safeProvider(ref: string): string | undefined {
  try {
    return parseModelRef(ref).provider;
  } catch {
    return undefined;
  }
}

function checkRef(ref: string, path: (string | number)[], providers: Map<string, Provider>): Issue[] {
  let parsed;
  try {
    parsed = parseModelRef(ref);
  } catch (e) {
    return [error(path, (e as Error).message)];
  }
  const provider = providers.get(parsed.provider);
  if (!provider) return [error(path, `Unknown provider "${parsed.provider}"`)];
  if (parsed.profile && !(provider.profiles ?? []).some((p) => p.label === parsed.profile)) {
    return [error(path, `Provider "${provider.id}" has no profile "${parsed.profile}"`)];
  }
  if (provider.enabled === false) return [warning(path, `Provider "${provider.id}" is disabled; the router skips this model`)];
  return [];
}
