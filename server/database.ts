import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type TessDatabase = Database.Database

export function createDatabase(filename = process.env.DATABASE_PATH ?? './data/tess.sqlite'): TessDatabase {
  if (filename !== ':memory:') mkdirSync(resolve(dirname(filename)), { recursive: true })
  const db = new Database(filename)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))')
  const migrationDirectory = fileURLToPath(new URL('./migrations/', import.meta.url))
  for (const filename of readdirSync(migrationDirectory).filter((name) => name.startsWith('001_') && name.endsWith('.sql')).sort()) {
    const version = Number(filename.split('_')[0])
    if (!Number.isInteger(version) || db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version)) continue
    const migration = readFileSync(resolve(migrationDirectory, filename), 'utf8')
    db.transaction(() => {
      db.exec(migration)
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version)
    }).immediate()
  }
  return db
}

export function ensureWallets(db: TessDatabase, userId: string): void {
  const insert = db.prepare('INSERT OR IGNORE INTO wallets (user_id, kind) VALUES (?, ?)')
  for (const kind of ['general', 'trading', 'staking']) insert.run(userId, kind)
}

export function claimDemoFunds(db: TessDatabase, userId: string): { claimed: boolean; ledgerId?: string } {
  const operation = db.transaction(() => {
    const ledgerId = randomUUID()
    const result = db.prepare('INSERT OR IGNORE INTO demo_claims (user_id, ledger_id) VALUES (?, ?)').run(userId, ledgerId)
    if (result.changes === 0) return { claimed: false as const }

    db.prepare('UPDATE wallets SET balance_cents = balance_cents + 100000 WHERE user_id = ? AND kind = ?').run(userId, 'general')
    db.prepare(`INSERT INTO ledger (id, user_id, kind, wallet, amount_cents, reference, details)
      VALUES (?, ?, 'demo_starting_funds', 'general', 100000, ?, ?)`)
      .run(ledgerId, userId, `demo:${userId}`, JSON.stringify({ label: 'Demo starting funds' }))
    return { claimed: true as const, ledgerId }
  })
  return operation.immediate()
}