export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  GEMINI_API_KEY: string;
}

export interface Source {
  id: number;
  url: string;
  name: string;
  active: number;
  last_fetched_at: string | null;
  fetch_order: number;
  added_by: number | null;
  created_at: string;
}

export interface Article {
  id: number;
  source_id: number;
  url: string;
  url_hash: string;
  title: string;
  content_snippet: string | null;
  media_url: string | null;
  media_type: 'photo' | 'video' | null;
  published_at: string | null;
  fetched_at: string;
  status: 'raw' | 'processing' | 'done' | 'failed' | 'skipped' | 'selected';
  summary_fa: string | null;
  full_fa: string | null;
  category: string | null;
  relevance_score: number | null;
  processed_at: string | null;
  error_message: string | null;
  retry_count: number;
  delivered: number;
  delivered_at: string | null;
}

/** Article in `raw` state — fetched, not yet selected. */
export interface RawArticle {
  id: number;
  source_id: number;
  url: string;
  url_hash: string;
  title: string;
  content_snippet: string | null;
  media_url: string | null;
  media_type: 'photo' | 'video' | null;
  published_at: string | null;
  fetched_at: string;
  source_name?: string;
}

/** Article in `selected` state — chosen by LLM, awaiting summarization. */
export interface SelectedArticle {
  id: number;
  source_id: number;
  url: string;
  title: string;
  content_snippet: string | null;
  media_url: string | null;
  media_type: 'photo' | 'video' | null;
  published_at: string | null;
  fetched_at: string;
  source_name?: string;
}

/** Article in `done` state — summarized, translated, ready for delivery. */
export interface DoneArticle {
  id: number;
  source_id: number;
  url: string;
  title: string;
  content_snippet: string | null;
  media_url: string | null;
  media_type: 'photo' | 'video' | null;
  published_at: string | null;
  fetched_at: string;
  summary_fa: string;
  full_fa: string;
  category: string;
  relevance_score: number;
  processed_at: string;
  source_name?: string;
}

/** Subset of DoneArticle passed to Telegram sender (with source_name required). */
export interface DeliverableArticle extends DoneArticle {
  source_name: string;
}

export interface Subscriber {
  id: number;
  chat_id: number;
  username: string | null;
  first_name: string | null;
  is_active: number;
  is_admin: number;
  created_at: string;
  stopped_at: string | null;
}

export interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate: string | null;
  mediaUrl: string | null;
  mediaType: 'photo' | 'video' | null;
}

export interface GeminiResult {
  summary: string;
  full_fa: string;
  category: string;
  relevance_score: number;
}
