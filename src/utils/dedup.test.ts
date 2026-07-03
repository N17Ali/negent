import { describe, it, expect } from 'vitest';
import { getBigrams, isSimilarTitle, filterDuplicates } from './dedup';

describe('getBigrams', () => {
  it('extracts word pairs from title', () => {
    const bg = getBigrams('React 19 released today');
    expect(bg).toContain('react released');
    expect(bg).toContain('released today');
  });

  it('filters out short words (<4 chars)', () => {
    const bg = getBigrams('AI is great');
    expect(bg).toHaveLength(0);
  });

  it('splits on hyphens and colons', () => {
    const bg = getBigrams('Pride Week: Baldurs Gate Stories');
    expect(bg).toContain('pride week');
    expect(bg).toContain('baldurs gate');
  });
});

describe('isSimilarTitle', () => {
  it('detects pride week articles as similar', () => {
    const t1 = 'Pride Week: Baldurs Gate 3 lesbian stories';
    const t2 = 'Pride Week: How games can queer the concept of time';
    expect(isSimilarTitle(t1, t2)).toBe(true);
  });

  it('does not flag unrelated titles', () => {
    expect(isSimilarTitle('GTA 6 release date announced', 'React 19 stable release')).toBe(false);
  });

  it('does not flag partial word matches', () => {
    expect(isSimilarTitle('React Router v7', 'React 19 stable')).toBe(false);
  });

  it('does not flag different news about same game', () => {
    expect(
      isSimilarTitle('GTA 6 trailer reveals Vice City', 'GTA 6 delayed to 2026')
    ).toBe(false);
  });

  it('detects articles sharing a topic phrase', () => {
    expect(
      isSimilarTitle('Steam Summer Sale 2024 best deals', 'Steam Summer Sale starts with discounts')
    ).toBe(true);
  });
});

describe('filterDuplicates', () => {
  it('removes candidates similar to recent titles', () => {
    const candidates = [
      { id: 1, title: 'Steam Summer Sale best deals', category: 'gaming' },
      { id: 2, title: 'Steam Summer Sale starts with discounts', category: 'gaming' },
      { id: 3, title: 'React 19 stable release', category: 'programming' },
    ];
    const recent = ['Steam Summer Sale 2024 announced'];
    const result = filterDuplicates(candidates, recent);
    expect(result.map((r) => r.id)).toEqual([3]);
  });

  it('removes duplicates within candidates', () => {
    const candidates = [
      { id: 1, title: 'Pride Week: Baldurs Gate stories', category: 'gaming' },
      { id: 2, title: 'Pride Week: How games queer time', category: 'gaming' },
      { id: 3, title: 'OpenAI launches GPT-5', category: 'ai' },
    ];
    const result = filterDuplicates(candidates, []);
    expect(result.map((r) => r.id)).toEqual([1, 3]);
  });

  it('keeps all articles when no duplicates', () => {
    const candidates = [
      { id: 1, title: 'React 19 stable release', category: 'programming' },
      { id: 2, title: 'GPT-5 launched by OpenAI', category: 'ai' },
      { id: 3, title: 'GTA 6 release date', category: 'gaming' },
    ];
    const result = filterDuplicates(candidates, []);
    expect(result).toHaveLength(3);
  });

  it('handles empty inputs', () => {
    expect(filterDuplicates([], [])).toEqual([]);
    expect(filterDuplicates([], ['some recent title'])).toEqual([]);
  });
});
