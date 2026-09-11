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
