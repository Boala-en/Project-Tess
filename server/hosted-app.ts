import express, { type NextFunction, type Request, type Response } from 'express'
import session from 'express-session'
import helmet from 'helmet'
import bcrypt from 'bcryptjs'
import { Pool, type PoolClient } from 'pg'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'

declare module 'express-session' {
  interface SessionData {
    userId?: string
    csrfToken?: string
    isLocked?: boolean
  }
}

const databaseUrl = process.env.DATABASE_URL
const sessionSecret = process.env.SESSION_SECRET
if (!databaseUrl) throw new Error('DATABASE_URL must be configured for the hosted API.')
if (!sessionSecret || sessionSecret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.')

const pool = new Pool({ connectionString: databaseUrl, max: 1, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 })
pool.on('error', (error) => console.error('Hosted database pool error:', error.message))

class PostgresSessionStore extends session.Store {
  constructor() { super() }
  get(sid: string, callback: (error?: unknown, session?: session.SessionData | null) => void): void {
    void pool.query('SELECT sess, expires FROM tess_sessions WHERE sid = $1 AND expires > $2', [sid, Date.now()])
      .then(({ rows }) => callback(undefined, rows[0]?.sess as session.SessionData | undefined ?? null))
      .catch(callback)
  }
  set(sid: string, value: session.SessionData, callback?: (error?: unknown) => void): void {
    const expires = value.cookie.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 8 * 60 * 60 * 1000
    void pool.query('INSERT INTO tess_sessions (sid, sess, expires) VALUES ($1, $2, $3) ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expires = EXCLUDED.expires', [sid, JSON.stringify(value), expires])
      .then(() => callback?.()).catch((error: unknown) => callback?.(error))
  }
  touch(sid: string, value: session.SessionData, callback?: (error?: unknown) => void): void {
    const expires = value.cookie.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 8 * 60 * 60 * 1000
    void pool.query('UPDATE tess_sessions SET expires = $1 WHERE sid = $2', [expires, sid])
      .then(() => callback?.()).catch((error: unknown) => callback?.(error))
  }
  destroy(sid: string, callback?: (error?: unknown) => void): void {
    void pool.query('DELETE FROM tess_sessions WHERE sid = $1', [sid])
      .then(() => callback?.()).catch((error: unknown) => callback?.(error))
  }
}

const identifierSchema = z.string().trim().min(3).max(180).transform((value) => value.includes('@') ? value.toLowerCase() : value.replace(/[\s()-]/g, ''))
const registrationSchema = z.object({
  displayName: z.string().trim().min(2).max(60), identifier: identifierSchema,
  password: z.string().min(12).max(200), pin: z.string().regex(/^\d{6}$/), pinConfirmation: z.string().regex(/^\d{6}$/),
  withdrawalPassword: z.string().min(12).max(200), withdrawalPasswordConfirmation: z.string().min(12).max(200),
  referralCode: z.string().trim().optional(),
}).refine((value) => value.pin === value.pinConfirmation, { path: ['pinConfirmation'], message: 'PIN entries do not match' })
  .refine((value) => value.withdrawalPassword === value.withdrawalPasswordConfirmation, { path: ['withdrawalPasswordConfirmation'], message: 'Withdrawal password entries do not match' })
  .refine((value) => value.password !== value.withdrawalPassword, { path: ['withdrawalPassword'], message: 'Withdrawal password must differ from account password' })

function csrf(req: Request, res: Response, next: NextFunction) {
  if (!req.session.csrfToken || req.get('x-csrf-token') !== req.session.csrfToken) return res.status(403).json({ error: 'Refresh the page and try again.' })
  next()
}
function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) return res.status(401).json({ error: 'Sign in to continue.' })
  next()
}
function requireUnlocked(req: Request, res: Response, next: NextFunction) {
  if (req.session.isLocked) return res.status(423).json({ error: 'Unlock your session to continue.' })
  next()
}

async function throttleCredentials(req: Request, res: Response, next: NextFunction) {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const bucket = `${ip}:${req.path}`
    const { rows } = await pool.query<{ attempts: number }>(`INSERT INTO auth_attempts (bucket, window_started, attempts)
      VALUES ($1, now(), 1)
      ON CONFLICT (bucket) DO UPDATE SET
        attempts = CASE WHEN auth_attempts.window_started < now() - interval '15 minutes' THEN 1 ELSE auth_attempts.attempts + 1 END,
        window_started = CASE WHEN auth_attempts.window_started < now() - interval '15 minutes' THEN now() ELSE auth_attempts.window_started END
      RETURNING attempts`, [bucket])
    if (rows[0].attempts > 12) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' })
    next()
  } catch { res.status(503).json({ error: 'Credential protection is temporarily unavailable.' }) }
}

async function regenerateSession(req: Request, userId: string): Promise<string> {
  await new Promise<void>((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()))
  req.session.userId = userId
  req.session.csrfToken = randomBytes(32).toString('hex')
  return req.session.csrfToken
}

async function createWallets(client: PoolClient, userId: string) {
  await client.query("INSERT INTO wallets (user_id, kind) VALUES ($1, 'general'), ($1, 'trading'), ($1, 'staking')", [userId])
}

export function createHostedApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)
  app.use(helmet({ contentSecurityPolicy: false }))
  app.use(express.json({ limit: '32kb' }))
  app.use(session({
    name: 'tess.sid', secret: sessionSecret!, store: new PostgresSessionStore(),
    resave: false, saveUninitialized: false, rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 8 * 60 * 60 * 1000, path: '/' },
  }))

  app.get('/api/health', (_req, res) => res.json({ status: 'ok', mode: 'simulated' }))
  app.get('/api/csrf', (req, res) => {
    req.session.csrfToken ??= randomBytes(32).toString('hex')
    res.json({ token: req.session.csrfToken })
  })

  app.post('/api/auth/register', throttleCredentials, csrf, async (req, res) => {
    const parsed = registrationSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Check your details.' })
    const user = parsed.data
    if (user.identifier.includes('@') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.identifier)) return res.status(400).json({ error: 'Enter a valid email address.' })
    if (user.identifier.startsWith('+') && !/^\+[1-9]\d{7,14}$/.test(user.identifier)) return res.status(400).json({ error: 'Phone numbers must include a valid country code.' })
    if (!user.identifier.includes('@') && !user.identifier.startsWith('+')) return res.status(400).json({ error: 'Enter an email address or a phone number with country code.' })
    const client = await pool.connect()
    try {
      const referral = user.referralCode ? (await client.query<{ id: string }>('SELECT id FROM users WHERE referral_code = $1', [user.referralCode])).rows[0] : undefined
      if (user.referralCode && (!referral || referral.id === req.session.userId)) return res.status(400).json({ error: 'Referral code is invalid.' })
      const id = randomUUID()
      const code = `TESS-${randomBytes(4).toString('hex').toUpperCase()}`
      const hashes = await Promise.all([bcrypt.hash(user.password, 12), bcrypt.hash(user.pin, 12), bcrypt.hash(user.withdrawalPassword, 12)])
      await client.query('BEGIN')
      await client.query(`INSERT INTO users (id, display_name, identifier, password_hash, pin_hash, withdrawal_hash, referral_code, referred_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, user.displayName, user.identifier, hashes[0], hashes[1], hashes[2], code, referral?.id ?? null])
      await createWallets(client, id)
      await client.query('COMMIT')
      const csrfToken = await regenerateSession(req, id)
      res.status(201).json({ id, displayName: user.displayName, identifier: user.identifier, role: 'user', referralCode: code, identityStatus: 'not_submitted', claimed: false, csrfToken })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      const message = error instanceof Error && 'code' in error && error.code === '23505' ? 'An account already exists for that email or phone.' : 'Could not create account.'
      res.status(400).json({ error: message })
    } finally { client.release() }
  })

  app.post('/api/auth/login', throttleCredentials, csrf, async (req, res) => {
    const data = z.object({ identifier: identifierSchema, password: z.string().min(1) }).safeParse(req.body)
    if (!data.success) return res.status(400).json({ error: 'Enter your email or phone and password.' })
    const { rows } = await pool.query('SELECT id, display_name, identifier, password_hash, role, referral_code, identity_status FROM users WHERE identifier = $1', [data.data.identifier])
    const user = rows[0] as { id: string; display_name: string; identifier: string; password_hash: string; role: string; referral_code: string; identity_status: string } | undefined
    if (!user || !(await bcrypt.compare(data.data.password, user.password_hash))) return res.status(401).json({ error: 'Email/phone or password is incorrect.' })
    const claim = await pool.query('SELECT 1 FROM demo_claims WHERE user_id = $1', [user.id])
    const csrfToken = await regenerateSession(req, user.id)
    res.json({ id: user.id, displayName: user.display_name, identifier: user.identifier, role: user.role, referralCode: user.referral_code, identityStatus: user.identity_status, claimed: Boolean(claim.rowCount), csrfToken })
  })

  app.get('/api/auth/me', requireUser, async (req, res) => {
    const { rows } = await pool.query(`SELECT id, display_name AS "displayName", identifier, role,
      referral_code AS "referralCode", identity_status AS "identityStatus" FROM users WHERE id = $1`, [req.session.userId])
    if (!rows[0]) return res.status(401).json({ error: 'Sign in to continue.' })
    if (req.session.isLocked) return res.json({ ...rows[0], wallets: [], claim: null, locked: true, csrfToken: req.session.csrfToken })
    const [wallets, claim] = await Promise.all([
      pool.query('SELECT kind, balance_cents AS cents FROM wallets WHERE user_id = $1', [req.session.userId]),
      pool.query('SELECT ledger_id AS "ledgerId", claimed_at AS "claimedAt" FROM demo_claims WHERE user_id = $1', [req.session.userId]),
    ])
    res.json({ ...rows[0], wallets: wallets.rows.map((wallet) => ({ ...wallet, cents: Number(wallet.cents) })), claim: claim.rows[0] ?? null, locked: false, csrfToken: req.session.csrfToken })
  })
  app.post('/api/auth/logout', csrf, (req, res) => req.session.destroy(() => { res.clearCookie('tess.sid', { path: '/' }); res.status(204).end() }))
  app.post('/api/auth/lock', requireUser, csrf, (req, res) => { req.session.isLocked = true; res.json({ locked: true }) })
  app.post('/api/auth/unlock', requireUser, throttleCredentials, csrf, async (req, res) => {
    const pin = z.string().regex(/^\d{6}$/).safeParse(req.body?.pin)
    const { rows } = await pool.query('SELECT pin_hash FROM users WHERE id = $1', [req.session.userId])
    if (!pin.success || !rows[0] || !(await bcrypt.compare(pin.data, rows[0].pin_hash))) return res.status(401).json({ error: 'PIN is incorrect.' })
    req.session.isLocked = false
    res.json({ locked: false })
  })

  app.get('/api/deposits/demo-claim', requireUser, requireUnlocked, async (req, res) => {
    const { rows } = await pool.query('SELECT ledger_id AS "ledgerId", claimed_at AS "claimedAt" FROM demo_claims WHERE user_id = $1', [req.session.userId])
    res.json({ eligible: !rows[0], claim: rows[0] ?? null })
  })
  app.post('/api/deposits/demo-claim', requireUser, requireUnlocked, csrf, async (req, res) => {
    const client = await pool.connect()
    const ledgerId = randomUUID()
    let claimed = false
    try {
      await client.query('BEGIN')
      const insert = await client.query('INSERT INTO demo_claims (user_id, ledger_id) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING RETURNING ledger_id', [req.session.userId, ledgerId])
      claimed = Boolean(insert.rowCount)
      if (claimed) {
        const credit = await client.query("UPDATE wallets SET balance_cents = balance_cents + 100000 WHERE user_id = $1 AND kind = 'general' RETURNING balance_cents", [req.session.userId])
        if (!credit.rowCount) throw new Error('General wallet is missing for this account.')
        await client.query(`INSERT INTO ledger (id, user_id, kind, wallet, amount_cents, reference, details)
          VALUES ($1, $2, 'demo_starting_funds', 'general', 100000, $3, $4::jsonb)`, [ledgerId, req.session.userId, `demo:${req.session.userId}`, JSON.stringify({ label: 'Demo starting funds' })])
      }
      const balance = await client.query("SELECT balance_cents FROM wallets WHERE user_id = $1 AND kind = 'general'", [req.session.userId])
      await client.query('COMMIT')
      res.status(claimed ? 201 : 200).json({ claimed, ledgerId: claimed ? ledgerId : undefined, amountCents: claimed ? 100000 : 0, balanceCents: Number(balance.rows[0]?.balance_cents ?? 0), message: claimed ? 'Demo starting funds added.' : 'This account has already claimed its demo funds.' })
    } catch {
      await client.query('ROLLBACK').catch(() => undefined)
      res.status(500).json({ error: 'Demo funds could not be added. No balance was changed.' })
    } finally { client.release() }
  })

  app.get('/api/transactions', requireUser, requireUnlocked, async (req, res) => {
    const { rows } = await pool.query(`SELECT id, kind, wallet, amount_cents AS "amountCents", fee_cents AS "feeCents",
      status, reference, details, created_at AS "createdAt" FROM ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [req.session.userId])
    res.json(rows.map((row) => ({ ...row, amountCents: Number(row.amountCents), feeCents: Number(row.feeCents), details: JSON.stringify(row.details) })))
  })
  app.post('/api/transfers', requireUser, requireUnlocked, csrf, async (req, res) => {
    const input = z.object({ from: z.enum(['general', 'trading']), to: z.enum(['general', 'trading']), amount: z.string().regex(/^\d+(\.\d{1,2})?$/) }).safeParse(req.body)
    if (!input.success || input.data.from === input.data.to) return res.status(400).json({ error: 'Choose different wallets and a valid amount.' })
    const cents = Math.round(Number(input.data.amount) * 100)
    if (cents < 1) return res.status(400).json({ error: 'Amount must be greater than zero.' })
    const client = await pool.connect()
    const ids = [randomUUID(), randomUUID()]
    try {
      await client.query('BEGIN')
      const debit = await client.query('UPDATE wallets SET balance_cents = balance_cents - $1 WHERE user_id = $2 AND kind = $3 AND balance_cents >= $1', [cents, req.session.userId, input.data.from])
      if (!debit.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Insufficient available balance.' }) }
      await client.query('UPDATE wallets SET balance_cents = balance_cents + $1 WHERE user_id = $2 AND kind = $3', [cents, req.session.userId, input.data.to])
      await client.query(`INSERT INTO ledger (id, user_id, kind, wallet, amount_cents, reference, details) VALUES
        ($1, $2, 'transfer', $3, $4, $1, $5::jsonb), ($6, $2, 'transfer', $7, $8, $6, $9::jsonb)`,
      [ids[0], req.session.userId, input.data.from, -cents, JSON.stringify({ to: input.data.to }), ids[1], input.data.to, cents, JSON.stringify({ from: input.data.from })])
      await client.query('COMMIT')
      res.status(201).json({ success: true, amountCents: cents })
    } catch {
      await client.query('ROLLBACK').catch(() => undefined)
      res.status(500).json({ error: 'Transfer could not be completed.' })
    } finally { client.release() }
  })

  app.get('/api/admin/identity', requireUser, async (req, res) => {
    const { rows: admins } = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId])
    if (admins[0]?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' })
    const { rows } = await pool.query(`SELECT id, display_name AS "displayName", identity_status AS status,
      identity_rejection_reason AS "rejectionReason" FROM users WHERE identity_status IN ('pending', 'rejected') ORDER BY created_at`)
    res.json(rows)
  })
  app.post('/api/admin/identity/:id/review', requireUser, csrf, async (req, res) => {
    const { rows: admins } = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId])
    if (admins[0]?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' })
    const data = z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().max(300).optional() }).safeParse(req.body)
    if (!data.success) return res.status(400).json({ error: 'Invalid review decision.' })
    if (req.params.id === req.session.userId) return res.status(400).json({ error: 'You cannot review your own identity submission.' })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const updated = await client.query('UPDATE users SET identity_status = $1, identity_rejection_reason = $2 WHERE id = $3 RETURNING id', [data.data.decision, data.data.decision === 'rejected' ? data.data.reason ?? '' : null, req.params.id])
      if (!updated.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Account not found.' }) }
      await client.query('INSERT INTO audit_log (id, actor_id, subject_id, action, details) VALUES ($1, $2, $3, $4, $5::jsonb)', [randomUUID(), req.session.userId, req.params.id, `identity_${data.data.decision}`, JSON.stringify({ reason: data.data.reason ?? '' })])
      await client.query('COMMIT')
      res.json({ success: true })
    } catch {
      await client.query('ROLLBACK').catch(() => undefined)
      res.status(500).json({ error: 'Review decision could not be recorded.' })
    } finally { client.release() }
  })
  return app
}