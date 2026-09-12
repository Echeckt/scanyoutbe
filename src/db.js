import pg from 'pg';

const { Pool } = pg;
let pool = null;

export function hasDatabase() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool() {
  if (!hasDatabase()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
    });
  }
  return pool;
}

export async function initDatabase() {
  const db = getPool();
  if (!db) return false;

  await db.query(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      custom_url TEXT,
      description TEXT,
      country TEXT,
      default_language TEXT,
      thumbnail TEXT,
      subscribers BIGINT DEFAULT 0,
      video_count BIGINT DEFAULT 0,
      view_count BIGINT DEFAULT 0,
      uploads_playlist_id TEXT,
      discovered_query TEXT,
      is_french BOOLEAN,
      fr_confidence INTEGER,
      fr_reason TEXT,
      discovery_count INTEGER NOT NULL DEFAULT 0,
      first_discovered_at TIMESTAMPTZ,
      last_discovered_at TIMESTAMPTZ,
      last_verified_at TIMESTAMPTZ,
      last_scanned_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      published_at TIMESTAMPTZ,
      thumbnail TEXT,
      youtube_url TEXT,
      view_count BIGINT,
      view_count_updated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS links (
      id BIGSERIAL PRIMARY KEY,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      normalized_url TEXT NOT NULL,
      domain TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      affiliate_likelihood TEXT NOT NULL DEFAULT 'unknown',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(video_id, normalized_url)
    );



    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_searches (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      query TEXT NOT NULL,
      mode TEXT NOT NULL,
      filters JSONB NOT NULL DEFAULT '{}'::jsonb,
      cache_key TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      credit_charged BOOLEAN NOT NULL DEFAULT TRUE,
      result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      failure_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS user_search_channels (
      search_id BIGINT NOT NULL REFERENCES user_searches(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (search_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS credit_transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      type TEXT NOT NULL,
      reference TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS dodo_payments (
      id BIGSERIAL PRIMARY KEY,
      checkout_session_id TEXT UNIQUE,
      payment_id TEXT UNIQUE,
      webhook_id TEXT UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id TEXT,
      amount_cents INTEGER NOT NULL DEFAULT 499,
      currency TEXT NOT NULL DEFAULT 'eur',
      credits INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS discovery_cache (
      cache_key TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      mode TEXT NOT NULL,
      params JSONB NOT NULL DEFAULT '{}'::jsonb,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE channels ADD COLUMN IF NOT EXISTS default_language TEXT;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_french BOOLEAN;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS fr_confidence INTEGER;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS fr_reason TEXT;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS discovery_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS first_discovered_at TIMESTAMPTZ;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS last_discovered_at TIMESTAMPTZ;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;
    ALTER TABLE videos ADD COLUMN IF NOT EXISTS view_count BIGINT;
    ALTER TABLE videos ADD COLUMN IF NOT EXISTS view_count_updated_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_links_channel_id ON links(channel_id);
    CREATE INDEX IF NOT EXISTS idx_links_domain ON links(domain);
    CREATE INDEX IF NOT EXISTS idx_videos_channel_id ON videos(channel_id);
    CREATE INDEX IF NOT EXISTS idx_channels_last_scanned_at ON channels(last_scanned_at DESC);
    CREATE INDEX IF NOT EXISTS idx_channels_last_verified_at ON channels(last_verified_at DESC);
    CREATE INDEX IF NOT EXISTS idx_channels_is_french ON channels(is_french);
    CREATE INDEX IF NOT EXISTS idx_discovery_cache_updated_at ON discovery_cache(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_user_searches_user_id_created_at ON user_searches(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_search_channels_user_channel ON user_search_channels(user_id, channel_id);
    CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id ON credit_transactions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dodo_payments_user_id ON dodo_payments(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dodo_payments_checkout ON dodo_payments(checkout_session_id);
    CREATE INDEX IF NOT EXISTS idx_dodo_payments_payment ON dodo_payments(payment_id);

  `);

  return true;
}
