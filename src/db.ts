import { Source, Article, Subscriber } from './types';

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

export function insertArticle(
  db: D1Database,
  sourceId: number,
  urlHash: string,
  url: string,
  title: string,
  contentSnippet: string | null,
  mediaUrl: string | null,
  mediaType: string | null,
  publishedAt: string | null
) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO articles
       (source_id, url_hash, url, title, content_snippet, media_url, media_type, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(sourceId, urlHash, url, title, contentSnippet, mediaUrl, mediaType, publishedAt)
    .run();
}

export function unstickProcessing(db: D1Database) {
  return db
    .prepare(
      `UPDATE articles SET status = 'failed', retry_count = retry_count + 1
       WHERE status = 'processing'
       AND processed_at < datetime('now', '-10 minutes')`
    )
    .run();
}

export function getNextRawArticle(db: D1Database) {
  return db
    .prepare(
      `SELECT a.*, s.name as source_name FROM articles a
       LEFT JOIN sources s ON a.source_id = s.id
       WHERE a.status = 'raw' OR (a.status = 'failed' AND a.retry_count < 3)
       ORDER BY CASE a.status WHEN 'raw' THEN 0 ELSE 1 END, a.fetched_at ASC
       LIMIT 1`
    )
    .first<Article & { source_name: string | null }>();
}

export function lockArticle(db: D1Database, articleId: number) {
  return db
    .prepare(
      `UPDATE articles SET status = 'processing', processed_at = datetime('now')
       WHERE id = ? AND status IN ('raw', 'failed')`
    )
    .bind(articleId)
    .run();
}

export function markArticleDone(db: D1Database, articleId: number, summaryFa: string) {
  return db
    .prepare(
      `UPDATE articles SET status = 'done', summary_fa = ?, processed_at = datetime('now')
       WHERE id = ?`
    )
    .bind(summaryFa, articleId)
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
      `SELECT a.*, s.name as source_name FROM articles a
       JOIN sources s ON a.source_id = s.id
       WHERE a.status = 'done' AND a.delivered = 0
       ORDER BY a.published_at ASC NULLS LAST
       LIMIT ?`
    )
    .bind(limit)
    .all<Article & { source_name: string }>();
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

export function getDeliveredChatIds(db: D1Database, articleId: number) {
  return db
    .prepare(
      'SELECT chat_id FROM delivery_log WHERE article_id = ? AND success = 1'
    )
    .bind(articleId)
    .all<{ chat_id: number }>();
}

export function upsertSubscriber(
  db: D1Database,
  chatId: number,
  username: string | null,
  firstName: string | null
) {
  return db
    .prepare(
      `INSERT INTO subscribers (chat_id, username, first_name, is_active, is_admin)
       VALUES (?, ?, ?, 1, CASE WHEN (SELECT COUNT(*) FROM subscribers) = 0 THEN 1 ELSE 0 END)
       ON CONFLICT(chat_id) DO UPDATE SET
         is_active = 1, username = excluded.username, first_name = excluded.first_name, stopped_at = NULL`
    )
    .bind(chatId, username, firstName)
    .run();
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

export function addSource(db: D1Database, url: string, name: string, addedBy: number) {
  return db
    .prepare(
      `INSERT INTO sources (url, name, added_by, fetch_order)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(fetch_order), 0) + 1 FROM sources))`
    )
    .bind(url, name, addedBy)
    .run();
}

export function removeSource(db: D1Database, sourceId: number) {
  return db
    .prepare('UPDATE sources SET active = 0 WHERE id = ?')
    .bind(sourceId)
    .run();
}
