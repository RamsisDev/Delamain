const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

export const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

/** Parses "300s", "10m", "1h", "500ms" or a bare number of seconds into milliseconds. */
export function parseDuration(value: string | number): number {
  if (typeof value === "number") return Math.round(value * 1000);
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) throw new Error(`Invalid duration "${value}". Use e.g. 300s, 10m, 1h or 500ms.`);
  return Math.round(Number(match[1]) * (UNIT_MS[match[2]!] ?? 1000));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}
