import { Source, Subscriber, RawArticle, SelectedArticle, DoneArticle, DeliverableArticle } from './types';
import { MIN_RELEVANCE_SCORE, MAX_ARTICLE_AGE_HOURS } from './utils/constants';

export function getNextSource(db: D1Database) {
  return db
    .prepare('SELECT * FROM sources WHERE active = 1 ORDER BY fetch_order ASC LIMIT 1')
    .first<Source>();
}

export function advanceSourceOrder(db: D1Database, sourceId: number) {
  return db
    .prepare(
      `UPDATE sources SET last_fetched_at = datetime('now'),
       fetch_order = (SELECT COALESCE(MAX(fetch_order), 0) + 1 FROM sources)
       WHERE id = ?`
    )
    .bind(sourceId)
    .run();
}

export interface ArticleInsert {
  sourceId: number;
  urlHash: string;
  url: string;
  title: string;
  contentSnippet: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
  publishedAt: string | null;
}

export function batchInsertArticles(
  db: D1Database,
  articles: ArticleInsert[]
): Promise<D1Result[]> {
  if (!articles.length) return Promise.resolve([]);
  const stmts = articles.map((a) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO articles
         (source_id, url_hash, url, title, content_snippet, media_url, media_type, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        a.sourceId,
        a.urlHash,
        a.url,
        a.title,
        a.contentSnippet,
        a.mediaUrl,
        a.mediaType,
        a.publishedAt
      )
  );
  return db.batch(stmts);
}

export function getRawArticlesBatch(db: D1Database, limit: number) {
  return db
    .prepare(
      `SELECT a.id, a.source_id, a.url, a.url_hash, a.title, a.content_snippet,
              a.media_url, a.media_type, a.published_at, a.fetched_at, s.name as source_name
       FROM articles a
       LEFT JOIN sources s ON a.source_id = s.id
       WHERE a.status = 'raw'
       AND a.fetched_at > datetime('now', '-${MAX_ARTICLE_AGE_HOURS} hours')
       ORDER BY a.fetched_at DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<RawArticle>();
}

// D1 caps bound parameters at 100 per statement. We bind status + ids, so chunk at 99.
const D1_MAX_VARS = 99;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function updateStatusByIds(db: D1Database, ids: number[], status: string) {
  if (!ids.length) return Promise.resolve([]);
  const statements = chunk(ids, D1_MAX_VARS).map((group) =>
    db
      .prepare(
        `UPDATE articles SET status = ? WHERE id IN (${group.map(() => '?').join(',')})`
      )
      .bind(status, ...group)
  );
  return db.batch(statements);
}

export function markArticlesSkipped(db: D1Database, ids: number[]) {
  return updateStatusByIds(db, ids, 'skipped');
}

export function markArticlesSelected(db: D1Database, ids: number[]) {
  return updateStatusByIds(db, ids, 'selected');
}

export function getSelectedArticles(db: D1Database) {
  return db
    .prepare(
      `SELECT a.id, a.source_id, a.url, a.title, a.content_snippet, a.media_url, a.media_type,
              a.published_at, a.fetched_at, s.name as source_name
       FROM articles a
       JOIN sources s ON a.source_id = s.id
       WHERE a.status = 'selected'
       ORDER BY a.fetched_at ASC`
    )
    .all<SelectedArticle & { source_name: string }>();
}

export function lockArticle(db: D1Database, articleId: number) {
  return db
    .prepare(
      `UPDATE articles SET status = 'processing', processed_at = datetime('now')
       WHERE id = ? AND status = 'selected'`
    )
    .bind(articleId)
    .run();
}

export function markArticleDone(
  db: D1Database,
  articleId: number,
  summaryFa: string,
  fullFa: string,
  category: string,
  relevanceScore: number
) {
  return db
    .prepare(
      `UPDATE articles SET status = 'done', summary_fa = ?, full_fa = ?, category = ?, relevance_score = ?,
       processed_at = datetime('now') WHERE id = ?`
    )
    .bind(summaryFa, fullFa, category, relevanceScore, articleId)
    .run();
}

export function markArticleFailed(db: D1Database, articleId: number, error: string) {
  return db
    .prepare(
      `UPDATE articles SET status = 'failed', retry_count = retry_count + 1,
       error_message = ? WHERE id = ?`
    )
    .bind(error, articleId)
    .run();
}

export function getUndeliveredArticles(db: D1Database, limit: number) {
  return db
    .prepare(
      `SELECT a.id, a.source_id, a.url, a.title, a.content_snippet, a.media_url, a.media_type,
              a.published_at, a.fetched_at, a.summary_fa, a.full_fa, a.category, a.relevance_score,
              a.processed_at, s.name as source_name
       FROM articles a
       JOIN sources s ON a.source_id = s.id
       WHERE a.status = 'done' AND a.delivered = 0 AND a.relevance_score >= ?
       ORDER BY a.processed_at DESC
       LIMIT ?`
    )
    .bind(MIN_RELEVANCE_SCORE, limit)
    .all<DeliverableArticle>();
}

export function getRecentDeliveredTitles(db: D1Database, limit: number) {
  return db
    .prepare(
      `SELECT title FROM (
         SELECT title, MAX(delivered_at) AS max_delivered_at
         FROM articles
         WHERE delivered = 1
         GROUP BY title
       ) ORDER BY max_delivered_at DESC LIMIT ?`
    )
    .bind(limit)
    .all<{ title: string }>();
}

export function markDelivered(db: D1Database, articleId: number) {
  return db
    .prepare(
      `UPDATE articles SET delivered = 1, delivered_at = datetime('now') WHERE id = ?`
    )
    .bind(articleId)
    .run();
}

export function logDelivery(
  db: D1Database,
  articleId: number,
  chatId: number,
  success: boolean,
  error?: string
) {
  return db
    .prepare(
      `INSERT INTO delivery_log (article_id, chat_id, success, error) VALUES (?, ?, ?, ?)`
    )
    .bind(articleId, chatId, success ? 1 : 0, error || null)
    .run();
}

export function getActiveSubscribers(db: D1Database) {
  return db
    .prepare('SELECT * FROM subscribers WHERE is_active = 1')
    .all<Subscriber>();
}

export function getSubscriberMessageCount(db: D1Database, chatId: number) {
  return db
    .prepare(
      `SELECT COUNT(*) as c FROM delivery_log
       WHERE chat_id = ? AND success = 1
       AND sent_at > datetime('now', '-1 hour')`
    )
    .bind(chatId)
    .first<{ c: number }>();
}

export async function upsertSubscriber(
  db: D1Database,
  chatId: number,
  username: string | null,
  firstName: string | null
): Promise<{ isNew: boolean }> {
  const existing = await db
    .prepare('SELECT id FROM subscribers WHERE chat_id = ?')
    .bind(chatId)
    .first();
  const isNew = !existing;

  // Insert with is_admin=0 first, then promote the very first subscriber.
  // This avoids a race where concurrent first /start calls both see COUNT=0.
  await db
    .prepare(
      `INSERT INTO subscribers (chat_id, username, first_name, is_active, is_admin)
       VALUES (?, ?, ?, 1, 0)
       ON CONFLICT(chat_id) DO UPDATE SET
         is_active = 1, username = excluded.username, first_name = excluded.first_name, stopped_at = NULL`
    )
    .bind(chatId, username, firstName)
    .run();

  if (isNew) {
    await db
      .prepare(
        `UPDATE subscribers SET is_admin = 1
         WHERE chat_id = ?
         AND (SELECT COUNT(*) FROM subscribers WHERE is_admin = 1) = 0`
      )
      .bind(chatId)
      .run();
  }

  return { isNew };
}

export function unsubscribe(db: D1Database, chatId: number) {
  return db
    .prepare(
      `UPDATE subscribers SET is_active = 0, stopped_at = datetime('now') WHERE chat_id = ?`
    )
    .bind(chatId)
    .run();
}

export function deactivateSubscriber(db: D1Database, chatId: number) {
  return db
    .prepare('UPDATE subscribers SET is_active = 0 WHERE chat_id = ?')
    .bind(chatId)
    .run();
}

export function isAdmin(db: D1Database, chatId: number) {
  return db
    .prepare('SELECT is_admin FROM subscribers WHERE chat_id = ? AND is_active = 1')
    .bind(chatId)
    .first<{ is_admin: number }>();
}

export function getAllSources(db: D1Database) {
  return db.prepare('SELECT * FROM sources ORDER BY name').all<Source>();
}

// Delete articles older than the retention window. delivery_log.article_id has a
// FK to articles(id) with no ON DELETE CASCADE, so the dependent delivery_log rows
// MUST be deleted first or the whole statement aborts with a FOREIGN KEY error —
// which previously killed fetchCron before any inserts ran. 'processing' is included
// so rows orphaned by a worker killed mid-summarize also get reclaimed.
export async function cleanupOldArticles(db: D1Database) {
  const cond = `fetched_at < datetime('now', '-${MAX_ARTICLE_AGE_HOURS} hours')
       AND status IN ('done', 'failed', 'raw', 'skipped', 'processing')`;
  const [, articleResult] = await db.batch([
    db.prepare(
      `DELETE FROM delivery_log WHERE article_id IN (
         SELECT id FROM articles WHERE ${cond})`
    ),
    db.prepare(`DELETE FROM articles WHERE ${cond}`),
  ]);
  return articleResult;
}
