CREATE TABLE IF NOT EXISTS sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT    NOT NULL UNIQUE,
  name            TEXT    NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  last_fetched_at TEXT,
  fetch_order     INTEGER NOT NULL DEFAULT 0,
  added_by        INTEGER,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS articles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id       INTEGER NOT NULL REFERENCES sources(id),
  url             TEXT    NOT NULL,
  url_hash        TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  content_snippet TEXT,
  media_url       TEXT,
  media_type      TEXT,
  published_at    TEXT,
  fetched_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  status          TEXT    NOT NULL DEFAULT 'raw',
  summary_fa      TEXT,
  processed_at    TEXT,
  error_message   TEXT,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  delivered       INTEGER NOT NULL DEFAULT 0,
  delivered_at    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_url_hash ON articles(url_hash);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status, fetched_at);
CREATE INDEX IF NOT EXISTS idx_articles_delivery ON articles(status, delivered, processed_at);

CREATE TABLE IF NOT EXISTS subscribers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL UNIQUE,
  username   TEXT,
  first_name TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  stopped_at TEXT
);

CREATE TABLE IF NOT EXISTS delivery_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  chat_id    INTEGER NOT NULL,
  sent_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  success    INTEGER NOT NULL DEFAULT 1,
  error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_delivery_log_article ON delivery_log(article_id, chat_id);
