import 'dotenv/config'
import express, { type NextFunction, type Request, type Response } from 'express'
import session from 'express-session'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import bcrypt from 'bcryptjs'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createDatabase, ensureWallets, claimDemoFunds, type TessDatabase } from './database.js'

declare module 'express-session' {
  interface SessionData {
    userId?: string
    csrfToken?: string
    isLocked?: boolean
  }
}

class SQLiteSessionStore extends session.Store {
  constructor(private readonly db: TessDatabase) {
    super()
    db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now())
  }

  get(sid: string, callback: (error?: unknown, session?: session.SessionData | null) => void): void {
    try {
      const row = this.db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid) as { sess: string; expires: number } | undefined
      if (!row || row.expires <= Date.now()) return callback(undefined, null)
      callback(undefined, JSON.parse(row.sess) as session.SessionData)
    } catch (error) { callback(error) }
  }

  set(sid: string, sess: session.SessionData, callback?: (error?: unknown) => void): void {
    try {
      const expires = sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 8 * 60 * 60 * 1000
      this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expires) VALUES (?, ?, ?)').run(sid, JSON.stringify(sess), expires)
      callback?.()
    } catch (error) { callback?.(error) }
  }

  touch(sid: string, sess: session.SessionData, callback?: (error?: unknown) => void): void {
    const expires = sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 8 * 60 * 60 * 1000
    try { this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(expires, sid); callback?.() }
    catch (error) { callback?.(error) }
  }

  destroy(sid: string, callback?: (error?: unknown) => void): void {
    try { this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); callback?.() }
    catch (error) { callback?.(error) }
  }
}

const identifierSchema = z.string().trim().min(3).max(180).transform((value) => {
  if (value.includes('@')) return value.toLowerCase()
  return value.replace(/[\s()-]/g, '')
})
const registrationSchema = z.object({
  displayName: z.string().trim().min(2).max(60),
  identifier: identifierSchema,
  password: z.string().min(12).max(200),
  pin: z.string().regex(/^\d{6}$/),
  pinConfirmation: z.string().regex(/^\d{6}$/),
  withdrawalPassword: z.string().min(12).max(200),
  withdrawalPasswordConfirmation: z.string().min(12).max(200),
  referralCode: z.string().trim().optional(),
}).refine((value) => value.pin === value.pinConfirmation, { path: ['pinConfirmation'], message: 'PIN entries do not match' })
  .refine((value) => value.withdrawalPassword === value.withdrawalPasswordConfirmation, { path: ['withdrawalPasswordConfirmation'], message: 'Withdrawal password entries do not match' })
  .refine((value) => value.password !== value.withdrawalPassword, { path: ['withdrawalPassword'], message: 'Withdrawal password must differ from account password' })

export function createApp(db = createDatabase(':memory:')) {
  const app = express()
  app.disable('x-powered-by')
  app.use(helmet({ contentSecurityPolicy: false }))
  app.use(express.json({ limit: '32kb' }))
  app.use(session({
    name: 'tess.sid',
    secret: process.env.SESSION_SECRET ?? 'local-demo-secret-change-before-sharing-please',
    store: new SQLiteSessionStore(db),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 },
  }))
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false })
  const csrf = (req: Request, res: Response, next: NextFunction) => {
    if (!req.session.csrfToken || req.get('x-csrf-token') !== req.session.csrfToken) return res.status(403).json({ error: 'Refresh the page and try again.' })
    next()
  }
  const requireUser = (req: Request, res: Response, next: NextFunction) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Sign in to continue.' })
    next()
  }
  const requireUnlocked = (req: Request, res: Response, next: NextFunction) => {
    if (req.session.isLocked) return res.status(423).json({ error: 'Unlock your session to continue.' })
    next()
  }
  app.get('/api/csrf', (req, res) => {
    req.session.csrfToken ??= randomBytes(32).toString('hex')
    res.json({ token: req.session.csrfToken })
  })
  app.post('/api/auth/register', authLimiter, csrf, async (req, res) => {
    const parsed = registrationSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Check your details.' })
    const user = parsed.data
    if (user.identifier.includes('@') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.identifier)) return res.status(400).json({ error: 'Enter a valid email address.' })
    if (user.identifier.startsWith('+') && !/^\+[1-9]\d{7,14}$/.test(user.identifier)) return res.status(400).json({ error: 'Phone numbers must include a valid country code.' })
    if (!user.identifier.includes('@') && !user.identifier.startsWith('+')) return res.status(400).json({ error: 'Enter an email address or a phone number with country code.' })
    const referral = user.referralCode ? db.prepare('SELECT id FROM users WHERE referral_code = ?').get(user.referralCode) as { id: string } | undefined : undefined
    if (user.referralCode && (!referral || referral.id === req.session.userId)) return res.status(400).json({ error: 'Referral code is invalid.' })
    const id = randomUUID()
    const code = `TESS-${randomBytes(4).toString('hex').toUpperCase()}`
    try {
      const values = await Promise.all([bcrypt.hash(user.password, 12), bcrypt.hash(user.pin, 12), bcrypt.hash(user.withdrawalPassword, 12)])
      db.transaction(() => {
        db.prepare('INSERT INTO users (id, display_name, identifier, password_hash, pin_hash, withdrawal_hash, referral_code, referred_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, user.displayName, user.identifier, values[0], values[1], values[2], code, referral?.id ?? null)
        ensureWallets(db, id)
      }).immediate()
      req.session.regenerate((error) => {
        if (error) return res.status(500).json({ error: 'Could not start session.' })
        req.session.userId = id
        req.session.csrfToken = randomBytes(32).toString('hex')
        res.status(201).json({ id, displayName: user.displayName, identifier: user.identifier, role: 'user', referralCode: code, identityStatus: 'not_submitted', claimed: false, csrfToken: req.session.csrfToken })
      })
    } catch (error) {
      const message = error instanceof Error && error.message.includes('UNIQUE') ? 'An account already exists for that email or phone.' : 'Could not create account.'
      res.status(400).json({ error: message })
    }
  })
  app.post('/api/auth/login', authLimiter, csrf, async (req, res) => {
    const data = z.object({ identifier: identifierSchema, password: z.string().min(1) }).safeParse(req.body)
    if (!data.success) return res.status(400).json({ error: 'Enter your email or phone and password.' })
    const user = db.prepare('SELECT id, display_name, identifier, password_hash, role, referral_code, identity_status FROM users WHERE identifier = ?').get(data.data.identifier) as { id: string; display_name: string; identifier: string; password_hash: string; role: string; referral_code: string; identity_status: string } | undefined
    if (!user || !(await bcrypt.compare(data.data.password, user.password_hash))) return res.status(401).json({ error: 'Email/phone or password is incorrect.' })
    req.session.regenerate((error) => {
      if (error) return res.status(500).json({ error: 'Could not start session.' })
      req.session.userId = user.id
      req.session.csrfToken = randomBytes(32).toString('hex')
      res.json({ id: user.id, displayName: user.display_name, identifier: user.identifier, role: user.role, referralCode: user.referral_code, identityStatus: user.identity_status, claimed: Boolean(db.prepare('SELECT 1 FROM demo_claims WHERE user_id = ?').get(user.id)), csrfToken: req.session.csrfToken })
    })
  })
  app.get('/api/auth/me', requireUser, (req, res) => {
    const user = db.prepare(`SELECT id, display_name as displayName, identifier, role, referral_code as referralCode,
      identity_status as identityStatus FROM users WHERE id = ?`).get(req.session.userId) as Record<string, unknown>
    if (req.session.isLocked) return res.json({ ...user, wallets: [], claim: null, locked: true, csrfToken: req.session.csrfToken })
    const wallets = db.prepare('SELECT kind, balance_cents as cents FROM wallets WHERE user_id = ?').all(req.session.userId)
    const claim = db.prepare('SELECT ledger_id as ledgerId, claimed_at as claimedAt FROM demo_claims WHERE user_id = ?').get(req.session.userId)
    res.json({ ...user, wallets, claim: claim ?? null, locked: false, csrfToken: req.session.csrfToken })
  })
  app.post('/api/auth/logout', csrf, (req, res) => req.session.destroy(() => { res.clearCookie('tess.sid'); res.status(204).end() }))
  app.post('/api/auth/lock', requireUser, csrf, (req, res) => { req.session.isLocked = true; res.json({ locked: true }) })
  app.post('/api/auth/unlock', requireUser, csrf, async (req, res) => {
    const pin = z.string().regex(/^\d{6}$/).safeParse(req.body?.pin)
    const row = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(req.session.userId) as { pin_hash: string } | undefined
    if (!pin.success || !row || !(await bcrypt.compare(pin.data, row.pin_hash))) return res.status(401).json({ error: 'PIN is incorrect.' })
    req.session.isLocked = false
    res.json({ locked: false })
  })
  app.get('/api/deposits/demo-claim', requireUser, requireUnlocked, (req, res) => {
    const claim = db.prepare('SELECT ledger_id as ledgerId, claimed_at as claimedAt FROM demo_claims WHERE user_id = ?').get(req.session.userId)
    res.json({ eligible: !claim, claim: claim ?? null })
  })
  app.post('/api/deposits/demo-claim', requireUser, requireUnlocked, csrf, (req, res) => {
    const result = claimDemoFunds(db, req.session.userId!)
    const wallet = db.prepare("SELECT balance_cents as cents FROM wallets WHERE user_id = ? AND kind = 'general'").get(req.session.userId) as { cents: number }
    res.status(result.claimed ? 201 : 200).json({ ...result, amountCents: result.claimed ? 100000 : 0, balanceCents: wallet.cents, message: result.claimed ? 'Demo starting funds added.' : 'This account has already claimed its demo funds.' })
  })
  app.get('/api/transactions', requireUser, requireUnlocked, (req, res) => {
    const rows = db.prepare(`SELECT id, kind, wallet, amount_cents as amountCents, fee_cents as feeCents,
      status, reference, details, created_at as createdAt FROM ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`).all(req.session.userId)
    res.json(rows)
  })
  app.post('/api/transfers', requireUser, requireUnlocked, csrf, (req, res) => {
    const input = z.object({ from: z.enum(['general', 'trading']), to: z.enum(['general', 'trading']), amount: z.string().regex(/^\d+(\.\d{1,2})?$/) }).safeParse(req.body)
    if (!input.success || input.data.from === input.data.to) return res.status(400).json({ error: 'Choose different wallets and a valid amount.' })
    const cents = Math.round(Number(input.data.amount) * 100)
    if (cents < 1) return res.status(400).json({ error: 'Amount must be greater than zero.' })
    try {
      const ids = [randomUUID(), randomUUID()]
      db.transaction(() => {
        const debit = db.prepare('UPDATE wallets SET balance_cents = balance_cents - ? WHERE user_id = ? AND kind = ? AND balance_cents >= ?').run(cents, req.session.userId, input.data.from, cents)
        if (!debit.changes) throw new Error('INSUFFICIENT')
        db.prepare('UPDATE wallets SET balance_cents = balance_cents + ? WHERE user_id = ? AND kind = ?').run(cents, req.session.userId, input.data.to)
        const insert = db.prepare(`INSERT INTO ledger (id, user_id, kind, wallet, amount_cents, reference, details) VALUES (?, ?, 'transfer', ?, ?, ?, ?)`)
        insert.run(ids[0], req.session.userId, input.data.from, -cents, ids[0], JSON.stringify({ to: input.data.to }))
        insert.run(ids[1], req.session.userId, input.data.to, cents, ids[1], JSON.stringify({ from: input.data.from }))
      }).immediate()
      res.status(201).json({ success: true, amountCents: cents })
    } catch (error) { res.status(400).json({ error: error instanceof Error && error.message === 'INSUFFICIENT' ? 'Insufficient available balance.' : 'Transfer could not be completed.' }) }
  })
  app.get('/api/admin/identity', requireUser, (req, res) => {
    const actor = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId) as { role: string } | undefined
    if (actor?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' })
    res.json(db.prepare("SELECT id, display_name as displayName, identity_status as status FROM users WHERE identity_status IN ('pending', 'rejected') ORDER BY created_at").all())
  })
  app.post('/api/admin/identity/:id/review', requireUser, csrf, (req, res) => {
    const actor = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId) as { role: string } | undefined
    if (actor?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' })
    const data = z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().max(300).optional() }).safeParse(req.body)
    if (!data.success) return res.status(400).json({ error: 'Invalid review decision.' })
    if (req.params.id === req.session.userId) return res.status(400).json({ error: 'You cannot review your own identity submission.' })
    db.transaction(() => {
      db.prepare('UPDATE users SET identity_status = ? WHERE id = ?').run(data.data.decision, req.params.id)
      db.prepare('INSERT INTO audit_log (id, actor_id, subject_id, action, details) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), req.session.userId, req.params.id, `identity_${data.data.decision}`, JSON.stringify({ reason: data.data.reason ?? '' }))
    }).immediate()
    res.json({ success: true })
  })
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', mode: 'simulated' }))
  return app
}

if (process.env.NODE_ENV !== 'test') {
  const db = createDatabase()
  const port = Number(process.env.API_PORT ?? 3001)
  createApp(db).listen(port, () => console.log(`Tess Protocol API (simulation only) listening on http://localhost:${port}`))
}