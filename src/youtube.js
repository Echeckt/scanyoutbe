const API_BASE = 'https://www.googleapis.com/youtube/v3';
const VERIFICATION_CACHE_DAYS = 30;

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
    headers: { 'User-Agent': 'ScanYTB/4.0' },
    signal: AbortSignal.timeout(25_000)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Erreur YouTube API (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.details = data?.error || data;
    const reasons = (data?.error?.errors || []).map((item) => item?.reason).filter(Boolean);
    if (response.status === 403 && (reasons.includes('quotaExceeded') || /quota/i.test(message))) {
      error.code = 'YOUTUBE_QUOTA_EXCEEDED';
    }
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
  'alors','avec','avoir','beaucoup','bien','bonjour','boutique','business','ce','ces','cette','chez','comment','dans','des','donc','du','elle','en','encore','est','et','faire','france','francais','francaise','gagner','ici','il','je','la','le','les','leur','leurs','mais','mes','mon','nous','notre','pas','plus','pour','pourquoi','quand','que','qui','sans','ses','shopify','site','sont','sur','ta','tes','ton','tout','tous','tu','un','une','vente','vendre','votre','vos','vous','argent','gratuit','formation','produit','produits','client','clients','commande','commandes','marque','marché','marge'
]);

const ENGLISH_WORDS = new Set([
  'about','and','are','best','business','buy','channel','course','dropshipping','ecommerce','for','from','how','learn','make','marketing','my','new','online','shopify','store','the','this','to','video','we','what','with','you','your','sales','product','products','brand','money','free','tutorial'
]);

const SPANISH_WORDS = new Set([
  'ahora','como','con','curso','de','el','en','es','esta','hacer','la','las','los','mas','mi','negocio','para','por','que','sin','tienda','tu','un','una','vender','ventas','y','producto','productos','dinero'
]);

const GERMAN_WORDS = new Set([
  'aber','auf','aus','bei','das','dein','der','die','ein','eine','für','ist','mit','nicht','oder','shop','und','verkaufen','von','wie','wir','zu','produkt','produkte'
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
    'clique sur', 'lien en description', 'formation gratuite', 'abonne toi', 'abonne-toi',
    'dans cette vidéo', 'je te montre', 'je t’explique', "je t'explique"
  ];
  for (const phrase of frenchPhrases) {
    if (normalized.includes(phrase)) fr += 3;
  }

  const foreign = Math.max(en, es, de);
  const evidence = fr + foreign;

  if (words.length < 4 || evidence < 2) {
    return { score: 45, fr, foreign, evidence, wordCount: words.length };
  }

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

  let confidence = sampleText.trim()
    ? Math.round(channelText.score * 0.28 + sample.score * 0.72)
    : channelText.score;

  const reasons = [];

  if (channel.country === 'FR') {
    confidence = Math.max(confidence, 90);
    reasons.push('pays FR déclaré');
  } else if (['BE', 'CH', 'CA', 'LU', 'MC'].includes(channel.country)) {
    confidence += 5;
    reasons.push(`pays francophone possible (${channel.country})`);
  }

  if (declaredLanguage === 'fr' || declaredLanguage.startsWith('fr-')) {
    confidence = Math.max(confidence, 90);
    reasons.push('langue FR déclarée');
  }

  if (sampleText.trim() && sample.score >= 72) reasons.push('vidéos majoritairement françaises');
  if (channelText.score >= 72) reasons.push('chaîne rédigée en français');

  confidence = Math.max(0, Math.min(100, confidence));
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

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, worker));
  return results;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function buildSearchPlan(query, mode) {
  const base = query.trim();
  if (mode !== 'deep') {
    return [{ q: base, type: 'channel', label: base }];
  }

  const variants = uniqueStrings([
    base,
    `${base} france`,
    `${base} français`,
    `${base} tutoriel`,
    `comment faire ${base}`
  ]);

  return [
    { q: variants[0], type: 'channel', label: variants[0] },
    { q: variants[0], type: 'video', label: variants[0] },
    { q: variants[1], type: 'channel', label: variants[1] },
    { q: variants[1], type: 'video', label: variants[1] },
    { q: variants[2], type: 'channel', label: variants[2] },
    { q: variants[2], type: 'video', label: variants[2] },
    { q: variants[3], type: 'video', label: variants[3] },
    { q: variants[4], type: 'video', label: variants[4] }
  ];
}

async function searchCandidates(query, mode = 'rapid') {
  const plan = buildSearchPlan(query, mode);
  const candidates = new Map();
  let rawResults = 0;
  let rank = 0;

  for (const step of plan) {
    const search = await youtubeRequest('search', {
      part: 'snippet',
      type: step.type,
      q: step.q,
      maxResults: 50,
      relevanceLanguage: 'fr',
      regionCode: 'FR',
      order: 'relevance'
    });

    rawResults += (search.items || []).length;

    for (const item of search.items || []) {
      const channelId = step.type === 'channel'
        ? (item?.id?.channelId || item?.snippet?.channelId)
        : item?.snippet?.channelId;
      if (!channelId) continue;

      if (!candidates.has(channelId)) {
        candidates.set(channelId, {
          id: channelId,
          firstRank: rank++,
          matchedQueries: new Set(),
          discoverySources: new Set()
        });
      }

      const candidate = candidates.get(channelId);
      candidate.matchedQueries.add(step.label);
      candidate.discoverySources.add(step.type);
    }
  }

  const candidateLimit = mode === 'deep' ? 250 : 50;
  return {
    candidates: [...candidates.values()]
      .sort((a, b) => a.firstRank - b.firstRank)
      .slice(0, candidateLimit)
      .map((candidate) => ({
        ...candidate,
        matchedQueries: [...candidate.matchedQueries],
        discoverySources: [...candidate.discoverySources]
      })),
    rawResults,
    searchCalls: plan.length,
    searchQueries: uniqueStrings(plan.map((step) => step.label))
  };
}

async function fetchChannelDetails(ids, discoveredQuery) {
  const details = [];
  for (let index = 0; index < ids.length; index += 50) {
    const chunk = ids.slice(index, index + 50);
    const data = await youtubeRequest('channels', {
      part: 'snippet,statistics,contentDetails',
      id: chunk.join(','),
      maxResults: 50
    });
    details.push(...(data.items || []).map((channel) => channelFromApi(channel, discoveredQuery)));
  }
  return details;
}

function isVerificationCacheFresh(channel) {
  if (!channel || typeof channel.isFrench !== 'boolean' || !channel.lastVerifiedAt) return false;
  const verifiedAt = new Date(channel.lastVerifiedAt).getTime();
  if (!Number.isFinite(verifiedAt)) return false;
  return Date.now() - verifiedAt < VERIFICATION_CACHE_DAYS * 24 * 60 * 60 * 1000;
}

function relevanceScore(channel) {
  const queryMatches = Number(channel.matchedQueries?.length || 0);
  const sourceBonus = channel.discoverySources?.includes('channel') ? 8 : 0;
  const videoBonus = channel.discoverySources?.includes('video') ? 4 : 0;
  const rankPenalty = Math.min(Number(channel.discoveryRank || 0), 200) / 20;
  return Math.round((queryMatches * 14 + sourceBonus + videoBonus - rankPenalty) * 10) / 10;
}

export async function discoverChannels({
  query,
  mode = 'rapid',
  maxResults = 50,
  minSubscribers = 0,
  maxSubscribers = 0,
  minVideos = 0,
  cachedChannels = []
}) {
  const requested = Math.min(Math.max(Number(maxResults) || 50, 1), 200);
  const minSubs = Math.max(Number(minSubscribers) || 0, 0);
  const maxSubs = Math.max(Number(maxSubscribers) || 0, 0);
  const minVids = Math.max(Number(minVideos) || 0, 0);
  const discoveryMode = mode === 'deep' ? 'deep' : 'rapid';

  const candidateSearch = await searchCandidates(query, discoveryMode);
  const candidateIds = candidateSearch.candidates.map((candidate) => candidate.id);
  if (!candidateIds.length) {
    return {
      channels: [],
      verifiedChannels: [],
      mode: discoveryMode,
      rawResults: 0,
      uniqueCandidates: 0,
      eligibleCandidates: 0,
      inspected: 0,
      rejected: 0,
      filteredByMinimum: 0,
      cacheHits: 0,
      freshChecks: 0,
      searchCalls: candidateSearch.searchCalls,
      searchQueries: candidateSearch.searchQueries
    };
  }

  const detailRows = await fetchChannelDetails(candidateIds, query);
  const candidateMeta = new Map(candidateSearch.candidates.map((candidate, index) => [candidate.id, { ...candidate, discoveryRank: index }]));
  const cache = new Map(cachedChannels.map((channel) => [channel.id, channel]));

  const enriched = detailRows
    .map((channel) => {
      const meta = candidateMeta.get(channel.id) || {};
      return {
        ...channel,
        matchedQueries: meta.matchedQueries || [query],
        discoverySources: meta.discoverySources || ['channel'],
        discoveryRank: meta.discoveryRank ?? 9999
      };
    })
    .sort((a, b) => a.discoveryRank - b.discoveryRank);

  const eligible = enriched.filter((channel) => channel.subscribers >= minSubs && (!maxSubs || channel.subscribers <= maxSubs) && channel.videoCount >= minVids);
  const filteredByMinimum = enriched.length - eligible.length;
  let cacheHits = 0;
  let freshChecks = 0;

  const checked = await mapWithConcurrency(eligible, discoveryMode === 'deep' ? 8 : 6, async (channel) => {
    const cached = cache.get(channel.id);
    let classification;
    let verificationCached = false;
    let lastVerifiedAt;

    if (isVerificationCacheFresh(cached)) {
      cacheHits += 1;
      verificationCached = true;
      classification = {
        isFrench: cached.isFrench,
        frConfidence: cached.frConfidence,
        frReason: cached.frReason
      };
      lastVerifiedAt = cached.lastVerifiedAt;
    } else {
      freshChecks += 1;
      const sampleText = await getLanguageSample(channel, discoveryMode === 'deep' ? 7 : 6);
      classification = classifyFrenchChannel(channel, sampleText);
      lastVerifiedAt = new Date().toISOString();
    }

    const merged = {
      ...channel,
      ...classification,
      verificationCached,
      lastVerifiedAt,
      relevanceScore: 0
    };
    merged.relevanceScore = relevanceScore(merged);
    return merged;
  });

  const french = checked
    .filter((channel) => channel.isFrench)
    .sort((a, b) => b.relevanceScore - a.relevanceScore || b.frConfidence - a.frConfidence || b.subscribers - a.subscribers)
    .slice(0, requested);

  const checkedById = new Map(checked.map((channel) => [channel.id, channel]));
  const rememberedChannels = enriched.map((channel) => {
    const checkedChannel = checkedById.get(channel.id);
    if (checkedChannel) return checkedChannel;

    const cached = cache.get(channel.id);
    if (cached && typeof cached.isFrench === 'boolean') {
      return {
        ...channel,
        isFrench: cached.isFrench,
        frConfidence: cached.frConfidence,
        frReason: cached.frReason,
        lastVerifiedAt: cached.lastVerifiedAt
      };
    }
    return channel;
  });

  return {
    channels: french,
    verifiedChannels: checked,
    rememberedChannels,
    mode: discoveryMode,
    rawResults: candidateSearch.rawResults,
    uniqueCandidates: candidateSearch.candidates.length,
    eligibleCandidates: eligible.length,
    inspected: checked.length,
    rejected: checked.filter((channel) => !channel.isFrench).length,
    filteredByMinimum,
    cacheHits,
    freshChecks,
    searchCalls: candidateSearch.searchCalls,
    searchQueries: candidateSearch.searchQueries
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

export async function getVideoStatistics(videoIds = []) {
  const ids = [...new Set((videoIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  const statistics = [];

  for (let index = 0; index < ids.length; index += 50) {
    const batch = ids.slice(index, index + 50);
    const response = await youtubeRequest('videos', {
      part: 'statistics',
      id: batch.join(','),
      maxResults: 50
    });

    for (const item of response.items || []) {
      statistics.push({
        id: item.id,
        viewCount: item.statistics?.viewCount === undefined ? null : numberOrZero(item.statistics.viewCount)
      });
    }
  }

  return statistics;
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
        youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
        viewCount: null
      });
    }

    pageToken = page.nextPageToken;
    if (!pageToken || !(page.items || []).length) break;
  }

  const limitedVideos = videos.slice(0, limit);
  const stats = await getVideoStatistics(limitedVideos.map((video) => video.id));
  const viewsById = new Map(stats.map((item) => [item.id, item.viewCount]));

  return limitedVideos.map((video) => ({
    ...video,
    viewCount: viewsById.has(video.id) ? viewsById.get(video.id) : null
  }));
}
