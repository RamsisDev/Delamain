export type Path = readonly (string | number)[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Structural equality where an object key holding `undefined` counts as absent. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) if (!deepEqual(a[key], b[key])) return false;
    return true;
  }
  return false;
}

export function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

export function getIn(value: unknown, path: Path): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

/**
 * Sets `path` inside a mutable draft, creating objects on the way. `undefined` deletes the key
 * and removes the objects left empty, so clearing a field does not leave `{}` behind.
 */
export function setInDraft(draft: object, path: Path, value: unknown): void {
  if (path.length === 0) return;
  const parents: Record<string | number, unknown>[] = [];
  let current = draft as Record<string | number, unknown>;
  for (const segment of path.slice(0, -1)) {
    parents.push(current);
    let next = current[segment];
    if (next === null || typeof next !== "object") {
      if (value === undefined) return;
      next = {};
      current[segment] = next;
    }
    current = next as Record<string | number, unknown>;
  }
  const last = path[path.length - 1]!;
  if (value !== undefined) {
    current[last] = value;
    return;
  }
  if (Array.isArray(current) && typeof last === "number") current.splice(last, 1);
  else delete current[last];
  for (let i = path.length - 2; i >= 0; i--) {
    const holder = parents[i]!;
    const child = holder[path[i]!];
    if (isPlainObject(child) && Object.keys(child).length === 0) delete holder[path[i]!];
    else break;
  }
}

/** Returns a copy of `object` without the keys whose value is `undefined`. */
export function withoutUndefined<T extends object>(object: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value;
  return out as T;
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

export function unique<T>(list: readonly T[]): T[] {
  return [...new Set(list)];
}
