import 'dotenv/config'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { randomBytes, randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { createDatabase, ensureWallets } from './database.js'

const input = createInterface({ input: stdin, output: stdout })
const displayName = await input.question('Admin display name: ')
const identifier = (await input.question('Admin email or +country-code phone: ')).trim().toLowerCase()
const password = await input.question('Account password (12+ characters): ')
input.close()
if (password.length < 12) throw new Error('Password must be at least 12 characters.')
const db = createDatabase()
const id = randomUUID()
const values = await Promise.all([bcrypt.hash(password, 12), bcrypt.hash(randomBytes(32).toString('hex').slice(0, 6), 12), bcrypt.hash(randomBytes(32).toString('hex'), 12)])
db.transaction(() => {
  db.prepare("INSERT INTO users (id, display_name, identifier, password_hash, pin_hash, withdrawal_hash, role, referral_code) VALUES (?, ?, ?, ?, ?, ?, 'admin', ?)")
    .run(id, displayName, identifier, values[0], values[1], values[2], `TESS-${randomBytes(4).toString('hex').toUpperCase()}`)
  ensureWallets(db, id)
}).immediate()
console.log(`Administrator ${identifier} created. Credentials were not written to disk.`)
db.close()