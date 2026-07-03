ALTER TABLE articles ADD COLUMN category TEXT;
ALTER TABLE articles ADD COLUMN relevance_score INTEGER;

DROP INDEX IF EXISTS idx_articles_delivery;
CREATE INDEX IF NOT EXISTS idx_articles_delivery ON articles(status, delivered, relevance_score DESC, published_at DESC);
