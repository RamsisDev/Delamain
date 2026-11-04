function summaryOf(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length}]`;
  return `{${Object.keys(value as object).length}}`;
}

function JsonNode({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const label = name !== undefined ? <span className="json-key">{name}: </span> : null;
  if (value === null || typeof value !== "object") {
    return (
      <div className="json-leaf">
        {label}
        <span className={`json-${value === null ? "null" : typeof value}`}>{JSON.stringify(value)}</span>
      </div>
    );
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  return (
    <details className="json-node" open={depth < 1}>
      <summary>
        {label}
        <span className="json-summary">{summaryOf(value)}</span>
      </summary>
      <div className="json-children">
        {entries.map(([key, child]) => (
          <JsonNode key={key} name={key} value={child} depth={depth + 1} />
        ))}
      </div>
    </details>
  );
}

/** Pretty, collapsible JSON for step outputs. */
export function JsonView({ value }: { value: unknown }) {
  return (
    <div className="json-view">
      <JsonNode value={value} depth={0} />
    </div>
  );
}
