/** The candidate closest to `word`, when it is close enough to be a typo of it. */
export function closestMatch(word: string, candidates: Iterable<string>): string | undefined {
  const limit = Math.max(1, Math.floor(word.length / 3));
  let best: { value: string; distance: number } | undefined;
  for (const candidate of candidates) {
    if (candidate === word) continue;
    const distance = editDistance(word.toLowerCase(), candidate.toLowerCase());
    if (distance <= limit && (!best || distance < best.distance)) best = { value: candidate, distance };
  }
  return best?.value;
}

/** Edits to turn `a` into `b`; swapping two neighbouring letters counts as one, like other typos. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}
