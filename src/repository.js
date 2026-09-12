import { getPool, hasDatabase } from './db.js';

const memory = {
  channels: new Map(),
  videos: new Map(),
  links: new Map(),
  discoveryCache: new Map()
};

function linkKey(videoId, normalizedUrl) {
  return `${videoId}::${normalizedUrl}`;
}

function mapChannelRow(row) {
  return {
    id: row.id,
    title: row.title,
    customUrl: row.custom_url,
    description: row.description || '',
    country: row.country,
    defaultLanguage: row.default_language,
    thumbnail: row.thumbnail,
    subscribers: Number(row.subscribers || 0),
    videoCount: Number(row.video_count || 0),
    viewCount: Number(row.view_count || 0),
    uploadsPlaylistId: row.uploads_playlist_id,
    discoveredQuery: row.discovered_query,
    isFrench: row.is_french,
    frConfidence: row.fr_confidence === null || row.fr_confidence === undefined ? null : Number(row.fr_confidence),
    frReason: row.fr_reason || null,
    discoveryCount: Number(row.discovery_count || 0),
    firstDiscoveredAt: row.first_discovered_at,
    lastDiscoveredAt: row.last_discovered_at,
    lastVerifiedAt: row.last_verified_at,
    lastScannedAt: row.last_scanned_at
  };
}

export async function getDiscoveryCache(cacheKey, { maxAgeHours = 24, allowStale = false } = {}) {
  const key = String(cacheKey || '').trim();
  if (!key) return null;
  const maxAgeMs = Math.max(Number(maxAgeHours) || 24, 0) * 60 * 60 * 1000;

  if (!hasDatabase()) {
    const item = memory.discoveryCache.get(key);
    if (!item) return null;
    const ageMs = Date.now() - new Date(item.updatedAt).getTime();
    if (!allowStale && ageMs > maxAgeMs) return null;
    return { ...item, ageMs, stale: ageMs > maxAgeMs };
  }

  const result = await getPool().query(`
    SELECT cache_key, query, mode, params, payload, created_at, updated_at
    FROM discovery_cache
    WHERE cache_key = $1
    LIMIT 1
  `, [key]);

  const row = result.rows[0];
  if (!row) return null;
  const ageMs = Date.now() - new Date(row.updated_at).getTime();
  if (!allowStale && ageMs > maxAgeMs) return null;
  return {
    cacheKey: row.cache_key,
    query: row.query,
    mode: row.mode,
    params: row.params || {},
    payload: row.payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ageMs,
    stale: ageMs > maxAgeMs
  };
}

export async function saveDiscoveryCache(cacheKey, { query, mode, params, payload }) {
  const key = String(cacheKey || '').trim();
  if (!key) return null;
  const now = new Date().toISOString();

  if (!hasDatabase()) {
    const existing = memory.discoveryCache.get(key);
    const value = {
      cacheKey: key,
      query,
      mode,
      params: params || {},
      payload,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      ageMs: 0,
      stale: false
    };
    memory.discoveryCache.set(key, value);
    return value;
  }

  const result = await getPool().query(`
    INSERT INTO discovery_cache (cache_key, query, mode, params, payload, created_at, updated_at)
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,NOW(),NOW())
    ON CONFLICT (cache_key) DO UPDATE SET
      query = EXCLUDED.query,
      mode = EXCLUDED.mode,
      params = EXCLUDED.params,
      payload = EXCLUDED.payload,
      updated_at = NOW()
    RETURNING cache_key, query, mode, params, payload, created_at, updated_at
  `, [key, query, mode, JSON.stringify(params || {}), JSON.stringify(payload)]);

  const row = result.rows[0];
  return {
    cacheKey: row.cache_key,
    query: row.query,
    mode: row.mode,
    params: row.params || {},
    payload: row.payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ageMs: 0,
    stale: false
  };
}

export async function saveChannel(channel) {
  const now = new Date().toISOString();
  const wasDiscovered = Boolean(channel.discoveredQuery);
  const value = {
    ...channel,
    discoveryCount: Number(channel.discoveryCount || 0) + (wasDiscovered ? 1 : 0),
    firstDiscoveredAt: channel.firstDiscoveredAt || (wasDiscovered ? now : null),
    lastDiscoveredAt: wasDiscovered ? now : (channel.lastDiscoveredAt || null),
    lastVerifiedAt: channel.lastVerifiedAt || null,
    lastScannedAt: channel.lastScannedAt || null
  };

  if (!hasDatabase()) {
    const existing = memory.channels.get(channel.id) || {};
    memory.channels.set(channel.id, {
      ...existing,
      ...value,
      discoveryCount: Number(existing.discoveryCount || 0) + (wasDiscovered ? 1 : 0),
      firstDiscoveredAt: existing.firstDiscoveredAt || value.firstDiscoveredAt,
      lastDiscoveredAt: wasDiscovered ? now : (existing.lastDiscoveredAt || value.lastDiscoveredAt),
      lastVerifiedAt: value.lastVerifiedAt || existing.lastVerifiedAt || null
    });
    return memory.channels.get(channel.id);
  }

  const db = getPool();
  const result = await db.query(`
    INSERT INTO channels (
      id, title, custom_url, description, country, default_language, thumbnail, subscribers,
      video_count, view_count, uploads_playlist_id, discovered_query,
      is_french, fr_confidence, fr_reason, discovery_count,
      first_discovered_at, last_discovered_at, last_verified_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
      CASE WHEN $12::text IS NULL THEN 0 ELSE 1 END,
      CASE WHEN $12::text IS NULL THEN NULL ELSE NOW() END,
      CASE WHEN $12::text IS NULL THEN NULL ELSE NOW() END,
      $16,
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      custom_url = EXCLUDED.custom_url,
      description = EXCLUDED.description,
      country = EXCLUDED.country,
      default_language = EXCLUDED.default_language,
      thumbnail = EXCLUDED.thumbnail,
      subscribers = EXCLUDED.subscribers,
      video_count = EXCLUDED.video_count,
      view_count = EXCLUDED.view_count,
      uploads_playlist_id = EXCLUDED.uploads_playlist_id,
      discovered_query = COALESCE(EXCLUDED.discovered_query, channels.discovered_query),
      is_french = COALESCE(EXCLUDED.is_french, channels.is_french),
      fr_confidence = COALESCE(EXCLUDED.fr_confidence, channels.fr_confidence),
      fr_reason = COALESCE(EXCLUDED.fr_reason, channels.fr_reason),
      discovery_count = channels.discovery_count + CASE WHEN EXCLUDED.discovered_query IS NULL THEN 0 ELSE 1 END,
      first_discovered_at = COALESCE(channels.first_discovered_at, EXCLUDED.first_discovered_at),
      last_discovered_at = CASE WHEN EXCLUDED.discovered_query IS NULL THEN channels.last_discovered_at ELSE NOW() END,
      last_verified_at = COALESCE(EXCLUDED.last_verified_at, channels.last_verified_at),
      updated_at = NOW()
    RETURNING *
  `, [
    channel.id,
    channel.title,
    channel.customUrl || null,
    channel.description || '',
    channel.country || null,
    channel.defaultLanguage || null,
    channel.thumbnail || null,
    Number(channel.subscribers || 0),
    Number(channel.videoCount || 0),
    Number(channel.viewCount || 0),
    channel.uploadsPlaylistId || null,
    channel.discoveredQuery || null,
    channel.isFrench ?? null,
    channel.frConfidence ?? null,
    channel.frReason || null,
    channel.lastVerifiedAt || null
  ]);

  return mapChannelRow(result.rows[0]);
}

export async function getChannelsByIds(ids = []) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return [];

  if (!hasDatabase()) {
    return uniqueIds.map((id) => memory.channels.get(id)).filter(Boolean);
  }

  const result = await getPool().query(
    'SELECT * FROM channels WHERE id = ANY($1::text[])',
    [uniqueIds]
  );
  return result.rows.map(mapChannelRow);
}

export async function saveScan(channel, videosWithLinks) {
  const scannedAt = new Date().toISOString();

  if (!hasDatabase()) {
    memory.channels.set(channel.id, {
      ...(memory.channels.get(channel.id) || {}),
      ...channel,
      lastScannedAt: scannedAt
    });

    for (const item of videosWithLinks) {
      memory.videos.set(item.video.id, { ...item.video, channelId: channel.id });
      for (const link of item.links) {
        memory.links.set(linkKey(item.video.id, link.normalizedUrl), {
          ...link,
          videoId: item.video.id,
          channelId: channel.id,
          videoTitle: item.video.title,
          publishedAt: item.video.publishedAt,
          youtubeUrl: item.video.youtubeUrl,
          viewCount: item.video.viewCount ?? null,
          viewCountUpdatedAt: item.video.viewCount === null || item.video.viewCount === undefined ? null : scannedAt,
          channelTitle: channel.title
        });
      }
    }
    return;
  }

  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      INSERT INTO channels (
        id, title, custom_url, description, country, default_language, thumbnail, subscribers,
        video_count, view_count, uploads_playlist_id, discovered_query, last_scanned_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        custom_url = EXCLUDED.custom_url,
        description = EXCLUDED.description,
        country = EXCLUDED.country,
        default_language = EXCLUDED.default_language,
        thumbnail = EXCLUDED.thumbnail,
        subscribers = EXCLUDED.subscribers,
        video_count = EXCLUDED.video_count,
        view_count = EXCLUDED.view_count,
        uploads_playlist_id = EXCLUDED.uploads_playlist_id,
        last_scanned_at = NOW(),
        updated_at = NOW()
    `, [
      channel.id,
      channel.title,
      channel.customUrl || null,
      channel.description || '',
      channel.country || null,
      channel.defaultLanguage || null,
      channel.thumbnail || null,
      Number(channel.subscribers || 0),
      Number(channel.videoCount || 0),
      Number(channel.viewCount || 0),
      channel.uploadsPlaylistId || null,
      channel.discoveredQuery || null
    ]);

    for (const item of videosWithLinks) {
      const video = item.video;
      await client.query(`
        INSERT INTO videos (id, channel_id, title, description, published_at, thumbnail, youtube_url, view_count, view_count_updated_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8::bigint IS NULL THEN NULL ELSE NOW() END,NOW())
        ON CONFLICT (id) DO UPDATE SET
          channel_id = EXCLUDED.channel_id,
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          published_at = EXCLUDED.published_at,
          thumbnail = EXCLUDED.thumbnail,
          youtube_url = EXCLUDED.youtube_url,
          view_count = COALESCE(EXCLUDED.view_count, videos.view_count),
          view_count_updated_at = CASE WHEN EXCLUDED.view_count IS NULL THEN videos.view_count_updated_at ELSE NOW() END,
          updated_at = NOW()
      `, [video.id, channel.id, video.title, null, video.publishedAt, video.thumbnail, video.youtubeUrl, video.viewCount ?? null]);

      for (const link of item.links) {
        await client.query(`
          INSERT INTO links (video_id, channel_id, url, normalized_url, domain, category, affiliate_likelihood)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (video_id, normalized_url) DO UPDATE SET
            url = EXCLUDED.url,
            domain = EXCLUDED.domain,
            category = EXCLUDED.category,
            affiliate_likelihood = EXCLUDED.affiliate_likelihood
        `, [video.id, channel.id, link.url, link.normalizedUrl, link.domain, link.category, link.affiliateLikelihood]);
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getKnownChannels(limit = 5000) {
  const safeLimit = Math.min(Math.max(Number(limit) || 5000, 1), 10000);
  if (!hasDatabase()) {
    return [...memory.channels.values()].slice(0, safeLimit);
  }

  const result = await getPool().query(`
    SELECT *
    FROM channels
    ORDER BY updated_at DESC
    LIMIT $1
  `, [safeLimit]);
  return result.rows.map(mapChannelRow);
}

export async function getChannels() {
  if (!hasDatabase()) {
    return [...memory.channels.values()]
      .filter((channel) => channel.isFrench === true)
      .sort((a, b) => Number(b.subscribers || 0) - Number(a.subscribers || 0));
  }

  const result = await getPool().query(`
    SELECT c.*, COUNT(DISTINCT v.id)::int AS scanned_videos, COUNT(DISTINCT l.id)::int AS links_count
    FROM channels c
    LEFT JOIN videos v ON v.channel_id = c.id
    LEFT JOIN links l ON l.channel_id = c.id
    WHERE c.is_french IS TRUE
    GROUP BY c.id
    ORDER BY c.subscribers DESC, c.updated_at DESC
    LIMIT 1000
  `);

  return result.rows.map((row) => ({
    ...mapChannelRow(row),
    scannedVideos: Number(row.scanned_videos || 0),
    linksCount: Number(row.links_count || 0)
  }));
}

export async function getLinks({ channelId, limit = 1000 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 1000, 1), 100000);

  if (!hasDatabase()) {
    const frenchIds = new Set([...memory.channels.values()].filter((c) => c.isFrench === true).map((c) => c.id));
    return [...memory.links.values()]
      .filter((link) => frenchIds.has(link.channelId))
      .filter((link) => !channelId || link.channelId === channelId)
      .map((link) => {
        const video = memory.videos.get(link.videoId);
        return {
          ...link,
          viewCount: video?.viewCount ?? link.viewCount ?? null,
          viewCountUpdatedAt: video?.viewCountUpdatedAt ?? link.viewCountUpdatedAt ?? null
        };
      })
      .sort((a, b) => Number(b.viewCount ?? -1) - Number(a.viewCount ?? -1) || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
      .slice(0, safeLimit);
  }

  const params = [];
  const where = ['c.is_french IS TRUE'];
  if (channelId) {
    params.push(channelId);
    where.push(`l.channel_id = $${params.length}`);
  }
  params.push(safeLimit);

  const result = await getPool().query(`
    SELECT
      l.id, l.video_id, l.channel_id, l.url, l.normalized_url, l.domain, l.category,
      l.affiliate_likelihood, v.title AS video_title, v.published_at, v.youtube_url,
      v.view_count, v.view_count_updated_at, c.title AS channel_title
    FROM links l
    JOIN videos v ON v.id = l.video_id
    JOIN channels c ON c.id = l.channel_id
    WHERE ${where.join(' AND ')}
    ORDER BY v.view_count DESC NULLS LAST, v.published_at DESC NULLS LAST, l.id DESC
    LIMIT $${params.length}
  `, params);

  return result.rows.map((row) => ({
    id: row.id,
    videoId: row.video_id,
    channelId: row.channel_id,
    url: row.url,
    normalizedUrl: row.normalized_url,
    domain: row.domain,
    category: row.category,
    affiliateLikelihood: row.affiliate_likelihood,
    videoTitle: row.video_title,
    publishedAt: row.published_at,
    youtubeUrl: row.youtube_url,
    viewCount: row.view_count === null || row.view_count === undefined ? null : Number(row.view_count),
    viewCountUpdatedAt: row.view_count_updated_at,
    channelTitle: row.channel_title
  }));
}

export async function getUniqueLinks(limit = 100000) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100000, 1), 100000);

  if (!hasDatabase()) {
    const frenchIds = new Set([...memory.channels.values()].filter((c) => c.isFrench === true).map((c) => c.id));
    const groups = new Map();

    for (const link of memory.links.values()) {
      if (!frenchIds.has(link.channelId)) continue;
      const key = link.normalizedUrl || link.url;
      const current = groups.get(key) || {
        normalizedUrl: key,
        url: link.url,
        domain: link.domain,
        category: link.category,
        affiliateLikelihood: link.affiliateLikelihood,
        occurrences: 0,
        channels: new Set(),
        videos: new Set(),
        firstPublishedAt: link.publishedAt || null,
        lastPublishedAt: link.publishedAt || null,
        latestChannelTitle: link.channelTitle || '',
        latestVideoTitle: link.videoTitle || '',
        latestYoutubeUrl: link.youtubeUrl || ''
      };

      current.occurrences += 1;
      current.channels.add(link.channelId);
      current.videos.add(link.videoId);

      if (link.affiliateLikelihood === 'high') current.affiliateLikelihood = 'high';
      else if (link.affiliateLikelihood === 'possible' && current.affiliateLikelihood !== 'high') current.affiliateLikelihood = 'possible';

      const first = current.firstPublishedAt;
      const last = current.lastPublishedAt;
      const published = link.publishedAt;
      if (!first || (published && new Date(published) < new Date(first))) current.firstPublishedAt = published;
      if (!last || (published && new Date(published) > new Date(last))) {
        current.lastPublishedAt = published;
        current.url = link.url;
        current.latestChannelTitle = link.channelTitle || current.latestChannelTitle;
        current.latestVideoTitle = link.videoTitle || current.latestVideoTitle;
        current.latestYoutubeUrl = link.youtubeUrl || current.latestYoutubeUrl;
      }

      groups.set(key, current);
    }

    return [...groups.values()]
      .map((item) => ({
        normalizedUrl: item.normalizedUrl,
        url: item.url,
        domain: item.domain,
        category: item.category,
        affiliateLikelihood: item.affiliateLikelihood,
        occurrences: item.occurrences,
        channelsCount: item.channels.size,
        videosCount: item.videos.size,
        firstPublishedAt: item.firstPublishedAt,
        lastPublishedAt: item.lastPublishedAt,
        latestChannelTitle: item.latestChannelTitle,
        latestVideoTitle: item.latestVideoTitle,
        latestYoutubeUrl: item.latestYoutubeUrl
      }))
      .sort((a, b) => b.occurrences - a.occurrences || b.channelsCount - a.channelsCount || new Date(b.lastPublishedAt || 0) - new Date(a.lastPublishedAt || 0))
      .slice(0, safeLimit);
  }

  const result = await getPool().query(`
    SELECT
      l.normalized_url,
      (ARRAY_AGG(l.url ORDER BY v.published_at DESC NULLS LAST, l.id DESC))[1] AS sample_url,
      MIN(l.domain) AS domain,
      MIN(l.category) AS category,
      CASE
        WHEN COUNT(*) FILTER (WHERE l.affiliate_likelihood = 'high') > 0 THEN 'high'
        WHEN COUNT(*) FILTER (WHERE l.affiliate_likelihood = 'possible') > 0 THEN 'possible'
        ELSE 'low'
      END AS affiliate_likelihood,
      COUNT(*)::int AS occurrences,
      COUNT(DISTINCT l.channel_id)::int AS channels_count,
      COUNT(DISTINCT l.video_id)::int AS videos_count,
      MIN(v.published_at) AS first_published_at,
      MAX(v.published_at) AS last_published_at,
      (ARRAY_AGG(c.title ORDER BY v.published_at DESC NULLS LAST, l.id DESC))[1] AS latest_channel_title,
      (ARRAY_AGG(v.title ORDER BY v.published_at DESC NULLS LAST, l.id DESC))[1] AS latest_video_title,
      (ARRAY_AGG(v.youtube_url ORDER BY v.published_at DESC NULLS LAST, l.id DESC))[1] AS latest_youtube_url
    FROM links l
    JOIN videos v ON v.id = l.video_id
    JOIN channels c ON c.id = l.channel_id
    WHERE c.is_french IS TRUE
    GROUP BY l.normalized_url
    ORDER BY occurrences DESC, channels_count DESC, last_published_at DESC NULLS LAST
    LIMIT $1
  `, [safeLimit]);

  return result.rows.map((row) => ({
    normalizedUrl: row.normalized_url,
    url: row.sample_url,
    domain: row.domain,
    category: row.category,
    affiliateLikelihood: row.affiliate_likelihood,
    occurrences: Number(row.occurrences || 0),
    channelsCount: Number(row.channels_count || 0),
    videosCount: Number(row.videos_count || 0),
    firstPublishedAt: row.first_published_at,
    lastPublishedAt: row.last_published_at,
    latestChannelTitle: row.latest_channel_title,
    latestVideoTitle: row.latest_video_title,
    latestYoutubeUrl: row.latest_youtube_url
  }));
}


export async function getUniqueLinksByChannelIds(channelIds = [], limit = 100000) {
  const ids = [...new Set((Array.isArray(channelIds) ? channelIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
  const safeLimit = Math.min(Math.max(Number(limit) || 100000, 1), 100000);
  if (!ids.length) return [];

  if (!hasDatabase()) {
    const allowedIds = new Set(ids);
    const frenchIds = new Set(
      [...memory.channels.values()]
        .filter((channel) => channel.isFrench === true && allowedIds.has(channel.id))
        .map((channel) => channel.id)
    );
    const groups = new Map();

    for (const link of memory.links.values()) {
      if (!frenchIds.has(link.channelId)) continue;
      const key = link.normalizedUrl || link.url;
      const current = groups.get(key) || {
        normalizedUrl: key,
        url: link.url,
        domain: link.domain,
        category: link.category,
        affiliateLikelihood: link.affiliateLikelihood,
        occurrences: 0,
        channels: new Set(),
        videos: new Set(),
        firstPublishedAt: link.publishedAt || null,
        lastPublishedAt: link.publishedAt || null,
        latestChannelTitle: link.channelTitle || '',
        latestVideoTitle: link.videoTitle || '',
        latestYoutubeUrl: link.youtubeUrl || ''
      };

      current.occurrences += 1;
      current.channels.add(link.channelId);
      current.videos.add(link.videoId);
      if (link.affiliateLikelihood === 'high') current.affiliateLikelihood = 'high';
      else if (link.affiliateLikelihood === 'possible' && current.affiliateLikelihood !== 'high') current.affiliateLikelihood = 'possible';

      const first = current.firstPublishedAt;
      const last = current.lastPublishedAt;
      const published = link.publishedAt;
      if (!first || (published && new Date(published) < new Date(first))) current.firstPublishedAt = published;
      if (!last || (published && new Date(published) > new Date(last))) {
        current.lastPublishedAt = published;
        current.url = link.url;
        current.latestChannelTitle = link.channelTitle || current.latestChannelTitle;
        current.latestVideoTitle = link.videoTitle || current.latestVideoTitle;
        current.latestYoutubeUrl = link.youtubeUrl || current.latestYoutubeUrl;
      }
      groups.set(key, current);
    }

    return [...groups.values()]
      .map((item) => ({
        normalizedUrl: item.normalizedUrl,
        url: item.url,
        domain: item.domain,
        category: item.category,
        affiliateLikelihood: item.affiliateLikelihood,
        occurrences: item.occurrences,
        channelsCount: item.channels.size,
        videosCount: item.videos.size,
        firstPublishedAt: item.firstPublishedAt,
        lastPublishedAt: item.lastPublishedAt,
        latestChannelTitle: item.latestChannelTitle,
        latestVideoTitle: item.latestVideoTitle,
        latestYoutubeUrl: item.latestYoutubeUrl
      }))
      .sort((a, b) => b.occurrences - a.occurrences || b.channelsCount - a.channelsCount || new Date(b.lastPublishedAt || 0) - new Date(a.lastPublishedAt || 0))
      .slice(0, safeLimit);
  }

  const result = await getPool().query(`
    SELECT
      l.normalized_url,
      (ARRAY_AGG(l.url ORDER BY v.published_at DESC NULLS LAST, l.id DESC))[1] AS sample_url,
      MIN(l.domain) AS domain,
      MIN(l.category) AS category,
      CASE
        WHEN COUNT(*) FILTER (WHERE l.affiliate_likelihood = 'high') > 0 THEN 'high'
        WHEN COUNT(*) FILTER (WHERE l.affiliate_likelihood = 'possible') > 0 THEN 'possible'
        ELSE 'low'
      END AS affiliate_likelihood,
      COUNT(*)::int AS occurrences,
      COUNT(DISTINCT l.channel_id)::int AS channels_count,
      COUNT(DISTINCT l.video_id)::int AS videos_count,
      MIN(v.published_at) AS first_published_at,
      MAX(v.published_at) AS last_published_at,
      (ARRAY_AGG(c.title ORDER BY v.published_at DESC NULLS LAST, l.id DESC))[1] AS latest_channel_title,
      (ARRAY_AGG(v.title ORDER BY v.published_at DESC NULLS LAST, l.id DESC))[1] AS latest_video_title,
      (ARRAY_AGG(v.youtube_url ORDER BY v.published_at DESC NULLS LAST, l.id DESC))[1] AS latest_youtube_url
    FROM links l
    JOIN videos v ON v.id = l.video_id
    JOIN channels c ON c.id = l.channel_id
    WHERE c.is_french IS TRUE
      AND l.channel_id = ANY($1::text[])
    GROUP BY l.normalized_url
    ORDER BY occurrences DESC, channels_count DESC, last_published_at DESC NULLS LAST
    LIMIT $2
  `, [ids, safeLimit]);

  return result.rows.map((row) => ({
    normalizedUrl: row.normalized_url,
    url: row.sample_url,
    domain: row.domain,
    category: row.category,
    affiliateLikelihood: row.affiliate_likelihood,
    occurrences: Number(row.occurrences || 0),
    channelsCount: Number(row.channels_count || 0),
    videosCount: Number(row.videos_count || 0),
    firstPublishedAt: row.first_published_at,
    lastPublishedAt: row.last_published_at,
    latestChannelTitle: row.latest_channel_title,
    latestVideoTitle: row.latest_video_title,
    latestYoutubeUrl: row.latest_youtube_url
  }));
}

export async function getDomainOccurrences(domain, limit = 5000) {
  const needle = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
  const safeLimit = Math.min(Math.max(Number(limit) || 5000, 1), 10000);
  if (!needle) return { total: 0, videos: 0, channels: 0, results: [] };

  if (!hasDatabase()) {
    const frenchIds = new Set(
      [...memory.channels.values()]
        .filter((channel) => channel.isFrench === true)
        .map((channel) => channel.id)
    );

    const results = [...memory.links.values()]
      .filter((link) => frenchIds.has(link.channelId))
      .filter((link) => {
        const value = String(link.domain || '').toLowerCase().replace(/^www\./, '');
        return value === needle || value.endsWith(`.${needle}`);
      })
      .map((link) => {
        const video = memory.videos.get(link.videoId);
        return {
          ...link,
          viewCount: video?.viewCount ?? link.viewCount ?? null,
          viewCountUpdatedAt: video?.viewCountUpdatedAt ?? link.viewCountUpdatedAt ?? null
        };
      })
      .sort((a, b) => Number(b.viewCount ?? -1) - Number(a.viewCount ?? -1) || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

    const all = results;
    return {
      total: all.length,
      videos: new Set(all.map((item) => item.videoId)).size,
      channels: new Set(all.map((item) => item.channelId)).size,
      results: all.slice(0, safeLimit)
    };
  }

  const db = getPool();
  const matchSql = `(LOWER(REGEXP_REPLACE(l.domain, '^www\\.', '')) = $1 OR LOWER(REGEXP_REPLACE(l.domain, '^www\\.', '')) LIKE ('%.' || $1))`;

  const [summaryResult, rowsResult] = await Promise.all([
    db.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(DISTINCT l.video_id)::int AS videos,
        COUNT(DISTINCT l.channel_id)::int AS channels
      FROM links l
      JOIN channels c ON c.id = l.channel_id
      WHERE c.is_french IS TRUE
        AND ${matchSql}
    `, [needle]),
    db.query(`
      SELECT
        l.id, l.video_id, l.channel_id, l.url, l.normalized_url, l.domain, l.category,
        l.affiliate_likelihood, v.title AS video_title, v.published_at, v.youtube_url,
        v.view_count, v.view_count_updated_at, c.title AS channel_title
      FROM links l
      JOIN videos v ON v.id = l.video_id
      JOIN channels c ON c.id = l.channel_id
      WHERE c.is_french IS TRUE
        AND ${matchSql}
      ORDER BY v.view_count DESC NULLS LAST, v.published_at DESC NULLS LAST, l.id DESC
      LIMIT $2
    `, [needle, safeLimit])
  ]);

  const summary = summaryResult.rows[0] || {};
  return {
    total: Number(summary.total || 0),
    videos: Number(summary.videos || 0),
    channels: Number(summary.channels || 0),
    results: rowsResult.rows.map((row) => ({
      id: row.id,
      videoId: row.video_id,
      channelId: row.channel_id,
      url: row.url,
      normalizedUrl: row.normalized_url,
      domain: row.domain,
      category: row.category,
      affiliateLikelihood: row.affiliate_likelihood,
      videoTitle: row.video_title,
      publishedAt: row.published_at,
      youtubeUrl: row.youtube_url,
      viewCount: row.view_count === null || row.view_count === undefined ? null : Number(row.view_count),
      viewCountUpdatedAt: row.view_count_updated_at,
      channelTitle: row.channel_title
    }))
  };
}

export async function updateVideoViewCounts(items = []) {
  const clean = (items || [])
    .map((item) => ({ id: String(item?.id || '').trim(), viewCount: item?.viewCount }))
    .filter((item) => item.id && item.viewCount !== null && item.viewCount !== undefined && Number.isFinite(Number(item.viewCount)));

  if (!clean.length) return 0;
  const updatedAt = new Date().toISOString();

  if (!hasDatabase()) {
    for (const item of clean) {
      const existing = memory.videos.get(item.id);
      if (!existing) continue;
      memory.videos.set(item.id, { ...existing, viewCount: Number(item.viewCount), viewCountUpdatedAt: updatedAt });
    }
    return clean.length;
  }

  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const item of clean) {
      await client.query(`
        UPDATE videos
        SET view_count = $2, view_count_updated_at = NOW(), updated_at = NOW()
        WHERE id = $1
      `, [item.id, Number(item.viewCount)]);
    }
    await client.query('COMMIT');
    return clean.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getDomainStats(limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);

  if (!hasDatabase()) {
    const frenchIds = new Set([...memory.channels.values()].filter((c) => c.isFrench === true).map((c) => c.id));
    const groups = new Map();
    for (const link of memory.links.values()) {
      if (!frenchIds.has(link.channelId)) continue;
      const current = groups.get(link.domain) || { domain: link.domain, links: 0, channels: new Set(), videos: new Set(), affiliateHigh: 0 };
      current.links += 1;
      current.channels.add(link.channelId);
      current.videos.add(link.videoId);
      if (link.affiliateLikelihood === 'high') current.affiliateHigh += 1;
      groups.set(link.domain, current);
    }
    return [...groups.values()]
      .map((g) => ({ domain: g.domain, links: g.links, channels: g.channels.size, videos: g.videos.size, affiliateHigh: g.affiliateHigh }))
      .sort((a, b) => b.channels - a.channels || b.links - a.links)
      .slice(0, safeLimit);
  }

  const result = await getPool().query(`
    SELECT
      l.domain,
      COUNT(*)::int AS links,
      COUNT(DISTINCT l.channel_id)::int AS channels,
      COUNT(DISTINCT l.video_id)::int AS videos,
      COUNT(*) FILTER (WHERE l.affiliate_likelihood = 'high')::int AS affiliate_high
    FROM links l
    JOIN channels c ON c.id = l.channel_id
    WHERE c.is_french IS TRUE
    GROUP BY l.domain
    ORDER BY channels DESC, links DESC
    LIMIT $1
  `, [safeLimit]);

  return result.rows.map((row) => ({
    domain: row.domain,
    links: Number(row.links),
    channels: Number(row.channels),
    videos: Number(row.videos),
    affiliateHigh: Number(row.affiliate_high)
  }));
}

export async function getStats() {
  if (!hasDatabase()) {
    const frenchIds = new Set([...memory.channels.values()].filter((c) => c.isFrench === true).map((c) => c.id));
    const videos = [...memory.videos.values()].filter((v) => frenchIds.has(v.channelId));
    const links = [...memory.links.values()].filter((l) => frenchIds.has(l.channelId));
    return {
      channels: frenchIds.size,
      knownChannels: memory.channels.size,
      videos: videos.length,
      links: links.length,
      domains: new Set(links.map((l) => l.domain)).size,
      persistent: false
    };
  }

  const result = await getPool().query(`
    SELECT
      (SELECT COUNT(*)::int FROM channels WHERE is_french IS TRUE) AS channels,
      (SELECT COUNT(*)::int FROM channels) AS known_channels,
      (SELECT COUNT(*)::int FROM videos v JOIN channels c ON c.id = v.channel_id WHERE c.is_french IS TRUE) AS videos,
      (SELECT COUNT(*)::int FROM links l JOIN channels c ON c.id = l.channel_id WHERE c.is_french IS TRUE) AS links,
      (SELECT COUNT(DISTINCT l.domain)::int FROM links l JOIN channels c ON c.id = l.channel_id WHERE c.is_french IS TRUE) AS domains
  `);

  const row = result.rows[0];
  return {
    channels: Number(row.channels || 0),
    knownChannels: Number(row.known_channels || 0),
    videos: Number(row.videos || 0),
    links: Number(row.links || 0),
    domains: Number(row.domains || 0),
    persistent: true
  };
}
