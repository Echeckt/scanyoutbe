const API_BASE = 'https://www.googleapis.com/youtube/v3';

function getApiKey() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    const error = new Error('YOUTUBE_API_KEY est manquante. Ajoute-la dans les variables Railway.');
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
    headers: { 'User-Agent': 'YouTube-Ecom-FR-Scanner/2.0' },
    signal: AbortSignal.timeout(20_000)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Erreur YouTube API (${response.status})`;
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

function channelFromApi(channel, discoveredQuery = null) {
  return {
    id: channel.id,
    title: channel.snippet?.title || 'Sans nom',
    customUrl: channel.snippet?.customUrl || null,
    description: channel.snippet?.description || '',
    country: channel.snippet?.country || null,
    defaultLanguage: channel.snippet?.defaultLanguage || null,
    thumbnail: channel.snippet?.thumbnails?.medium?.url || channel.snippet?.thumbnails?.default?.url || null,
    subscribers: numberOrZero(channel.statistics?.subscriberCount),
    videoCount: numberOrZero(channel.statistics?.videoCount),
    viewCount: numberOrZero(channel.statistics?.viewCount),
    uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads || null,
    discoveredQuery,
    youtubeUrl: `https://www.youtube.com/channel/${channel.id}`
  };
}

const FRENCH_WORDS = new Set([
  'alors','avec','avoir','beaucoup','bien','bonjour','boutique','business','ce','ces','cette','chez','comment','dans','des','donc','du','elle','en','encore','est','et','faire','france','francais','francaise','gagner','ici','il','je','la','le','les','leur','leurs','mais','mes','mon','nous','notre','pas','plus','pour','pourquoi','quand','que','qui','sans','ses','shopify','site','sont','sur','ta','tes','ton','tout','tous','tu','un','une','vente','vendre','votre','vos','vous'
]);

const ENGLISH_WORDS = new Set([
  'about','and','are','best','business','buy','channel','course','dropshipping','ecommerce','for','from','how','learn','make','marketing','my','new','online','shopify','store','the','this','to','video','we','what','with','you','your'
]);

const SPANISH_WORDS = new Set([
  'ahora','como','con','curso','de','el','en','es','esta','hacer','la','las','los','mas','mi','negocio','para','por','que','sin','tienda','tu','un','una','vender','ventas','y'
]);

const GERMAN_WORDS = new Set([
  'aber','auf','aus','bei','das','dein','der','die','ein','eine','für','ist','mit','nicht','oder','shop','und','verkaufen','von','wie','wir','zu'
]);

function normalizeForLanguage(text = '') {
  return String(text)
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/www\.\S+/gi, ' ')
    .replace(/[@#][\p{L}\p{N}_-]+/gu, ' ')
    .toLowerCase()
    .normalize('NFKC');
}

function scoreTextFrench(text = '') {
  const normalized = normalizeForLanguage(text);
  const words = normalized.match(/[\p{L}']+/gu) || [];
  let fr = 0;
  let en = 0;
  let es = 0;
  let de = 0;

  for (const rawWord of words) {
    const word = rawWord.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (FRENCH_WORDS.has(word)) fr += 1;
    if (ENGLISH_WORDS.has(word)) en += 1;
    if (SPANISH_WORDS.has(word)) es += 1;
    if (GERMAN_WORDS.has(word)) de += 1;
  }

  const frenchAccents = (normalized.match(/[àâçéèêëîïôùûüÿœæ]/g) || []).length;
  fr += Math.min(frenchAccents, 12) * 0.55;

  const frenchPhrases = [
    'comment faire', 'business en ligne', 'boutique en ligne', 'gagner de l’argent',
    "gagner de l'argent", 'je vais', 'je vous', 'dans cette vidéo', 'dans cette video',
    'clique sur', 'lien en description', 'formation gratuite'
  ];
  for (const phrase of frenchPhrases) {
    if (normalized.includes(phrase)) fr += 3;
  }

  const foreign = Math.max(en, es, de);
  const evidence = fr + foreign;

  if (words.length < 4 || evidence < 2) {
    return { score: 45, fr, foreign, evidence, wordCount: words.length };
  }

  // 20 = clairement étranger, 95 = français très net.
  let score = 20 + (75 * fr) / Math.max(evidence, 1);
  if (fr >= 8 && fr >= foreign * 1.7) score += 5;
  if (foreign >= 8 && foreign >= fr * 1.8) score -= 8;

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    fr,
    foreign,
    evidence,
    wordCount: words.length
  };
}

async function getLanguageSample(channel, maxVideos = 6) {
  if (!channel.uploadsPlaylistId || channel.videoCount === 0) return '';

  try {
    const page = await youtubeRequest('playlistItems', {
      part: 'snippet,contentDetails',
      playlistId: channel.uploadsPlaylistId,
      maxResults: Math.min(Math.max(maxVideos, 1), 10)
    });

    return (page.items || [])
      .map((item) => `${item.snippet?.title || ''}\n${item.snippet?.description || ''}`)
      .join('\n')
      .slice(0, 30_000);
  } catch (error) {
    console.warn(`Language sample failed for ${channel.id}:`, error.message);
    return '';
  }
}

function classifyFrenchChannel(channel, sampleText = '') {
  const channelText = scoreTextFrench(`${channel.title}\n${channel.description}`);
  const sample = scoreTextFrench(sampleText);
  const declaredLanguage = String(channel.defaultLanguage || '').toLowerCase();

  let confidence;
  if (sampleText.trim()) {
    confidence = Math.round(channelText.score * 0.28 + sample.score * 0.72);
  } else {
    confidence = channelText.score;
  }

  const reasons = [];

  if (channel.country === 'FR') {
    confidence = Math.max(confidence, 88);
    reasons.push('pays FR déclaré');
  } else if (['BE', 'CH', 'CA', 'LU', 'MC'].includes(channel.country)) {
    confidence += 5;
  }

  if (declaredLanguage === 'fr' || declaredLanguage.startsWith('fr-')) {
    confidence = Math.max(confidence, 88);
    reasons.push('langue FR déclarée');
  }

  if (sampleText.trim() && sample.score >= 72) reasons.push('vidéos majoritairement françaises');
  if (channelText.score >= 72) reasons.push('chaîne rédigée en français');

  confidence = Math.max(0, Math.min(100, confidence));

  // On préfère perdre quelques faux négatifs plutôt que polluer la base avec des chaînes étrangères.
  const isFrench = confidence >= 62 || channel.country === 'FR' || declaredLanguage === 'fr' || declaredLanguage.startsWith('fr-');

  return {
    isFrench,
    frConfidence: Math.round(confidence),
    frReason: reasons.length ? reasons.join(' · ') : (isFrench ? 'signaux linguistiques FR' : 'contenu probablement non francophone')
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export async function discoverChannels({ query, maxResults = 25 }) {
  const requested = Math.min(Math.max(Number(maxResults) || 25, 1), 50);
  // On demande davantage de candidats quand possible, puis on élimine les faux positifs non francophones.
  const candidateCount = Math.min(50, Math.max(requested, requested * 2));

  const search = await youtubeRequest('search', {
    part: 'snippet',
    type: 'channel',
    q: query,
    maxResults: candidateCount,
    relevanceLanguage: 'fr',
    regionCode: 'FR'
  });

  const ids = [...new Set((search.items || [])
    .map((item) => item?.snippet?.channelId || item?.id?.channelId)
    .filter(Boolean))];

  if (!ids.length) {
    return { channels: [], inspected: 0, rejected: 0 };
  }

  const details = await youtubeRequest('channels', {
    part: 'snippet,statistics,contentDetails',
    id: ids.join(','),
    maxResults: 50
  });

  const rank = new Map(ids.map((id, index) => [id, index]));
  const candidates = (details.items || [])
    .map((channel) => channelFromApi(channel, query))
    .sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));

  const checked = await mapWithConcurrency(candidates, 6, async (channel) => {
    const sampleText = await getLanguageSample(channel, 6);
    return { ...channel, ...classifyFrenchChannel(channel, sampleText) };
  });

  const channels = checked
    .filter((channel) => channel.isFrench)
    .slice(0, requested);

  return {
    channels,
    inspected: checked.length,
    rejected: checked.filter((channel) => !channel.isFrench).length
  };
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

  return channelFromApi(channel);
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
