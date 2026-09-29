import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from './index.js'
import { createDatabase } from './database.js'

const password = 'correct-horse-battery'
const registration = (identifier = 'demo@example.test') => ({
  displayName: 'Demo Member', identifier, password, pin: '294681', pinConfirmation: '294681',
  withdrawalPassword: 'separate-withdrawal-pass', withdrawalPasswordConfirmation: 'separate-withdrawal-pass',
})

describe('simulated starting funds', () => {
  const databases: ReturnType<typeof createDatabase>[] = []
  afterEach(() => databases.splice(0).forEach((db) => db.close()))

  async function newAccount(identifier?: string) {
    const db = createDatabase(':memory:')
    databases.push(db)
    const app = createApp(db)
    const agent = request.agent(app)
    const csrfResponse = await agent.get('/api/csrf').expect(200)
    const result = await agent.post('/api/auth/register')
      .set('X-CSRF-Token', csrfResponse.body.token)
      .send(registration(identifier))
      .expect(201)
    return { db, agent, user: result.body as { id: string; csrfToken: string } }
  }

  it('credits exactly $1,000 to General and writes one labelled ledger entry', async () => {
    const { db, agent, user } = await newAccount()
    const response = await agent.post('/api/deposits/demo-claim').set('X-CSRF-Token', user.csrfToken).send({}).expect(201)
    expect(response.body).toMatchObject({ claimed: true, amountCents: 100000, balanceCents: 100000 })
    expect(db.prepare("SELECT balance_cents FROM wallets WHERE user_id = ? AND kind = 'general'").get(user.id)).toEqual({ balance_cents: 100000 })
    expect(db.prepare("SELECT kind, amount_cents, details FROM ledger WHERE user_id = ?").get(user.id)).toEqual({ kind: 'demo_starting_funds', amount_cents: 100000, details: '{"label":"Demo starting funds"}' })
  })

  it('returns the persisted claim on retries without adding another credit', async () => {
    const { db, agent, user } = await newAccount()
    await agent.post('/api/deposits/demo-claim').set('X-CSRF-Token', user.csrfToken).send({}).expect(201)
    const retry = await agent.post('/api/deposits/demo-claim').set('X-CSRF-Token', user.csrfToken).send({}).expect(200)
    expect(retry.body.claimed).toBe(false)
    expect(db.prepare("SELECT balance_cents FROM wallets WHERE user_id = ? AND kind = 'general'").get(user.id)).toEqual({ balance_cents: 100000 })
    expect(db.prepare('SELECT count(*) as count FROM ledger WHERE user_id = ?').get(user.id)).toEqual({ count: 1 })
  })

  it('does not restore eligibility after the demo balance has been spent', async () => {
    const { db, agent, user } = await newAccount()
    await agent.post('/api/deposits/demo-claim').set('X-CSRF-Token', user.csrfToken).send({}).expect(201)
    db.prepare("UPDATE wallets SET balance_cents = 0 WHERE user_id = ? AND kind = 'general'").run(user.id)
    const retry = await agent.post('/api/deposits/demo-claim').set('X-CSRF-Token', user.csrfToken).send({}).expect(200)
    expect(retry.body.claimed).toBe(false)
    expect(db.prepare("SELECT balance_cents FROM wallets WHERE user_id = ? AND kind = 'general'").get(user.id)).toEqual({ balance_cents: 0 })
  })

  it('serializes simultaneous claim requests into one grant', async () => {
    const { db, agent, user } = await newAccount()
    const responses = await Promise.all(Array.from({ length: 8 }, () => agent.post('/api/deposits/demo-claim').set('X-CSRF-Token', user.csrfToken).send({})))
    expect(responses.filter((response) => response.body.claimed)).toHaveLength(1)
    expect(db.prepare("SELECT balance_cents FROM wallets WHERE user_id = ? AND kind = 'general'").get(user.id)).toEqual({ balance_cents: 100000 })
    expect(db.prepare('SELECT count(*) as count FROM demo_claims WHERE user_id = ?').get(user.id)).toEqual({ count: 1 })
    expect(db.prepare('SELECT count(*) as count FROM ledger WHERE user_id = ?').get(user.id)).toEqual({ count: 1 })
  })

  it('keeps claim eligibility across sign-out and a new session', async () => {
    const { db, agent, user } = await newAccount('persist@example.test')
    await agent.post('/api/deposits/demo-claim').set('X-CSRF-Token', user.csrfToken).send({}).expect(201)
    await agent.post('/api/auth/logout').set('X-CSRF-Token', user.csrfToken).send({}).expect(204)
    const nextSession = request.agent(createApp(db))
    const csrfResponse = await nextSession.get('/api/csrf').expect(200)
    const login = await nextSession.post('/api/auth/login').set('X-CSRF-Token', csrfResponse.body.token)
      .send({ identifier: 'PERSIST@example.test', password }).expect(200)
    expect(login.body.claimed).toBe(true)
    const claim = await nextSession.post('/api/deposits/demo-claim').set('X-CSRF-Token', login.body.csrfToken).send({}).expect(200)
    expect(claim.body.claimed).toBe(false)
    expect(db.prepare("SELECT balance_cents FROM wallets WHERE user_id = ? AND kind = 'general'").get(user.id)).toEqual({ balance_cents: 100000 })
  })

  it('hides wallet details and blocks claim actions while the session is locked', async () => {
    const { agent, user } = await newAccount()
    await agent.post('/api/deposits/demo-claim').set('X-CSRF-Token', user.csrfToken).send({}).expect(201)
    await agent.post('/api/auth/lock').set('X-CSRF-Token', user.csrfToken).send({}).expect(200)
    const profile = await agent.get('/api/auth/me').expect(200)
    expect(profile.body).toMatchObject({ locked: true, wallets: [], claim: null })
    await agent.post('/api/deposits/demo-claim').set('X-CSRF-Token', user.csrfToken).send({}).expect(423)
  })

  it('normalizes duplicate email identifiers and rejects a second registration', async () => {
    const { agent, user } = await newAccount('Member@Example.test')
    const response = await agent.post('/api/auth/register').set('X-CSRF-Token', user.csrfToken)
      .send(registration(' member@example.test ')).expect(400)
    expect(response.body.error).toContain('already exists')
  })
})