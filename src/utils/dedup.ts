export function getBigrams(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[\s\-:—–|]+/)
    .filter((w) => w.length > 3);
  const bigrams: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(`${words[i]} ${words[i + 1]}`);
  }
  return bigrams;
}

export function isSimilarTitle(title1: string, title2: string): boolean {
  const bigrams1 = getBigrams(title1);
  const bigrams2 = getBigrams(title2);
  if (bigrams1.length === 0 || bigrams2.length === 0) return false;

  const set2 = new Set(bigrams2);
  let common = 0;
  for (const b of bigrams1) {
    if (set2.has(b)) common++;
  }

  return common >= 1;
}

export function filterDuplicates(
  candidates: { id: number; title: string; category: string | null }[],
  recentTitles: string[]
): typeof candidates {
  const recentBigrams = recentTitles.map(getBigrams);
  const selectedBigrams: string[][] = [];
  const result: typeof candidates = [];

  for (const article of candidates) {
    const articleBigrams = getBigrams(article.title);

    let isDup = false;
    for (const existing of [...recentBigrams, ...selectedBigrams]) {
      if (existing.length === 0 || articleBigrams.length === 0) continue;
      const existingSet = new Set(existing);
      let common = 0;
      for (const b of articleBigrams) {
        if (existingSet.has(b)) common++;
      }
      if (common >= 1) {
        isDup = true;
        break;
      }
    }

    if (isDup) continue;

    selectedBigrams.push(articleBigrams);
    result.push(article);
  }

  return result;
}
