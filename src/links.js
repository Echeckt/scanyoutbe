const URL_REGEX = /(?:https?:\/\/|www\.)[^\s<>"'`\])}]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

const SOCIAL_DOMAINS = [
  'instagram.com', 'tiktok.com', 'twitter.com', 'x.com', 'facebook.com',
  'linkedin.com', 'discord.gg', 'discord.com', 't.me', 'telegram.me',
  'snapchat.com', 'pinterest.com', 'threads.net'
];

const SHORTENER_DOMAINS = [
  'bit.ly', 'tinyurl.com', 'cutt.ly', 'linktr.ee', 'beacons.ai', 'bio.site',
  'lnk.bio', 'stan.store', 'solo.to', 'taplink.cc', 'msha.ke', 'urlz.fr'
];

const ECOM_DOMAINS = [
  'shopify.com', 'myshopify.com', 'amazon.fr', 'amazon.com', 'etsy.com',
  'ebay.fr', 'ebay.com', 'vinted.fr', 'vinted.com', 'temu.com', 'aliexpress.com'
];

const YOUTUBE_DOMAINS = ['youtube.com', 'youtu.be'];

function canonicalDomain(hostname) {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function domainMatches(domain, candidates) {
  return candidates.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`));
}

export function normalizeUrl(raw) {
  if (!raw) return null;

  let cleaned = raw.trim().replace(TRAILING_PUNCTUATION, '');
  if (cleaned.startsWith('www.')) cleaned = `https://${cleaned}`;

  try {
    const parsed = new URL(cleaned);
    parsed.hash = '';

    // Remove common tracking parameters while preserving referral/affiliate parameters.
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_(campaign|medium|content|term)$/i.test(key) || ['fbclid', 'gclid', 'msclkid'].includes(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }

    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }

    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function classifyUrl(url) {
  try {
    const parsed = new URL(url);
    const domain = canonicalDomain(parsed.hostname);

    let category = 'other';
    if (domainMatches(domain, SOCIAL_DOMAINS)) category = 'social';
    else if (domainMatches(domain, SHORTENER_DOMAINS)) category = 'shortener';
    else if (domainMatches(domain, ECOM_DOMAINS)) category = 'ecommerce';
    else if (domainMatches(domain, YOUTUBE_DOMAINS)) category = 'youtube';

    const affiliateKeys = [
      'ref', 'referral', 'affiliate', 'aff', 'aff_id', 'affid', 'partner',
      'partner_id', 'via', 'invite', 'invite_code', 'coupon', 'code', 'sa'
    ];
    const hasAffiliateParam = [...parsed.searchParams.keys()]
      .some((key) => affiliateKeys.includes(key.toLowerCase()));

    let affiliateLikelihood = 'unknown';
    if (hasAffiliateParam) affiliateLikelihood = 'high';
    else if (category === 'shortener') affiliateLikelihood = 'possible';
    else if (category === 'social' || category === 'youtube') affiliateLikelihood = 'low';

    return { domain, category, affiliateLikelihood };
  } catch {
    return { domain: 'invalid', category: 'other', affiliateLikelihood: 'unknown' };
  }
}

export function extractLinks(description = '') {
  const matches = description.match(URL_REGEX) || [];
  const seen = new Set();
  const results = [];

  for (const raw of matches) {
    const normalizedUrl = normalizeUrl(raw);
    if (!normalizedUrl || seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);

    const meta = classifyUrl(normalizedUrl);
    if (meta.domain === 'invalid') continue;

    results.push({
      url: raw,
      normalizedUrl,
      ...meta
    });
  }

  return results;
}
