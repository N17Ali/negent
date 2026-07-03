import { Env } from '../types';
import { summarizeAndTranslate } from '../services/gemini';
import {
  unstickProcessing,
  getNextRawArticle,
  lockArticle,
  markArticleDone,
  markArticleFailed,
} from '../db';
import { PROCESS_BATCH_SIZE } from '../utils/constants';

export async function processCron(env: Env): Promise<void> {
  await unstickProcessing(env.DB);

  let processed = 0;
  let succeeded = 0;

  for (let i = 0; i < PROCESS_BATCH_SIZE; i++) {
    const article = await getNextRawArticle(env.DB);
    if (!article) {
      console.log(`process: no more articles after ${processed} processed`);
      break;
    }

    const lock = await lockArticle(env.DB, article.id);
    if (!lock.meta.changes) {
      console.log(`process: article ${article.id} could not be locked, skipping`);
      continue;
    }

    console.log(`process: [${i + 1}/${PROCESS_BATCH_SIZE}] article ${article.id} "${article.title}"`);

    try {
      const result = await summarizeAndTranslate(
        article.title,
        article.content_snippet || '',
        article.source_name || '',
        env.GEMINI_API_KEY
      );
      console.log(
        `process: article ${article.id} [${result.category}|${result.relevance_score}] done`
      );
      await markArticleDone(
        env.DB,
        article.id,
        result.summary,
        result.category,
        result.relevance_score
      );
      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error(`process: article ${article.id} failed: ${msg}`);
      await markArticleFailed(env.DB, article.id, msg);
    }
    processed++;
  }

  if (processed > 0) {
    console.log(`process: batch done — ${succeeded}/${processed} succeeded`);
  } else {
    console.log('process: no articles to process');
  }
}
