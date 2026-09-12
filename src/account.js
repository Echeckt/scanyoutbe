import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getPool, hasDatabase } from './db.js';

const SESSION_COOKIE = 'scan_ytb_session';
const SESSION_DAYS = 30;

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
      RETURNING id, email, credits, created_at
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
    SELECT id, email, password_hash, credits, created_at
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
    SELECT u.id, u.email, u.credits, u.created_at
    FROM user_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > NOW()
    LIMIT 1
  `, [hashToken(token)]);
  return publicUser(result.rows[0]);
}

export async function getUserById(userId) {
  const db = requireDb();
  const result = await db.query('SELECT id, email, credits, created_at FROM users WHERE id = $1 LIMIT 1', [userId]);
  return publicUser(result.rows[0]);
}

export async function reserveSearchCredit(userId, search) {
  const db = requireDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const debit = await client.query(`
      UPDATE users
      SET credits = credits - 1, updated_at = NOW()
      WHERE id = $1 AND credits > 0
      RETURNING credits
    `, [userId]);
    if (!debit.rowCount) {
      const error = new Error('Tu n’as plus de crédit de recherche.');
      error.status = 402;
      error.code = 'NO_CREDITS';
      throw error;
    }

    const result = await client.query(`
      INSERT INTO user_searches (user_id, query, mode, filters, cache_key, status, credit_charged)
      VALUES ($1,$2,$3,$4::jsonb,$5,'pending',TRUE)
      RETURNING id, created_at
    `, [userId, search.query, search.mode, JSON.stringify(search.filters || {}), search.cacheKey || null]);

    const balance = Number(debit.rows[0].credits || 0);
    await client.query(`
      INSERT INTO credit_transactions (user_id, delta, balance_after, type, reference, metadata)
      VALUES ($1,-1,$2,'search_debit',$3,$4::jsonb)
    `, [userId, balance, String(result.rows[0].id), JSON.stringify({ query: search.query, mode: search.mode })]);

    await client.query('COMMIT');
    return { searchId: Number(result.rows[0].id), creditsRemaining: balance };
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
    if (!row || !row.credit_charged || row.status !== 'pending') {
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

export async function recordCheckoutSession({ sessionId, userId, amountCents = 499, currency = 'usd', credits = 1 }) {
  const db = requireDb();
  await db.query(`
    INSERT INTO payments (stripe_session_id, user_id, amount_cents, currency, credits, status)
    VALUES ($1,$2,$3,$4,$5,'pending')
    ON CONFLICT (stripe_session_id) DO NOTHING
  `, [sessionId, userId, amountCents, currency, credits]);
}

export async function fulfillPaidCheckout(session) {
  const db = requireDb();
  const userId = String(session?.metadata?.user_id || '').trim();
  const credits = Math.max(Number(session?.metadata?.credits || 1), 1);
  if (!userId || !session?.id) return false;
  if (session.payment_status !== 'paid') return false;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(`
      SELECT stripe_session_id, status FROM payments WHERE stripe_session_id = $1 FOR UPDATE
    `, [session.id]);

    if (existing.rows[0]?.status === 'paid') {
      await client.query('COMMIT');
      return false;
    }

    await client.query(`
      INSERT INTO payments (stripe_session_id, stripe_payment_intent, user_id, amount_cents, currency, credits, status, paid_at)
      VALUES ($1,$2,$3,$4,$5,$6,'paid',NOW())
      ON CONFLICT (stripe_session_id) DO UPDATE SET
        stripe_payment_intent = EXCLUDED.stripe_payment_intent,
        amount_cents = EXCLUDED.amount_cents,
        currency = EXCLUDED.currency,
        credits = EXCLUDED.credits,
        status = 'paid',
        paid_at = COALESCE(payments.paid_at, NOW())
    `, [
      session.id,
      typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
      userId,
      Number(session.amount_total || 499),
      String(session.currency || 'usd'),
      credits
    ]);

    const balanceResult = await client.query(`
      UPDATE users SET credits = credits + $2, updated_at = NOW()
      WHERE id = $1
      RETURNING credits
    `, [userId, credits]);
    if (!balanceResult.rowCount) throw new Error('Utilisateur Stripe introuvable.');
    const balance = Number(balanceResult.rows[0].credits || 0);

    await client.query(`
      INSERT INTO credit_transactions (user_id, delta, balance_after, type, reference, metadata)
      VALUES ($1,$2,$3,'purchase',$4,$5::jsonb)
    `, [userId, credits, balance, session.id, JSON.stringify({ amountTotal: session.amount_total, currency: session.currency })]);

    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
