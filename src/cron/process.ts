import { Env } from '../types';
import { summarizeAndTranslate } from '../services/gemini';
import {
  unstickProcessing,
  getNextRawArticle,
  lockArticle,
  markArticleDone,
  markArticleFailed,
} from '../db';

export async function processCron(env: Env): Promise<void> {
  await unstickProcessing(env.DB);

  const article = await getNextRawArticle(env.DB);
  if (!article) {
    console.log('process: no articles to process');
    return;
  }

  console.log(`process: article ${article.id} "${article.title}" (status=${article.status})`);

  const lock = await lockArticle(env.DB, article.id);
  if (!lock.meta.changes) {
    console.log(`process: article ${article.id} could not be locked`);
    return;
  }

  try {
    const summary = await summarizeAndTranslate(
      article.title,
      article.content_snippet || '',
      article.source_name || '',
      env.GEMINI_API_KEY
    );
    console.log(`process: article ${article.id} summary (${summary.length} chars) saved`);
    await markArticleDone(env.DB, article.id, summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`process: article ${article.id} failed: ${msg}`);
    await markArticleFailed(env.DB, article.id, msg);
  }
}
