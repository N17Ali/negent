import { RELEVANT_KEYWORDS } from './constants';

const allKeywords = Object.values(RELEVANT_KEYWORDS).flat();
const keywordRegex = new RegExp(
  `\\b(${allKeywords.map(escapeRegex).join('|')})\\b`,
  'i'
);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isRelevantArticle(title: string, description: string): boolean {
  const text = `${title} ${description}`;
  return keywordRegex.test(text);
}
