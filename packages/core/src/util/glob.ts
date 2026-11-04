const cache = new Map<string, RegExp>();

function escapeRegex(char: string): string {
  return /[.+^${}()|[\]\\/]/.test(char) ? `\\${char}` : char;
}

/**
 * Converts a glob to a regular expression. Supports `**`, `*`, `?`, `{a,b}` and `[...]`.
 * Paths are matched with forward slashes and relative to the repository root.
 */
export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  let source = "";
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        const atSegmentStart = i === 0 || glob[i - 1] === "/";
        const atSegmentEnd = i + 2 === glob.length || glob[i + 2] === "/";
        if (atSegmentStart && atSegmentEnd) {
          source += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
          i += glob[i + 2] === "/" ? 2 : 1;
          continue;
        }
        source += "[^/]*";
        i += 1;
        continue;
      }
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      braceDepth++;
      source += "(?:";
    } else if (char === "}" && braceDepth > 0) {
      braceDepth--;
      source += ")";
    } else if (char === "," && braceDepth > 0) {
      source += "|";
    } else if (char === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        source += "\\[";
      } else {
        const body = glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\");
        source += `[${body}]`;
        i = end;
      }
    } else {
      source += escapeRegex(char);
    }
  }
  const regex = new RegExp(`^${source}$`);
  cache.set(glob, regex);
  return regex;
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(normalizePath(glob)).test(normalizePath(path));
}

export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesGlob(path, glob));
}
