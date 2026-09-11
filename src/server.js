import 'dotenv/config';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { initDatabase, hasDatabase } from './db.js';
import { discoverChannels, getChannel, getUploadedVideos, getVideoStatistics } from './youtube.js';
import { extractLinks } from './links.js';
import {
  saveChannel,
  saveScan,
  getChannels,
  getKnownChannels,
  getLinks,
  getUniqueLinks,
  getUniqueLinksByChannelIds,
  getDomainOccurrences,
  updateVideoViewCounts,
  getDomainStats,
  getStats,
  getDiscoveryCache,
  saveDiscoveryCache
} from './repository.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'img-src': ["'self'", 'data:', 'https:'],
      'connect-src': ["'self'"]
    }
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', async (_req, res) => {
  res.json({
    ok: true,
    version: '4.2.0',
    youtubeKeyConfigured: Boolean(process.env.YOUTUBE_API_KEY),
    databaseConfigured: hasDatabase(),
    timestamp: new Date().toISOString()
  });
});

app.post('/api/discover', async (req, res, next) => {
  try {
    const query = String(req.body?.query || '').trim();
    if (!query) return res.status(400).json({ error: 'Entre un mot-clé de recherche.' });

    const mode = req.body?.mode === 'deep' ? 'deep' : 'rapid';
    const maxResults = Math.min(Math.max(Number(req.body?.maxResults || 50), 1), 200);
    const minSubscribers = Math.max(Number(req.body?.minSubscribers || 0), 0);
    const maxSubscribers = Math.max(Number(req.body?.maxSubscribers || 0), 0);
    const minVideos = Math.max(Number(req.body?.minVideos || 0), 0);
    const forceRefresh = req.body?.forceRefresh === true;
    if (maxSubscribers && maxSubscribers < minSubscribers) {
      return res.status(400).json({ error: 'Le maximum d’abonnés doit être supérieur ou égal au minimum.' });
    }

    const cacheParams = { mode, maxResults, minSubscribers, maxSubscribers, minVideos };
    const normalizedQuery = query.toLowerCase().replace(/\s+/g, ' ').trim();
    const cacheKey = crypto
      .createHash('sha256')
      .update(JSON.stringify({ query: normalizedQuery, ...cacheParams }))
      .digest('hex');

    // Par défaut, une recherche identique faite dans les 24 h ne consomme aucun appel search.list.
    if (!forceRefresh) {
      const cached = await getDiscoveryCache(cacheKey, { maxAgeHours: 24, allowStale: false });
      if (cached?.payload) {
        return res.json({
          ...cached.payload,
          servedFromCache: true,
          cacheStale: false,
          quotaReached: false,
          cacheAgeSeconds: Math.max(0, Math.round((cached.ageMs || 0) / 1000))
        });
      }
    }

    try {
      const cachedChannels = await getKnownChannels(10000);
      const result = await discoverChannels({
        query,
        mode,
        maxResults,
        minSubscribers,
        maxSubscribers,
        minVideos,
        cachedChannels
      });

      await Promise.all(result.rememberedChannels.map((channel) => saveChannel(channel)));

      const payload = {
        query,
        mode: result.mode,
        count: result.channels.length,
        rawResults: result.rawResults,
        uniqueCandidates: result.uniqueCandidates,
        eligibleCandidates: result.eligibleCandidates,
        inspected: result.inspected,
        rejected: result.rejected,
        filteredByMinimum: result.filteredByMinimum,
        cacheHits: result.cacheHits,
        freshChecks: result.freshChecks,
        searchCalls: result.searchCalls,
        searchQueries: result.searchQueries,
        channels: result.channels
      };

      await saveDiscoveryCache(cacheKey, {
        query: normalizedQuery,
        mode,
        params: cacheParams,
        payload
      });

      return res.json({
        ...payload,
        servedFromCache: false,
        cacheStale: false,
        quotaReached: false,
        cacheAgeSeconds: 0
      });
    } catch (error) {
      if (error?.code !== 'YOUTUBE_QUOTA_EXCEEDED') throw error;

      // Si le quota YouTube est atteint, on ne tente pas de le contourner : on sert le dernier cache disponible.
      const cached = await getDiscoveryCache(cacheKey, { maxAgeHours: 24, allowStale: true });
      if (cached?.payload) {
        return res.json({
          ...cached.payload,
          servedFromCache: true,
          cacheStale: true,
          quotaReached: true,
          cacheAgeSeconds: Math.max(0, Math.round((cached.ageMs || 0) / 1000))
        });
      }

      const quotaError = new Error('Quota de recherche YouTube atteint. Aucune version en cache n’est disponible pour cette recherche. Réessaie après le reset du quota ou demande une extension de quota YouTube.');
      quotaError.status = 429;
      quotaError.code = 'YOUTUBE_SEARCH_QUOTA_EXCEEDED';
      throw quotaError;
    }
  } catch (error) {
    next(error);
  }
});

app.post('/api/scan', async (req, res, next) => {
  try {
    const channelId = String(req.body?.channelId || '').trim();
    const maxVideos = Math.min(Math.max(Number(req.body?.maxVideos || 100), 1), 1000);
    if (!channelId) return res.status(400).json({ error: 'channelId requis.' });

    const freshChannel = await getChannel(channelId);
    const knownChannels = await getKnownChannels(10000);
    const known = knownChannels.find((channel) => channel.id === channelId);
    const channel = known
      ? {
          ...known,
          ...freshChannel,
          isFrench: known.isFrench,
          frConfidence: known.frConfidence,
          frReason: known.frReason,
          lastVerifiedAt: known.lastVerifiedAt,
          discoveredQuery: known.discoveredQuery
        }
      : freshChannel;

    const videos = await getUploadedVideos(channel.uploadsPlaylistId, maxVideos);
    const videosWithLinks = videos.map((video) => ({
      video,
      links: extractLinks(video.description)
    }));

    await saveScan(channel, videosWithLinks);

    const links = videosWithLinks.flatMap(({ video, links: videoLinks }) =>
      videoLinks.map((link) => ({
        ...link,
        videoId: video.id,
        videoTitle: video.title,
        publishedAt: video.publishedAt,
        youtubeUrl: video.youtubeUrl,
        channelId: channel.id,
        channelTitle: channel.title
      }))
    );

    const domains = [...new Set(links.map((link) => link.domain))];
    res.json({
      channel,
      scannedVideos: videos.length,
      videosWithLinks: videosWithLinks.filter((item) => item.links.length).length,
      linksFound: links.length,
      uniqueDomains: domains.length,
      links
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/channels', async (_req, res, next) => {
  try {
    res.json({ channels: await getChannels() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/links', async (req, res, next) => {
  try {
    res.json({
      links: await getLinks({
        channelId: req.query.channelId || undefined,
        limit: req.query.limit || 1000
      })
    });
  } catch (error) {
    next(error);
  }
});

function normalizeDomainSearch(value = '') {
  let raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  raw = raw.replace(/^\*\./, '');

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return raw
      .replace(/^https?:\/\//, '')
      .split('/')[0]
      .split(':')[0]
      .replace(/^www\./, '')
      .replace(/\.$/, '');
  }
}

app.get('/api/domain-search', async (req, res, next) => {
  try {
    const domain = normalizeDomainSearch(req.query.domain || req.query.q || '');
    if (!domain || !domain.includes('.')) {
      return res.status(400).json({ error: 'Entre un nom de domaine valide, par ex. ecomstrike.com.' });
    }

    const data = await getDomainOccurrences(domain, req.query.limit || 5000);

    // Les anciennes vidéos scannées avant la V3.5 n'ont pas encore de compteur de vues.
    // On hydrate automatiquement les compteurs manquants / vieux de plus de 24 h, par lots de 50 IDs.
    const now = Date.now();
    const staleIds = [...new Set(data.results
      .filter((item) => {
        if (item.viewCount === null || item.viewCount === undefined) return true;
        if (!item.viewCountUpdatedAt) return true;
        const age = now - new Date(item.viewCountUpdatedAt).getTime();
        return !Number.isFinite(age) || age > 24 * 60 * 60 * 1000;
      })
      .map((item) => item.videoId)
      .filter(Boolean))]
      .slice(0, 500);

    if (staleIds.length) {
      const statistics = await getVideoStatistics(staleIds);
      await updateVideoViewCounts(statistics);
      const viewsById = new Map(statistics.map((item) => [item.id, item.viewCount]));
      const refreshedAt = new Date().toISOString();

      data.results = data.results.map((item) => viewsById.has(item.videoId)
        ? { ...item, viewCount: viewsById.get(item.videoId), viewCountUpdatedAt: refreshedAt }
        : item);
    }

    data.results.sort((a, b) =>
      Number(b.viewCount ?? -1) - Number(a.viewCount ?? -1) ||
      new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

    res.json({ domain, ...data, sort: 'views_desc' });
  } catch (error) {
    next(error);
  }
});

app.get('/api/domains', async (req, res, next) => {
  try {
    res.json({ domains: await getDomainStats(req.query.limit || 100) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/stats', async (_req, res, next) => {
  try {
    res.json(await getStats());
  } catch (error) {
    next(error);
  }
});

const NON_BUSINESS_ROOT_DOMAINS = new Set([
  'youtube.com', 'youtu.be',
  'instagram.com', 'tiktok.com', 'x.com', 'twitter.com', 'facebook.com',
  'linkedin.com', 'discord.gg', 'discord.com', 't.me', 'telegram.me',
  'snapchat.com', 'pinterest.com', 'threads.net', 'whatsapp.com', 'wa.me',
  'bit.ly', 'tinyurl.com', 'cutt.ly', 'linktr.ee', 'beacons.ai', 'bio.site',
  'lnk.bio', 'stan.store', 'solo.to', 'taplink.cc', 'msha.ke', 'urlz.fr',
  'c3po.link', 'taap.it'
]);

const COMMON_MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'com.br', 'com.mx', 'com.tr',
  'co.jp', 'co.kr', 'com.sg', 'com.hk',
  'co.in', 'com.cn', 'com.tw', 'co.za'
]);

function toRootDomain(hostname = '') {
  const cleaned = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');

  if (!cleaned || !cleaned.includes('.')) return null;
  const parts = cleaned.split('.').filter(Boolean);
  if (parts.length <= 2) return cleaned;

  const lastTwo = parts.slice(-2).join('.');
  if (COMMON_MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }

  return lastTwo;
}

function uniqueRootDomains(links, { businessOnly = false } = {}) {
  const domains = new Set();

  for (const link of links) {
    const root = toRootDomain(link.domain);
    if (!root || !root.includes('.')) continue;

    if (businessOnly) {
      if (['social', 'youtube', 'shortener'].includes(link.category)) continue;
      if (NON_BUSINESS_ROOT_DOMAINS.has(root)) continue;
    }

    domains.add(root);
  }

  return [...domains].sort((a, b) => a.localeCompare(b, 'fr'));
}

async function sendDomainTxt(res, { businessOnly, filename }) {
  const links = await getUniqueLinks(100000);
  const domains = uniqueRootDomains(links, { businessOnly });

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Domain-Count', String(domains.length));
  res.send(`\uFEFF${domains.join('\n')}${domains.length ? '\n' : ''}`);
}


app.post('/api/export-search-domains.txt', async (req, res, next) => {
  try {
    const channelIds = Array.isArray(req.body?.channelIds) ? req.body.channelIds : [];
    const businessOnly = Boolean(req.body?.businessOnly);
    const query = String(req.body?.query || 'recherche').trim();

    if (!channelIds.length) {
      return res.status(400).json({ error: 'Aucune chaîne dans la recherche courante.' });
    }

    const links = await getUniqueLinksByChannelIds(channelIds, 100000);
    const domains = uniqueRootDomains(links, { businessOnly });
    const slug = query
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'recherche';
    const filename = businessOnly
      ? `${slug}-domaines-business.txt`
      : `${slug}-domaines-tous.txt`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Domain-Count', String(domains.length));
    res.send(`\uFEFF${domains.join('\n')}${domains.length ? '\n' : ''}`);
  } catch (error) {
    next(error);
  }
});

app.get('/api/export-domains.txt', async (_req, res, next) => {
  try {
    await sendDomainTxt(res, {
      businessOnly: false,
      filename: 'domaines-uniques-tous.txt'
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/export-business-domains.txt', async (_req, res, next) => {
  try {
    await sendDomainTxt(res, {
      businessOnly: true,
      filename: 'domaines-business-uniques.txt'
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/export-unique.csv', async (_req, res, next) => {
  try {
    const links = await getUniqueLinks(100000);
    const headers = [
      'normalized_url',
      'sample_url',
      'domain',
      'category',
      'affiliate_likelihood',
      'occurrences',
      'channels_count',
      'videos_count',
      'first_published_at',
      'last_published_at',
      'latest_channel',
      'latest_video',
      'latest_youtube_url'
    ];
    const escapeCsv = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = links.map((link) => [
      link.normalizedUrl,
      link.url,
      link.domain,
      link.category,
      link.affiliateLikelihood,
      link.occurrences,
      link.channelsCount,
      link.videosCount,
      link.firstPublishedAt,
      link.lastPublishedAt,
      link.latestChannelTitle,
      link.latestVideoTitle,
      link.latestYoutubeUrl
    ].map(escapeCsv).join(','));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="youtube-ecom-fr-unique-links.csv"');
    res.send(`\uFEFF${headers.join(',')}\n${rows.join('\n')}`);
  } catch (error) {
    next(error);
  }
});

app.get('/api/export.csv', async (_req, res, next) => {
  try {
    const links = await getLinks({ limit: 100000 });
    const headers = ['channel', 'video', 'views', 'published_at', 'domain', 'category', 'affiliate_likelihood', 'url', 'youtube_url'];
    const escapeCsv = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = links.map((link) => [
      link.channelTitle,
      link.videoTitle,
      link.viewCount ?? '',
      link.publishedAt,
      link.domain,
      link.category,
      link.affiliateLikelihood,
      link.normalizedUrl,
      link.youtubeUrl
    ].map(escapeCsv).join(','));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="youtube-ecom-fr-all-links.csv"');
    res.send(`\uFEFF${headers.join(',')}\n${rows.join('\n')}`);
  } catch (error) {
    next(error);
  }
});

app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = Number(error.status) || 500;
  res.status(status).json({
    error: error.message || 'Erreur interne.',
    code: error.code || undefined,
    details: process.env.NODE_ENV === 'development' ? error.details : undefined
  });
});

async function bootstrap() {
  try {
    const databaseReady = await initDatabase();
    console.log(databaseReady ? 'PostgreSQL ready.' : 'DATABASE_URL absent: memory mode enabled.');
  } catch (error) {
    console.error('Database init failed:', error.message);
    console.log('App will not start because DATABASE_URL is configured but invalid.');
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ScanYTB v4 running on port ${PORT}`);
  });
}

bootstrap();
