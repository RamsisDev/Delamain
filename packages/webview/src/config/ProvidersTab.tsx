import { useState } from "react";
import {
  MAX_PROFILES_PER_PROVIDER,
  PROVIDER_TYPES,
  providerBaseUrl,
  type Health,
  type Provider,
  type ProviderType,
} from "@delamain/core";
import { LayerBadge, Pill } from "../components/badges";
import {
  Button,
  Checkbox,
  Field,
  FieldIssues,
  NumberInput,
  OptionalText,
  Select,
  TextInput,
  toOptions,
} from "../components/controls";
import { post } from "../vscode";
import { useConfig } from "./ConfigContext";
import { addEntry, editKeyedEntry, removeKeyedEntry } from "./layers";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function HealthPill({ health }: { health: Health | undefined }) {
  if (!health) return <Pill tone="muted">not tested</Pill>;
  switch (health.status) {
    case "online":
      return (
        <Pill tone="ok">
          online{health.latencyMs !== undefined ? ` · ${health.latencyMs} ms` : ""}
          {health.models !== undefined ? ` · ${health.models} models` : ""}
        </Pill>
      );
    case "offline":
      return (
        <Pill tone="error" title={health.message}>
          offline: {health.message}
        </Pill>
      );
    case "rate_limited":
      return <Pill tone="warning">rate limited until {new Date(health.untilMs).toLocaleTimeString()}</Pill>;
    case "auth_error":
      return (
        <Pill tone="error" title={health.message}>
          auth error: {health.message}
        </Pill>
      );
  }
}

function useProviderEditing(provider: Provider, index: number) {
  const cfg = useConfig();
  const path = ["providers", index] as const;
  const update = (mutate: (p: Provider) => void) => cfg.edit((d) => editKeyedEntry(d, ["providers"], "id", provider, mutate));
  const set = (key: keyof Provider, value: unknown) =>
    update((p) => {
      const record = p as Record<string, unknown>;
      if (value === undefined) delete record[key];
      else record[key] = value;
    });
  return { cfg, path, update, set, at: (...rest: (string | number)[]) => cfg.issuesAt([...path, ...rest]) };
}

function HeadersEditor({ headers, onChange, disabled }: { headers: Record<string, string> | undefined; onChange: (h: Record<string, string> | undefined) => void; disabled: boolean }) {
  const entries = Object.entries(headers ?? {});
  const write = (next: [string, string][]) => onChange(next.length ? Object.fromEntries(next) : undefined);
  return (
    <div className="kv-list">
      {entries.map(([name, value], i) => (
        <div className="kv-row" key={i}>
          <TextInput value={name} disabled={disabled} placeholder="Header" onChange={(n) => write(entries.map((e, j) => (j === i ? [n, e[1]] : e)))} />
          <TextInput value={value} disabled={disabled} placeholder="Value" onChange={(v) => write(entries.map((e, j) => (j === i ? [e[0], v] : e)))} />
          <Button small variant="link" disabled={disabled} onClick={() => write(entries.filter((_, j) => j !== i))}>
            ✕
          </Button>
        </div>
      ))}
      <Button small disabled={disabled} onClick={() => write([...entries, [entries.length ? "" : "HTTP-Referer", ""]])}>
        + Header
      </Button>
    </div>
  );
}

function ProfileRow({ provider, index, profileIndex, disabled }: { provider: Provider; index: number; profileIndex: number; disabled: boolean }) {
  const { cfg, update, at } = useProviderEditing(provider, index);
  const [key, setKey] = useState("");
  const profile = provider.profiles![profileIndex]!;
  const stored = cfg.snapshot.secrets[profile.secret] === true;
  const setField = (field: "label" | "secret", value: string) =>
    update((p) => {
      const target = p.profiles?.[profileIndex];
      if (!target) return;
      if (field === "label" && p.active_profile === target.label) p.active_profile = value;
      target[field] = value;
    });
  return (
    <div className="profile-row">
      <Field label="Label" issues={at("profiles", profileIndex, "label")}>
        <TextInput value={profile.label} disabled={disabled} onChange={(v) => setField("label", v)} />
      </Field>
      <Field label="Secret name" hint="Name in VS Code SecretStorage." issues={at("profiles", profileIndex, "secret")}>
        <TextInput value={profile.secret} disabled={disabled} onChange={(v) => setField("secret", v)} />
      </Field>
      <Field label="API key" badge={stored ? <Pill tone="ok">stored</Pill> : <Pill tone="warning">not set</Pill>}>
        <div className="inline">
          <TextInput type="password" value={key} placeholder={stored ? "•••••• (replace)" : "Paste the key"} onChange={setKey} />
          <Button
            small
            variant="primary"
            disabled={!key || !profile.secret}
            onClick={() => {
              post({ type: "secret.set", secret: profile.secret, value: key });
              setKey("");
            }}
          >
            Store
          </Button>
          {stored ? (
            <Button small onClick={() => post({ type: "secret.delete", secret: profile.secret })}>
              Forget
            </Button>
          ) : null}
        </div>
      </Field>
      <Button
        small
        variant="link"
        disabled={disabled}
        title="Remove profile"
        onClick={() =>
          update((p) => {
            const removed = p.profiles?.splice(profileIndex, 1)[0];
            if (removed && p.active_profile === removed.label) delete p.active_profile;
            if (p.profiles?.length === 0) delete p.profiles;
          })
        }
      >
        ✕
      </Button>
    </div>
  );
}

function ProviderCard({ provider, index }: { provider: Provider; index: number }) {
  const { cfg, path, update, set, at } = useProviderEditing(provider, index);
  const owner = cfg.owner(path);
  const editable = cfg.editable(path);
  const owned = owner === cfg.destination;
  const disabled = !editable;
  const saved = cfg.snapshot.merged.providers?.some((p) => p.id === provider.id) === true;
  const profiles = provider.profiles ?? [];

  return (
    <div className="card">
      <div className="card-header">
        <strong>{provider.label ?? provider.id}</strong>
        <span className="muted">
          {provider.id} · {provider.type}
          {provider.local ? " · local" : ""}
        </span>
        <LayerBadge layer={owner} />
        <HealthPill health={cfg.health[provider.id]} />
        <span className="spacer" />
        <Checkbox label="Enabled" checked={provider.enabled !== false} disabled={disabled} onChange={(on) => set("enabled", on ? undefined : false)} />
        <Button small disabled={!saved} title={saved ? "Check the endpoint and the key" : "Save the configuration first"} onClick={() => post({ type: "provider.test", provider: provider.id })}>
          Test connection
        </Button>
        {owned ? (
          <Button small variant="danger" onClick={() => cfg.edit((d) => removeKeyedEntry(d, ["providers"], "id", provider.id))}>
            Remove
          </Button>
        ) : null}
      </div>
      {!editable ? <p className="muted">Defined in the {owner} layer; switch the destination to edit it.</p> : null}
      {editable && !owned ? <p className="muted">Inherited from {owner}: changes are saved as an override in {cfg.destination}.</p> : null}
      <FieldIssues issues={cfg.issuesAt(path)} />
      <div className="form-grid">
        <Field label="Label" issues={at("label")}>
          <OptionalText value={provider.label} disabled={disabled} onChange={(v) => set("label", v)} />
        </Field>
        {provider.type !== "cli" ? <Field label="Base URL" issues={at("base_url")} hint={provider.base_url ? undefined : providerBaseUrl(provider) ?? "Required"}>
          <OptionalText value={provider.base_url} disabled={disabled} placeholder={providerBaseUrl(provider)} onChange={(v) => set("base_url", v)} />
        </Field> : null}
        <Field label="Max concurrent" hint={`Default ${provider.local ? 1 : 4}`} issues={at("max_concurrent")}>
          <NumberInput value={provider.max_concurrent} min={1} disabled={disabled} onChange={(v) => set("max_concurrent", v)} />
        </Field>
        <Field label="Local" issues={at("local")}>
          <Checkbox label="Served on this machine or network" checked={provider.local === true} disabled={disabled} onChange={(on) => set("local", on ? true : undefined)} />
        </Field>
        {provider.type === "cli" ? (
          <Field label="Command" issues={at("command")} wide>
            <OptionalText value={provider.command} disabled={disabled} placeholder="codex exec" onChange={(v) => set("command", v)} />
          </Field>
        ) : null}
        {provider.type === "cli" ? (
          <Field label="Prompt input" hint="Use stdin for long prompts and multiline prompts on Windows; the command must read standard input." issues={at("prompt_input")}>
            <Select
              value={provider.prompt_input}
              empty="argument (default)"
              options={toOptions(["argument", "stdin"])}
              disabled={disabled}
              onChange={(v) => set("prompt_input", v)}
            />
          </Field>
        ) : null}
        {provider.type === "openrouter" || provider.headers ? (
          <Field label="Headers" hint="e.g. HTTP-Referer and X-Title for OpenRouter." issues={cfg.issuesUnder([...path, "headers"])} wide>
            <HeadersEditor headers={provider.headers} disabled={disabled} onChange={(h) => set("headers", h)} />
          </Field>
        ) : null}
      </div>
      {provider.type !== "cli" ? (
        <div className="profiles">
          <div className="section-title">
            Credential profiles ({profiles.length}/{MAX_PROFILES_PER_PROVIDER})
            <span className="spacer" />
            {profiles.length ? (
              <Field label="Active profile" issues={at("active_profile")}>
                <Select
                  value={provider.active_profile}
                  empty={`${profiles[0]?.label ?? ""} (first)`}
                  options={toOptions(profiles.map((p) => p.label))}
                  disabled={disabled}
                  onChange={(v) => set("active_profile", v)}
                />
              </Field>
            ) : null}
          </div>
          <FieldIssues issues={at("profiles")} />
          {profiles.map((_, i) => (
            <ProfileRow key={i} provider={provider} index={index} profileIndex={i} disabled={disabled} />
          ))}
          <Button
            small
            disabled={disabled || profiles.length >= MAX_PROFILES_PER_PROVIDER}
            onClick={() =>
              update((p) => {
                const n = (p.profiles?.length ?? 0) + 1;
                p.profiles = [...(p.profiles ?? []), { label: n === 1 ? "Default" : `Profile ${n}`, secret: `harness.${p.id}.${n}` }];
              })
            }
          >
            + Profile
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function AddProvider() {
  const cfg = useConfig();
  const [type, setType] = useState<ProviderType>("openrouter");
  const [id, setId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [command, setCommand] = useState("");
  const taken = new Set((cfg.merged.providers ?? []).map((p) => p.id));
  let suggested: string = type === "openai-compatible" ? "local" : type;
  for (let n = 2; taken.has(suggested); n++) suggested = `${type}-${n}`;
  const finalId = id || suggested;
  const problem = !IDENTIFIER.test(finalId)
    ? "Use letters, digits, '-', '_' or '.'"
    : taken.has(finalId)
      ? `A provider named "${finalId}" exists`
      : type === "openai-compatible" && !baseUrl
        ? "openai-compatible needs a base URL"
        : type === "cli" && !command
          ? "cli providers need a command"
          : undefined;

  return (
    <div className="card add-card">
      <div className="form-grid">
        <Field label="Type">
          <Select value={type} options={toOptions(PROVIDER_TYPES)} onChange={(v) => v && setType(v)} />
        </Field>
        <Field label="Id" hint="First segment of model refs.">
          <TextInput value={id} placeholder={suggested} onChange={setId} />
        </Field>
        {type === "openai-compatible" ? (
          <Field label="Base URL">
            <TextInput value={baseUrl} placeholder="http://localhost:1234/v1" onChange={setBaseUrl} />
          </Field>
        ) : null}
        {type === "cli" ? (
          <Field label="Command">
            <TextInput value={command} placeholder="codex exec" onChange={setCommand} />
          </Field>
        ) : null}
      </div>
      <div className="inline">
        <Button
          variant="primary"
          disabled={problem !== undefined}
          title={problem}
          onClick={() => {
            cfg.edit((d) =>
              addEntry(d, ["providers"], {
                id: finalId,
                type,
                ...(type === "openai-compatible" ? { base_url: baseUrl } : {}),
                ...(type === "cli" ? { command, prompt_input: "stdin" } : {}),
              }),
            );
            setId("");
            setBaseUrl("");
            setCommand("");
          }}
        >
          Add provider
        </Button>
        {problem ? <span className="muted">{problem}</span> : null}
      </div>
    </div>
  );
}

function DiscoveredServers() {
  const cfg = useConfig();
  const taken = new Set((cfg.merged.providers ?? []).map((p) => p.id));
  return (
    <section>
      <div className="section-title">
        Local servers
        <span className="spacer" />
        <Button onClick={() => post({ type: "provider.discover" })}>Find local servers</Button>
      </div>
      {cfg.snapshot.discovered.length === 0 ? (
        <p className="muted">No local server found yet. Start Jan, Ollama, LM Studio, llama.cpp or vLLM and search again.</p>
      ) : (
        <ul className="plain-list">
          {cfg.snapshot.discovered.map((server) => (
            <li key={server.id} className="inline">
              <strong>{server.label}</strong>
              <span className="muted">
                {server.base_url} · {server.models.length} model(s)
              </span>
              <Button
                small
                variant="primary"
                disabled={taken.has(server.id)}
                onClick={() =>
                  cfg.edit((d) =>
                    addEntry(d, ["providers"], {
                      id: server.id,
                      type: "openai-compatible",
                      label: server.label,
                      base_url: server.base_url,
                      local: true,
                      max_concurrent: 1,
                    }),
                  )
                }
              >
                {taken.has(server.id) ? "Added" : "Add"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ProvidersTab() {
  const cfg = useConfig();
  const providers = cfg.merged.providers ?? [];
  return (
    <div className="tab-content">
      <h2>Providers</h2>
      <p className="muted">API keys are stored in VS Code SecretStorage and never written to the configuration files.</p>
      <FieldIssues issues={cfg.issuesAt(["providers"])} />
      {providers.length === 0 ? <p className="muted">No providers yet.</p> : null}
      {providers.map((provider, index) => (
        <ProviderCard key={`${provider.id}-${index}`} provider={provider} index={index} />
      ))}
      <h3>Add a provider</h3>
      <AddProvider />
      <DiscoveredServers />
    </div>
  );
}
