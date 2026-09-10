import { getPool, hasDatabase } from './db.js';

const memory = {
  channels: new Map(),
  videos: new Map(),
  links: new Map()
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
    thumbnail: row.thumbnail,
    subscribers: Number(row.subscribers || 0),
    videoCount: Number(row.video_count || 0),
    viewCount: Number(row.view_count || 0),
    uploadsPlaylistId: row.uploads_playlist_id,
    discoveredQuery: row.discovered_query,
    lastScannedAt: row.last_scanned_at
  };
}

export async function saveChannel(channel) {
  const value = { ...channel, lastScannedAt: channel.lastScannedAt || null };

  if (!hasDatabase()) {
    memory.channels.set(channel.id, { ...(memory.channels.get(channel.id) || {}), ...value });
    return value;
  }

  const db = getPool();
  const result = await db.query(`
    INSERT INTO channels (
      id, title, custom_url, description, country, thumbnail, subscribers,
      video_count, view_count, uploads_playlist_id, discovered_query, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      custom_url = EXCLUDED.custom_url,
      description = EXCLUDED.description,
      country = EXCLUDED.country,
      thumbnail = EXCLUDED.thumbnail,
      subscribers = EXCLUDED.subscribers,
      video_count = EXCLUDED.video_count,
      view_count = EXCLUDED.view_count,
      uploads_playlist_id = EXCLUDED.uploads_playlist_id,
      discovered_query = COALESCE(EXCLUDED.discovered_query, channels.discovered_query),
      updated_at = NOW()
    RETURNING *
  `, [
    channel.id, channel.title, channel.customUrl, channel.description, channel.country,
    channel.thumbnail, channel.subscribers, channel.videoCount, channel.viewCount,
    channel.uploadsPlaylistId, channel.discoveredQuery || null
  ]);

  return mapChannelRow(result.rows[0]);
}

export async function saveScan(channel, videosWithLinks) {
  const scannedAt = new Date().toISOString();

  if (!hasDatabase()) {
    memory.channels.set(channel.id, { ...(memory.channels.get(channel.id) || {}), ...channel, lastScannedAt: scannedAt });

    for (const item of videosWithLinks) {
      memory.videos.set(item.video.id, { ...item.video, channelId: channel.id });
      for (const link of item.links) {
        memory.links.set(linkKey(item.video.id, link.normalizedUrl), {
          ...link,
          videoId: item.video.id,
          channelId: channel.id,
          videoTitle: item.video.title,
          publishedAt: item.video.publishedAt,
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
        id, title, custom_url, description, country, thumbnail, subscribers,
        video_count, view_count, uploads_playlist_id, discovered_query, last_scanned_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        custom_url = EXCLUDED.custom_url,
        description = EXCLUDED.description,
        country = EXCLUDED.country,
        thumbnail = EXCLUDED.thumbnail,
        subscribers = EXCLUDED.subscribers,
        video_count = EXCLUDED.video_count,
        view_count = EXCLUDED.view_count,
        uploads_playlist_id = EXCLUDED.uploads_playlist_id,
        last_scanned_at = NOW(),
        updated_at = NOW()
    `, [
      channel.id, channel.title, channel.customUrl, channel.description, channel.country,
      channel.thumbnail, channel.subscribers, channel.videoCount, channel.viewCount,
      channel.uploadsPlaylistId, channel.discoveredQuery || null
    ]);

    for (const item of videosWithLinks) {
      const video = item.video;
      await client.query(`
        INSERT INTO videos (id, channel_id, title, description, published_at, thumbnail, youtube_url, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (id) DO UPDATE SET
          channel_id = EXCLUDED.channel_id,
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          published_at = EXCLUDED.published_at,
          thumbnail = EXCLUDED.thumbnail,
          youtube_url = EXCLUDED.youtube_url,
          updated_at = NOW()
      `, [video.id, channel.id, video.title, video.description, video.publishedAt, video.thumbnail, video.youtubeUrl]);

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

export async function getChannels() {
  if (!hasDatabase()) {
    return [...memory.channels.values()].sort((a, b) => new Date(b.lastScannedAt || 0) - new Date(a.lastScannedAt || 0));
  }

  const result = await getPool().query(`
    SELECT c.*, COUNT(DISTINCT v.id)::int AS scanned_videos, COUNT(DISTINCT l.id)::int AS links_count
    FROM channels c
    LEFT JOIN videos v ON v.channel_id = c.id
    LEFT JOIN links l ON l.channel_id = c.id
    GROUP BY c.id
    ORDER BY c.last_scanned_at DESC NULLS LAST, c.updated_at DESC
    LIMIT 500
  `);

  return result.rows.map((row) => ({ ...mapChannelRow(row), scannedVideos: Number(row.scanned_videos || 0), linksCount: Number(row.links_count || 0) }));
}

export async function getLinks({ channelId, limit = 1000 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 1000, 1), 5000);

  if (!hasDatabase()) {
    return [...memory.links.values()]
      .filter((link) => !channelId || link.channelId === channelId)
      .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
      .slice(0, safeLimit);
  }

  const params = [];
  let where = '';
  if (channelId) {
    params.push(channelId);
    where = `WHERE l.channel_id = $${params.length}`;
  }
  params.push(safeLimit);

  const result = await getPool().query(`
    SELECT
      l.id, l.video_id, l.channel_id, l.url, l.normalized_url, l.domain, l.category,
      l.affiliate_likelihood, v.title AS video_title, v.published_at, v.youtube_url,
      c.title AS channel_title
    FROM links l
    JOIN videos v ON v.id = l.video_id
    JOIN channels c ON c.id = l.channel_id
    ${where}
    ORDER BY v.published_at DESC NULLS LAST, l.id DESC
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
    channelTitle: row.channel_title
  }));
}

export async function getDomainStats(limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);

  if (!hasDatabase()) {
    const groups = new Map();
    for (const link of memory.links.values()) {
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
      domain,
      COUNT(*)::int AS links,
      COUNT(DISTINCT channel_id)::int AS channels,
      COUNT(DISTINCT video_id)::int AS videos,
      COUNT(*) FILTER (WHERE affiliate_likelihood = 'high')::int AS affiliate_high
    FROM links
    GROUP BY domain
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
    return {
      channels: memory.channels.size,
      videos: memory.videos.size,
      links: memory.links.size,
      domains: new Set([...memory.links.values()].map((l) => l.domain)).size,
      persistent: false
    };
  }

  const result = await getPool().query(`
    SELECT
      (SELECT COUNT(*)::int FROM channels) AS channels,
      (SELECT COUNT(*)::int FROM videos) AS videos,
      (SELECT COUNT(*)::int FROM links) AS links,
      (SELECT COUNT(DISTINCT domain)::int FROM links) AS domains
  `);

  return { ...result.rows[0], persistent: true };
}
