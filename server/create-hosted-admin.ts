import 'dotenv/config'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { randomBytes, randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { Pool } from 'pg'

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the hosted Supabase Postgres connection string.')

const input = createInterface({ input: stdin, output: stdout })
const displayName = await input.question('Admin display name: ')
const identifierInput = await input.question('Admin email or +country-code phone: ')
const password = await input.question('Account password (12+ characters): ')
const pin = await input.question('Six-digit unlock PIN: ')
const pinConfirmation = await input.question('Confirm unlock PIN: ')
const withdrawalPassword = await input.question('Different withdrawal password (12+ characters): ')
const withdrawalPasswordConfirmation = await input.question('Confirm withdrawal password: ')
input.close()
const identifier = identifierInput.trim().toLowerCase()
if (password.length < 12) throw new Error('Password must be at least 12 characters.')
if (!/^\d{6}$/.test(pin) || pin !== pinConfirmation) throw new Error('PIN must contain six digits and both entries must match.')
if (withdrawalPassword.length < 12 || withdrawalPassword !== withdrawalPasswordConfirmation) throw new Error('Withdrawal password entries must match and contain at least 12 characters.')
if (password === withdrawalPassword) throw new Error('Withdrawal password must differ from account password.')
if (!(identifier.includes('@') ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier) : /^\+[1-9]\d{7,14}$/.test(identifier))) throw new Error('Enter a valid email address or an international phone number.')

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
const client = await pool.connect()
try {
  await client.query('BEGIN')
  const id = randomUUID()
  const hashes = await Promise.all([bcrypt.hash(password, 12), bcrypt.hash(pin, 12), bcrypt.hash(withdrawalPassword, 12)])
  await client.query(`INSERT INTO users (id, display_name, identifier, password_hash, pin_hash, withdrawal_hash, role, referral_code)
    VALUES ($1, $2, $3, $4, $5, $6, 'admin', $7)`, [id, displayName, identifier, hashes[0], hashes[1], hashes[2], `TESS-${randomBytes(4).toString('hex').toUpperCase()}`])
  await client.query("INSERT INTO wallets (user_id, kind) VALUES ($1, 'general'), ($1, 'trading'), ($1, 'staking')", [id])
  await client.query('COMMIT')
  console.log(`Hosted administrator ${identifier} created. Credentials were not written to disk.`)
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  client.release()
  await pool.end()
}