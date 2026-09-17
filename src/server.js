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
import {
  createUser, authenticateUser, createSession, setSessionCookie, clearSessionCookie,
  destroySession, getUserFromRequest, getUserById, reserveSearchCredit, completeUserSearch,
  refundSearchCredit, canUserScanChannel, hasCompletedSearch, getSearchHistory, getUserSearch,
  recordDodoCheckoutSession, fulfillDodoPayment, resolveDodoPaymentUserId, getDodoPaymentRecord
} from './account.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_URL = String(process.env.APP_URL || 'https://scan-ytb.com').replace(/\/$/, '');
const DODO_ENVIRONMENT = String(process.env.DODO_PAYMENTS_ENVIRONMENT || 'live_mode').toLowerCase();
const DODO_API_BASE = DODO_ENVIRONMENT === 'test_mode'
  ? 'https://test.dodopayments.com'
  : 'https://live.dodopayments.com';
const DODO_PRODUCT_ID = String(process.env.DODO_PRODUCT_ID || '').trim();
const DODO_API_KEY = String(process.env.DODO_PAYMENTS_API_KEY || '').trim();
const DODO_WEBHOOK_KEY = String(process.env.DODO_PAYMENTS_WEBHOOK_KEY || '').trim();

function dodoConfigured() {
  return Boolean(DODO_API_KEY && DODO_PRODUCT_ID && DODO_WEBHOOK_KEY);
}

function verifyDodoWebhook(rawBody, headers) {
  const webhookId = String(headers['webhook-id'] || '');
  const webhookSignature = String(headers['webhook-signature'] || '');
  const webhookTimestamp = String(headers['webhook-timestamp'] || '');
  if (!webhookId || !webhookSignature || !webhookTimestamp) throw new Error('Headers webhook manquants.');

  const timestamp = Number.parseInt(webhookTimestamp, 10);
  if (!Number.isFinite(timestamp)) throw new Error('Timestamp webhook invalide.');
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 5 * 60) throw new Error('Webhook expiré.');

  let secret = DODO_WEBHOOK_KEY;
  if (secret.startsWith('whsec_')) secret = secret.slice('whsec_'.length);
  const key = Buffer.from(secret, 'base64');
  if (!key.length) throw new Error('Signing secret Dodo invalide.');

  const expected = crypto
    .createHmac('sha256', key)
    .update(`${webhookId}.${timestamp}.${rawBody}`)
    .digest('base64');

  const valid = webhookSignature.split(' ').some((entry) => {
    const [version, signature] = entry.split(',');
    if (version !== 'v1' || !signature) return false;
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  if (!valid) throw new Error('Signature webhook invalide.');
  return true;
}

async function dodoRequest(pathname, options = {}) {
  if (!DODO_API_KEY) {
    const error = new Error('Dodo Payments n’est pas encore configuré.');
    error.status = 503;
    error.code = 'DODO_NOT_CONFIGURED';
    throw error;
  }
  const response = await fetch(`${DODO_API_BASE}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DODO_API_KEY}`,
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.message || body?.error || body?.detail || `Dodo Payments a répondu ${response.status}.`);
    error.status = response.status >= 400 && response.status < 500 ? 400 : 502;
    error.code = 'DODO_API_ERROR';
    error.details = body;
    throw error;
  }
  return body;
}

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'img-src': ["'self'", 'data:', 'https:'],
      'connect-src': ["'self'"]
    }
  }
}));
app.post('/api/dodo/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!DODO_WEBHOOK_KEY) return res.status(503).send('Webhook Dodo Payments non configuré.');
  try {
    const webhookId = String(req.headers['webhook-id'] || '');
    const webhookSignature = String(req.headers['webhook-signature'] || '');
    const webhookTimestamp = String(req.headers['webhook-timestamp'] || '');
    if (!webhookId || !webhookSignature || !webhookTimestamp) {
      return res.status(400).send('Headers webhook manquants.');
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    verifyDodoWebhook(rawBody, {
      'webhook-id': webhookId,
      'webhook-signature': webhookSignature,
      'webhook-timestamp': webhookTimestamp
    });

    const event = JSON.parse(rawBody);
    // Répondre seulement après traitement : Dodo peut réessayer les livraisons non-2xx.
    if (event?.type === 'payment.succeeded') {
      await fulfillDodoPayment(event, { webhookId });
    }
    return res.json({ received: true });
  } catch (error) {
    console.error('Dodo webhook error:', error?.message || error);
    return res.status(400).send('Webhook Dodo invalide.');
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

async function requireAuth(req, res, next) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Connecte-toi pour continuer.', code: 'AUTH_REQUIRED' });
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

async function requirePaidAccess(req, res, next) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Connecte-toi pour continuer.', code: 'AUTH_REQUIRED' });
    if (!user.isAdmin && !(await hasCompletedSearch(user.id))) {
      return res.status(403).json({ error: 'Lance d’abord une recherche pour accéder à ces données.', code: 'SEARCH_REQUIRED' });
    }
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

app.get('/api/auth/session', async (req, res, next) => {
  try {
    const user = await getUserFromRequest(req);
    res.json({ user });
  } catch (error) { next(error); }
});

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const user = await createUser(req.body?.email, req.body?.password);
    const session = await createSession(user.id);
    setSessionCookie(res, session.token, session.expiresAt);
    res.status(201).json({ user });
  } catch (error) { next(error); }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const user = await authenticateUser(req.body?.email, req.body?.password);
    const session = await createSession(user.id);
    setSessionCookie(res, session.token, session.expiresAt);
    res.json({ user });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    await destroySession(req);
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/account/history', requireAuth, async (req, res, next) => {
  try {
    res.json({ searches: await getSearchHistory(req.user.id, req.query.limit || 30) });
  } catch (error) { next(error); }
});

app.get('/api/account/searches/:id', requireAuth, async (req, res, next) => {
  try {
    const search = await getUserSearch(req.user.id, Number(req.params.id));
    if (!search) return res.status(404).json({ error: 'Recherche introuvable.' });
    let payload = null;
    if (search.cacheKey && search.status === 'completed') {
      payload = (await getDiscoveryCache(search.cacheKey, { maxAgeHours: 24, allowStale: true }))?.payload || null;
    }
    res.json({ search, payload });
  } catch (error) { next(error); }
});

app.post('/api/billing/checkout', requireAuth, async (req, res, next) => {
  try {
    if (req.user.isAdmin) {
      return res.status(400).json({ error: 'Ton compte administrateur dispose déjà de recherches illimitées.', code: 'ADMIN_UNLIMITED' });
    }
    if (!DODO_API_KEY || !DODO_PRODUCT_ID) {
      return res.status(503).json({ error: 'Le paiement Dodo Payments n’est pas encore configuré.', code: 'DODO_NOT_CONFIGURED' });
    }

    const checkout = await dodoRequest('/checkouts', {
      method: 'POST',
      body: JSON.stringify({
        product_cart: [{ product_id: DODO_PRODUCT_ID, quantity: 1 }],
        customer: { email: req.user.email },
        return_url: `${APP_URL}/?payment=success`,
        metadata: {
          user_id: req.user.id,
          credits: '1',
          product_id: DODO_PRODUCT_ID,
          source: 'scan_ytb'
        },
        feature_flags: { redirect_immediately: true }
      })
    });

    if (!checkout?.session_id || !checkout?.checkout_url) {
      throw new Error('Dodo Payments n’a pas renvoyé de lien de paiement valide.');
    }

    await recordDodoCheckoutSession({
      sessionId: checkout.session_id,
      userId: req.user.id,
      productId: DODO_PRODUCT_ID,
      amountCents: 499,
      currency: 'eur',
      credits: 1
    });

    res.json({ url: checkout.checkout_url, sessionId: checkout.session_id });
  } catch (error) { next(error); }
});

app.post('/api/billing/verify-payment', requireAuth, async (req, res, next) => {
  try {
    const paymentId = String(req.body?.paymentId || '').trim();
    if (!paymentId) return res.status(400).json({ error: 'Identifiant de paiement Dodo manquant.' });

    // Si le webhook a déjà été reçu, aucune requête Dodo supplémentaire n’est nécessaire.
    const existing = await getDodoPaymentRecord(paymentId, req.user.id);
    if (existing?.status === 'paid') {
      return res.json({ paid: true, user: await getUserById(req.user.id) });
    }

    const payment = await dodoRequest(`/payments/${encodeURIComponent(paymentId)}`, { method: 'GET' });
    const ownerId = await resolveDodoPaymentUserId(payment);
    if (ownerId !== req.user.id) return res.status(403).json({ error: 'Paiement invalide pour ce compte.' });

    const paid = String(payment?.status || '').toLowerCase() === 'succeeded';
    if (paid) await fulfillDodoPayment(payment);
    res.json({ paid, user: await getUserById(req.user.id) });
  } catch (error) { next(error); }
});

app.get('/api/health', async (_req, res) => {
  res.json({
    ok: true,
    version: '5.5.0',
    youtubeKeyConfigured: Boolean(process.env.YOUTUBE_API_KEY),
    databaseConfigured: hasDatabase(),
    dodoConfigured: dodoConfigured(),
    dodoEnvironment: DODO_ENVIRONMENT,
    adminConfigured: Boolean(String(process.env.ADMIN_EMAIL || '').trim()),
    timestamp: new Date().toISOString()
  });
});

app.post('/api/discover', requireAuth, async (req, res, next) => {
  let reservation = null;
  try {
    const query = String(req.body?.query || '').trim();
    if (!query) return res.status(400).json({ error: 'Entre un mot-clé de recherche.' });

    const mode = req.body?.mode === 'deep' ? 'deep' : 'rapid';
    const maxResults = Math.min(Math.max(Number(req.body?.maxResults || 50), 1), 500);
    const minSubscribers = Math.max(Number(req.body?.minSubscribers || 0), 0);
    const maxSubscribers = Math.max(Number(req.body?.maxSubscribers || 0), 0);
    const minVideos = Math.max(Number(req.body?.minVideos || 0), 0);
    const forceRefresh = req.body?.forceRefresh === true;
    if (maxSubscribers && maxSubscribers < minSubscribers) {
      return res.status(400).json({ error: 'Le maximum d’abonnés doit être supérieur ou égal au minimum.' });
    }

    // La découverte sert uniquement aux niches / mots-clés. Les recherches NDD restent disponibles dans la section Liens.
    const normalizedInput = query.toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0].replace(/^www\./, '');
    if (!query.includes(' ') && /^[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z]{2,63}$/i.test(normalizedInput)) {
      return res.status(400).json({
        error: 'Entre une niche ou un mot-clé (ex. dropshipping, Shopify, WordPress), pas un nom de domaine.'
      });
    }
    const normalizedQuery = query.toLowerCase().replace(/\s+/g, ' ').trim();
    // Versionne le cache afin de ne jamais resservir les anciennes recherches étroites de la V5.3.
    const cacheParams = { mode, maxResults, minSubscribers, maxSubscribers, minVideos, discoveryVersion: 'broad-v2' };
    const cacheKey = crypto
      .createHash('sha256')
      .update(JSON.stringify({ query: normalizedQuery, ...cacheParams }))
      .digest('hex');

    // Le crédit est réservé côté serveur avant la recherche. Toute erreur technique le rembourse automatiquement.
    reservation = await reserveSearchCredit(req.user.id, {
      query,
      mode,
      filters: cacheParams,
      cacheKey
    });

    const finalize = async (payload) => {
      const channels = Array.isArray(payload.channels) ? payload.channels : [];
      await completeUserSearch(reservation.searchId, req.user.id, payload, channels.map((channel) => channel.id));
      return res.json({
        ...payload,
        userSearchId: reservation.searchId,
        creditsRemaining: reservation.creditsRemaining
      });
    };

    // Une recherche identique faite dans les 24 h réutilise le cache YouTube, mais reste une recherche achetée.
    if (!forceRefresh) {
      const cached = await getDiscoveryCache(cacheKey, { maxAgeHours: 24, allowStale: false });
      if (cached?.payload) {
        return finalize({
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
        channels: result.channels,
        servedFromCache: false,
        cacheStale: false,
        quotaReached: false,
        cacheAgeSeconds: 0
      };

      await saveDiscoveryCache(cacheKey, {
        query: normalizedQuery,
        mode,
        params: cacheParams,
        payload
      });

      return finalize(payload);
    } catch (error) {
      if (error?.code !== 'YOUTUBE_QUOTA_EXCEEDED') throw error;

      const cached = await getDiscoveryCache(cacheKey, { maxAgeHours: 24, allowStale: true });
      if (cached?.payload) {
        return finalize({
          ...cached.payload,
          servedFromCache: true,
          cacheStale: true,
          quotaReached: true,
          cacheAgeSeconds: Math.max(0, Math.round((cached.ageMs || 0) / 1000))
        });
      }

      const quotaError = new Error('Quota de recherche YouTube atteint. Ton crédit a été rendu automatiquement. Réessaie après le reset du quota.');
      quotaError.status = 429;
      quotaError.code = 'YOUTUBE_SEARCH_QUOTA_EXCEEDED';
      throw quotaError;
    }
  } catch (error) {
    if (reservation?.searchId) {
      try { await refundSearchCredit(reservation.searchId, req.user.id, error.code || error.message || 'search_failed'); }
      catch (refundError) { console.error('Credit refund failed:', refundError); }
    }
    next(error);
  }
});

app.post('/api/scan', requireAuth, async (req, res, next) => {
  try {
    const channelId = String(req.body?.channelId || '').trim();
    const maxVideos = Math.min(Math.max(Number(req.body?.maxVideos || 100), 1), 1000);
    if (!channelId) return res.status(400).json({ error: 'channelId requis.' });
    if (!req.user.isAdmin && !(await canUserScanChannel(req.user.id, channelId))) {
      return res.status(403).json({ error: 'Cette chaîne ne fait pas partie d’une recherche achetée sur ton compte.', code: 'CHANNEL_NOT_PURCHASED' });
    }

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

app.get('/api/channels', requirePaidAccess, async (_req, res, next) => {
  try {
    res.json({ channels: await getChannels() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/links', requirePaidAccess, async (req, res, next) => {
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

app.get('/api/domain-search', requirePaidAccess, async (req, res, next) => {
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

app.get('/api/domains', requirePaidAccess, async (req, res, next) => {
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


app.post('/api/export-search-domains.txt', requirePaidAccess, async (req, res, next) => {
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

app.get('/api/export-domains.txt', requirePaidAccess, async (_req, res, next) => {
  try {
    await sendDomainTxt(res, {
      businessOnly: false,
      filename: 'domaines-uniques-tous.txt'
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/export-business-domains.txt', requirePaidAccess, async (_req, res, next) => {
  try {
    await sendDomainTxt(res, {
      businessOnly: true,
      filename: 'domaines-business-uniques.txt'
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/export-unique.csv', requirePaidAccess, async (_req, res, next) => {
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

app.get('/api/export.csv', requirePaidAccess, async (_req, res, next) => {
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

app.get('/privacy', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'privacy.html'));
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
    console.log(`ScanYTB v5.1 Dodo running on port ${PORT}`);
  });
}

bootstrap();
