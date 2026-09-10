const API_BASE = 'https://www.googleapis.com/youtube/v3';

function getApiKey() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    const error = new Error('YOUTUBE_API_KEY is missing. Add it to your environment variables.');
    error.status = 500;
    throw error;
  }
  return apiKey;
}

async function youtubeRequest(endpoint, params = {}) {
  const url = new URL(`${API_BASE}/${endpoint}`);
  url.searchParams.set('key', getApiKey());

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: { 'User-Agent': 'YouTube-Ecom-FR-Scanner/1.0' },
    signal: AbortSignal.timeout(20_000)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `YouTube API error (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.details = data?.error || data;
    throw error;
  }

  return data;
}

function numberOrZero(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export async function discoverChannels({ query, maxResults = 25 }) {
  const safeMax = Math.min(Math.max(Number(maxResults) || 25, 1), 50);

  const search = await youtubeRequest('search', {
    part: 'snippet',
    type: 'channel',
    q: query,
    maxResults: safeMax,
    relevanceLanguage: 'fr',
    regionCode: 'FR'
  });

  const ids = [...new Set((search.items || []).map((item) => item?.snippet?.channelId || item?.id?.channelId).filter(Boolean))];
  if (!ids.length) return [];

  const details = await youtubeRequest('channels', {
    part: 'snippet,statistics,contentDetails',
    id: ids.join(','),
    maxResults: 50
  });

  const rank = new Map(ids.map((id, index) => [id, index]));

  return (details.items || [])
    .map((channel) => ({
      id: channel.id,
      title: channel.snippet?.title || 'Sans nom',
      customUrl: channel.snippet?.customUrl || null,
      description: channel.snippet?.description || '',
      country: channel.snippet?.country || null,
      thumbnail: channel.snippet?.thumbnails?.medium?.url || channel.snippet?.thumbnails?.default?.url || null,
      subscribers: numberOrZero(channel.statistics?.subscriberCount),
      videoCount: numberOrZero(channel.statistics?.videoCount),
      viewCount: numberOrZero(channel.statistics?.viewCount),
      uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads || null,
      discoveredQuery: query,
      youtubeUrl: `https://www.youtube.com/channel/${channel.id}`,
      frSignal: channel.snippet?.country === 'FR' ? 'strong' : 'targeted'
    }))
    .sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
}

export async function getChannel(channelId) {
  const details = await youtubeRequest('channels', {
    part: 'snippet,statistics,contentDetails',
    id: channelId
  });

  const channel = details.items?.[0];
  if (!channel) {
    const error = new Error('Chaîne YouTube introuvable.');
    error.status = 404;
    throw error;
  }

  return {
    id: channel.id,
    title: channel.snippet?.title || 'Sans nom',
    customUrl: channel.snippet?.customUrl || null,
    description: channel.snippet?.description || '',
    country: channel.snippet?.country || null,
    thumbnail: channel.snippet?.thumbnails?.medium?.url || channel.snippet?.thumbnails?.default?.url || null,
    subscribers: numberOrZero(channel.statistics?.subscriberCount),
    videoCount: numberOrZero(channel.statistics?.videoCount),
    viewCount: numberOrZero(channel.statistics?.viewCount),
    uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads || null,
    youtubeUrl: `https://www.youtube.com/channel/${channel.id}`
  };
}

export async function getUploadedVideos(uploadsPlaylistId, maxVideos = 100) {
  if (!uploadsPlaylistId) return [];

  const limit = Math.min(Math.max(Number(maxVideos) || 100, 1), 1000);
  const videos = [];
  let pageToken;

  while (videos.length < limit) {
    const remaining = limit - videos.length;
    const page = await youtubeRequest('playlistItems', {
      part: 'snippet,contentDetails',
      playlistId: uploadsPlaylistId,
      maxResults: Math.min(remaining, 50),
      pageToken
    });

    for (const item of page.items || []) {
      const videoId = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
      if (!videoId) continue;

      videos.push({
        id: videoId,
        title: item.snippet?.title || 'Sans titre',
        description: item.snippet?.description || '',
        publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || null,
        thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null,
        youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`
      });
    }

    pageToken = page.nextPageToken;
    if (!pageToken || !(page.items || []).length) break;
  }

  return videos.slice(0, limit);
}
