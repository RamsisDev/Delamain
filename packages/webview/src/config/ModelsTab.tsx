import { useMemo, useState } from "react";
import { FAVORITE_ROLES, parseModelRef, type FavoriteModel, type ModelInfo, type Pricing } from "@delamain/core";
import { LayerBadge, Pill } from "../components/badges";
import { Button, Chips, Field, FieldIssues, NumberInput, OptionalText, Select, TextInput, TriState, cx, toOptions } from "../components/controls";
import { useToggleSet } from "../hooks";
import { formatTokens } from "../util/format";
import { post } from "../vscode";
import { useConfig } from "./ConfigContext";
import { addEntry, editKeyedEntry, removeKeyedEntry } from "./layers";

const LIST_LIMIT = 200;

function safeParse(ref: string) {
  try {
    return parseModelRef(ref);
  } catch {
    return undefined;
  }
}

function baseOf(ref: string): string {
  const parsed = safeParse(ref);
  return parsed ? `${parsed.provider}/${parsed.model}` : ref;
}

function infoIn(catalogs: Record<string, ModelInfo[]>, ref: string): ModelInfo | undefined {
  const parsed = safeParse(ref);
  return parsed ? catalogs[parsed.provider]?.find((m) => m.id === parsed.model) : undefined;
}

function describeCapabilities(info: { contextWindow?: number | undefined; toolCalling?: boolean | undefined; pricing?: Pricing | undefined } | undefined): string {
  if (!info) return "";
  const parts: string[] = [];
  if (info.contextWindow) parts.push(`${formatTokens(info.contextWindow)} ctx`);
  if (info.toolCalling !== undefined) parts.push(info.toolCalling ? "tools" : "no tools");
  if (info.pricing) parts.push(`$${info.pricing.input_per_mtok}/$${info.pricing.output_per_mtok} per Mtok`);
  return parts.join(" · ");
}

function FavoriteEditor({ favorite, index, detected }: { favorite: FavoriteModel; index: number; detected: ModelInfo | undefined }) {
  const cfg = useConfig();
  const path = ["models", index];
  const disabled = !cfg.editable(path);
  const at = (...rest: (string | number)[]) => cfg.issuesAt([...path, ...rest]);
  const update = (mutate: (f: FavoriteModel) => void) => cfg.edit((d) => editKeyedEntry(d, ["models"], "ref", favorite, mutate));
  const set = (key: keyof FavoriteModel, value: unknown) =>
    update((f) => {
      const record = f as Record<string, unknown>;
      if (value === undefined) delete record[key];
      else record[key] = value;
    });
  const setPricing = (key: keyof Pricing, value: number | undefined) =>
    update((f) => {
      const next: Record<string, number> = { ...f.pricing };
      if (value === undefined) delete next[key];
      else next[key] = value;
      if (Object.keys(next).length) f.pricing = next as Pricing;
      else delete f.pricing;
    });
  const parsed = safeParse(favorite.ref);
  const provider = cfg.merged.providers?.find((p) => p.id === parsed?.provider);
  const probe = cfg.probes[favorite.ref];

  return (
    <div className="favorite-editor">
      <FieldIssues issues={at()} />
      <div className="form-grid">
        <Field label="Label" issues={at("label")}>
          <OptionalText value={favorite.label} disabled={disabled} placeholder={detected?.label ?? parsed?.model} onChange={(v) => set("label", v)} />
        </Field>
        <Field label="Billed to profile" hint="Pins the favorite with @profile; empty uses the provider's active profile." issues={at("ref")}>
          <Select
            value={parsed?.profile}
            empty="active profile"
            disabled={disabled || !parsed}
            options={toOptions((provider?.profiles ?? []).map((p) => p.label))}
            onChange={(profile) =>
              parsed && set("ref", `${parsed.provider}/${parsed.model}${profile ? `@${profile}` : ""}`)
            }
          />
        </Field>
        <Field label="Roles" wide issues={at("roles")}>
          <Chips options={FAVORITE_ROLES} values={favorite.roles ?? []} disabled={disabled} onChange={(roles) => set("roles", roles.length ? roles : undefined)} />
        </Field>
        <Field label="Context window" hint={detected?.contextWindow ? `Detected ${detected.contextWindow}` : undefined} issues={at("context_window")}>
          <NumberInput value={favorite.context_window} min={1} disabled={disabled} placeholder={detected?.contextWindow?.toString()} onChange={(v) => set("context_window", v)} />
        </Field>
        <Field
          label="Tool calling"
          hint={probe?.message ?? (detected?.toolCalling !== undefined ? `Detected: ${detected.toolCalling ? "yes" : "no"}` : undefined)}
          issues={at("tool_calling")}
        >
          <div className="inline">
            <TriState value={favorite.tool_calling} unsetLabel="auto-detect" disabled={disabled} onChange={(v) => set("tool_calling", v)} />
            <Button small onClick={() => post({ type: "provider.probe", ref: favorite.ref })}>
              Detect tool calling
            </Button>
          </div>
        </Field>
        <Field label="Max output tokens" issues={at("max_output_tokens")}>
          <NumberInput value={favorite.max_output_tokens} min={1} disabled={disabled} onChange={(v) => set("max_output_tokens", v)} />
        </Field>
        <Field label="Input $ / Mtok" issues={at("pricing", "input_per_mtok")}>
          <NumberInput value={favorite.pricing?.input_per_mtok} step="any" min={0} disabled={disabled} placeholder={detected?.pricing?.input_per_mtok?.toString()} onChange={(v) => setPricing("input_per_mtok", v)} />
        </Field>
        <Field label="Output $ / Mtok" issues={at("pricing", "output_per_mtok")}>
          <NumberInput value={favorite.pricing?.output_per_mtok} step="any" min={0} disabled={disabled} placeholder={detected?.pricing?.output_per_mtok?.toString()} onChange={(v) => setPricing("output_per_mtok", v)} />
        </Field>
        <Field label="Cached $ / Mtok" issues={at("pricing", "cached_per_mtok")}>
          <NumberInput value={favorite.pricing?.cached_per_mtok} step="any" min={0} disabled={disabled} onChange={(v) => setPricing("cached_per_mtok", v)} />
        </Field>
      </div>
    </div>
  );
}

interface Row {
  ref: string;
  label: string;
  favorite?: { model: FavoriteModel; index: number };
  info?: ModelInfo;
}

export function ModelsTab() {
  const cfg = useConfig();
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState<string>();
  const [expanded, toggle] = useToggleSet();
  const providers = cfg.merged.providers ?? [];
  const favorites = cfg.merged.models ?? [];

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = (row: Row) =>
      (!provider || row.ref.startsWith(`${provider}/`)) && (!needle || `${row.ref} ${row.label}`.toLowerCase().includes(needle));
    const favoriteBases = new Set(favorites.map((f) => baseOf(f.ref)));
    const favoriteRows: Row[] = favorites.map((model, index) => {
      const info = infoIn(cfg.catalogs, model.ref);
      return { ref: model.ref, label: model.label ?? info?.label ?? model.ref, favorite: { model, index }, ...(info ? { info } : {}) };
    });
    const catalogRows: Row[] = [];
    for (const p of providers) {
      for (const info of cfg.catalogs[p.id] ?? []) {
        const ref = `${p.id}/${info.id}`;
        if (!favoriteBases.has(ref)) catalogRows.push({ ref, label: info.label ?? info.id, info });
      }
    }
    return { favorites: favoriteRows.filter(matches), catalog: catalogRows.filter(matches) };
  }, [search, provider, favorites, providers, cfg.catalogs]);

  return (
    <div className="tab-content">
      <h2>Models</h2>
      <p className="muted">Favorites are what the router uses; give them roles. Capabilities are detected from the catalog and can be corrected.</p>
      <div className="card">
        <div className="section-title">Catalogs</div>
        <ul className="plain-list">
          {providers.map((p) => (
            <li key={p.id} className="inline">
              <strong>{p.label ?? p.id}</strong>
              <span className="muted">{cfg.catalogs[p.id] ? `${cfg.catalogs[p.id]!.length} models loaded` : "not loaded"}</span>
              <Button small onClick={() => post({ type: "provider.catalog", provider: p.id })}>
                {cfg.catalogs[p.id] ? "Reload catalog" : "Load catalog"}
              </Button>
            </li>
          ))}
        </ul>
      </div>
      <div className="inline toolbar-row">
        <TextInput value={search} placeholder="Search models…" onChange={setSearch} />
        <Select value={provider} empty="All providers" options={providers.map((p) => ({ value: p.id, label: p.label ?? p.id }))} onChange={setProvider} />
      </div>
      <FieldIssues issues={cfg.issuesAt(["models"])} />
      <ul className="model-list">
        {rows.favorites.map((row) => {
          const { model, index } = row.favorite!;
          const path = ["models", index];
          const owner = cfg.owner(path);
          const owned = owner === cfg.destination;
          const issues = cfg.issuesUnder(path);
          return (
            <li key={`f-${index}`} className={cx("model-row", "favorite", issues.some((i) => i.severity === "error") && "has-error")}>
              <div className="model-line">
                <button
                  type="button"
                  className="star on"
                  disabled={!owned}
                  title={owned ? "Remove from favorites" : `Inherited from ${owner}; it can only be removed there`}
                  onClick={() => cfg.edit((d) => removeKeyedEntry(d, ["models"], "ref", model.ref))}
                >
                  ★
                </button>
                <button type="button" className="model-name btn-link" onClick={() => toggle(model.ref)}>
                  {row.label}
                </button>
                <code className="muted">{model.ref}</code>
                {(model.roles ?? []).map((r) => (
                  <Pill key={r}>{r}</Pill>
                ))}
                <span className="muted">{describeCapabilities({ contextWindow: model.context_window ?? row.info?.contextWindow, toolCalling: model.tool_calling ?? row.info?.toolCalling, pricing: model.pricing ?? row.info?.pricing })}</span>
                <span className="spacer" />
                <LayerBadge layer={owner} />
                <Button small variant="link" onClick={() => toggle(model.ref)}>
                  {expanded.has(model.ref) ? "Close" : "Edit"}
                </Button>
              </div>
              {expanded.has(model.ref) ? <FavoriteEditor favorite={model} index={index} detected={row.info} /> : <FieldIssues issues={issues} />}
            </li>
          );
        })}
        {rows.catalog.slice(0, LIST_LIMIT).map((row) => (
          <li key={`c-${row.ref}`} className="model-row">
            <div className="model-line">
              <button type="button" className="star" title="Add to favorites" onClick={() => cfg.edit((d) => addEntry(d, ["models"], { ref: row.ref }))}>
                ☆
              </button>
              <span className="model-name">{row.label}</span>
              <code className="muted">{row.ref}</code>
              <span className="muted">{describeCapabilities(row.info)}</span>
            </div>
          </li>
        ))}
      </ul>
      {rows.catalog.length > LIST_LIMIT ? (
        <p className="muted">
          Showing {LIST_LIMIT} of {rows.catalog.length} catalog models; refine the search.
        </p>
      ) : null}
      {rows.favorites.length === 0 && rows.catalog.length === 0 ? <p className="muted">No models match. Load a catalog or change the search.</p> : null}
    </div>
  );
}
