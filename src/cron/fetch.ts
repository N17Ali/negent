import { Env } from '../types';
import { parseFeed, computeUrlHash } from '../services/rss';
import { getNextSource, advanceSourceOrder, insertArticle } from '../db';
import { isRelevantArticle } from '../utils/filter';

export async function fetchCron(env: Env): Promise<void> {
  const source = await getNextSource(env.DB);
  if (!source) {
    console.log('fetch: no active sources');
    return;
  }

  let xml: string;
  try {
    console.log(`fetch: ${source.name} → ${source.url}`);
    const resp = await fetch(source.url, {
      headers: { 'User-Agent': 'negent/1.0 (RSS reader)' },
    });
    if (!resp.ok) {
      console.warn(`fetch: ${source.name} returned HTTP ${resp.status}`);
      await advanceSourceOrder(env.DB, source.id);
      return;
    }
    xml = await resp.text();
  } catch (err) {
    console.error(`fetch: ${source.name} failed:`, err instanceof Error ? err.message : err);
    await advanceSourceOrder(env.DB, source.id);
    return;
  }

  const items = parseFeed(xml);
  console.log(`fetch: ${source.name} parsed ${items.length} items`);

  let inserted = 0;
  let skipped = 0;
  for (const item of items) {
    if (!item.link) continue;
    if (!isRelevantArticle(item.title, item.description || '')) {
      skipped++;
      continue;
    }
    const urlHash = await computeUrlHash(item.link);
    const result = await insertArticle(
      env.DB,
      source.id,
      urlHash,
      item.link,
      item.title,
      item.description || null,
      item.mediaUrl,
      item.mediaType,
      item.pubDate
    );
    if (result.meta.changes) inserted++;
  }

  console.log(`fetch: ${source.name} inserted ${inserted} new, skipped ${skipped} irrelevant`);
  await advanceSourceOrder(env.DB, source.id);
}
