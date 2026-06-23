/** Subsequence fuzzy score; 0 = no match, higher = better. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();

  if (!q) {
    return 1;
  }

  let score = 0;
  let textIndex = 0;
  let consecutive = 0;

  for (let queryIndex = 0; queryIndex < q.length; queryIndex++) {
    const char = q[queryIndex]!;
    let found = false;

    while (textIndex < t.length) {
      if (t[textIndex] === char) {
        score += 1 + consecutive * 2;
        consecutive += 1;
        textIndex += 1;
        found = true;
        break;
      }
      consecutive = 0;
      textIndex += 1;
    }

    if (!found) {
      return 0;
    }
  }

  if (t.startsWith(q)) {
    score += 10;
  }

  return score;
}

export function rankByFuzzyScore<T>(
  items: T[],
  query: string,
  getLabel: (item: T) => string,
): T[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return items;
  }

  return items
    .map((item) => ({ item, score: fuzzyScore(trimmed, getLabel(item)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || getLabel(a.item).localeCompare(getLabel(b.item)))
    .map((entry) => entry.item);
}

// ponytail: naive subsequence scorer; upgrade path = Fuse.js if album count grows large
