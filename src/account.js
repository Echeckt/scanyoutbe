import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getPool, hasDatabase } from './db.js';

const SESSION_COOKIE = 'scan_ytb_session';
const SESSION_DAYS = 30;

function configuredAdminEmails() {
  return String(process.env.ADMIN_EMAIL || '')
    .split(',')
    .map((email) => normalizeEmail(email))
    .filter(Boolean);
}

function isConfiguredAdminEmail(email) {
  const normalized = normalizeEmail(email);
  return Boolean(normalized && configuredAdminEmails().includes(normalized));
}

function isAdminRow(row) {
  return Boolean(row?.is_admin || isConfiguredAdminEmail(row?.email));
}

function requireDb() {
  if (!hasDatabase()) {
    const error = new Error('Le système de compte nécessite PostgreSQL.');
    error.status = 503;
    error.code = 'DATABASE_REQUIRED';
    throw error;
  }
  return getPool();
}

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function readCookie(req, name) {
  const header = String(req.headers.cookie || '');
  for (const chunk of header.split(';')) {
    const [key, ...rest] = chunk.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    credits: Number(row.credits || 0),
    isAdmin: isAdminRow(row),
    createdAt: row.created_at || row.createdAt || null
  };
}

export async function createUser(emailInput, password) {
  const db = requireDb();
  const email = normalizeEmail(emailInput);
  if (!validateEmail(email)) {
    const error = new Error('Entre une adresse e-mail valide.');
    error.status = 400;
    throw error;
  }
  if (String(password || '').length < 8) {
    const error = new Error('Le mot de passe doit contenir au moins 8 caractères.');
    error.status = 400;
    throw error;
  }

  const passwordHash = await bcrypt.hash(String(password), 12);
  const id = crypto.randomUUID();
  try {
    const result = await db.query(`
      INSERT INTO users (id, email, password_hash)
      VALUES ($1,$2,$3)
      RETURNING id, email, credits, is_admin, created_at
    `, [id, email, passwordHash]);
    return publicUser(result.rows[0]);
  } catch (error) {
    if (error?.code === '23505') {
      const duplicate = new Error('Un compte existe déjà avec cette adresse e-mail.');
      duplicate.status = 409;
      duplicate.code = 'EMAIL_EXISTS';
      throw duplicate;
    }
    throw error;
  }
}

export async function authenticateUser(emailInput, password) {
  const db = requireDb();
  const email = normalizeEmail(emailInput);
  const result = await db.query(`
    SELECT id, email, password_hash, credits, is_admin, created_at
    FROM users
    WHERE email = $1
    LIMIT 1
  `, [email]);
  const row = result.rows[0];
  const ok = row ? await bcrypt.compare(String(password || ''), row.password_hash) : false;
  if (!ok) {
    const error = new Error('E-mail ou mot de passe incorrect.');
    error.status = 401;
    error.code = 'INVALID_CREDENTIALS';
    throw error;
  }
  return publicUser(row);
}

export async function createSession(userId) {
  const db = requireDb();
  await db.query('DELETE FROM user_sessions WHERE expires_at <= NOW()');
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.query(`
    INSERT INTO user_sessions (token_hash, user_id, expires_at)
    VALUES ($1,$2,$3)
  `, [tokenHash, userId, expiresAt]);
  return { token, expiresAt };
}

export function setSessionCookie(res, token, expiresAt) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Expires=${expiresAt.toUTCString()}`);
}

export function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`);
}

export async function destroySession(req) {
  if (!hasDatabase()) return;
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return;
  await getPool().query('DELETE FROM user_sessions WHERE token_hash = $1', [hashToken(token)]);
}

export async function getUserFromRequest(req) {
  if (!hasDatabase()) return null;
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const result = await getPool().query(`
    SELECT u.id, u.email, u.credits, u.is_admin, u.created_at
    FROM user_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > NOW()
    LIMIT 1
  `, [hashToken(token)]);
  return publicUser(result.rows[0]);
}

export async function getUserById(userId) {
  const db = requireDb();
  const result = await db.query('SELECT id, email, credits, is_admin, created_at FROM users WHERE id = $1 LIMIT 1', [userId]);
  return publicUser(result.rows[0]);
}

export async function reserveSearchCredit(userId, search) {
  const db = requireDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query(`
      SELECT id, email, credits, is_admin
      FROM users
      WHERE id = $1
      FOR UPDATE
    `, [userId]);
    const user = userResult.rows[0];
    if (!user) {
      const error = new Error('Compte introuvable.');
      error.status = 401;
      error.code = 'AUTH_REQUIRED';
      throw error;
    }

    const admin = isAdminRow(user);
    let balance = Number(user.credits || 0);

    if (!admin) {
      if (balance < 1) {
        const error = new Error('Tu n’as plus de crédit de recherche.');
        error.status = 402;
        error.code = 'NO_CREDITS';
        throw error;
      }
      const debit = await client.query(`
        UPDATE users
        SET credits = credits - 1, updated_at = NOW()
        WHERE id = $1
        RETURNING credits
      `, [userId]);
      balance = Number(debit.rows[0]?.credits || 0);
    }

    const result = await client.query(`
      INSERT INTO user_searches (user_id, query, mode, filters, cache_key, status, credit_charged)
      VALUES ($1,$2,$3,$4::jsonb,$5,'pending',$6)
      RETURNING id, created_at
    `, [userId, search.query, search.mode, JSON.stringify(search.filters || {}), search.cacheKey || null, !admin]);

    if (!admin) {
      await client.query(`
        INSERT INTO credit_transactions (user_id, delta, balance_after, type, reference, metadata)
        VALUES ($1,-1,$2,'search_debit',$3,$4::jsonb)
      `, [userId, balance, String(result.rows[0].id), JSON.stringify({ query: search.query, mode: search.mode })]);
    }

    await client.query('COMMIT');
    return {
      searchId: Number(result.rows[0].id),
      creditsRemaining: balance,
      unlimited: admin
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function completeUserSearch(searchId, userId, payload, channelIds = []) {
  const db = requireDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      UPDATE user_searches
      SET status = 'completed', result_summary = $3::jsonb, completed_at = NOW()
      WHERE id = $1 AND user_id = $2
    `, [searchId, userId, JSON.stringify({
      count: Number(payload?.count || 0),
      rawResults: Number(payload?.rawResults || 0),
      uniqueCandidates: Number(payload?.uniqueCandidates || 0),
      servedFromCache: Boolean(payload?.servedFromCache),
      quotaReached: Boolean(payload?.quotaReached)
    })]);

    for (const channelId of [...new Set(channelIds.filter(Boolean))]) {
      await client.query(`
        INSERT INTO user_search_channels (search_id, user_id, channel_id)
        VALUES ($1,$2,$3)
        ON CONFLICT DO NOTHING
      `, [searchId, userId, channelId]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function refundSearchCredit(searchId, userId, reason = 'search_failed') {
  const db = requireDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const search = await client.query(`
      SELECT id, status, credit_charged
      FROM user_searches
      WHERE id = $1 AND user_id = $2
      FOR UPDATE
    `, [searchId, userId]);
    const row = search.rows[0];
    if (!row || row.status !== 'pending') {
      await client.query('COMMIT');
      return false;
    }

    // Les recherches admin n'ont jamais consommé de crédit. On clôture simplement la recherche en échec.
    if (!row.credit_charged) {
      await client.query(`
        UPDATE user_searches
        SET status = 'failed', failure_reason = $3, completed_at = NOW()
        WHERE id = $1 AND user_id = $2
      `, [searchId, userId, reason]);
      await client.query('COMMIT');
      return false;
    }

    const balanceResult = await client.query(`
      UPDATE users SET credits = credits + 1, updated_at = NOW()
      WHERE id = $1
      RETURNING credits
    `, [userId]);
    const balance = Number(balanceResult.rows[0]?.credits || 0);

    await client.query(`
      UPDATE user_searches
      SET status = 'refunded', credit_charged = FALSE, failure_reason = $3, completed_at = NOW()
      WHERE id = $1 AND user_id = $2
    `, [searchId, userId, reason]);

    await client.query(`
      INSERT INTO credit_transactions (user_id, delta, balance_after, type, reference, metadata)
      VALUES ($1,1,$2,'search_refund',$3,$4::jsonb)
    `, [userId, balance, String(searchId), JSON.stringify({ reason })]);

    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function isAdminUser(userId) {
  const db = requireDb();
  const result = await db.query('SELECT email, is_admin FROM users WHERE id = $1 LIMIT 1', [userId]);
  return isAdminRow(result.rows[0]);
}

export async function canUserScanChannel(userId, channelId) {
  const db = requireDb();
  const result = await db.query(`
    SELECT 1
    FROM user_search_channels usc
    JOIN user_searches us ON us.id = usc.search_id
    WHERE usc.user_id = $1 AND usc.channel_id = $2 AND us.status = 'completed'
    LIMIT 1
  `, [userId, channelId]);
  return Boolean(result.rowCount);
}

export async function hasCompletedSearch(userId) {
  const db = requireDb();
  const result = await db.query(`SELECT 1 FROM user_searches WHERE user_id = $1 AND status = 'completed' LIMIT 1`, [userId]);
  return Boolean(result.rowCount);
}

export async function getSearchHistory(userId, limit = 30) {
  const db = requireDb();
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const result = await db.query(`
    SELECT id, query, mode, filters, cache_key, status, credit_charged, result_summary, failure_reason, created_at, completed_at
    FROM user_searches
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [userId, safeLimit]);
  return result.rows.map((row) => ({
    id: Number(row.id),
    query: row.query,
    mode: row.mode,
    filters: row.filters || {},
    cacheKey: row.cache_key,
    status: row.status,
    creditCharged: Boolean(row.credit_charged),
    resultSummary: row.result_summary || {},
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    completedAt: row.completed_at
  }));
}

export async function getUserSearch(userId, searchId) {
  const db = requireDb();
  const result = await db.query(`
    SELECT id, query, mode, filters, cache_key, status, result_summary, created_at, completed_at
    FROM user_searches
    WHERE id = $1 AND user_id = $2
    LIMIT 1
  `, [searchId, userId]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id), query: row.query, mode: row.mode, filters: row.filters || {},
    cacheKey: row.cache_key, status: row.status, resultSummary: row.result_summary || {},
    createdAt: row.created_at, completedAt: row.completed_at
  };
}

export async function recordDodoCheckoutSession({ sessionId, userId, productId, amountCents = 499, currency = 'eur', credits = 1 }) {
  const db = requireDb();
  await db.query(`
    INSERT INTO dodo_payments (checkout_session_id, user_id, product_id, amount_cents, currency, credits, status)
    VALUES ($1,$2,$3,$4,$5,$6,'pending')
    ON CONFLICT (checkout_session_id) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      product_id = EXCLUDED.product_id,
      amount_cents = EXCLUDED.amount_cents,
      currency = EXCLUDED.currency,
      credits = EXCLUDED.credits
  `, [sessionId, userId, productId || null, amountCents, String(currency || 'eur').toLowerCase(), credits]);
}

function dodoPaymentObject(eventOrPayment) {
  if (!eventOrPayment || typeof eventOrPayment !== 'object') return null;
  const data = eventOrPayment.data;
  if (data && typeof data === 'object') {
    if (data.object && typeof data.object === 'object') return data.object;
    if (data.payment_id || data.checkout_session_id || data.status) return data;
  }
  return eventOrPayment;
}

function dodoMetadata(payment) {
  const metadata = payment?.metadata;
  return metadata && typeof metadata === 'object' ? metadata : {};
}

export async function resolveDodoPaymentUserId(eventOrPayment) {
  const payment = dodoPaymentObject(eventOrPayment);
  if (!payment) return null;
  const metadata = dodoMetadata(payment);
  const metadataUserId = String(metadata.user_id || metadata.userId || '').trim();
  if (metadataUserId) return metadataUserId;

  const checkoutSessionId = String(payment.checkout_session_id || '').trim();
  if (!checkoutSessionId) return null;
  const result = await requireDb().query(`
    SELECT user_id FROM dodo_payments WHERE checkout_session_id = $1 LIMIT 1
  `, [checkoutSessionId]);
  return result.rows[0]?.user_id || null;
}

export async function getDodoPaymentRecord(paymentId, userId) {
  const id = String(paymentId || '').trim();
  if (!id) return null;
  const result = await requireDb().query(`
    SELECT payment_id, checkout_session_id, user_id, product_id, amount_cents, currency, credits, status, paid_at
    FROM dodo_payments
    WHERE payment_id = $1 AND user_id = $2
    LIMIT 1
  `, [id, userId]);
  return result.rows[0] || null;
}

export async function fulfillDodoPayment(eventOrPayment, { webhookId = null } = {}) {
  const db = requireDb();
  const payment = dodoPaymentObject(eventOrPayment);
  if (!payment) return false;

  const paymentId = String(payment.payment_id || '').trim();
  const checkoutSessionId = String(payment.checkout_session_id || '').trim() || null;
  if (!paymentId) return false;

  const metadata = dodoMetadata(payment);
  let userId = String(metadata.user_id || metadata.userId || '').trim();
  const credits = Math.max(Number(metadata.credits || 1), 1);
  const configuredProductId = String(process.env.DODO_PRODUCT_ID || '').trim();
  const cart = Array.isArray(payment.product_cart) ? payment.product_cart : [];
  const purchasedProductId = String(cart[0]?.product_id || metadata.product_id || configuredProductId || '').trim() || null;

  // Never grant a ScanYTB credit for an unrelated Dodo product.
  if (configuredProductId && cart.length && !cart.some((item) => String(item?.product_id || '') === configuredProductId)) {
    return false;
  }

  const status = String(payment.status || '').toLowerCase();
  if (status && status !== 'succeeded' && status !== 'paid') return false;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let existing = await client.query(`
      SELECT id, user_id, status, credits
      FROM dodo_payments
      WHERE payment_id = $1 OR ($2::text IS NOT NULL AND checkout_session_id = $2)
      ORDER BY CASE WHEN payment_id = $1 THEN 0 ELSE 1 END
      LIMIT 1
      FOR UPDATE
    `, [paymentId, checkoutSessionId]);

    if (existing.rows[0]?.status === 'paid') {
      await client.query('COMMIT');
      return false;
    }

    if (!userId) userId = String(existing.rows[0]?.user_id || '').trim();
    if (!userId) {
      await client.query('ROLLBACK');
      return false;
    }

    const amountCents = Number(payment.total_amount ?? payment.amount ?? 499) || 499;
    const currency = String(payment.currency || 'EUR').toLowerCase();
    const safeWebhookId = webhookId ? String(webhookId) : null;

    if (existing.rowCount) {
      await client.query(`
        UPDATE dodo_payments SET
          payment_id = $2,
          webhook_id = COALESCE($3, webhook_id),
          product_id = COALESCE($4, product_id),
          amount_cents = $5,
          currency = $6,
          credits = $7,
          status = 'paid',
          metadata = $8::jsonb,
          paid_at = COALESCE(paid_at, NOW())
        WHERE id = $1
      `, [existing.rows[0].id, paymentId, safeWebhookId, purchasedProductId, amountCents, currency, credits, JSON.stringify(metadata)]);
    } else {
      await client.query(`
        INSERT INTO dodo_payments
          (checkout_session_id, payment_id, webhook_id, user_id, product_id, amount_cents, currency, credits, status, metadata, paid_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'paid',$9::jsonb,NOW())
      `, [checkoutSessionId, paymentId, safeWebhookId, userId, purchasedProductId, amountCents, currency, credits, JSON.stringify(metadata)]);
    }

    const balanceResult = await client.query(`
      UPDATE users SET credits = credits + $2, updated_at = NOW()
      WHERE id = $1
      RETURNING credits
    `, [userId, credits]);
    if (!balanceResult.rowCount) throw new Error('Utilisateur Dodo Payments introuvable.');
    const balance = Number(balanceResult.rows[0].credits || 0);

    await client.query(`
      INSERT INTO credit_transactions (user_id, delta, balance_after, type, reference, metadata)
      VALUES ($1,$2,$3,'purchase',$4,$5::jsonb)
    `, [userId, credits, balance, paymentId, JSON.stringify({
      provider: 'dodo_payments',
      checkoutSessionId,
      amountTotal: amountCents,
      currency,
      productId: purchasedProductId
    })]);

    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    // A replay can race with another delivery. If the unique payment id already won, it is safely idempotent.
    if (error?.code === '23505') return false;
    throw error;
  } finally {
    client.release();
  }
}
